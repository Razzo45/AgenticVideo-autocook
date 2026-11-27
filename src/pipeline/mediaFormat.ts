/**
 * The bytes of a delivered picture match its file extension.
 *
 * The brain may write an SVG for a file it named Banner.png, a generator may return a
 * JPEG for a .png slot, or an attached .jpg may be placed as a .png. Before this the
 * bytes were copied under the new name, so a ".png" deliverable was an SVG.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareFonts, rendererEnv, requestedFamilies, substitutionNote } from "./fontFetch";
import { findChromium, paintAnimatedGif, svgAnimationPlan } from "./paintGif";
import { recordPlatformNote } from "./platformNotes";

const execFileAsync = promisify(execFile);

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "svg";

const EXT_FORMAT: Record<string, ImageFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".gif": "gif",
  ".svg": "svg",
};

const FORMAT_EXT: Record<ImageFormat, string> = { png: ".png", jpeg: ".jpg", webp: ".webp", gif: ".gif", svg: ".svg" };

/** What the bytes are, from their first bytes. */
export function sniffImage(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 6 && buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  const head = buf.subarray(0, 2048).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[\s\S]*?>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

export function formatForFilename(filename: string): ImageFormat | null {
  return EXT_FORMAT[path.extname(filename).toLowerCase()] ?? null;
}

export function extensionFor(format: ImageFormat): string {
  return FORMAT_EXT[format];
}

/** Pixel size an SVG declares (width/height, else viewBox). */
export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const num = (attr: string) => {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i"));
    return m ? Number(m[1]) : NaN;
  };
  const vb = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  const width = num("width") || (vb ? Number(vb[1]) : NaN);
  const height = num("height") || (vb ? Number(vb[2]) : NaN);
  if (!(width > 0 && height > 0)) return null;
  return { width, height };
}

const MAX_DENSITY = 100_000;
/** Sharp's guard is 268M pixels; refuse a size that would exhaust the worker first. */
const MAX_OUTPUT_PIXELS = 80_000_000;
/**
 * libxml refuses an attribute longer than about 10MB unless a flag the SVG
 * renderer does not set. A picture pasted into the markup as a data URI can
 * pass that, and the whole file is then reported as a corrupt header.
 */
const SVG_RENDERER_HREF_LIMIT = 8_000_000;

type PlacedSvgImage = {
  bytes: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: "cover" | "inside" | "fill";
  position: string;
};

/** Take picture values the SVG renderer cannot parse out of the markup, to be drawn on top. */
export function liftHeavySvgImages(svg: string, hrefLimit = SVG_RENDERER_HREF_LIMIT): { svg: string; images: PlacedSvgImage[] } {
  const images: PlacedSvgImage[] = [];
  const next = svg.replace(/<image\b[^>]*\/?>/gi, (tag) => {
    const href = svgAttr(tag, "href") ?? svgAttr(tag, "xlink:href");
    if (!href || href.length <= hrefLimit || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(href)) return tag;
    const bytes = Buffer.from(href.slice(href.indexOf(",") + 1).replace(/\s/g, ""), "base64");
    if (bytes.length < 8) return tag;
    const box = aspectFit(svgAttr(tag, "preserveAspectRatio"));
    images.push({
      bytes,
      x: svgNum(tag, "x"),
      y: svgNum(tag, "y"),
      width: svgNum(tag, "width"),
      height: svgNum(tag, "height"),
      fit: box.fit,
      position: box.position,
    });
    return "";
  });
  return { svg: next, images };
}

function svgAttr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2];
}

