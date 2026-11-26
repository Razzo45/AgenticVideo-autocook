/**
 * Autocook brain — Gemini 4 (Argon or Carbon) via GEMINI_API_KEY only.
 * Used for storyboard, audio extract, EDL refine, and input vision cataloguing.
 * Document cooks may use brainWithTools (image/video/SVG) like gemini.google.com.
 */
import fs from "node:fs";
import path from "node:path";
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { BRAIN_MODEL } from "./constants";
import { brainLabel } from "./brainChoice";
import { currentGeminiOwnerId, withGeminiAdmission } from "./geminiAdmission";
import { DELIVERABLE_CONTINUATIONS, DELIVERABLE_MAX_OUTPUT_TOKENS, INTERRUPTED_FINISH } from "./deliverableReceive";
import { assembleSvgHops, guidedSvgMissText, svgDocument, type SvgHopPart } from "./svgHops";
import { logStage } from "./stageLog";
import { stagedMarkupNote } from "./stagedMarkup";
import {
  BRAIN_CALL_TIMEOUT_MS,
  BRAIN_ROUND_TIMEOUT_MS,
  BRAIN_STREAM_IDLE_MS,
  BRAIN_STREAM_TIMEOUT_MS,
  PlatformFaultError,
  getRunSignal,
  isCancelledError,
  isPlatformFaultError,
  withDeadline,
  withStatusHeartbeat,
} from "./runControl";

function brainCallSignal(): AbortSignal | undefined {
  const owner = currentGeminiOwnerId();
  return owner ? getRunSignal(owner) : undefined;
}

async function generateContentBounded<T>(
  label: string,
  work: () => Promise<T>,
  onStatus?: (msg: string) => void,
): Promise<T> {
  return withGeminiAdmission(
    "brain",
    () =>
      withDeadline(work(), {
        timeoutMs: BRAIN_ROUND_TIMEOUT_MS,
        label,
        signal: brainCallSignal(),
        onStatus,
      }),
    { onStatus },
  );
}

export type BrainMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

const STAGED_MARKUP_TOOLS = new Set(["write_html", "write_svg"]);
const STAGED_MARKUP_SCRUB_CHARS = 400;

/**
 * After write_html / write_svg succeed, the full markup sits in the functionCall
 * args and would be re-sent every later round — that blows the context and hangs
 * round 2+. Keep a short stub; the platform already staged the bytes on disk.
 */
function scrubStagedMarkupArgs(parts: Part[]): Part[] {
  return parts.map((part) => {
    const call = (part as { functionCall?: { name?: string; args?: Record<string, unknown>; id?: string } })
      .functionCall;
    if (!call?.name || !STAGED_MARKUP_TOOLS.has(call.name) || !call.args) return part;
    const args = { ...call.args };
    for (const key of ["html", "svg"] as const) {
      const value = args[key];
      if (typeof value !== "string" || value.length <= STAGED_MARKUP_SCRUB_CHARS) continue;
      args[key] = stagedMarkupNote(call.name === "write_html" ? "write_html" : "write_svg", value.length);
    }
    return {
      functionCall: {
        name: call.name,
        id: call.id,
        args,
      },
    } as Part;
  });
}

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env (Google AI Studio key) for the autocook brain.",
    );
  }
  return key;
}

function brainClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireGeminiKey() });
}

function dataUrlToInline(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  return { mimeType: m[1]!, data: m[2]! };
}

function flattenMessages(messages: BrainMessage[]): {
  system?: string;
  parts: Array<Record<string, unknown>>;
} {
  const systemBits: string[] = [];
  const parts: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemBits.push(msg.content);
      continue;
    }
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "image_url") {
        const inline = dataUrlToInline(block.image_url.url);
        if (inline) {
          parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
        } else if (fs.existsSync(block.image_url.url)) {
          const buf = fs.readFileSync(block.image_url.url);
          const ext = block.image_url.url.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
          parts.push({ inlineData: { mimeType: ext, data: buf.toString("base64") } });
        }
      }
    }
  }
  return { system: systemBits.length ? systemBits.join("\n\n") : undefined, parts };
}

export type BrainUsage = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

export type BrainText = {
  text: string;
  /**
   * Gemini finishReason. MAX_TOKENS means the reply stopped because the output budget ran out.
   * INTERRUPTED means the stream dropped or stalled after text had arrived; the text is what arrived.
   */
  finishReason?: string;
  usage?: BrainUsage;
};

