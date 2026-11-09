/**
 * Media tools Argon can call during document cooks — mirrors gemini.google.com
 * (generate image / video / SVG, then reference or inline in the deliverable).
 * Platform executes tools with Argon's prompts only — no creative wrappers.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import { generateOmniVideo } from "../pipeline/geminiOmni";
import { withGeminiAdmission } from "../pipeline/geminiAdmission";
import type { HtmlMediaAsset } from "../pipeline/schemaDocs";
import { probeFile } from "../pipeline/stitch";

const execFileAsync = promisify(execFile);

const IMAGE_MODEL = process.env.PRODUCT_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error("GEMINI_API_KEY is missing for Argon media tools.");
  }
  return key;
}

export const ARGON_MEDIA_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "generate_image",
    description:
      "Generate a PNG. The prompt is sent unchanged. This model chooses the pixel size; width and height on this call are not applied. When the job needs exact pixels, call fit_image on the returned id.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "Stable asset id used as {{asset:id}} in HTML." },
        prompt: { type: Type.STRING, description: "Full image prompt — used verbatim." },
        filename: {
          type: Type.STRING,
          description: "Relative path in the bundle, e.g. assets/hero.png",
        },
        references: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Attached filenames to send with this prompt, unchanged.",
        },
        width: { type: Type.NUMBER, description: "Ignored. Call fit_image for exact pixels." },
        height: { type: Type.NUMBER, description: "Ignored. Call fit_image for exact pixels." },
        embed: {
          type: Type.STRING,
          description: "path (default) or data_uri for <img src=data:...>",
        },
      },
      required: ["id", "prompt", "filename"],
    },
  },
  {
    name: "fit_image",
    description:
      "Set the exact pixel size of an image that already exists. Does not redraw it. contain pads to the box, cover crops to fill it, stretch scales to the exact width and height. Source is a staged id or a filename.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "Id for the fitted file. Use a new id to keep the source." },
        source: { type: Type.STRING, description: "Staged id or filename to resize." },
        filename: { type: Type.STRING, description: "Output path, e.g. assets/cover.png" },
        width: { type: Type.NUMBER, description: "Exact pixel width." },
        height: { type: Type.NUMBER, description: "Exact pixel height." },
        fit: { type: Type.STRING, description: "contain, cover, or stretch. Default contain." },
        pad_color: { type: Type.STRING, description: "Hex color for contain padding, default FFFFFF." },
      },
      required: ["id", "source", "filename", "width", "height"],
    },
  },
  {
    name: "generate_video",
    description:
      "Generate one MP4. The prompt is sent unchanged. The generator only accepts 3–10 seconds and aspect 16:9 or 9:16. Call fit_video to resize, pad, crop, trim, or loop that file, and join_videos to play clips in order.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        prompt: { type: Type.STRING, description: "Full motion prompt — used verbatim." },
        filename: {
          type: Type.STRING,
          description: "Relative path, e.g. assets/loop.mp4",
        },
        duration_sec: {
          type: Type.NUMBER,
          description: "Asked length. The generator clamps this to 3–10 seconds.",
        },
        aspect: { type: Type.STRING, description: "16:9 or 9:16. Other aspects are not applied." },
        references: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Attached filenames to send with this prompt, unchanged.",
        },
      },
      required: ["id", "prompt", "filename"],
    },
  },
  {
    name: "fit_video",
    description:
      "Resize, pad, crop, trim, or loop an existing MP4. Does not regenerate the picture. Width and height are rounded to even pixels. duration_sec may be longer than 10 by looping, or shorter by trimming. contain pads, cover crops, stretch scales.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        source: { type: Type.STRING, description: "Staged id or filename." },
        filename: { type: Type.STRING, description: "Output path, e.g. assets/spot.mp4" },
        width: { type: Type.NUMBER },
        height: { type: Type.NUMBER },
        aspect: { type: Type.STRING, description: "Used when width and height are omitted, e.g. 1:1 or 4:5." },
        duration_sec: { type: Type.NUMBER, description: "Output length. Longer than the source loops it." },
        fit: { type: Type.STRING, description: "contain, cover, or stretch. Default contain." },
        pad_color: { type: Type.STRING, description: "Hex color for contain padding, default 000000." },
      },
      required: ["id", "source", "filename"],
    },
  },
  {
    name: "join_videos",
    description:
      "Place existing MP4s one after another, in the order given. Each clip is padded to the first clip's frame size. Use this when the job is longer than one generate_video call.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        filename: { type: Type.STRING, description: "Output path, e.g. assets/full.mp4" },
        clips: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Staged ids or filenames, in play order.",
        },
      },
      required: ["id", "filename", "clips"],
    },
  },
  {
    name: "write_svg",
    description:
      "Register SVG markup Argon authored (no rasterization). Prefer for logos/icons that must stay crisp.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        svg: { type: Type.STRING, description: "Full SVG document." },
        filename: { type: Type.STRING, description: "e.g. assets/mark.svg" },
        embed: { type: Type.STRING, description: "path or data_uri" },
      },
      required: ["id", "svg", "filename"],
    },
  },
];

export type StagedMedia = {
  id: string;
  format: HtmlMediaAsset["format"];
  filename: string;
  absPath: string;
  embed: "path" | "data_uri";
  mime: string;
  /** Set for png/svg when embed=data_uri or when caller needs inline. */
  dataUri?: string;
};

