import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { setRunInputAssets, type RunRow } from "../db";
import { brainVisionCompletion } from "./geminiBrain";
import { BRAIN_MODEL } from "./constants";
import { isLikelyPresenterStill } from "./autoOptions";
import {
  classifyOperatorVideoRole,
  filenameWords,
  isLikelyTitleGraphicAsset,
  isLikelyTrademarkAsset,
  parseRunInputs,
  type RunInputAsset,
} from "./inputs";
import { encodeReferenceStill, fileToDataUrl, probeFile } from "./stitch";

const execFileAsync = promisify(execFile);
const DOC_TEXT_MAX_CHARS = 60_000;
const TIMELINE_MAX_FRAMES = 24;
async function extractDocumentText(asset: RunInputAsset): Promise<string | undefined> {
  const script = path.join(__dirname, "extract_doc_text.py");
  try {
    const { stdout } = await execFileAsync("python", [script, asset.path], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    const text = stdout.trim();
    return text ? text.slice(0, DOC_TEXT_MAX_CHARS) : undefined;
  } catch (err) {
    console.warn(`[inputs] text extract failed for ${asset.filename}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Timestamped literal description of a supplied video, from evenly sampled frames. */
async function describeVideoTimeline(run: RunRow, asset: RunInputAsset): Promise<string | undefined> {
  const probe = await probeFile(asset.path);
  const dur = probe.duration ?? 0;
  if (dur <= 0) return undefined;
  const step = Math.max(1, dur / TIMELINE_MAX_FRAMES);
  const stamps: number[] = [];
  for (let t = 0; t < dur - 0.05 && stamps.length < TIMELINE_MAX_FRAMES; t += step) stamps.push(Number(t.toFixed(2)));

  const dir = path.join(path.dirname(asset.path), "timeline_frames", asset.id);
  fs.mkdirSync(dir, { recursive: true });
  const images: string[] = [];
  const labels: string[] = [];
  for (const [i, t] of stamps.entries()) {
    const raw = path.join(dir, `f${i}.png`);
    const jpg = path.join(dir, `f${i}.jpg`);
    await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-y", "-ss", String(t), "-i", asset.path, "-frames:v", "1", "-update", "1", raw],
      { windowsHide: true },
    );
    if (!fs.existsSync(raw)) continue;
    await encodeReferenceStill(raw, jpg, 1024);
    images.push(fileToDataUrl(jpg));
    labels.push(`image ${images.length} = t=${t.toFixed(1)}s`);
  }
  if (!images.length) return undefined;

  const text = await brainVisionCompletion({
    model: BRAIN_MODEL,
    system:
      "You log supplied footage for an editor. Be literal: describe only what is visible. Never guess at content between frames.",
    text: [
      `Supplied video "${asset.filename}" — ${dur.toFixed(2)}s, ${probe.width}x${probe.height}${probe.fps ? ` @ ${probe.fps}fps` : ""}.`,
      `Frames in order: ${labels.join("; ")}.`,
      "Write a timestamped timeline an editor can cut from: one line per distinct segment as `start–end s: what is on screen`.",
      "Name pages, sections, headings, UI panels, forms, fields and values, cursor/typing actions, people, locations, and legible on-screen text.",
      "Plain text only.",
    ].join("\n"),
    imageDataUrls: images,
  });
  return `VIDEO TIMELINE (${dur.toFixed(2)}s, ${probe.width}x${probe.height}${probe.fps ? `, ${probe.fps}fps` : ""}):\n${text.trim()}`;
}

/** Literal caption of a supplied reference still, so the storyboard knows what it shows (not just its filename). */
async function describeReferenceStill(run: RunRow, asset: RunInputAsset): Promise<string | undefined> {
  const jpg = path.join(path.dirname(asset.path), "timeline_frames", `${asset.id}.jpg`);
  fs.mkdirSync(path.dirname(jpg), { recursive: true });
  await encodeReferenceStill(asset.path, jpg, 1024);
  const text = await brainVisionCompletion({
    model: BRAIN_MODEL,
    system: "You catalogue supplied reference images for a video production. Be literal: describe only what is visible.",
    text: [
      `Supplied image "${asset.filename}".`,
      "In 2–4 sentences say what it shows: the kind of place or subject, setting details, materials, colours, light and time of day, and any legible text.",
      "Plain text only.",
    ].join("\n"),
    imageDataUrls: [fileToDataUrl(jpg)],
  });
  return text.trim() ? `IMAGE (reference still): ${text.trim()}` : undefined;
}

const MUSIC_NAME = /\b(music|bed|score|soundtrack|underscore|song|instrumental)\b/;
const VOICE_NAME = /\b(vo|voice|voiceover|sample|narration|dialogue|interview)\b/;

/** Attached music bed: named like music, or any long non-voice audio file. */
export async function findMusicBed(raw: string | null | undefined): Promise<RunInputAsset | undefined> {
  const audio = parseRunInputs(raw).filter((a) => a.kind === "audio");
  const named = audio.find((a) => MUSIC_NAME.test(filenameWords(a.filename)));
  if (named) return named;
  for (const a of audio) {
    if (VOICE_NAME.test(filenameWords(a.filename))) continue;
    const dur = (await probeFile(a.path)).duration ?? 0;
    if (dur >= 30) return a;
  }
  return undefined;
}

/**
 * One-time perception pass over the run's attachments before the storyboard: document text
 * (PDF/DOCX/PPTX) and a timeline of each supplied reference video. Persisted on the run.
 */
export async function prepareRunInputs(
  run: RunRow,
  onStatus?: (msg: string) => void | Promise<void>,
): Promise<RunRow> {
  const assets = parseRunInputs(run.input_assets_json);
  let changed = false;
  for (const asset of assets) {
    if (asset.textContent) continue;
    if (asset.kind === "document") {
      onStatus?.(`Reading ${asset.filename}…`);
      const text = await extractDocumentText(asset);
      if (text) {
        asset.textContent = text;
        asset.note = "Document text extracted below.";
        changed = true;
      }
    } else if (asset.kind === "video" && classifyOperatorVideoRole(asset.filename) === "reference") {
      onStatus?.(`Watching ${asset.filename}…`);
      try {
        const timeline = await describeVideoTimeline(run, asset);
        if (timeline) {
          asset.textContent = timeline;
          changed = true;
        }
      } catch (err) {
        console.warn(`[inputs] timeline failed for ${asset.filename}:`, err instanceof Error ? err.message : err);
      }
    } else if (
      asset.kind === "image" &&
      !isLikelyTrademarkAsset(asset.filename) &&
      !isLikelyTitleGraphicAsset(asset.filename) &&
      !isLikelyPresenterStill(asset.filename)
    ) {
      onStatus?.(`Looking at ${asset.filename}…`);
      try {
        const caption = await describeReferenceStill(run, asset);
        if (caption) {
          asset.textContent = caption;
          changed = true;
        }
      } catch (err) {
        console.warn(`[inputs] caption failed for ${asset.filename}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (!changed) return run;
  const json = JSON.stringify(assets);
  await setRunInputAssets(run.id, json);
  return { ...run, input_assets_json: json };
}