type StreamChunk = {
  text?: string;
  candidates?: Array<{ finishReason?: unknown; content?: { parts?: SvgHopPart[] } }>;
  usageMetadata?: BrainUsage;
};

/** How long one streamed document may run: one hop of silence, then this many hops in all. */
export function streamedDocumentBudget(): { totalMs: number; silentMs: number } {
  return {
    totalMs: BRAIN_STREAM_TIMEOUT_MS * DELIVERABLE_CONTINUATIONS,
    silentMs: BRAIN_STREAM_TIMEOUT_MS,
  };
}

/** Streaming is the default. BRAIN_STREAM=0 goes back to one unary request per call. */
export function brainStreamEnabled(): boolean {
  const raw = (process.env.BRAIN_STREAM ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/**
 * Receive one streamed reply.
 *
 * - Text is kept as it arrives. If the stream then drops, stalls, or runs out of
 *   time, what arrived is returned with finishReason INTERRUPTED, so the caller
 *   continues that text. It is not thrown away and written again.
 * - Nothing arrived and the stream failed: the error is thrown (admission may retry).
 * - The run was cancelled: the cancel reason is thrown.
 */
export async function consumeBrainStream(opts: {
  open: (signal: AbortSignal) => Promise<AsyncIterable<StreamChunk>>;
  label: string;
  runSignal?: AbortSignal;
  onStatus?: (msg: string) => void;
  totalMs?: number;
  idleMs?: number;
  /** False: a broken stream is an error even when text arrived (the caller cannot continue it). */
  keepPartial?: boolean;
  /**
   * No bytes yet. Defaults to totalMs, so a short test cap still fails a silent call.
   * A multi-hop document sets this to one hop and totalMs to the whole document.
   */
  silentMs?: number;
  /** Bytes already gathered outside chunk.text (a write_svg argument streaming in parts). */
  extraProgress?: () => number;
  onChunk?: (chunk: StreamChunk) => void;
  /** Test hooks. */
  tickMs?: number;
  graceMs?: number;
}): Promise<BrainText> {
  const totalMs = opts.totalMs ?? BRAIN_STREAM_TIMEOUT_MS;
  const silentMs = opts.silentMs ?? totalMs;
  const idleMs = opts.idleMs ?? BRAIN_STREAM_IDLE_MS;
  const cancelled = () =>
    opts.runSignal?.reason instanceof Error ? opts.runSignal.reason : new PlatformFaultError(`${opts.label} aborted`);
  if (opts.runSignal?.aborted) throw cancelled();

  const ctl = new AbortController();
  const started = Date.now();
  let text = "";
  let finish: string | undefined;
  let usage: BrainUsage | undefined;
  let lastChunk = started;
  let lastBeat = started;
  let stalled: string | null = null;
  let hardStop: (err: Error) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    hardStop = reject;
  });
  stopped.catch(() => undefined);
  // The SDK should end the request on abort. If it does not, stop waiting anyway.
  const giveUp = (why: string) => {
    if (stalled) return;
    stalled = why;
    ctl.abort();
    setTimeout(() => hardStop(new Error(why)), opts.graceMs ?? 15_000).unref?.();
  };
  const onRunAbort = () => giveUp("cancelled");
  opts.runSignal?.addEventListener("abort", onRunAbort, { once: true });
  const progressed = () => text.length + (opts.extraProgress?.() ?? 0);
  const watchdog = setInterval(() => {
    const now = Date.now();
    const chars = progressed();
    if (!chars && now - started > silentMs) giveUp(`timed out after ${Math.round(silentMs / 1000)}s`);
    else if (now - started > totalMs) giveUp(`timed out after ${Math.round(totalMs / 1000)}s`);
    else if (chars && now - lastChunk > idleMs) giveUp(`stalled: no output for ${Math.round(idleMs / 1000)}s`);
    else if (opts.onStatus && now - lastBeat >= 20_000) {
      lastBeat = now;
      const sec = Math.round((now - started) / 1000);
      opts.onStatus(
        chars ? `${opts.label} (writing, ${chars} characters, ${sec}s)…` : `${opts.label} (thinking, ${sec}s)…`,
      );
    }
  }, opts.tickMs ?? 5_000);

  const consume = async () => {
    const stream = await opts.open(ctl.signal);
    for await (const chunk of stream) {
      lastChunk = Date.now();
      opts.onChunk?.(chunk);
      const piece = chunk.text;
      if (piece) text += piece;
      const reason = chunk.candidates?.[0]?.finishReason;
      if (reason) finish = String(reason);
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
  };

  try {
    await Promise.race([consume(), stopped]);
    return { text, finishReason: finish, usage };
  } catch (err) {
    if (opts.runSignal?.aborted) throw cancelled();
    if ((text.trim() || (opts.extraProgress?.() ?? 0) > 0) && opts.keepPartial !== false) {
      const why = stalled ?? (err instanceof Error ? err.message : String(err));
      console.warn(`[brain] ${opts.label} interrupted after ${text.length} chars (${why.slice(0, 200)}) — keeping the text`);
      return { text, finishReason: INTERRUPTED_FINISH, usage };
    }
    if (stalled) throw new PlatformFaultError(`${opts.label} ${stalled}`);
    throw err;
  } finally {
    clearInterval(watchdog);
    opts.runSignal?.removeEventListener("abort", onRunAbort);
    if (!ctl.signal.aborted) ctl.abort();
  }
}

export type BrainCompletionOpts = {
  model?: string;
  messages: BrainMessage[];
  json?: boolean;
  /** Cap the reply. Gemini's sync default is 65536; composition needs the full document. */
  maxOutputTokens?: number;
  /**
   * Defaults to medium. Argon and Carbon reject MINIMAL.
   * An unsupported level is retried once at medium.
   */
  thinkingLevel?: ThinkingLevel;
  /** Operator turn, including attached files. When set, message text parts are not used. */
  userParts?: Part[];
  /**
   * Cut-off continuation. This text is the model's own previous turn.
   * followUp is the only new user text. userParts stay the original operator turn.
   */
  priorModelText?: string;
  followUp?: string;
  onStatus?: (msg: string) => void;
  /** Status line for this call. Defaults to the generic writing line. */
  activity?: string;
  /**
   * The caller can continue a partial reply (deliverable JSON). A stream that breaks
   * after text arrived then returns that text with finishReason INTERRUPTED.
   * Otherwise a broken stream is an error and admission may retry the call.
   */
  continuable?: boolean;
  /**
   * Name of a context cache holding the shared system instruction and the operator's
   * files. userParts are then only this call's own text. System messages are ignored:
   * the instruction is already in the cache.
   */
  cachedContent?: string;
};

/** Argon and Carbon answer 400 when asked for a thinking level they do not implement. */
export function isUnsupportedThinkingLevel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /thinking level/i.test(message) && /not supported/i.test(message);
}

