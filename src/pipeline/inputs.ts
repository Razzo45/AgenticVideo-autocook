import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runDir } from "./paths";
import { ensureAbsRunFile, persistRunFile, storageMode } from "./storage";

export type InputAssetKind = "image" | "text" | "document" | "audio" | "video" | "other";

export type RunInputAsset = {
  id: string;
  filename: string;
  path: string;
  kind: InputAssetKind;
  /** Injected into the script step when readable as UTF-8 text. */
  textContent?: string;
  note?: string;
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif"]);
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json"]);
const DOC_EXT = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm"]);

function kindFor(name: string): InputAssetKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  if (DOC_EXT.has(ext)) return "document";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120);
  return base || "input.bin";
}

function readTextIfSmall(filePath: string, maxBytes = 512_000): string | undefined {
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) return undefined;
    const raw = fs.readFileSync(filePath);
    if (raw.includes(0)) return undefined;
    return raw.toString("utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Prefer sourcePath for multi-GB plates — never buffer the whole file in RAM. */
export type RunInputFile =
  | { originalName: string; data: Buffer }
  | { originalName: string; sourcePath: string };

export async function saveRunInputs(runId: string, files: RunInputFile[]): Promise<RunInputAsset[]> {
  if (!files.length) return [];
  const dir = path.join(runDir(runId), "inputs");
  fs.mkdirSync(dir, { recursive: true });
  const out: RunInputAsset[] = [];
  for (const file of files) {
    const filename = safeName(file.originalName);
    const id = crypto.randomUUID();
    const abs = path.join(dir, `${id}_${filename}`);
    if ("sourcePath" in file) {
      const src = path.resolve(file.sourcePath);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        throw new Error(`Missing input file: ${file.originalName}`);
      }
      try {
        fs.copyFileSync(src, abs);
      } catch {
        // Chunked copy if native copyFile fails — never hold the whole plate in RAM.
        const fdSrc = fs.openSync(src, "r");
        const fdDst = fs.openSync(abs, "w");
        try {
          const buf = Buffer.alloc(8 * 1024 * 1024);
          let bytes = 0;
          while ((bytes = fs.readSync(fdSrc, buf, 0, buf.length, null)) > 0) {
            fs.writeSync(fdDst, buf, 0, bytes);
          }
        } finally {
          fs.closeSync(fdSrc);
          fs.closeSync(fdDst);
        }
      }
    } else {
      fs.writeFileSync(abs, file.data);
    }
    await persistRunFile(abs);
    // In s3 mode the bucket holds the attachment; local copy is optional scratch.
    const kind = kindFor(filename);
    const asset: RunInputAsset = { id, filename, path: abs, kind };
    if (kind === "text") {
      asset.textContent = readTextIfSmall(abs);
    } else if (kind === "document") {
      asset.note = "Document attached — text is extracted before the storyboard.";
    } else if (kind === "image") {
      asset.note = isLikelyTitleGraphicAsset(filename)
        ? "Title/brand graphic — stitch or bookend guidance; not burned into keyframes as filename text."
        : "Reference still — use for look/identity when the brief calls for it.";
    } else if (kind === "audio") {
      asset.note = "Audio attached — follow the brief for whether it is a bed, SFX, or context-only.";
    } else if (kind === "video") {
      const role = classifyOperatorVideoRole(filename);
      asset.note =
        role === "intro" || role === "outro"
          ? `Video role=${role} — bookended in the final stitch; also used as visual guidance.`
          : "Supplied footage — can be cut into the edit with a shot insert (see its timeline).";
    }
    out.push(asset);
  }
  return out;
}

export function parseRunInputs(raw: string | null | undefined): RunInputAsset[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as RunInputAsset[];
    if (!Array.isArray(parsed)) return [];
    // When S3 is configured, paths may exist only on the other container — keep them
    // and hydrate via ensureAbsRunFile / hydrateRunInputs before use.
    if (storageMode() === "s3") {
      return parsed.filter((a) => a?.path);
    }
    return parsed.filter((a) => a?.path && fs.existsSync(a.path));
  } catch {
    return [];
  }
}

/** Pull any missing operator attachments from the bucket onto local disk. */
export async function hydrateRunInputs(raw: string | null | undefined): Promise<RunInputAsset[]> {
  const assets = parseRunInputs(raw);
  if (storageMode() !== "s3") return assets.filter((a) => fs.existsSync(a.path));
  const out: RunInputAsset[] = [];
  for (const a of assets) {
    try {
      await ensureAbsRunFile(a.path);
      out.push(a);
    } catch {
      /* attachment missing in bucket too */
    }
  }
  return out;
}

export function operatorImageRefs(raw: string | null | undefined): string[] {
  return parseRunInputs(raw)
    .filter((a) => a.kind === "image")
    .map((a) => a.path);
}

/** Lowercased basename with underscores as word breaks, so `\b` matches `Brand_Logo_White.png`. */
export function filenameWords(filename: string): string {
  return path.basename(filename).toLowerCase().replace(/_+/g, " ");
}