function mimeFor(format: HtmlMediaAsset["format"]): string {
  if (format === "png") return "image/png";
  if (format === "svg") return "image/svg+xml";
  if (format === "mp4") return "video/mp4";
  return "audio/wav";
}

function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("..")) throw new Error(`Unsafe media path: ${rel}`);
  return norm;
}

/** A second id must not replace another staged file that shares the same path. */
function claimRel(ctx: MediaToolContext, filename: string, id: string): string {
  let rel = safeRel(filename);
  const taken = (candidate: string) =>
    [...ctx.staged.values()].some((staged) => staged.id !== id && staged.absPath === path.join(ctx.stagingDir, candidate));
  if (!taken(rel)) return rel;
  const ext = path.extname(rel);
  const stem = ext ? rel.slice(0, -ext.length) : rel;
  const safeId = id.replace(/[^\w.-]+/g, "_").slice(0, 40) || "file";
  rel = `${stem}-${safeId}${ext}`;
  return taken(rel) ? `${stem}-${safeId}-${ctx.staged.size}${ext}` : rel;
}

async function generatePngBytes(prompt: string, referenceImagePaths: string[] = []): Promise<Buffer> {
  const ai = new GoogleGenAI({ apiKey: requireGeminiKey() });
  const parts: Array<Record<string, unknown>> = [{ text: prompt.trim() }];
  for (const ref of referenceImagePaths) {
    if (!ref || !fs.existsSync(ref)) continue;
    const buf = fs.readFileSync(ref);
    const mime = /\.png$/i.test(ref) ? "image/png" : "image/jpeg";
    parts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
  }
  return withGeminiAdmission("image", async () => {
    const result = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseModalities: ["IMAGE", "TEXT"] },
    });
    for (const c of result.candidates ?? []) {
      for (const part of c.content?.parts ?? []) {
        const data = (part as { inlineData?: { data?: string } }).inlineData;
        if (data?.data) return Buffer.from(data.data, "base64");
      }
    }
    throw new Error("generate_image: model returned no image bytes");
  });
}

export type MediaToolContext = {
  stagingDir: string;
  staged: Map<string, StagedMedia>;
  referenceImagePaths?: string[];
  /** Basename → file path for references Argon names on a tool call. */
  filesByName?: Map<string, string>;
  /** When true, attach only the files Argon names. Do not add the rest. */
  namedReferencesOnly?: boolean;
  onStatus?: (msg: string) => void;
};

function remember(ctx: MediaToolContext, staged: StagedMedia): void {
  ctx.staged.set(staged.id, staged);
  const base = path.basename(staged.filename).toLowerCase();
  if (base) ctx.filesByName?.set(base, staged.absPath);
}

function positiveInt(value: unknown, label: string, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > max) throw new Error(`${label} must be 1–${max}`);
  return n;
}

function fitMode(value: unknown): "contain" | "cover" | "stretch" {
  const mode = String(value ?? "contain").trim().toLowerCase();
  if (mode === "cover" || mode === "stretch") return mode;
  return "contain";
}

function padColor(value: unknown, fallback: string): string {
  const hex = String(value ?? fallback).trim().replace(/^#/, "");
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) return `0x${hex}`;
  return `0x${fallback}`;
}

function evenPixels(n: number): number {
  const even = n % 2 === 0 ? n : n + 1;
  return Math.min(7680, Math.max(2, even));
}

function scaleFilter(width: number, height: number, fit: "contain" | "cover" | "stretch", color: string): string {
  if (fit === "stretch") return `scale=${width}:${height}`;
  if (fit === "cover") {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color}`;
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg failed: ${msg.slice(0, 500)}`);
  }
}