/** Text reply plus the reason the model stopped. Empty text is returned; callers decide what that means. */
export async function brainCompletionText(opts: BrainCompletionOpts): Promise<BrainText> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const { system, parts } = flattenMessages(opts.messages);
  const userParts = opts.userParts?.length ? opts.userParts : (parts as Part[]);
  if (!userParts.length) throw new Error("brainCompletion: empty user content");
  const prior = opts.priorModelText ?? "";
  const followUp =
    opts.followUp?.trim() ||
    "Continue from the exact last character of your previous message. Output only the missing characters.";
  const contents: Content[] = prior
    ? [
        { role: "user", parts: userParts },
        { role: "model", parts: [{ text: prior }] },
        { role: "user", parts: [{ text: followUp }] },
      ]
    : [{ role: "user", parts: userParts }];
  const label = opts.activity?.trim() || `${brainLabel(model)} is writing the deliverables`;
  opts.onStatus?.(`${label}…`);

  const requested = opts.thinkingLevel ?? ThinkingLevel.MEDIUM;
  const owner = currentGeminiOwnerId() ?? "-";
  const stream = brainStreamEnabled();
  const configFor = (thinkingLevel: ThinkingLevel) => ({
    ...(opts.cachedContent ? { cachedContent: opts.cachedContent } : system ? { systemInstruction: system } : {}),
    ...(opts.json ? { responseMimeType: "application/json" } : {}),
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    thinkingConfig: { thinkingLevel },
  });

  /** One request. Streamed: text is kept as it arrives. Unary: one bounded wait. */
  const callOnce = async (thinkingLevel: ThinkingLevel): Promise<BrainText> => {
    if (stream) {
      return consumeBrainStream({
        label,
        runSignal: brainCallSignal(),
        onStatus: opts.onStatus,
        keepPartial: Boolean(opts.continuable),
        ...streamedDocumentBudget(),
        open: (signal) =>
          ai.models.generateContentStream({
            model,
            contents,
            config: { ...configFor(thinkingLevel), abortSignal: signal },
          }) as Promise<AsyncIterable<StreamChunk>>,
      });
    }
    // The deadline sits past Gemini's own 10 minute unary bound. Our own deadline is a
    // platform fault: admission does not retry it, so the document is not rewritten in a loop.
    const result = await withDeadline(
      withStatusHeartbeat(
        ai.models.generateContent({
          model,
          contents,
          config: { ...configFor(thinkingLevel), abortSignal: brainCallSignal() },
        }),
        { label, onStatus: opts.onStatus, signal: brainCallSignal() },
      ),
      { timeoutMs: BRAIN_CALL_TIMEOUT_MS, label, signal: brainCallSignal() },
    );
    const finish = result.candidates?.[0]?.finishReason;
    return {
      text: result.text ?? "",
      finishReason: finish ? String(finish) : undefined,
      usage: result.usageMetadata as BrainUsage | undefined,
    };
  };

  let attempt = 0;
  const generate = (thinkingLevel: ThinkingLevel) =>
    withGeminiAdmission(
      "brain",
      async () => {
        attempt += 1;
        const started = Date.now();
        try {
          const got = await callOnce(thinkingLevel);
          logStage(owner, `gemini ${label}`, Date.now() - started, {
            model,
            attempt,
            mode: stream ? "stream" : "unary",
            cache: opts.cachedContent ? "on" : undefined,
            chars: got.text.length,
            finish: got.finishReason,
            in: got.usage?.promptTokenCount,
            cached: got.usage?.cachedContentTokenCount,
            out: got.usage?.candidatesTokenCount,
            thoughts: got.usage?.thoughtsTokenCount,
          });
          return got;
        } catch (err) {
          logStage(owner, `gemini ${label}`, Date.now() - started, {
            model,
            attempt,
            mode: stream ? "stream" : "unary",
            failed: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
      { onStatus: opts.onStatus },
    );

  try {
    return await generate(requested);
  } catch (err) {
    if (requested === ThinkingLevel.MEDIUM || !isUnsupportedThinkingLevel(err)) throw err;
    opts.onStatus?.(`${label} — ${requested} thinking is not supported, retrying at medium…`);
    return generate(ThinkingLevel.MEDIUM);
  }
}

/** Text (optional JSON) completion via the selected brain. */
export async function brainCompletion(opts: BrainCompletionOpts): Promise<string> {
  const got = await brainCompletionText(opts);
  // Callers of this helper want one whole reply. Only the deliverable path continues a partial one.
  if (got.finishReason === INTERRUPTED_FINISH) {
    const model = opts.model?.trim() || BRAIN_MODEL;
    throw new PlatformFaultError(`${brainLabel(model)} brain (${model}) reply was interrupted before it finished`);
  }
  const text = got.text.trim();
  if (!text) {
    const model = opts.model?.trim() || BRAIN_MODEL;
    throw new Error(`${brainLabel(model)} brain (${model}) returned no content`);
  }
  return text;
}

/** Vision cataloguing via the brain (replaces OpenRouter visionCompletion for brain tasks). */
export async function brainVisionCompletion(opts: {
  model?: string;
  system?: string;
  text: string;
  imageDataUrls: string[];
}): Promise<string> {
  const messages: BrainMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({
    role: "user",
    content: [
      { type: "text", text: opts.text },
      ...opts.imageDataUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ],
  });
  return brainCompletion({ model: opts.model, messages, json: false });
}

export type BrainToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Multi-turn brain completion with function tools (media generate/inline).
 * Returns the final text (expected JSON plan) after tools finish.
 */
export async function brainWithTools(opts: {
  model?: string;
  system: string;
  user: string;
  /** When set, this is the operator turn (text plus attached files). `user` is ignored. */
  userParts?: Part[];
  tools: FunctionDeclaration[];
  onTool: BrainToolHandler;
  maxRounds?: number;
  onStatus?: (msg: string) => void;
}): Promise<string> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const label = brainLabel(model);
  const maxRounds = opts.maxRounds ?? 16;

  const contents: Content[] = [
    { role: "user", parts: opts.userParts?.length ? opts.userParts : [{ text: opts.user }] },
  ];
  let emptyStreak = 0;

  for (let round = 0; round < maxRounds; round++) {
    opts.onStatus?.(`${label} tool round ${round + 1}/${maxRounds}…`);
    const roundLabel = `${label} tool round ${round + 1}/${maxRounds}`;
    const callRound = () =>
      generateContentBounded(
        roundLabel,
        () =>
          ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: opts.system,
              tools: [{ functionDeclarations: opts.tools }],
              thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            },
          }),
        opts.onStatus,
      );
    let result;
    try {
      result = await callRound();
    } catch (err) {
      // One retry on a hung/timed-out brain round — same as the composition mistake pingback.
      if (isCancelledError(err)) throw err;
      const timedOut =
        isPlatformFaultError(err) && /timed out/i.test(err instanceof Error ? err.message : String(err));
      if (!timedOut) throw err;
      opts.onStatus?.(`${roundLabel} timed out — one retry…`);
      result = await callRound();
    }

    const calls = result.functionCalls ?? [];
    const modelParts: Part[] = [];
    const candidateParts = result.candidates?.[0]?.content?.parts ?? [];
    if (candidateParts.length) {
      for (const p of candidateParts) modelParts.push(p as Part);
    } else if (calls.length) {
      for (const fc of calls) {
        modelParts.push({
          functionCall: { name: fc.name, args: fc.args ?? {}, id: fc.id },
        } as Part);
      }
    }

    if (!calls.length) {
      const text = (result.text ?? "").trim();
      if (text) return text;
      emptyStreak += 1;
      if (emptyStreak >= 3) {
        throw new Error(`${label} brain (${model}) returned no content after tools`);
      }
      contents.push({
        role: "user",
        parts: [
          {
            text: "Your previous reply was empty. Call write_svg if the markup is large, or reply with the JSON object only. Do not return an empty message.",
          },
        ],
      });
      continue;
    }

    emptyStreak = 0;
    contents.push({ role: "model", parts: modelParts });

    const responseParts: Part[] = [];
    let scrubMarkup = false;
    for (const fc of calls) {
      const name = fc.name ?? "";
      const args = (fc.args ?? {}) as Record<string, unknown>;
      opts.onStatus?.(`Executing tool ${name}…`);
      let response: Record<string, unknown>;
      try {
        response = await opts.onTool(name, args);
        if (STAGED_MARKUP_TOOLS.has(name) && response.ok !== false) scrubMarkup = true;
      } catch (err) {
        // Cancel / platform timeout → stop the cook. Tool contract mistakes → one pingback.
        if (isCancelledError(err) || isPlatformFaultError(err)) throw err;
        response = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      responseParts.push({
        functionResponse: {
          name,
          id: fc.id,
          response,
        },
      } as Part);
    }
    contents.push({ role: "user", parts: responseParts });
    // Drop staged markup from prior model turns so the next round stays thin.
    if (scrubMarkup) {
      for (let i = 0; i < contents.length; i++) {
        const turn = contents[i];
        if (turn?.role !== "model" || !turn.parts?.length) continue;
        contents[i] = { role: "model", parts: scrubStagedMarkupArgs(turn.parts) };
      }
    }
  }

  throw new Error(`${label} tool loop exceeded ${maxRounds} rounds without a final plan`);
}