function svgNum(tag: string, name: string): number {
  const raw = svgAttr(tag, name);
  if (!raw || !/^-?[\d.]+(?:px)?$/i.test(raw.trim())) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** How an SVG image fills its box. Default is meet, centred. */
function aspectFit(value: string | undefined): { fit: PlacedSvgImage["fit"]; position: string } {
  const text = (value || "xMidYMid meet").trim();
  if (text === "none") return { fit: "fill", position: "centre" };
  const align = text.split(/\s+/)[0] || "xMidYMid";
  const fit: PlacedSvgImage["fit"] = /\bslice\b/i.test(text) ? "cover" : "inside";
  const x = align.includes("xMin") ? "left" : align.includes("xMax") ? "right" : "";
  const y = align.includes("YMin") ? "top" : align.includes("YMax") ? "bottom" : "";
  const position = [x, y].filter(Boolean).join(" ") || "centre";
  return { fit, position };
}

async function overlaysFor(
  images: PlacedSvgImage[],
  canvasW: number,
  canvasH: number,
  scaleX: number,
  scaleY: number,
): Promise<Array<{ input: Buffer; left: number; top: number }>> {
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const image of images) {
    let w = Math.round(image.width * scaleX);
    let h = Math.round(image.height * scaleY);
    if (!(w > 0 && h > 0)) {
      try {
        const meta = await sharp(image.bytes, { limitInputPixels: false }).metadata();
        w = Math.round((meta.width ?? 0) * scaleX);
        h = Math.round((meta.height ?? 0) * scaleY);
      } catch {
        w = 0;
        h = 0;
      }
    }
    if (!(w > 0 && h > 0) || !(canvasW > 0 && canvasH > 0)) continue;
    let box: Buffer;
    try {
      box = await sharp(image.bytes, { limitInputPixels: false })
        .resize(w, h, { fit: image.fit, position: image.position })
        .png()
        .toBuffer();
    } catch {
      recordPlatformNote("A picture inside the SVG could not be read, so the file was drawn without it.");
      continue;
    }
    const x = image.x * scaleX;
    const y = image.y * scaleY;
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const cropLeft = Math.max(0, Math.min(w, Math.round(-Math.min(x, 0))));
    const cropTop = Math.max(0, Math.min(h, Math.round(-Math.min(y, 0))));
    const cropW = Math.min(w - cropLeft, canvasW - left);
    const cropH = Math.min(h - cropTop, canvasH - top);
    if (cropW < 1 || cropH < 1 || left >= canvasW || top >= canvasH) continue;
    const piece =
      cropLeft || cropTop || cropW !== w || cropH !== h
        ? await sharp(box).extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH }).png().toBuffer()
        : box;
    layers.push({ input: piece, left, top });
  }
  return layers;
}

/**
 * A private scratch file for one write. Callers of the same dest used to share
 * `${dest}.part`, then the first to finish deleted it and the other rename threw ENOENT.
 */
function scratchPath(dest: string): string {
  const name = `.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${path.basename(dest)}.part`;
  return path.join(path.dirname(dest), name);
}

/** Move a finished scratch onto dest. A dest already published by another writer is kept. */
function commitScratch(tmp: string, dest: string): void {
  if (!fs.existsSync(tmp)) {
    if (fs.existsSync(dest)) return;
    throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${tmp}' -> '${dest}'`), { code: "ENOENT" });
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    if (fs.existsSync(dest)) return;
    throw err;
  }
}

export type ConvertOptions = {
  /** Exact output pixels, when the plan names them. Otherwise the source's own size. */
  width?: number;
  height?: number;
  /**
   * A picture href longer than this is drawn onto the SVG afterwards.
   * The SVG renderer rejects a longer value (libxml's buffer limit).
   */
  svgImageHrefLimit?: number;
};

/**
 * Write src to dest in dest's format. Same format and no resize: a plain copy.
 * SVG is drawn to pixels (system fonts via fontconfig). A raster cannot become SVG:
 * null is returned and nothing is written.
 */
