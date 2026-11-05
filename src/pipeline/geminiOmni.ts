/**
 * Gemini Omni Flash via Google Interactions API (direct GEMINI_API_KEY — not OpenRouter).
 * Model: gemini-omni-1.1-flash. Video refs / edits capped at 10s; max 3 videos per prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, FileState } from "@google/genai";
import type { OutputResolution } from "./constants";
import { compressVideoForUpload, probeFile } from "./stitch";
import { withGeminiAdmission } from "./geminiAdmission";
import { stageLocalPath } from "./geminiStaging";

export const OMNI_PIPELINE_SLUG = "google/gemini-omni-1.1-flash";
export const OMNI_API_MODEL = "gemini-omni-1.1-flash";
export const OMNI_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10] as const;
const OMNI_MAX_VIDEOS = 3;
const OMNI_MAX_VIDEO_SEC = 10;

export function isOmniModel(slug: string): boolean {
  return /gemini-omni/i.test(slug);
}

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env (Google AI Studio key) to use Gemini Omni.");
  }
  return key;
}

function omniClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireGeminiKey() });
}

function omniAspect(aspectRatio: string): "16:9" | "9:16" {
  return aspectRatio.trim() === "9:16" ? "9:16" : "16:9";
}

function omniResolution(token: string | undefined, output?: OutputResolution): "720p" | "1080p" | "4k" {
  const t = (token ?? output ?? "1080p").toString();
  if (/4k/i.test(t)) return "4k";
  if (/720/i.test(t)) return "720p";
  return "1080p";
}

function snapOmniDuration(requested: number | undefined): number {
  const want = requested && Number.isFinite(requested) ? requested : 8;
  let best: number = OMNI_DURATIONS[0];
  let bestDist = Math.abs(want - best);
  for (const d of OMNI_DURATIONS) {
    const dist = Math.abs(want - d);
    if (dist < bestDist || (dist === bestDist && d > best)) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Google's Omni text filter often blocks Veo-oriented safety / identity lines
 * even when they are negations ("no blood", "match faces/ages/bodies").
 */
export function sanitizePromptForOmni(prompt: string): string {
  let p = prompt;
  p = p.replace(/Fictional cinematic\.[^\n]*/gi, "");
  p = p.replace(/No blood[^\n]*/gi, "");
  p = p.replace(/Safer retake:[^\n]*/gi, "");
  p = p.replace(
    /When people appear on screen[\s\S]*?substitute different people\./gi,
    "",
  );
  p = p.replace(
    /Reference footage: match look, location, wardrobe, and people from those plates when the brief uses them\./gi,
    "Reference footage: match the look and setting of the attached plates when the brief uses them.",
  );
  p = p.replace(/trademark image refs/gi, "brand image refs");
  p = p.replace(
    /No UI chrome, watermarks, or metadata overlays unless the brief explicitly requires designed titles\./gi,
    "Keep the real on-screen interface from the reference footage. No watermarks or metadata overlays.",
  );
  p = p.replace(/\b(blood|gore|dismember\w*|decapitat\w*|weapon impact|weapons? striking)\b/gi, "");
  p = p.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return p;
}

