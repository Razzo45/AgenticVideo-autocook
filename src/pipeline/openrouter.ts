import fs from "node:fs";
import path from "node:path";
import { imageDimensionsForAspect, providerImageAspect, providerResolutionToken, providerVideoAspect, VIDEO_CAPACITY_BACKOFF_MS, VIDEO_CAPACITY_PERSIST_MAX, VIDEO_CAPACITY_PERSIST_MS, VIDEO_FILTER_RETRIES, type OutputResolution, type VideoAspect } from "./constants";
import { generateOmniVideo, isOmniModel, OMNI_DURATIONS } from "./geminiOmni";
import { loadModelsConfig } from "./config";
import { cropVideoToCinemascope, compressVideoForUpload, encodeReferenceStill, probeFile, scaleVideoToSize } from "./stitch";

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === "replace-me") {
    throw new Error("OPENROUTER_API_KEY is missing. Copy .env.example to .env.");
  }
  return key;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Agentic Video Pipeline",
  };
}

async function orFetch(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const url = pathname.startsWith("http") ? pathname : `${BASE}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
  const { timeoutMs: customTimeout, ...rest } = init ?? {};
  const timeoutMs = customTimeout ?? 90_000;
  const res = await fetch(url, {
    ...rest,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    headers: {
      ...headers(),
      // Prefer plain JSON — some undici/global mixes return gzip bytes without decoding.
      "Accept-Encoding": "identity",
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
  return res;
}

async function orJson<T>(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await orFetch(pathname, init);
  const buf = Buffer.from(await res.arrayBuffer());
  // Some transports hand back gzip without decoding — detect magic 1f 8b.
  const decoded =
    buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
      ? await import("node:zlib").then((z) => z.gunzipSync(buf))
      : buf;
  const text = decoded.toString("utf8");
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status} ${pathname}: ${text.slice(0, 800)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chatCompletion(opts: {
  model: string;
  messages: ChatMessage[];
  json?: boolean;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  const data = await orJson<{
    choices?: Array<{ message?: { content?: string }; finish_reason?: string; native_finish_reason?: string }>;
    error?: { message?: string };
  }>("/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 300_000,
  });
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const reason = choice?.finish_reason ?? choice?.native_finish_reason ?? data.error?.message ?? "unknown";
    throw new Error(`OpenRouter chat returned no content (finish_reason=${reason})`);
  }
  return content;
}

/** One user turn of text + images (data URLs) through an OpenRouter vision model. */
export async function visionCompletion(opts: {
  model: string;
  system?: string;
  text: string;
  imageDataUrls: string[];
}): Promise<string> {
  const messages: unknown[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({
    role: "user",
    content: [
      { type: "text", text: opts.text },
      ...opts.imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  });
  const data = await orJson<{ choices?: Array<{ message?: { content?: string } }> }>("/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: opts.model, messages }),
    timeoutMs: 300_000,
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter vision returned no content");
  return content;
}

export async function listChatModels(): Promise<unknown> {
  return orJson("/models");
}

export async function listImageModels(): Promise<unknown> {
  return orJson("/images/models");
}

let videoModelListCache: { at: number; raw: unknown } | null = null;
const learnedDurations = new Map<string, number[]>();

export async function listVideoModels(): Promise<unknown> {
  if (videoModelListCache && Date.now() - videoModelListCache.at < 10 * 60 * 1000) {
    return videoModelListCache.raw;
  }
  const raw = await orJson("/videos/models");
  videoModelListCache = { at: Date.now(), raw };
  return raw;
}

export function collectModelList(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data as Array<Record<string, unknown>>;
    if (Array.isArray(o.models)) return o.models as Array<Record<string, unknown>>;
  }
  return [];
}

export function findModel(raw: unknown, slug: string): Record<string, unknown> | undefined {
  return collectModelList(raw).find((m) => {
    const id = String(m.id ?? m.name ?? "");
    return id === slug || id.endsWith("/" + slug);
  });
}

export function modelSupports1080p(model: Record<string, unknown> | undefined): boolean | null {
  if (!model) return null;
  const blob = JSON.stringify(model).toLowerCase();
  if (blob.includes("1080p") || blob.includes("1920x1080")) return true;
  if (blob.includes("720p") && !blob.includes("1080")) return false;
  return null;
}

function asSeconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/s$/i, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function uniqDurations(vals: unknown): number[] {
  if (!Array.isArray(vals)) return [];
  return [...new Set(vals.map(asSeconds).filter((n): n is number => n != null && n > 0 && n <= 60))].sort((a, b) => a - b);
}

export function modelDurations(model: Record<string, unknown> | undefined): number[] {
  if (!model) return [];
  const top = uniqDurations(model.supported_durations ?? model.supportedDurations);
  if (top.length) return top;
  const params = (model.supported_parameters ?? model.supportedParameters ?? {}) as Record<string, unknown>;
  const duration = (params.duration ?? {}) as Record<string, unknown>;
  return uniqDurations(duration.enum ?? duration.values ?? duration.allowed ?? model.durations);
}

export function parseDurationsFromError(message: string): number[] {
  const m = message.match(/supported durations:\s*([^\n.}]+)/i);
  if (!m) return [];
  return uniqDurations([...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])));
}

export function snapDuration(requested: number | undefined, allowed: number[]): number | undefined {
  if (!allowed.length) return requested ? Math.round(requested) : undefined;
  const want = requested && requested > 0 ? requested : allowed[allowed.length - 1];
  return allowed.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best));
}

export function modelSupportsFrameImages(model: Record<string, unknown> | undefined): boolean | null {
  if (!model) return null;
  const blob = JSON.stringify(model).toLowerCase();
  if (blob.includes("frame_images") || blob.includes("first_frame") || blob.includes("image-to-video")) return true;
  if (blob.includes("text-to-video") && !blob.includes("image")) return false;
  return null;
}

function fileToDataUrl(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function existingPaths(paths: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths ?? []) {
    if (!p || seen.has(p) || !fs.existsSync(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

async function prepareReferenceJpegs(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const dest = `${p}.ref.jpg`;
    try {
      if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(p).mtimeMs) {
        await encodeReferenceStill(p, dest, 1536);
      }
      out.push(fs.existsSync(dest) ? dest : p);
    } catch {
      out.push(p);
    }
  }
  return out;
}

async function referencePayloads(paths: string[]): Promise<Array<{ name: string; patch: Record<string, unknown> }>> {
  const prepared = await prepareReferenceJpegs(paths);
  const urls = prepared.map((p) => fileToDataUrl(p));
  return [
    {
      name: "input_references",
      patch: {
        input_references: urls.map((url) => ({ type: "image_url", image_url: { url } })),
      },
    },
    {
      name: "input_references_bare",
      patch: { input_references: urls },
    },
    {
      name: "images",
      patch: { images: urls },
    },
  ];
}

export async function generateImage(opts: {
  model: string;
  prompt: string;
  aspectRatio: string;
  outPath: string;
  referencePaths?: string[];
  outputResolution?: OutputResolution;
  /** When true, never drop references (continuation join frames). */
  requireReferences?: boolean;
}): Promise<void> {
  const outputResolution = opts.outputResolution ?? "1080p";
  const dim = imageDimensionsForAspect(opts.aspectRatio as VideoAspect, outputResolution);
  const aspect = providerImageAspect(opts.aspectRatio);
  const imageResToken = outputResolution === "4K" ? "4K" : "2K";
  const refPaths = existingPaths(opts.referencePaths);
  if ((opts.referencePaths?.length ?? 0) > 0 && !refPaths.length) {
    throw new Error("Keyframe generation needs reference stills, but none of the files exist on disk.");
  }
  const hardRequireRefs = Boolean(opts.requireReferences && refPaths.length);
  // Seed rejects size+resolution together when they disagree (e.g. 3840 with token "4K" → wants 4096).
  const bases: Array<Record<string, unknown>> = [
    {
      model: opts.model,
      prompt: opts.prompt,
      aspect_ratio: aspect,
      resolution: imageResToken,
    },
    {
      model: opts.model,
      prompt: opts.prompt,
      aspect_ratio: aspect,
      width: dim.width,
      height: dim.height,
      size: `${dim.width}x${dim.height}`,
    },
    {
      model: opts.model,
      prompt: opts.prompt,
      aspect_ratio: aspect,
    },
  ];

  function buildAttempts(withRefs: boolean): Promise<Array<{ label: string; body: Record<string, unknown> }>> {
    return (async () => {
      const attempts: Array<{ label: string; body: Record<string, unknown> }> = [];
      if (withRefs && refPaths.length) {
        for (const fmt of await referencePayloads(refPaths)) {
          for (const b of bases) attempts.push({ label: `${fmt.name}+refs`, body: { ...b, ...fmt.patch } });
        }
      } else {
        for (const b of bases) attempts.push({ label: "text", body: { ...b } });
      }
      return attempts;
    })();
  }

  async function runAttempts(
    attempts: Array<{ label: string; body: Record<string, unknown> }>,
  ): Promise<{ ok: true } | { ok: false; lastError: unknown; trademark: boolean }> {
    let lastError: unknown;
    let trademark = false;
    for (const attempt of attempts) {
      try {
        const data = await orJson<Record<string, unknown>>("/images", {
          method: "POST",
          body: JSON.stringify(attempt.body),
          // Nano Banana / Seedream with refs often exceed 90s.
          timeoutMs: 300_000,
        });
        const bytes = await extractImageBytes(data);
        fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
        fs.writeFileSync(opts.outPath, bytes);
        console.info(`[image] ok via ${attempt.label}`);
        return { ok: true };
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/copyright|trademark|flagged/i.test(msg)) trademark = true;
        const timedOut = /aborted|timeout|TimeoutError/i.test(msg);
        const paramIssue =
          timedOut ||
          msg.includes("400") ||
          msg.includes("output pixels") ||
          msg.includes("size") ||
          /input_references|reference|images|copyright|trademark|flagged|blocked/i.test(msg);
        if (!paramIssue) throw err;
        console.warn(`[image] ${attempt.label} rejected: ${msg.slice(0, 240)}`);
      }
    }
    return { ok: false, lastError, trademark };
  }

  function fail(lastError: unknown, required: boolean): never {
    const suffix = required
      ? " Reference stills are required for this shot — refusing to generate from the storyboard text alone."
      : "";
    throw lastError instanceof Error
      ? new Error(`${lastError.message}${suffix}`)
      : new Error(`Image generation failed.${suffix}`);
  }

  // Prefer refs when present; Seed often blocks logos/trademarks — fall back to text-only.
  if (refPaths.length) {
    const withRefs = await runAttempts(await buildAttempts(true));
    if (withRefs.ok) return;
    if (!hardRequireRefs) {
      console.warn(
        `[image] reference stills blocked (${withRefs.trademark ? "trademark/copyright" : "param/timeout"}); retrying text-only`,
      );
      const textOnly = await runAttempts(await buildAttempts(false));
      if (textOnly.ok) return;
      fail(textOnly.lastError ?? withRefs.lastError, false);
    }
    fail(withRefs.lastError, hardRequireRefs);
  }

  const textOnly = await runAttempts(await buildAttempts(false));
  if (textOnly.ok) return;
  fail(textOnly.lastError, false);
}

async function extractImageBytes(data: Record<string, unknown>): Promise<Buffer> {
  const arr = (data.data ?? data.images ?? data.output) as unknown;
  const first = Array.isArray(arr) ? arr[0] : arr;
  if (typeof first === "string") {
    if (first.startsWith("http")) {
      const res = await fetch(first);
      if (!res.ok) throw new Error(`Image URL download failed ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    const b64 = first.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(b64, "base64");
  }
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    const b64 = String(o.b64_json ?? o.b64 ?? o.base64 ?? "");
    if (b64) return Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    if (typeof o.url === "string" && o.url.startsWith("data:")) {
      return Buffer.from(o.url.split(",")[1] ?? "", "base64");
    }
    if (typeof o.url === "string" && o.url.startsWith("http")) {
      const res = await fetch(o.url);
      if (!res.ok) throw new Error(`Image URL download failed ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
  }
  throw new Error("Could not parse image bytes from OpenRouter /images response");
}

export function isVideoFilterError(message: string): boolean {
  // Keep this narrow — bare "safety"/"blocked"/"policy" matched unrelated provider text
  // and caused finished jobs to silently burn another full submit.
  return /content may have been filtered|completed with no output|content.?filter|safety.?filter|blocked by (?:the )?safety|violat(?:es|ion) (?:our |the )?policy/i.test(
    message,
  );
}

export function isVideoCapacityError(message: string): boolean {
  return /high load|try again later|overloaded|resource.?exhausted|unavailable|too many requests|rate.?limit|\b429\b|\b503\b|capacity/i.test(
    message,
  );
}

const VIDEO_SAFETY =
  "Fictional cinematic. No blood, no gore, no injury, no weapons striking anyone, no dismemberment.";

/** Educational / training cooks — avoid combat-safety negations (those words themselves trip Veo). */
const EDUCATIONAL_VIDEO_GUARD =
  "Calm professional workplace training clip. Natural talking-head or simple demonstration only. No on-screen text, logos, title cards, UI, or captions.";

/** Graphic-card shots animate a designed still — talking-head guards would turn them into a person. */
const CARD_VIDEO_GUARD =
  "The first-frame still is a designed graphic card: keep it exactly as shown — same text, layout and colours — with at most a very slow, subtle push-in. No people, faces or presenter on screen. Any narration is voice-over only.";

export function isGraphicCardPrompt(prompt: string): boolean {
  return /\b(title card|chapter card|section card|end card|closing card|opening card|graphic card|summary card|text card|card holds|full-screen (?:title|graphic|card)|logo (?:is )?cent(?:er|re)d)\b/i.test(
    prompt,
  );
}

/**
 * Strip prompt patterns that routinely empty-filter Veo on training cooks:
 * long quoted VO, logo/title burn-ins, combat safety baggage.
 */
export function sanitizeEducationalVideoPrompt(prompt: string): string {
  if (isGraphicCardPrompt(prompt)) {
    const p = prompt
      .trim()
      .replace(/\b[\w.-]+\.(?:jpg|jpeg|png|webp|gif|mp3|wav|mp4|mov|pdf|docx?)\b/gi, "")
      .replace(/[ \t]{2,}/g, " ");
    return `${p}\n\n${CARD_VIDEO_GUARD}`;
  }
  let p = prompt.trim();
  // Drop explicit spoken scripts — Veo often empty-filters long dialogue quotes.
  p = p.replace(/\bVOICEOVER:\s*[^\n]+/gi, "");
  p = p.replace(/\bHe says:\s*[^\n]+/gi, "");
  p = p.replace(/\bShe says:\s*[^\n]+/gi, "");
  p = p.replace(/\bThey say:\s*[^\n]+/gi, "");
  p = p.replace(/\b(?:Marcus|presenter|host|narrator)\s+says:\s*[^\n]+/gi, "");
  p = p.replace(/[“"][^”"]{40,}[”"]/g, "");
  p = p.replace(/\b(?:lower[- ]thirds?|title cards?|on-screen text|bullet lists?|logos?|wordmarks?)\b[^.]*\./gi, "");
  // Filenames / asset paths in the prompt routinely empty-filter Veo (model tries to render them as text).
  p = p.replace(/\b[\w.-]+\.(?:jpg|jpeg|png|webp|gif|mp3|wav|mp4|mov|pdf|docx?)\b/gi, "");
  p = p.replace(/\busing\s+\S+\s+as a pacing guide\.?/gi, "");
  p = p.replace(/\bfrom\s+as depicted in\b/gi, "as depicted in");
  p = p.replace(/\bpreserving\s+\S+\s+appearance from\s+/gi, "preserving appearance from the first-frame still; ");
  p = p.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!/\bspeaks?\b|\btalking-head\b|\bmouth\b/i.test(p)) {
    p = `${p}\nPresenter speaks naturally to camera with subtle mouth movement.`.trim();
  }
  return `${p}\n\n${EDUCATIONAL_VIDEO_GUARD}`;
}

export function softenVideoPrompt(prompt: string): string {
  let p = prompt;
  const swaps: Array<[RegExp, string]> = [
    [/\b(combat|fight|fighting|battle|brawl)\b/gi, "confrontation"],
    [/\b(attack|assault|strike|punch|kick|blow|slash|stab|lunge)\b/gi, "move"],
    [/\b(parry|clash|block an attack)\b/gi, "meet"],
    [/\b(kill|murder|gore|blood\w*|wound\w*|injur\w*|dismember\w*|decapitat\w*)\b/gi, ""],
    [/\b(weapon impact|weapon strike)\b/gi, "prop motion"],
  ];
  for (const [re, to] of swaps) p = p.replace(re, to);
  p = p.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return `${p}\n\nSafer retake: same characters, wardrobe, weather, and camera. Slow physical presence only. No impact. ${VIDEO_SAFETY}`;
}

/** Empty/filtered output retry for educational / talking-head auto cooks (not combat softening). */
export function softenEmptyOutputPrompt(prompt: string): string {
  if (isGraphicCardPrompt(prompt)) {
    return [
      "Hold the designed graphic card from the first-frame still unchanged — same text, layout and colours.",
      "Very slow, subtle push-in only. No people, no faces, no new graphics.",
      CARD_VIDEO_GUARD,
    ].join("\n");
  }
  const base = sanitizeEducationalVideoPrompt(prompt)
    .replace(EDUCATIONAL_VIDEO_GUARD, "")
    .trim();
  return [
    base,
    "",
    "Safer retake after empty provider output:",
    "Same single person as the first-frame still. Wardrobe, lighting, and room unchanged.",
    "Strict talking-head only: NO on-screen text, NO title cards, NO bullet lists, NO logos, NO UI chrome, NO animating graphics.",
    "Natural speech motion and one small gesture only. Calm professional educational tone.",
    "Do not invent cuts, transitions, or graphics.",
    EDUCATIONAL_VIDEO_GUARD,
  ].join("\n");
}

/** Last-resort educational retry — minimal motion, identity from first frame only. */
export function minimalTalkingHeadPrompt(prompt = ""): string {
  if (isGraphicCardPrompt(prompt)) {
    return "Static hold of the graphic card in the first-frame still. Nothing changes. No people. No new text.";
  }
  return [
    "Same person already visible in the first-frame still.",
    "Calm talking-head workplace training take.",
    "Subtle natural mouth movement as if speaking. Soft blink. Tiny hand gesture optional.",
    "Static camera. No cuts. No text. No logos. No graphics. No captions.",
    EDUCATIONAL_VIDEO_GUARD,
  ].join(" ");
}

/** One neutral rewrite of a video instruction the provider rejected for its wording. */
async function rephraseVideoInstruction(prompt: string): Promise<string> {
  const out = await chatCompletion({
    model: loadModelsConfig().script,
    messages: [
      {
        role: "system",
        content:
          "Rewrite this video-generation instruction in plain, neutral film-production language. Keep every visual change, the timing and the camera direction. Describe the person only by wardrobe and movement through the frame; do not describe their body, anatomy or physique. Return only the rewritten instruction.",
      },
      { role: "user", content: prompt },
    ],
  });
  return out.trim() || prompt;
}

export async function generateVideo(opts: {
  model: string;
  prompt: string;
  aspectRatio: string;
  duration?: number;
  firstFramePath?: string;
  lastFramePath?: string;
  sourceVideoPath?: string;
  /** Style / reference stills (operator images and frames pulled from operator videos). */
  referenceImagePaths?: string[];
  /** Operator reference videos — uploaded as video_url when the model honors them (e.g. Seedance 2.x). */
  referenceVideoPaths?: string[];
  /** Omni: send the reference videos from this point on (the shot's place in the edit). */
  referenceVideoStartSec?: number;
  /** Operator audio beds — uploaded as audio_url when supported. */
  referenceAudioPaths?: string[];
  outPath: string;
  /** Native output. Defaults to 1080p. Use 4K when the model supports it. */
  resolution?: string;
  outputResolution?: OutputResolution;
  /** Skip safety rewrites — used for targeted edits on an existing take. */
  preservePrompt?: boolean;
  onStatus?: (msg: string) => void;
  /**
   * When true, retry provider overload / 503 with backoff (capped).
   * Used by auto runs — still not infinite.
   */
  persistOnCapacity?: boolean;
  /**
   * How many distinct prompt attempts after empty/filtered outputs.
   * Default VIDEO_FILTER_RETRIES. Auto passes 2: one normal + one educational soften.
   */
  maxFilterAttempts?: number;
  /** When true, empty/filter retries use educational soften (not combat soften). */
  educationalSoften?: boolean;
  /**
   * Argon (or another brain) owns the full generation instruction.
   * Omni must not wrap/rephrase — only API transport + duration/aspect from the plan.
   */
  brainOwnedPrompt?: boolean;
}): Promise<void> {
  if (isOmniModel(opts.model)) {
    const duration = snapDuration(opts.duration, [...OMNI_DURATIONS]) ?? opts.duration ?? 8;
    const resolution =
      opts.resolution ?? providerResolutionToken(opts.outputResolution ?? "1080p");
    opts.onStatus?.("Using Gemini Omni (direct GEMINI_API_KEY)…");
    // Do NOT append VIDEO_SAFETY — Google's Omni policy filter often blocks the
    // negation words themselves (blood/gore/weapons/dismemberment).
    const omni = (withStills: boolean, prompt = opts.prompt) =>
      generateOmniVideo({
        prompt: prompt.trim(),
        aspectRatio: opts.aspectRatio,
        duration,
        firstFramePath: withStills ? opts.firstFramePath : undefined,
        lastFramePath: withStills ? opts.lastFramePath : undefined,
        sourceVideoPath: opts.sourceVideoPath,
        referenceImagePaths: withStills ? opts.referenceImagePaths : undefined,
        referenceVideoPaths: opts.referenceVideoPaths,
        referenceVideoStartSec: opts.referenceVideoStartSec,
        outPath: opts.outPath,
        resolution,
        outputResolution: opts.outputResolution,
        onStatus: opts.onStatus,
        brainOwnedPrompt: opts.brainOwnedPrompt,
      });
    const hasPlate = Boolean(opts.sourceVideoPath || opts.referenceVideoPaths?.length);
    let withStills = Boolean(opts.firstFramePath || opts.lastFramePath || opts.referenceImagePaths?.length);
    let prompt = opts.prompt;
    let rephrased = false;
    for (;;) {
      try {
        await omni(withStills, prompt);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/input blocked|request blocked|safety violation/i.test(message)) throw err;
        // Never rewrite Argon-owned prompts — silent rewriteScene handles filter recovery upstream.
        if (
          !opts.brainOwnedPrompt &&
          /sensitive words|rephras|safety violation/i.test(message) &&
          !rephrased &&
          !opts.preservePrompt
        ) {
          rephrased = true;
          opts.onStatus?.("Omni rejected the wording — rephrasing in neutral production language…");
          prompt = await rephraseVideoInstruction(prompt);
          continue;
        }
        // A single still is judged on its own by the input classifier; the footage it came from carries more context.
        if (hasPlate && withStills) {
          withStills = false;
          opts.onStatus?.("Omni blocked the still inputs — retrying from the supplied footage only…");
          continue;
        }
        throw err;
      }
    }
  }

  const info = await inspectVideoModel(opts.model);
  let allowed = info.durations;
  let duration = snapDuration(opts.duration, allowed);
  const resolution =
    opts.resolution ?? providerResolutionToken(opts.outputResolution ?? "1080p");
  const filterAttempts = Math.max(1, opts.maxFilterAttempts ?? VIDEO_FILTER_RETRIES);
  const prompts = opts.preservePrompt
    ? [opts.prompt.trim()]
    : opts.educationalSoften
      ? [
          sanitizeEducationalVideoPrompt(opts.prompt),
          softenEmptyOutputPrompt(opts.prompt),
          minimalTalkingHeadPrompt(opts.prompt),
        ].slice(0, filterAttempts)
      : [
          `${opts.prompt.trim()}\n\n${VIDEO_SAFETY}`,
          softenVideoPrompt(opts.prompt),
        ].slice(0, filterAttempts);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < prompts.length; attempt++) {
    try {
      opts.onStatus?.(
        attempt === 0
          ? `Submitting to video model…`
          : `Previous submit finished with no usable output — resubmitting prompt ${attempt + 1}/${prompts.length}…`,
      );
      await generateVideoOnceWithCapacityRetry({
        ...opts,
        prompt: prompts[attempt],
        duration,
        allowed,
        resolution,
        outputResolution: opts.outputResolution ?? (resolution === "4K" ? "4K" : "1080p"),
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const parsed = parseDurationsFromError(lastError.message);
      if (parsed.length) {
        learnedDurations.set(opts.model, parsed);
        allowed = parsed;
        duration = snapDuration(opts.duration, allowed);
      }
      if (!isVideoFilterError(lastError.message) && !parsed.length) throw lastError;
      if (attempt < prompts.length - 1) {
        console.warn(`[video] attempt ${attempt + 1} filtered or empty, retrying with next prompt`);
        opts.onStatus?.(
          `Video finished but returned no usable file (${lastError.message.slice(0, 120)}). Trying alternate prompt ${attempt + 2}/${prompts.length}…`,
        );
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  throw lastError ?? new Error("Video generation failed");
}

async function generateVideoOnceWithCapacityRetry(
  opts: Parameters<typeof generateVideoOnce>[0] & {
    onStatus?: (msg: string) => void;
    persistOnCapacity?: boolean;
  },
): Promise<void> {
  let lastError: Error | null = null;
  const finiteTries = VIDEO_CAPACITY_BACKOFF_MS.length + 1;
  const maxTries = opts.persistOnCapacity
    ? VIDEO_CAPACITY_BACKOFF_MS.length + VIDEO_CAPACITY_PERSIST_MAX + 1
    : finiteTries;
  for (let i = 0; i < maxTries; i++) {
    try {
      await generateVideoOnce(opts);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Timeouts / failed jobs must not look like "keep trying forever".
      if (/timed out after/i.test(lastError.message)) break;
      if (!isVideoCapacityError(lastError.message)) break;
      if (i >= maxTries - 1) break;

      const withinFinite = i < VIDEO_CAPACITY_BACKOFF_MS.length;
      const wait = withinFinite
        ? (VIDEO_CAPACITY_BACKOFF_MS[i] ?? VIDEO_CAPACITY_PERSIST_MS)
        : VIDEO_CAPACITY_PERSIST_MS;
      const waitSec = Math.round(wait / 1000);
      const attemptLabel = `${i + 2}/${maxTries}`;
      console.warn(`[video] overloaded, retry ${attemptLabel} in ${waitSec}s`);
      opts.onStatus?.(
        `Video service is overloaded. Waiting ${waitSec}s, then submitting again (${attemptLabel}).`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const detail = lastError?.message ?? "unknown error";
  if (!lastError || !isVideoCapacityError(detail)) {
    throw lastError ?? new Error("Video generation failed");
  }
  throw new Error(
    `${detail} The video provider was overloaded after ${maxTries} submit attempt(s). Retry this stage later — each accepted job may still be billed even if it later fails.`,
  );
}

function videoDataUrl(filePath: string): string {
  const st = fs.statSync(filePath);
  // data: URLs balloon ~1.33× — refuse anything that would OOM the worker.
  if (st.size > 24 * 1024 * 1024) {
    throw new Error(
      `Refusing data: video URL for ${path.basename(filePath)} (${(st.size / 1e6).toFixed(1)} MB). Use HTTPS upload.`,
    );
  }
  const buf = fs.readFileSync(filePath);
  return `data:video/mp4;base64,${buf.toString("base64")}`;
}

/**
 * V2V models need an HTTPS video_url (data: URLs are rejected).
 * Prefer short-lived hosts; fall back to Catbox when Litterbox/0x0 are down.
 * Streams from disk via openAsBlob — never buffers the whole file into a Buffer.
 */
async function uploadTempHttpsVideo(filePath: string): Promise<string> {
  const { openAsBlob } = await import("node:fs");
  const name = path.basename(filePath) || "clip.mp4";
  const fileBlob = await openAsBlob(filePath, { type: "video/mp4" });
  const blob = () => fileBlob;

  const attempts: Array<{ label: string; run: () => Promise<string> }> = [
    {
      label: "tmpfiles",
      run: async () => {
        const form = new FormData();
        form.append("file", blob(), name);
        form.append("expire", "3600"); // 1 hour
        const res = await fetch("https://tmpfiles.org/api/v1/upload", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
        let pageUrl = "";
        try {
          const json = JSON.parse(text) as { data?: { url?: string }; status?: string };
          pageUrl = json.data?.url?.trim() ?? "";
        } catch {
          pageUrl = "";
        }
        if (!pageUrl.startsWith("https://")) throw new Error(text.slice(0, 200));
        // API returns a landing page URL; providers need the direct /dl/ binary URL.
        const page = await fetch(pageUrl, { signal: AbortSignal.timeout(60_000) });
        const html = await page.text();
        const dl = html.match(/href="(https:\/\/tmpfiles\.org\/dl\/[^"]+)"/i)?.[1];
        if (!dl) throw new Error(`no download link in page for ${pageUrl}`);
        return dl;
      },
    },
    {
      label: "catbox",
      run: async () => {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("fileToUpload", blob(), name);
        const res = await fetch("https://catbox.moe/user/api.php", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
        const text = (await res.text()).trim();
        const url = text.split(/\s+/).find((t) => t.startsWith("https://"));
        if (!res.ok || !url) throw new Error(`${res.status} ${text.slice(0, 200)}`);
        return url;
      },
    },
    {
      label: "litterbox",
      run: async () => {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("time", "1h");
        form.append("fileToUpload", blob(), name);
        const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
        const text = (await res.text()).trim();
        const url = text.split(/\s+/).find((t) => t.startsWith("https://"));
        if (!res.ok || !url) throw new Error(`${res.status} ${text.slice(0, 200)}`);
        return url;
      },
    },
    {
      label: "0x0.st",
      run: async () => {
        const form = new FormData();
        form.append("file", blob(), name);
        form.append("expires", "1");
        form.append("secret", "");
        const res = await fetch("https://0x0.st", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
        const text = (await res.text()).trim();
        const url = text.split(/\s+/).find((t) => t.startsWith("https://"));
        if (!res.ok || !url) throw new Error(`${res.status} ${text.slice(0, 200)}`);
        return url;
      },
    },
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const url = await attempt.run();
      console.info(`[video] uploaded edit source via ${attempt.label}: ${url}`);
      return url;
    } catch (err) {
      errors.push(`${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Could not publish the source clip as an HTTPS URL for video edit. ${errors.join(" | ")}. Providers reject local/base64 video.`,
  );
}

function applyVideoSource(body: Record<string, unknown>, httpsUrl: string): void {
  body.input_references = [{ type: "video_url", video_url: { url: httpsUrl } }];
}

async function buildOperatorInputReferences(opts: {
  imagePaths?: string[];
  videoPaths?: string[];
  audioPaths?: string[];
  allowVideoAudioUrls: boolean;
  onStatus?: (msg: string) => void;
}): Promise<Array<Record<string, unknown>>> {
  const refs: Array<Record<string, unknown>> = [];
  for (const p of opts.imagePaths ?? []) {
    if (!fs.existsSync(p)) continue;
    refs.push({ type: "image_url", image_url: { url: fileToDataUrl(p) } });
  }
  if (opts.allowVideoAudioUrls) {
    for (const p of opts.videoPaths ?? []) {
      if (!fs.existsSync(p)) continue;
      opts.onStatus?.(`Uploading operator video ref ${path.basename(p)}…`);
      const compressed = `${p}.ref.mp4`;
      await compressVideoForUpload(p, compressed);
      const url = await uploadTempHttpsVideo(compressed);
      refs.push({ type: "video_url", video_url: { url } });
    }
    for (const p of opts.audioPaths ?? []) {
      if (!fs.existsSync(p)) continue;
      opts.onStatus?.(`Uploading operator audio ref ${path.basename(p)}…`);
      try {
        const url = await uploadTempHttpsAudio(p);
        refs.push({ type: "audio_url", audio_url: { url } });
      } catch (err) {
        console.warn(`[video] audio ref upload failed for ${path.basename(p)}:`, err);
      }
    }
  }
  return refs;
}

async function uploadTempHttpsAudio(filePath: string): Promise<string> {
  const { openAsBlob } = await import("node:fs");
  const name = path.basename(filePath) || "bed.mp3";
  const mime =
    name.toLowerCase().endsWith(".wav")
      ? "audio/wav"
      : name.toLowerCase().endsWith(".m4a")
        ? "audio/mp4"
        : "audio/mpeg";
  const fileBlob = await openAsBlob(filePath, { type: mime });
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", fileBlob, name);
  const res = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const text = (await res.text()).trim();
  const url = text.split(/\s+/).find((t) => t.startsWith("https://"));
  if (!res.ok || !url) throw new Error(`audio upload failed: ${res.status} ${text.slice(0, 200)}`);
  return url;
}

function isAlephModel(model: string): boolean {
  return /aleph/i.test(model);
}

function isSeedance2Model(model: string): boolean {
  return /seedance-2/i.test(model);
}

async function generateVideoOnce(opts: {
  model: string;
  prompt: string;
  aspectRatio: string;
  duration?: number;
  allowed: number[];
  firstFramePath?: string;
  lastFramePath?: string;
  sourceVideoPath?: string;
  referenceImagePaths?: string[];
  referenceVideoPaths?: string[];
  referenceAudioPaths?: string[];
  outPath: string;
  resolution?: string;
  outputResolution?: OutputResolution;
  onStatus?: (msg: string) => void;
}): Promise<void> {
  let duration = opts.duration;
  let allowed = opts.allowed;
  const aspect = providerVideoAspect(opts.aspectRatio);
  const videoResolution = opts.resolution ?? providerResolutionToken(opts.outputResolution ?? "1080p");
  const outputResolution: OutputResolution = opts.outputResolution ?? (videoResolution === "4K" ? "4K" : "1080p");
  const firstFramePath = opts.firstFramePath;
  const lastFramePath = opts.lastFramePath;
  let sourceHttpsUrl: string | undefined;
  let sourceSize: { width: number; height: number } | undefined;
  if (opts.sourceVideoPath) {
    if (!fs.existsSync(opts.sourceVideoPath)) {
      throw new Error(`Source video missing: ${opts.sourceVideoPath}`);
    }
    const srcProbe = await probeFile(opts.sourceVideoPath);
    sourceSize = { width: srcProbe.width, height: srcProbe.height };
    opts.onStatus?.(
      `Preparing source clip for edit (${sourceSize.width}x${sourceSize.height}, compress + HTTPS upload)…`,
    );
    const compressed = `${opts.sourceVideoPath}.v2v.mp4`;
    await compressVideoForUpload(opts.sourceVideoPath, compressed);
    sourceHttpsUrl = await uploadTempHttpsVideo(compressed);
  }

  const operatorRefs = await buildOperatorInputReferences({
    imagePaths: opts.referenceImagePaths,
    videoPaths: opts.referenceVideoPaths,
    audioPaths: opts.referenceAudioPaths,
    // Seedance 2.x honors video/audio refs; Veo Fast schema is image-only — stills cover that path.
    allowVideoAudioUrls: isSeedance2Model(opts.model),
    onStatus: opts.onStatus,
  });

  async function submit(
    dur: number | undefined,
    withAudio: boolean,
    omitSize = false,
    includeOperatorRefs = true,
  ) {
    const body: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.prompt,
      aspect_ratio: aspect,
    };
    // V2V: Aleph often ignores aspect and returns ~half-res on 9:16 — request exact size.
    // Seedance 2.x uses catalog resolutions; we scale back to the source pixels after download.
    if (sourceHttpsUrl && sourceSize) {
      if (isAlephModel(opts.model) && !omitSize) {
        body.size = `${sourceSize.width}x${sourceSize.height}`;
      } else if (isSeedance2Model(opts.model)) {
        body.resolution = videoResolution;
      }
    } else if (!opts.sourceVideoPath) {
      body.resolution = videoResolution;
    }
    if (withAudio) body.generate_audio = true;
    // Seedance 2.x V2V honors duration; Aleph follows the source clip length.
    if (dur && (!opts.sourceVideoPath || isSeedance2Model(opts.model))) body.duration = dur;
    if (sourceHttpsUrl) {
      applyVideoSource(body, sourceHttpsUrl);
    } else if (firstFramePath) {
      const frames: Array<Record<string, unknown>> = [
        {
          type: "image_url",
          image_url: { url: fileToDataUrl(firstFramePath) },
          frame_type: "first_frame",
        },
      ];
      if (lastFramePath && fs.existsSync(lastFramePath)) {
        frames.push({
          type: "image_url",
          image_url: { url: fileToDataUrl(lastFramePath) },
          frame_type: "last_frame",
        });
      }
      body.frame_images = frames;
      // Also attach operator brand/style refs. Some providers drop these when frame_images
      // is set; we retry without them on 400 below.
      if (includeOperatorRefs && operatorRefs.length) {
        body.input_references = operatorRefs;
      }
    } else if (includeOperatorRefs && operatorRefs.length) {
      body.input_references = operatorRefs;
    }
    return orJson<{ id?: string; polling_url?: string; status?: string }>("/videos", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Aleph has no audio SKU; Seedance 2.x V2V should keep diegetic audio.
  let withAudio = !isAlephModel(opts.model);
  let submitted: { id?: string; polling_url?: string; status?: string } | undefined;
  let lastSubmitError: Error | null = null;
  try {
    submitted = await submit(duration, withAudio);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastSubmitError = err instanceof Error ? err : new Error(msg);
    const parsed = parseDurationsFromError(msg);
    if (parsed.length) {
      learnedDurations.set(opts.model, parsed);
      allowed = parsed;
      duration = snapDuration(opts.duration, allowed);
      try {
        submitted = await submit(duration, withAudio);
        lastSubmitError = null;
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        lastSubmitError = err2 instanceof Error ? err2 : new Error(msg2);
        if (/audio/i.test(msg2) && withAudio) {
          withAudio = false;
          submitted = await submit(duration, false);
          lastSubmitError = null;
        }
      }
    } else if (/audio/i.test(msg) && withAudio) {
      withAudio = false;
      try {
        submitted = await submit(duration, false);
        lastSubmitError = null;
      } catch (err2) {
        lastSubmitError = err2 instanceof Error ? err2 : new Error(String(err2));
      }
    } else if (
      operatorRefs.length &&
      (/input_reference|reference|400/i.test(msg) || /unsupported|unknown field/i.test(msg))
    ) {
      console.warn(`[video] operator refs rejected, retrying without them: ${msg.slice(0, 200)}`);
      try {
        submitted = await submit(duration, withAudio, false, false);
        lastSubmitError = null;
      } catch (err2) {
        lastSubmitError = err2 instanceof Error ? err2 : new Error(String(err2));
      }
    } else if (/size|dimension|WIDTHxHEIGHT/i.test(msg) && sourceSize && isAlephModel(opts.model)) {
      // Post-download scale still restores source geometry.
      try {
        submitted = await submit(duration, withAudio, true);
        lastSubmitError = null;
      } catch (err2) {
        lastSubmitError = err2 instanceof Error ? err2 : new Error(String(err2));
      }
    }
  }
  if (!submitted) throw lastSubmitError ?? new Error("Video submit failed");

  const jobId = submitted.id;
  if (!jobId) throw new Error("OpenRouter video submit returned no job id");
  const pollUrl = submitted.polling_url ?? `/videos/${jobId}`;
  const started = Date.now();
  let status = submitted.status ?? "pending";
  opts.onStatus?.(`Submitted to the video model (${jobId.slice(0, 8)}…). Waiting for frames.`);
  while (status === "pending" || status === "in_progress") {
    if (Date.now() - started > 20 * 60 * 1000) {
      throw new Error(`Video job ${jobId} timed out after 20 minutes`);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    opts.onStatus?.(`Video model ${status.replace(/_/g, " ")}… ${elapsed}s elapsed. This often takes 5–15 minutes per take.`);
    await new Promise((r) => setTimeout(r, 5000));
    const polled = await orJson<{ status?: string; error?: string; unsigned_urls?: string[] }>(pollUrl);
    status = polled.status ?? "pending";
    if (status === "failed" || status === "cancelled" || status === "expired") {
      throw new Error(`Video job ${jobId} ${status}: ${polled.error ?? "no detail"}`);
    }
    if (status === "completed") break;
  }
  opts.onStatus?.("Downloading the finished clip…");
  const contentRes = await orFetch(`/videos/${jobId}/content?index=0`);
  if (!contentRes.ok) {
    const t = await contentRes.text();
    throw new Error(
      /filter|no output|safety/i.test(t)
        ? `Video job ${jobId} failed: Video generation completed with no output (content may have been filtered)`
        : `Failed to download video ${jobId}: ${t.slice(0, 400)}`,
    );
  }
  const buf = Buffer.from(await contentRes.arrayBuffer());
  if (buf.length < 2048) {
    throw new Error(`Video job ${jobId} failed: Video generation completed with no output (content may have been filtered)`);
  }
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, buf);
  if (opts.aspectRatio === "2.35:1") {
    const raw = `${opts.outPath}.ultrawide.mp4`;
    fs.renameSync(opts.outPath, raw);
    await cropVideoToCinemascope(raw, opts.outPath, outputResolution);
    fs.rmSync(raw, { force: true });
  }
  if (sourceSize) {
    const outProbe = await probeFile(opts.outPath);
    if (outProbe.width !== sourceSize.width || outProbe.height !== sourceSize.height) {
      opts.onStatus?.(
        `Edit came back ${outProbe.width}x${outProbe.height}; scaling to source ${sourceSize.width}x${sourceSize.height}…`,
      );
      const raw = `${opts.outPath}.rawsize.mp4`;
      fs.renameSync(opts.outPath, raw);
      await scaleVideoToSize(raw, opts.outPath, sourceSize.width, sourceSize.height);
      fs.rmSync(raw, { force: true });
    }
  }
}

export async function inspectVideoModel(slug: string): Promise<{
  raw: Record<string, unknown> | undefined;
  durations: number[];
  supports1080p: boolean | null;
  supportsI2v: boolean | null;
}> {
  if (isOmniModel(slug)) {
    return {
      raw: {
        id: slug,
        name: "Gemini Omni 1.1 Flash",
        provider: "google-direct",
      },
      durations: [...OMNI_DURATIONS],
      supports1080p: true,
      supportsI2v: true,
    };
  }
  const rawList = await listVideoModels();
  const raw = findModel(rawList, slug);
  const fromCatalog = modelDurations(raw);
  const learned = learnedDurations.get(slug) ?? [];
  return {
    raw,
    durations: fromCatalog.length ? fromCatalog : learned,
    supports1080p: modelSupports1080p(raw),
    supportsI2v: modelSupportsFrameImages(raw),
  };
}