export async function convertImage(
  src: string,
  dest: string,
  target: ImageFormat,
  options: ConvertOptions = {},
): Promise<string | null> {
  let opts = options;
  const buf = fs.readFileSync(src);
  const actual = sniffImage(buf);
  if (!actual) throw new Error(`${path.basename(src)} is not an image this platform can read`);
  const resize = Boolean(opts.width && opts.height);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (actual === target && !resize) {
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    return dest;
  }
  if (target === "svg") return null;

  let input: ReturnType<typeof sharp>;
  if (actual === "svg") {
    // No size asked for: the SVG's own size (its width/height, else its viewBox), 1 unit = 1 px.
    // A size asked for: drawn at that size, so it is sharp rather than scaled up from small.
    const svgText = buf.toString("utf8");
    if (target === "gif") {
      const painted = await paintSvgGif(src, svgText, dest, opts);
      if (painted) return dest;
    }
    const hrefLimit = opts.svgImageHrefLimit ?? SVG_RENDERER_HREF_LIMIT;
    const lifted = liftHeavySvgImages(svgText, hrefLimit);
    let drawPath = src;
    let drawBuf = buf;
    let tempSvg: string | null = null;
    if (lifted.images.length) {
      tempSvg = path.join(os.tmpdir(), `svg-draw-${process.pid}-${Date.now().toString(36)}.svg`);
      fs.writeFileSync(tempSvg, lifted.svg);
      drawPath = tempSvg;
      drawBuf = Buffer.from(lifted.svg);
    }
    try {
      const size = svgIntrinsicSize(svgText);
      const long = size ? Math.max(size.width, size.height) : 0;
      const density = resize && long ? Math.min(MAX_DENSITY, Math.max(1, (72 * Math.max(opts.width!, opts.height!)) / long)) : 72;
      const childSize = !lifted.images.length && resize ? { width: opts.width, height: opts.height } : {};
      const drawn = await drawSvgWithFonts(drawPath, lifted.svg, dest, density, childSize);
      if (lifted.images.length) {
        const base = drawn ?? (await sharp(drawBuf, { density, limitInputPixels: false }).png().toBuffer());
        const meta = await sharp(base).metadata();
        const canvasW = meta.width ?? 0;
        const canvasH = meta.height ?? 0;
        const declared = svgIntrinsicSize(svgText);
        const scaleX = declared && canvasW ? canvasW / declared.width : 1;
        const scaleY = declared && canvasH ? canvasH / declared.height : 1;
        const layers = await overlaysFor(lifted.images, canvasW, canvasH, scaleX, scaleY);
        if (layers.length) {
          recordPlatformNote(
            "A picture in this SVG was placed on the drawing. The SVG renderer cannot hold a picture that large inside the file.",
          );
        }
        const placed = layers.length ? await sharp(base).composite(layers).png().toBuffer() : base;
        input = sharp(placed, { limitInputPixels: false });
      } else {
        input = drawn ? sharp(drawn, { limitInputPixels: false }) : sharp(buf, { density, limitInputPixels: false });
        if (drawn && resize) opts = {};
      }
    } finally {
      if (tempSvg) fs.rmSync(tempSvg, { force: true });
    }
  } else {
    input = sharp(buf, { animated: false, limitInputPixels: MAX_OUTPUT_PIXELS });
  }
  if (opts.width && opts.height) {
    if (opts.width * opts.height > MAX_OUTPUT_PIXELS) throw new Error(`${opts.width}x${opts.height} is too large to render`);
    input = input.resize(Math.round(opts.width), Math.round(opts.height), { fit: "fill" });
  }
  if (target === "png") input = input.png();
  else if (target === "jpeg") input = input.flatten({ background: "#ffffff" }).jpeg({ quality: 92 });
  else if (target === "webp") input = input.webp({ quality: 92 });
  else input = input.gif();
  const tmp = scratchPath(dest);
  try {
    await input.toFile(tmp);
    commitScratch(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return dest;
}

/**
 * A GIF whose SVG animates is that timeline, one cycle, looping.
 * A still SVG, or a worker with no browser, keeps the single-frame draw.
 */
async function paintSvgGif(
  src: string,
  svgText: string,
  dest: string,
  opts: ConvertOptions,
): Promise<boolean> {
  const plan = svgAnimationPlan(svgText);
  if (!plan) return false;
  const size = svgIntrinsicSize(svgText);
  const width = Math.round(opts.width ?? size?.width ?? 0);
  const height = Math.round(opts.height ?? size?.height ?? 0);
  if (!(width > 0 && height > 0)) throw new Error(`${path.basename(src)} has no size to paint as a GIF`);
  if (width * height > MAX_OUTPUT_PIXELS) throw new Error(`${width}x${height} is too large to render`);
  if (!findChromium()) {
    recordPlatformNote("The GIF is one frame of the SVG; this worker has no browser to paint the animation.");
    return false;
  }
  const report = await prepareFonts([svgText]);
  const note = substitutionNote(report, "The SVG renderer");
  if (note) recordPlatformNote(note);
  await paintAnimatedGif({ svg: svgText, dest, width, height, plan });
  return true;
}

/** Encoder arguments for an audio file whose name says this format. */
const AUDIO_ENCODE: Record<string, string[]> = {
  ".wav": ["-vn", "-c:a", "pcm_s16le"],
  ".mp3": ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
  ".m4a": ["-vn", "-c:a", "aac", "-b:a", "192k"],
  ".aac": ["-vn", "-c:a", "aac", "-b:a", "192k"],
  ".ogg": ["-vn", "-c:a", "libvorbis", "-q:a", "5"],
  ".opus": ["-vn", "-c:a", "libopus", "-b:a", "128k"],
  ".flac": ["-vn", "-c:a", "flac"],
};

/** Encoder arguments for a video file whose name says this container. */
const VIDEO_ENCODE: Record<string, string[]> = {
  ".mp4": ["-c", "copy", "-movflags", "+faststart"],
  ".m4v": ["-c", "copy", "-movflags", "+faststart"],
  ".mov": ["-c", "copy"],
  ".mkv": ["-c", "copy"],
  ".webm": ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k"],
};

/** Formats an audio or video deliverable can be written in. */
export function mediaEncodeArgs(kind: "audio" | "video", ext: string): string[] | null {
  const table = kind === "audio" ? AUDIO_ENCODE : VIDEO_ENCODE;
  return table[ext.toLowerCase()] ?? null;
}

/**
 * Write a built audio or video file in the format its filename names (an mp3 named
 * .mp3, not WAV bytes under that name). Same extension: a plain copy.
 * An extension with no encoder here is copied as it is; the caller records that.
 */
export async function encodeMediaTo(
  kind: "audio" | "video",
  src: string,
  dest: string,
  run: (args: string[]) => Promise<void>,
): Promise<"copied" | "encoded" | "unsupported"> {
  const want = path.extname(dest).toLowerCase();
  const have = path.extname(src).toLowerCase();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!want || want === have) {
    fs.copyFileSync(src, dest);
    return "copied";
  }
  const args = mediaEncodeArgs(kind, want);
  if (!args) {
    fs.copyFileSync(src, dest);
    return "unsupported";
  }
  const part = scratchPath(dest);
  try {
    await run(["-y", "-hide_banner", "-loglevel", "error", "-i", src, ...args, "-f", formatFlag(want), part]);
    commitScratch(part, dest);
  } finally {
    fs.rmSync(part, { force: true });
  }
  return "encoded";
}

function formatFlag(ext: string): string {
  const map: Record<string, string> = {
    ".wav": "wav", ".mp3": "mp3", ".m4a": "ipod", ".aac": "adts", ".ogg": "ogg", ".opus": "opus",
    ".flac": "flac", ".mp4": "mp4", ".m4v": "mp4", ".mov": "mov", ".mkv": "matroska", ".webm": "webm",
  };
  return map[ext] ?? ext.slice(1);
}

const GENERATOR_MIME: Partial<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * A reference picture as the generators accept it, labelled by its real bytes.
 * GIF and SVG are drawn to PNG first; before, they were silently left out,
 * and a WebP was sent labelled as JPEG. Returns null for a file that is not a picture.
 */
export async function asGeneratorPicture(src: string, workDir: string): Promise<{ path: string; mime: string } | null> {
  if (!fs.existsSync(src)) return null;
  const actual = sniffImage(fs.readFileSync(src));
  if (!actual) return null;
  const mime = GENERATOR_MIME[actual];
  if (mime) return { path: src, mime };
  const dest = path.join(workDir, ".refs", `${path.basename(src, path.extname(src))}-${fs.statSync(src).size}.png`);
  if (!fs.existsSync(dest)) await convertImage(src, dest, "png");
  return { path: dest, mime: "image/png" };
}

export async function asGeneratorPictures(paths: string[], workDir: string): Promise<Array<{ path: string; mime: string }>> {
  const out: Array<{ path: string; mime: string }> = [];
  for (const p of paths) {
    const pic = await asGeneratorPicture(p, workDir);
    if (pic) out.push(pic);
  }
  return out;
}


/**
 * Draw an SVG to a PNG next to dest, in a child process that sees the fonts this SVG names
 * (fetched where they can be). Records a note when a family had to be substituted.
 * Returns the PNG path, or null where fontconfig is not available (then the caller draws in-process).
 */
async function drawSvgWithFonts(
  src: string,
  svgText: string,
  dest: string,
  density: number,
  size: ConvertOptions,
): Promise<Buffer | null> {
  const report = await prepareFonts([svgText]);
  const note = substitutionNote(report, "The SVG renderer");
  if (note) recordPlatformNote(note);
  if (!report.fetched.length && !report.substituted.length && !requestedFamilies(svgText).length) return null;
  const out = path.join(path.dirname(dest), `.svg-${process.pid}-${Date.now().toString(36)}-${path.basename(dest)}.png`);
  try {
    await execFileAsync(
      process.execPath,
      [CHILD, JSON.stringify({ input: src, output: out, density, width: size.width, height: size.height })],
      { env: rendererEnv(), timeout: 120_000, windowsHide: true },
    );
  } catch (err) {
    fs.rmSync(out, { force: true });
    throw new Error(`Drawing ${path.basename(src)} failed: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
  }
  const bytes = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return bytes;
}

// Same directory as this file (the worker runs these sources with tsx as CommonJS).
const CHILD = path.join(__dirname, "rasterizeSvgChild.cjs");