/** Logos / wordmarks — providers (Seed, Seedance, often Gemini) reject these as trademarked. */
export function isLikelyTrademarkAsset(filename: string): boolean {
  const n = filenameWords(filename);
  return /\b(logo|wordmark|lockup|brand[\s_-]?mark|trademark|emblem|crest)\b/.test(n);
}

/** Title / end-card style assets — stitch or bookend, not raw keyframe image refs. */
export function isLikelyTitleGraphicAsset(filename: string): boolean {
  const n = filenameWords(filename);
  return (
    isLikelyTrademarkAsset(n) ||
    /\b(title[\s_-]?card|title[\s_-]?graphic|end[\s_-]?card|lower[\s_-]?third|animated[\s_-]?graphic)\b/.test(n)
  );
}

/** Image refs safe to send to image/video models (excludes logo/title card files). */
export function operatorModelImageRefs(raw: string | null | undefined): string[] {
  return parseRunInputs(raw)
    .filter((a) => a.kind === "image" && !isLikelyTitleGraphicAsset(a.filename))
    .map((a) => a.path);
}

export function operatorVideoAssets(raw: string | null | undefined): RunInputAsset[] {
  return parseRunInputs(raw).filter((a) => a.kind === "video");
}

export function operatorAudioAssets(raw: string | null | undefined): RunInputAsset[] {
  return parseRunInputs(raw).filter((a) => a.kind === "audio");
}

/** Heuristic: open/close / title plates vs generic style refs (filename only). */
export function classifyOperatorVideoRole(filename: string): "intro" | "outro" | "reference" {
  const n = filenameWords(filename);
  if (/\b(intro|opening|opener|cold[\s_-]?open|animated[\s_-]?graphic|title[\s_-]?card|title[\s_-]?graphic)\b/.test(n)) {
    return "intro";
  }
  if (/\b(outro|ending|end[\s_-]?logo|endlogo|closing|close)\b/.test(n)) return "outro";
  return "reference";
}

export function operatorBookendVideos(raw: string | null | undefined): {
  intros: string[];
  outros: string[];
  references: string[];
} {
  const intros: string[] = [];
  const outros: string[] = [];
  const references: string[] = [];
  for (const a of operatorVideoAssets(raw)) {
    const role = classifyOperatorVideoRole(a.filename);
    if (role === "intro") intros.push(a.path);
    else if (role === "outro") outros.push(a.path);
    else references.push(a.path);
  }
  return { intros, outros, references };
}

/** Build attachment guidance from what THIS run actually attached — no assumed brand or genre. */
export function formatInputsForScript(raw: string | null | undefined): string {
  const assets = parseRunInputs(raw);
  if (!assets.length) return "";
  const hasText = assets.some((a) => a.textContent || a.kind === "text");
  const hasLogo = assets.some((a) => a.kind === "image" && isLikelyTrademarkAsset(a.filename));
  const hasImage = assets.some((a) => a.kind === "image");
  const hasVideo = assets.some((a) => a.kind === "video");
  const hasAudio = assets.some((a) => a.kind === "audio");
  const bookends = operatorBookendVideos(raw);

  const parts = [
    "OPERATOR ATTACHMENTS for THIS run only (honor these over generic guesses; do not invent assets from other jobs):",
  ];
  if (hasText) {
    parts.push(
      "Text/script: preserve spoken/dialogue lines verbatim; treat production, timing, and camera directions as action beats to execute visually — never as lines to speak aloud.",
    );
  }
  if (hasLogo) {
    parts.push(
      "Logo/mark images are attached — only put on-screen branding where the brief asks; match those files when branding is required.",
    );
  } else if (hasImage) {
    parts.push("Still references are attached — use them for look/identity as the brief indicates.");
  }
  if (hasVideo) {
    parts.push(
      "Video references are attached — match look and motion from those plates when the brief relies on them.",
    );
  }
  if (bookends.intros.length || bookends.outros.length) {
    parts.push(
      "Intro/outro (or animated title) videos are bookended onto the final stitch — they must appear in the finished piece; keep body look consistent with those plates.",
    );
  }
  if (hasAudio) {
    parts.push(
      "Audio is attached — follow the brief for score/SFX/context-only; do not invent a different soundtrack.",
    );
  }

  for (const a of assets) {
    if (a.kind === "video") {
      const role = classifyOperatorVideoRole(a.filename);
      parts.push(`\n- ${a.filename} (video, role=${role})${a.note ? `: ${a.note}` : ""}`);
      if (a.textContent) parts.push(a.textContent);
    } else if (a.textContent) {
      parts.push(`\n--- ${a.filename} ---\n${a.textContent}`);
    } else {
      parts.push(`\n- ${a.filename} (${a.kind})${a.note ? `: ${a.note}` : ""}`);
    }
  }
  return parts.join("\n");
}