/** Trim/re-encode a segment for Omni upload (≤10s). */
export async function trimVideoForOmni(
  src: string,
  dest: string,
  opts?: { startSec?: number; durationSec?: number },
): Promise<void> {
  if (!fs.existsSync(src)) throw new Error(`Omni trim source missing: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const probe = await probeFile(src);
  const start = Math.max(0, opts?.startSec ?? 0);
  const maxDur = Math.min(OMNI_MAX_VIDEO_SEC, opts?.durationSec ?? OMNI_MAX_VIDEO_SEC);
  const available = Math.max(0.5, (probe.duration ?? maxDur) - start);
  const dur = Math.min(maxDur, available);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      start.toFixed(3),
      "-i",
      src,
      "-t",
      dur.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      dest,
    ],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
    throw new Error(`Failed to trim Omni segment from ${path.basename(src)}`);
  }
}

async function waitForFileActive(
  ai: GoogleGenAI,
  name: string,
  onStatus?: (msg: string) => void,
): Promise<{ uri?: string; name?: string; state?: string }> {
  const started = Date.now();
  let file = await ai.files.get({ name });
  while (file.state === FileState.PROCESSING) {
    if (Date.now() - started > 10 * 60 * 1000) {
      throw new Error(`Gemini file ${name} still PROCESSING after 10 minutes`);
    }
    onStatus?.(`Waiting for Gemini file processing (${path.basename(name)})…`);
    await new Promise((r) => setTimeout(r, 4000));
    file = await ai.files.get({ name });
  }
  if (file.state === FileState.FAILED) {
    throw new Error(`Gemini file upload failed: ${name}`);
  }
  return file;
}

async function uploadLocalFile(
  _ai: GoogleGenAI,
  filePath: string,
  mimeType: string,
  onStatus?: (msg: string) => void,
  runId?: string,
): Promise<{ uri: string; name: string }> {
  // GDP-style: stage once per sha256 and reuse URI across scenes / cooks.
  const staged = await stageLocalPath(filePath, mimeType, {
    forceStage: true,
    runId,
    onStatus,
  });
  if (staged.kind !== "uri") throw new Error(`Expected staged URI for ${path.basename(filePath)}`);
  return { uri: staged.data, name: staged.name };
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "video"; uri: string }
  | { type: "image"; uri?: string; data?: string; mime_type?: string };

/** Small stills go inline; larger ones reuse GDP staged Files URI by content hash. */
async function imagePart(
  ai: GoogleGenAI,
  img: string,
  onStatus?: (msg: string) => void,
  onUpload?: (name: string) => void,
  runId?: string,
): Promise<ContentPart> {
  const mime = /\.png$/i.test(img) ? "image/png" : "image/jpeg";
  const staged = await stageLocalPath(img, mime, { runId, onStatus });
  if (staged.kind === "inline") {
    return { type: "image", data: staged.data, mime_type: mime };
  }
  onUpload?.(staged.name);
  return { type: "image", uri: staged.data };
}

function extractVideoBytes(interaction: {
  output_video?: { data?: string };
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }>;
}): Buffer {
  const direct = interaction.output_video?.data;
  if (direct) return Buffer.from(direct, "base64");
  for (const step of interaction.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) {
      if (block.type === "video" && block.data) return Buffer.from(block.data, "base64");
    }
  }
  throw new Error(
    "Gemini Omni returned no video bytes. If you are in EEA/UK/CH, uploaded-video edit may be region-blocked — try I2V/T2V without plate video, or run from a supported region.",
  );
}

export async function generateOmniVideo(opts: {
  prompt: string;
  aspectRatio: string;
  duration?: number;
  firstFramePath?: string;
  lastFramePath?: string;
  sourceVideoPath?: string;
  referenceImagePaths?: string[];
  referenceVideoPaths?: string[];
  referenceVideoStartSec?: number;
  outPath: string;
  resolution?: string;
  outputResolution?: OutputResolution;
  onStatus?: (msg: string) => void;
  /** When true, send the brain's prompt verbatim — no platform modeHint / creative rewrite. */
  brainOwnedPrompt?: boolean;
}): Promise<void> {
  return withGeminiAdmission(
    "omni",
    () => generateOmniVideoAdmitted(opts),
    { onStatus: opts.onStatus, maxAttempts: 4 },
  );
}

async function generateOmniVideoAdmitted(opts: Parameters<typeof generateOmniVideo>[0]): Promise<void> {
  const ai = omniClient();
  const durationSec = snapOmniDuration(opts.duration);
  const aspect = omniAspect(opts.aspectRatio);
  const resolution = omniResolution(opts.resolution, opts.outputResolution);
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  const input: ContentPart[] = [];
  const videoSources: string[] = [];
  if (opts.sourceVideoPath && fs.existsSync(opts.sourceVideoPath)) {
    videoSources.push(opts.sourceVideoPath);
  }
  for (const p of opts.referenceVideoPaths ?? []) {
    if (p && fs.existsSync(p) && !videoSources.includes(p)) videoSources.push(p);
  }

  const tmpDir = path.join(path.dirname(opts.outPath), ".omni_upload");
  fs.mkdirSync(tmpDir, { recursive: true });
  const uploadedVideos: string[] = [];
  // Files API storage is capped (~20GB) — uploads must be released after each clip.
  const uploadedFileNames: string[] = [];

  try {
    for (const src of videoSources.slice(0, OMNI_MAX_VIDEOS)) {
      const trimmed = path.join(tmpDir, `${path.basename(src, path.extname(src))}_omni.mp4`);
      opts.onStatus?.(`Preparing ≤${OMNI_MAX_VIDEO_SEC}s Omni plate from ${path.basename(src)}…`);
      try {
        const srcDur = (await probeFile(src)).duration ?? 0;
        let startSec = Math.max(0, opts.referenceVideoStartSec ?? 0);
        if (srcDur > 0 && startSec > srcDur - 1) startSec = Math.max(0, srcDur - durationSec);
        await trimVideoForOmni(src, trimmed, { startSec, durationSec });
      } catch {
        await compressVideoForUpload(src, trimmed);
      }
      const { uri, name } = await uploadLocalFile(ai, trimmed, "video/mp4", opts.onStatus);
      uploadedVideos.push(uri);
      uploadedFileNames.push(name);
      input.push({ type: "video", uri });
    }

    const imagePaths: string[] = [];
    if (opts.firstFramePath && fs.existsSync(opts.firstFramePath)) imagePaths.push(opts.firstFramePath);
    if (opts.lastFramePath && fs.existsSync(opts.lastFramePath)) imagePaths.push(opts.lastFramePath);
    for (const p of opts.referenceImagePaths ?? []) {
      if (p && fs.existsSync(p) && !imagePaths.includes(p)) imagePaths.push(p);
    }
    // Operator look/grade stills travel with the plate; first/last frames only when there is no video.
    const stillsToSend = uploadedVideos.length
      ? (opts.referenceImagePaths ?? []).filter((p) => p && fs.existsSync(p)).slice(0, 2)
      : imagePaths.slice(0, 3);
    for (const img of stillsToSend) {
      input.push(await imagePart(ai, img, opts.onStatus, (n) => uploadedFileNames.push(n)));
    }

    // Argon-owned takes: the brain wrote the full instruction — do not prepend platform creative wrappers.
    // Transport-only: API response_format already carries duration / aspect / resolution.
    let textPayload: string;
    if (opts.brainOwnedPrompt) {
      textPayload = opts.prompt.trim();
      if (textPayload.length > 6000) textPayload = textPayload.slice(0, 6000);
    } else {
      const modeHint = uploadedVideos.length
        ? stillsToSend.length
          ? "Use the first uploaded video as the base footage: keep its framing, camera movement, on-screen content, people, performance and timing. Match the attached reference still(s) for color, contrast, haze and overall look, and apply the changes described below."
          : "Use the first uploaded video as the base footage: keep its framing, camera movement, on-screen content, people, performance and timing, and apply the changes described below."
        : opts.firstFramePath
          ? "Animate from the provided first-frame image. Match the interface shown in the still."
          : "Generate from the text brief.";

      let cleanPrompt = sanitizePromptForOmni(opts.prompt);
      if (uploadedVideos.length && cleanPrompt.length > 2000) {
        const vo = cleanPrompt.match(/FEMALE VO:\s*["“]([^"”]+)["”]/i)?.[1]
          ?? cleanPrompt.match(/VO:\s*["“]([^"”]+)["”]/i)?.[1];
        cleanPrompt = vo ? `Narration: ${vo}` : cleanPrompt.slice(0, 2000);
      }
      textPayload = `${modeHint}\n\nTarget length ~${durationSec}s.\n\n${cleanPrompt}`;
    }
    opts.onStatus?.(`Omni text payload ${textPayload.length} chars…`);
    try {
      const debugPath = `${opts.outPath}.omni_prompt.txt`;
      fs.writeFileSync(debugPath, textPayload, "utf8");
    } catch {
      /* ignore */
    }

    input.push({
      type: "text",
      text: textPayload,
    });

    // Prefer model inference over explicit task — forced edit/reference_to_video
    // plus long identity suffixes was policy-blocking corporate UI walks.
    let task: "image_to_video" | "reference_to_video" | "edit" | undefined;
    if (!uploadedVideos.length && opts.firstFramePath) task = "image_to_video";

    opts.onStatus?.(
      `Submitting Gemini Omni (${OMNI_API_MODEL}${task ? `, task=${task}` : ""}, ${resolution}, ${durationSec}s)…`,
    );

    const buildRequest = (parts: ContentPart[], taskName?: typeof task) => ({
      model: OMNI_API_MODEL,
      input: parts as never,
      response_format: {
        type: "video" as const,
        aspect_ratio: aspect,
        resolution,
        duration: `${durationSec}s`,
      },
      ...(taskName
        ? {
            generation_config: {
              video_config: { task: taskName },
            },
          }
        : {}),
    });

    let interaction;
    try {
      interaction = await ai.interactions.create(buildRequest(input, task));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const blocked = /input blocked|content_blocked|prohibited use|sensitive words|request blocked|safety violation/i.test(msg);
      if (!blocked || !uploadedVideos.length) throw err;

      // Plate video often trips Google's filter (reported as "prompt"). Fall back to I2V.
      opts.onStatus?.(
        "Omni blocked plate-video submit — retrying image-to-video without the screen recording…",
      );
      const imageOnly: ContentPart[] = [];
      // image_to_video allows at most 2 images (1 = animate still, 2 = interpolate).
      const still =
        (opts.firstFramePath && fs.existsSync(opts.firstFramePath) && opts.firstFramePath) ||
        (opts.referenceImagePaths ?? []).find((p) => p && fs.existsSync(p));
      if (!still) throw err;
      imageOnly.push(await imagePart(ai, still, opts.onStatus, (n) => uploadedFileNames.push(n)));
      imageOnly.push({
        type: "text",
        text: opts.brainOwnedPrompt
          ? textPayload.slice(0, 2000)
          : [
              "Animate from the provided first-frame image. Match the interface shown in the still.",
              `Target length ~${durationSec}s.`,
              textPayload.slice(0, 600),
            ].join("\n\n"),
      });
      interaction = await ai.interactions.create(buildRequest(imageOnly, "image_to_video"));
    }

    const status = String((interaction as { status?: string }).status ?? "");
    if (status && status !== "completed" && status !== "COMPLETED") {
      // Some SDK builds return before completion when background=true; we request sync.
      opts.onStatus?.(`Omni interaction status=${status}; extracting video if present…`);
    }

    const bytes = extractVideoBytes(interaction as never);
    fs.writeFileSync(opts.outPath, bytes);
    if (!fs.existsSync(opts.outPath) || fs.statSync(opts.outPath).size < 1024) {
      throw new Error("Gemini Omni wrote an empty video file");
    }
    opts.onStatus?.(`Omni clip ready (${Math.round(bytes.length / 1024)} KB).`);
  } finally {
    for (const name of uploadedFileNames) {
      try {
        await ai.files.delete({ name });
      } catch {
        /* best-effort — files also expire on Google's side */
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
