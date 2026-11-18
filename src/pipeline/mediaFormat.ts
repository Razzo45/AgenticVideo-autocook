/**
 * The bytes of a delivered picture match its file extension.
 *
 * The brain may write an SVG for a file it named Banner.png, a generator may return a
 * JPEG for a .png slot, or an attached .jpg may be placed as a .png. Before this the
 * bytes were copied under the new name, so a ".png" deliverable was an SVG.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

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

export type ConvertOptions = {
  /** Exact output pixels, when the plan names them. Otherwise the source's own size. */
  width?: number;
  height?: number;
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
  opts: ConvertOptions = {},
): Promise<string | null> {
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
    const size = svgIntrinsicSize(buf.toString("utf8"));
    const long = size ? Math.max(size.width, size.height) : 0;
    const density = resize && long ? Math.min(MAX_DENSITY, Math.max(1, (72 * Math.max(opts.width!, opts.height!)) / long)) : 72;
    input = sharp(buf, { density, limitInputPixels: false });
  } else {
    input = sharp(buf, { animated: false, limitInputPixels: MAX_OUTPUT_PIXELS });
  }
  if (resize) {
    if (opts.width! * opts.height! > MAX_OUTPUT_PIXELS) throw new Error(`${opts.width}x${opts.height} is too large to render`);
    input = input.resize(Math.round(opts.width!), Math.round(opts.height!), { fit: "fill" });
  }
  if (target === "png") input = input.png();
  else if (target === "jpeg") input = input.flatten({ background: "#ffffff" }).jpeg({ quality: 92 });
  else if (target === "webp") input = input.webp({ quality: 92 });
  else input = input.gif();
  const tmp = `${dest}.part`;
  try {
    await input.toFile(tmp);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return dest;
}