/** Write to a temp file so ffmpeg can read and replace the same path. */
async function ffmpegOut(outPath: string, args: string[]): Promise<void> {
  const tmp = path.join(path.dirname(outPath), `.${process.pid}.${path.basename(outPath)}`);
  try {
    await ffmpeg([...args, tmp]);
    fs.renameSync(tmp, outPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function lookupNamed(ctx: MediaToolContext, name: string): string | undefined {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!norm) return undefined;
  const direct = ctx.filesByName?.get(norm);
  if (direct && fs.existsSync(direct)) return direct;
  const base = norm.split("/").pop();
  if (!base) return undefined;
  const hit = ctx.filesByName?.get(base);
  if (hit && fs.existsSync(hit)) return hit;
  return undefined;
}

function resolveSource(ctx: MediaToolContext, token: string): string {
  const raw = token.trim();
  if (!raw) throw new Error("source required");
  const byId = ctx.staged.get(raw);
  if (byId && fs.existsSync(byId.absPath)) return byId.absPath;
  const named = lookupNamed(ctx, raw);
  if (named) return named;
  const base = raw.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (base) {
    for (const staged of ctx.staged.values()) {
      const stagedBase = path.basename(staged.filename).toLowerCase();
      if (stagedBase === base && fs.existsSync(staged.absPath)) return staged.absPath;
    }
  }
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  throw new Error(`source not found: ${raw}`);
}

function namedRefs(args: Record<string, unknown>, ctx: MediaToolContext): string[] {
  const raw = args.references ?? args.reference_files;
  const wanted = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  if (!wanted.length) {
    return ctx.namedReferencesOnly ? [] : (ctx.referenceImagePaths ?? []);
  }
  const out: string[] = [];
  for (const name of wanted) {
    const hit = lookupNamed(ctx, name);
    if (hit) out.push(hit);
  }
  return out;
}

export async function executeArgonMediaTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MediaToolContext,
): Promise<Record<string, unknown>> {
  fs.mkdirSync(ctx.stagingDir, { recursive: true });
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error(`${name}: id required`);

  if (name === "generate_image") {
    const filename = claimRel(ctx, String(args.filename ?? `assets/${id}.png`), id);
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("generate_image: prompt required");
    const embed = String(args.embed ?? "path") === "data_uri" ? "data_uri" : "path";
    ctx.onStatus?.(`Argon tool generate_image (${id})…`);
    const buf = await generatePngBytes(prompt, namedRefs(args, ctx).filter((p) => /\.(png|jpe?g|webp)$/i.test(p)));
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
    const staged: StagedMedia = {
      id,
      format: "png",
      filename,
      absPath,
      embed,
      mime: "image/png",
      dataUri,
    };
    remember(ctx, staged);
    const probed = await probeFile(absPath).catch(() => null);
    const askedW = Number(args.width);
    const askedH = Number(args.height);
    const sized = Number.isFinite(askedW) && askedW > 0 && Number.isFinite(askedH) && askedH > 0;
    return {
      ok: true,
      id,
      filename,
      mime: "image/png",
      embed,
      bytes: buf.length,
      width: probed?.width || null,
      height: probed?.height || null,
      placeholder: `{{asset:${id}}}`,
      data_uri_available: true,
      limit: sized
        ? "generate_image did not apply width or height. Call fit_image with this id for the exact pixels."
        : "Pixel size was chosen by the image model. Call fit_image with this id when the job names a size.",
      hint:
        embed === "data_uri"
          ? `Use {{asset:${id}}} — platform will inline as data URI.`
          : `Use src="{{asset:${id}}}" or src="${filename}".`,
    };
  }

  if (name === "fit_image") {
    const filename = claimRel(ctx, String(args.filename ?? `assets/${id}.png`), id);
    const width = positiveInt(args.width, "width", 8000);
    const height = positiveInt(args.height, "height", 8000);
    const fit = fitMode(args.fit);
    const source = resolveSource(ctx, String(args.source ?? args.source_id ?? ""));
    ctx.onStatus?.(`Argon tool fit_image (${id}, ${width}x${height} ${fit})…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    await ffmpegOut(absPath, [
      "-i",
      source,
      "-vf",
      scaleFilter(width, height, fit, padColor(args.pad_color, "FFFFFF")),
      "-frames:v",
      "1",
    ]);
    const buf = fs.readFileSync(absPath);
    const probed = await probeFile(absPath);
    remember(ctx, {
      id,
      format: "png",
      filename,
      absPath,
      embed: "path",
      mime: "image/png",
      dataUri: `data:image/png;base64,${buf.toString("base64")}`,
    });
    return {
      ok: true,
      id,
      filename,
      mime: "image/png",
      width: probed.width,
      height: probed.height,
      fit,
      bytes: buf.length,
    };
  }

  if (name === "write_svg") {
    const filename = claimRel(ctx, String(args.filename ?? `assets/${id}.svg`), id);
    const svg = String(args.svg ?? "").trim();
    if (!svg) throw new Error("write_svg: svg required");
    const embed = String(args.embed ?? "path") === "data_uri" ? "data_uri" : "path";
    ctx.onStatus?.(`Argon tool write_svg (${id})…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, svg, "utf8");
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    remember(ctx, {
      id,
      format: "svg",
      filename,
      absPath,
      embed,
      mime: "image/svg+xml",
      dataUri,
    });
    return {
      ok: true,
      id,
      filename,
      mime: "image/svg+xml",
      embed,
      placeholder: `{{asset:${id}}}`,
      hint: `Use {{asset:${id}}} in HTML (path or data URI per embed).`,
    };
  }

  if (name === "generate_video") {
    const filename = claimRel(ctx, String(args.filename ?? `assets/${id}.mp4`), id);
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("generate_video: prompt required");
    const askedDuration = Number(args.duration_sec);
    const duration = Math.min(10, Math.max(3, Number.isFinite(askedDuration) && askedDuration > 0 ? askedDuration : 5));
    const askedAspect = String(args.aspect ?? "16:9");
    const aspect = askedAspect === "9:16" ? "9:16" : "16:9";
    ctx.onStatus?.(`Argon tool generate_video (${id}, ${duration}s)…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    await generateOmniVideo({
      prompt,
      outPath: absPath,
      duration,
      aspectRatio: aspect,
      brainOwnedPrompt: true,
      referenceImagePaths: namedRefs(args, ctx).filter((p) => /\.(png|jpe?g|webp)$/i.test(p)),
      onStatus: ctx.onStatus,
    });
    remember(ctx, {
      id,
      format: "mp4",
      filename,
      absPath,
      embed: "path",
      mime: "video/mp4",
    });
    return {
      ok: true,
      id,
      filename,
      mime: "video/mp4",
      embed: "path",
      duration_sec: duration,
      aspect,
      requested_duration_sec: Number.isFinite(askedDuration) ? askedDuration : null,
      requested_aspect: askedAspect,
      limit:
        "generate_video only made a 3–10s clip at 16:9 or 9:16. Call fit_video to resize, trim, or loop this id. Call join_videos to put clips in order.",
      placeholder: `{{asset:${id}}}`,
      hint: `Use <video src="{{asset:${id}}}" controls autoplay muted loop></video>`,
    };
  }

  if (name === "fit_video") {
    const filename = claimRel(ctx, String(args.filename ?? `assets/${id}.mp4`), id);
    const source = resolveSource(ctx, String(args.source ?? args.source_id ?? ""));
    const probedIn = await probeFile(source);
    const fit = fitMode(args.fit);
    let width = Number(args.width);
    let height = Number(args.height);
    if (!(width > 0 && height > 0)) {
      const ratio = String(args.aspect ?? "16:9").trim();
      const [aw, ah] = ratio.split(":").map((part) => Number(part));
      const longSide = Math.max(probedIn.width || 1280, probedIn.height || 720, 2);
      if (aw > 0 && ah > 0) {
        if (aw >= ah) {
          width = longSide;
          height = Math.round((longSide * ah) / aw);
        } else {
          height = longSide;
          width = Math.round((longSide * aw) / ah);
        }
      } else {
        width = probedIn.width || 1280;
        height = probedIn.height || 720;
      }
    }
    const outW = evenPixels(Math.round(width));
    const outH = evenPixels(Math.round(height));
    const duration = args.duration_sec == null || args.duration_sec === "" ? null : Number(args.duration_sec);
    if (duration != null && (!Number.isFinite(duration) || duration <= 0 || duration > 600)) {
      throw new Error("duration_sec must be between 0 and 600");
    }
    ctx.onStatus?.(`Argon tool fit_video (${id}, ${outW}x${outH})…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const sourceDur = probedIn.duration ?? 0;
    const loop = duration != null && sourceDur > 0 && duration > sourceDur + 0.05;
    const argsFfmpeg = [
      ...(loop ? ["-stream_loop", "-1"] : []),
      "-i",
      source,
      "-vf",
      `${scaleFilter(outW, outH, fit, padColor(args.pad_color, "000000"))},setsar=1`,
      ...(duration != null ? ["-t", duration.toFixed(3)] : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      ...(probedIn.hasAudio ? ["-c:a", "aac"] : ["-an"]),
    ];
    await ffmpegOut(absPath, argsFfmpeg);
    const probed = await probeFile(absPath);
    remember(ctx, { id, format: "mp4", filename, absPath, embed: "path", mime: "video/mp4" });
    return {
      ok: true,
      id,
      filename,
      mime: "video/mp4",
      width: probed.width,
      height: probed.height,
      duration_sec: probed.duration,
      fit,
      bytes: fs.statSync(absPath).size,
    };
  }

  if (name === "join_videos") {
    const filename = claimRel(ctx, String(args.filename ?? `assets/${id}.mp4`), id);
    const clips = Array.isArray(args.clips) ? args.clips.map((clip) => String(clip)) : [];
    if (clips.length < 2 || clips.length > 12) throw new Error("join_videos needs 2–12 clips");
    const sources = clips.map((clip) => resolveSource(ctx, clip));
    const first = await probeFile(sources[0]);
    const outW = evenPixels(first.width || 1280);
    const outH = evenPixels(first.height || 720);
    const probes = await Promise.all(sources.map((src) => probeFile(src)));
    const withAudio = probes.every((probe) => probe.hasAudio);
    ctx.onStatus?.(`Argon tool join_videos (${id}, ${clips.length} clips)…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const chains = sources.map((_, index) => {
      const video = `[${index}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=0x000000,setsar=1[v${index}]`;
      const audio = withAudio ? `;[${index}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${index}]` : "";
      return video + audio;
    });
    const vLabels = sources.map((_, index) => `[v${index}]`).join("");
    const aLabels = sources.map((_, index) => `[a${index}]`).join("");
    const concat = withAudio
      ? `${vLabels}${aLabels}concat=n=${sources.length}:v=1:a=1[v][a]`
      : `${vLabels}concat=n=${sources.length}:v=1:a=0[v]`;
    await ffmpegOut(absPath, [
      ...sources.flatMap((src) => ["-i", src]),
      "-filter_complex",
      `${chains.join(";")} ; ${concat}`,
      "-map",
      "[v]",
      ...(withAudio ? ["-map", "[a]", "-c:a", "aac"] : ["-an"]),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ]);
    const probed = await probeFile(absPath);
    remember(ctx, { id, format: "mp4", filename, absPath, embed: "path", mime: "video/mp4" });
    return {
      ok: true,
      id,
      filename,
      mime: "video/mp4",
      width: probed.width,
      height: probed.height,
      duration_sec: probed.duration,
      clips: clips.length,
      bytes: fs.statSync(absPath).size,
    };
  }

  throw new Error(`Unknown Argon media tool: ${name}`);
}

/** Materialize declarative plan assets (when Argon listed them without calling tools). */
export async function materializePlanAssets(
  assets: HtmlMediaAsset[],
  ctx: MediaToolContext,
): Promise<StagedMedia[]> {
  const out: StagedMedia[] = [];
  for (const asset of assets) {
    if (ctx.staged.has(asset.id)) {
      out.push(ctx.staged.get(asset.id)!);
      continue;
    }
    if (asset.format === "png") {
      await executeArgonMediaTool(
        "generate_image",
        {
          id: asset.id,
          prompt: asset.prompt,
          filename: asset.filename,
          width: asset.width,
          height: asset.height,
          embed: asset.embed,
        },
        ctx,
      );
    } else if (asset.format === "svg") {
      await executeArgonMediaTool(
        "write_svg",
        { id: asset.id, svg: asset.svg, filename: asset.filename, embed: asset.embed },
        ctx,
      );
    } else if (asset.format === "mp4") {
      await executeArgonMediaTool(
        "generate_video",
        {
          id: asset.id,
          prompt: asset.prompt,
          filename: asset.filename,
          duration_sec: asset.duration_sec,
        },
        ctx,
      );
    } else {
      // wav deferred — treat as missing
      throw new Error(`HTML asset format ${asset.format} not supported yet (use png/svg/mp4)`);
    }
    out.push(ctx.staged.get(asset.id)!);
  }
  return out;
}

/** Rewrite {{asset:id}} placeholders using staged media (path or data URI). */
export function rewriteAssetPlaceholders(content: string, staged: Iterable<StagedMedia>): string {
  let out = content;
  for (const m of staged) {
    const token = `{{asset:${m.id}}}`;
    const replacement =
      m.embed === "data_uri" && m.dataUri && (m.format === "png" || m.format === "svg")
        ? m.dataUri
        : m.filename.replace(/\\/g, "/");
    out = out.split(token).join(replacement);
  }
  return out;
}

export { mimeFor };