export type GuidedSvgTarget = { id: string; filename: string; note?: string };

function writeSvgMatchesTarget(
  args: Record<string, unknown>,
  target: GuidedSvgTarget,
): boolean {
  const id = String(args.id ?? "").trim();
  const filename = String(args.filename ?? "").trim();
  return (
    id === target.id ||
    filename === target.filename ||
    filename.endsWith(target.filename) ||
    path.basename(filename) === path.basename(target.filename)
  );
}

function hopParts(chunk: StreamChunk): SvgHopPart[] {
  return chunk.candidates?.[0]?.content?.parts ?? [];
}

function svgChars(parts: SvgHopPart[]): number {
  let n = 0;
  for (const part of parts) {
    if (part.text) n += part.text.length;
    const svg = part.functionCall?.args?.svg;
    if (typeof svg === "string") n += svg.length;
  }
  return n;
}

type SvgCall = { name?: string; args?: Record<string, unknown>; id?: string };

/**
 * One session for multi-SVG tasks: one write_svg per file, then thin JSON.
 * The SVG streams. A hop that ends early is resumed by the API's continuation token
 * and its bytes are appended. write_svg runs once, when the document is complete.
 */
export async function brainGuidedWriteSvgThenJson(opts: {
  model?: string;
  system: string;
  userParts: Part[];
  svgTargets: GuidedSvgTarget[];
  tools: FunctionDeclaration[];
  onTool: BrainToolHandler;
  onStatus?: (msg: string) => void;
  perSvgAttempts?: number;
  /** A document already stored for this file. The model is not asked again. */
  priorSvg?: (target: GuidedSvgTarget) => string | null;
}): Promise<string> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const label = brainLabel(model);
  const perSvgAttempts = opts.perSvgAttempts ?? 4;
  const writeSvgTools = opts.tools.filter((tool) => tool.name === "write_svg");
  if (!writeSvgTools.length) throw new Error("brainGuidedWriteSvgThenJson requires write_svg");

  const contents: Content[] = [{ role: "user", parts: opts.userParts }];
  const system = `${opts.system}

Multi-SVG mode: you will be asked for one write_svg at a time. Never emit all marks in one reply. After every mark is staged, you will return thin JSON with empty svg bodies.`;

  for (let i = 0; i < opts.svgTargets.length; i++) {
    const target = opts.svgTargets[i]!;
    const note = target.note?.trim() ? ` Note: ${target.note.trim()}` : "";
    const prior = opts.priorSvg?.(target)?.trim() ?? "";
    if (svgDocument(prior)) {
      opts.onStatus?.(`${label} write_svg ${i + 1}/${opts.svgTargets.length} reusing ${target.filename}`);
      await opts.onTool("write_svg", { id: target.id, filename: target.filename, svg: prior });
      continue;
    }
    contents.push({
      role: "user",
      parts: [
        {
          text: `Call write_svg exactly once for id="${target.id}" filename="${target.filename}".${note} Put the FULL SVG document in the tool arguments. Do not return the final JSON yet. Only this one file (${i + 1}/${opts.svgTargets.length}).`,
        },
      ],
    });

    let landed = false;
    for (let attempt = 0; attempt < perSvgAttempts; attempt++) {
      const activity = `${label} write_svg ${i + 1}/${opts.svgTargets.length}`;
      opts.onStatus?.(`${activity} (${target.filename})…`);
      const svgConfig = {
        systemInstruction: system,
        tools: [{ functionDeclarations: writeSvgTools }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["write_svg"],
          },
        },
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        // Above one streamed hop. At the default cap Carbon stops with MAX_TOKENS and no
        // continuation token, and the next attempt starts the poster over.
        maxOutputTokens: DELIVERABLE_MAX_OUTPUT_TOKENS * DELIVERABLE_CONTINUATIONS,
      };
      let calls: SvgCall[] = [];
      let modelParts: Part[] = [];
      let gathered: SvgHopPart[] = [];
      if (brainStreamEnabled()) {
        const started = Date.now();
        let got: BrainText;
        try {
          got = await withGeminiAdmission(
            "brain",
            () =>
              consumeBrainStream({
                label: activity,
                runSignal: brainCallSignal(),
                onStatus: opts.onStatus,
                keepPartial: true,
                ...streamedDocumentBudget(),
                extraProgress: () => svgChars(gathered),
                onChunk: (chunk) => {
                  for (const part of hopParts(chunk)) gathered.push(part);
                },
                open: (signal) =>
                  ai.models.generateContentStream({
                    model,
                    contents,
                    config: { ...svgConfig, abortSignal: signal },
                  }) as Promise<AsyncIterable<StreamChunk>>,
              }),
            { onStatus: opts.onStatus },
          );
        } catch (err) {
          if (isCancelledError(err)) throw err;
          const timedOut =
            isPlatformFaultError(err) && /timed out/i.test(err instanceof Error ? err.message : String(err));
          if (timedOut && attempt < perSvgAttempts - 1) {
            contents.push({
              role: "user",
              parts: [{ text: `That try produced no SVG. ${guidedSvgMissText([], target)}` }],
            });
            continue;
          }
          throw err;
        }
        const assembled = assembleSvgHops(gathered);
        logStage(currentGeminiOwnerId() ?? "-", `gemini ${activity}`, Date.now() - started, {
          model,
          mode: "stream",
          chars: assembled?.svg.length ?? svgChars(gathered),
          finish: got.finishReason,
        });
        if (assembled) {
          const args = {
            id: assembled.id || target.id,
            filename: assembled.filename || target.filename,
            svg: assembled.svg,
          };
          calls = [{ name: "write_svg", args }];
          modelParts = [{ functionCall: { name: "write_svg", args } } as Part];
        } else if (got.finishReason === INTERRUPTED_FINISH) {
          throw new PlatformFaultError(`${activity} ended before the SVG document was finished`);
        }
      } else {
        const result = await generateContentBounded(
          activity,
          () => ai.models.generateContent({ model, contents, config: svgConfig }),
          opts.onStatus,
        );
        calls = (result.functionCalls ?? []) as SvgCall[];
        const candidateParts = result.candidates?.[0]?.content?.parts ?? [];
        if (candidateParts.length) {
          for (const p of candidateParts) modelParts.push(p as Part);
        } else {
          for (const fc of calls) {
            modelParts.push({ functionCall: { name: fc.name, args: fc.args ?? {}, id: fc.id } } as Part);
          }
        }
      }

      if (!calls.length) {
        contents.push({
          role: "user",
          parts: [
            {
              text: guidedSvgMissText(gathered, target),
            },
          ],
        });
        continue;
      }

      contents.push({ role: "model", parts: modelParts });
      const responseParts: Part[] = [];
      let scrubMarkup = false;
      for (const fc of calls) {
        const name = fc.name ?? "";
        const args = (fc.args ?? {}) as Record<string, unknown>;
        opts.onStatus?.(`Executing tool ${name}…`);
        let response: Record<string, unknown>;
        try {
          response = await opts.onTool(name, args);
          if (STAGED_MARKUP_TOOLS.has(name) && response.ok !== false) scrubMarkup = true;
        } catch (err) {
          if (isCancelledError(err) || isPlatformFaultError(err)) throw err;
          response = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        responseParts.push({
          functionResponse: { name, id: fc.id, response },
        } as Part);
      }
      contents.push({ role: "user", parts: responseParts });
      if (scrubMarkup) {
        for (let i = 0; i < contents.length; i++) {
          const turn = contents[i];
          if (turn?.role !== "model" || !turn.parts?.length) continue;
          contents[i] = { role: "model", parts: scrubStagedMarkupArgs(turn.parts) };
        }
      }

      const matchedTarget = calls.some(
        (fc) => fc.name === "write_svg" && writeSvgMatchesTarget((fc.args ?? {}) as Record<string, unknown>, target),
      );
      const wroteTarget = responseParts.some((part, index) => {
        const call = calls[index];
        if (!call || call.name !== "write_svg" || !writeSvgMatchesTarget((call.args ?? {}) as Record<string, unknown>, target)) {
          return false;
        }
        const response = (part as { functionResponse?: { response?: { ok?: boolean } } }).functionResponse?.response;
        return response?.ok !== false;
      });
      if (wroteTarget) {
        landed = true;
        break;
      }
      if (!matchedTarget) {
        contents.push({
          role: "user",
          parts: [
            {
              text: `That write_svg was not for id="${target.id}" / "${target.filename}". Call write_svg once for that exact id and filename.`,
            },
          ],
        });
      }
    }
    if (!landed) {
      throw new Error(`${label} did not write_svg for ${target.filename} after ${perSvgAttempts} attempts`);
    }
  }

  contents.push({
    role: "user",
    parts: [
      {
        text: `All SVG marks are staged via write_svg. Reply with the JSON object only — one deliverable per planned file, kind "svg", matching ids and filenames, omit "svg" (or leave it empty). No more tool calls.`,
      },
    ],
  });

  let emptyStreak = 0;
  for (let round = 0; round < 4; round++) {
    opts.onStatus?.(`${label} composing thin SVG JSON…`);
    const result = await generateContentBounded(
      `${label} composing thin SVG JSON`,
      () =>
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            tools: [{ functionDeclarations: writeSvgTools }],
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
            },
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          },
        }),
      opts.onStatus,
    );
    const text = (result.text ?? "").trim();
    if (text) return text;
    emptyStreak += 1;
    if (emptyStreak >= 3) {
      throw new Error(`${label} returned no JSON after staged SVGs`);
    }
    contents.push({
      role: "user",
      parts: [
        {
          text: "Your previous reply was empty. Reply with the JSON object only (thin svg deliverables, no tool calls).",
        },
      ],
    });
  }
  throw new Error(`${label} guided SVG session ended without JSON`);
}

export type GuidedHtmlTarget = { id: string; filename: string; note?: string };
