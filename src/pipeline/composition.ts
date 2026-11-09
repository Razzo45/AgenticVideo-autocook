/**
 * One Argon reply is the deliverable. The platform builds the file and generates
 * only the pictures, clips, and audio that reply names.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { z } from "zod";
import { executeArgonMediaTool, type MediaToolContext } from "../autocook/argonMediaTools";
import { exportPdf } from "../autocook/exportPdf";
import { withGeminiOwner } from "./geminiAdmission";
import { generateLyriaMusic, generateSpeechTts } from "./geminiAudio";

const execFileAsync = promisify(execFile);
const EMU_PER_INCH = 914400;

const sourceSchema = z.object({
  kind: z.enum(["place", "generate", "svg"]),
  file: z.string().optional(),
  prompt: z.string().optional(),
  references: z.array(z.string()).optional().default([]),
  svg: z.string().optional(),
  media: z.enum(["image", "video", "audio"]).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  fit: z.enum(["contain", "cover", "stretch"]).optional(),
  pad_color: z.string().optional(),
  duration_sec: z.number().positive().optional(),
  aspect: z.string().optional(),
  voice: z.string().optional(),
  style: z.string().optional(),
  instrumental: z.boolean().optional(),
});
export type MediaSource = z.infer<typeof sourceSchema>;

const elementSchema = z.object({
  type: z.enum(["text", "shape", "image"]),
  text: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  size: z.number().positive().optional(),
  bold: z.boolean().optional(),
  color: z.string().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  font: z.string().optional(),
  fill: z.string().optional(),
  source: sourceSchema.optional(),
});

const slideSchema = z.object({
  notes: z.string().optional(),
  background: z.string().optional(),
  font: z.string().optional(),
  elements: z.array(elementSchema).min(1),
});

const assetSchema = z.object({
  id: z.string().min(1),
  filename: z.string().optional(),
  embed: z.enum(["path", "data_uri"]).optional(),
  source: sourceSchema,
});

const clipSchema = z.object({
  prompt: z.string().optional(),
  file: z.string().optional(),
  duration_sec: z.number().positive().optional(),
  aspect: z.string().optional(),
  references: z.array(z.string()).optional().default([]),
});

const speechSchema = z.object({
  text: z.string().min(1),
  voice: z.string().optional(),
  style: z.string().optional(),
});

const musicSchema = z.object({
  prompt: z.string().optional(),
  file: z.string().optional(),
  instrumental: z.boolean().optional(),
  duration_sec: z.number().positive().optional(),
});

const fileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const deliverableSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  kind: z.enum(["pptx", "pdf", "html", "svg", "image", "video", "audio"]),
  font: z.string().optional(),
  width_in: z.number().positive().optional(),
  height_in: z.number().positive().optional(),
  slides: z.array(slideSchema).optional(),
  html: z.string().optional(),
  from: z.string().optional(),
  entry: z.string().optional(),
  files: z.array(fileSchema).optional(),
  assets: z.array(assetSchema).optional(),
  svg: z.string().optional(),
  source: sourceSchema.optional(),
  clips: z.array(clipSchema).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  duration_sec: z.number().positive().optional(),
  fit: z.enum(["contain", "cover", "stretch"]).optional(),
  pad_color: z.string().optional(),
  speech: z.array(speechSchema).optional(),
  music: musicSchema.optional(),
  places: z.array(z.string().min(1)).optional(),
});
export type CompositionDeliverable = z.infer<typeof deliverableSchema>;

export const compositionSchema = z.object({
  deliverables: z.array(deliverableSchema).min(1),
});
export type Composition = z.infer<typeof compositionSchema>;

export type BuiltFile = { id: string; filename: string; absPath: string; printPath?: string };

const KIND_ALIASES: Record<string, CompositionDeliverable["kind"]> = {
  pptx: "pptx",
  powerpoint: "pptx",
  deck: "pptx",
  slides: "pptx",
  pdf: "pdf",
  html: "html",
  webpage: "html",
  website: "html",
  svg: "svg",
  image: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  video: "video",
  mp4: "video",
  audio: "audio",
  wav: "audio",
  mp3: "audio",
};

export function composeInstructions(planned: unknown[], attachedNames: string[]): string {
  const plan = planned.length ? JSON.stringify(planned) : "(none — the operator message names the files)";
  const attached = attachedNames.length ? attachedNames.join(", ") : "(none)";
  return `You are Argon. The operator message and the attached files are the whole job.
Reply with one JSON object and nothing else. This reply is the deliverable. Write the copy, the notes, the layout, the HTML, and the SVG here.

{"deliverables":[{"id":"string","filename":"string","kind":"pptx"|"pdf"|"html"|"svg"|"image"|"video"|"audio"}]}

kind "pptx" — width_in, height_in, slides[]. A slide has notes (the full speaker notes) and elements[].
x, y, w, h are percentages of the slide.
{"type":"text","text":"...","x":6,"y":8,"w":80,"h":14,"size":28,"bold":true,"color":"111111","align":"left","font":"Poppins"}
font is the typeface for that text. A font on the slide or the deck applies where a text element does not name one. An attached font file whose family matches is embedded. Text with no font names no typeface.
{"type":"shape","x":0,"y":0,"w":100,"h":100,"fill":"F4F1EA"}
{"type":"image","x":56,"y":18,"w":38,"h":64,"source":{"kind":"place","file":"exact-name.png"}}
{"type":"image","x":6,"y":28,"w":40,"h":40,"source":{"kind":"generate","prompt":"...","references":["exact-name.png"],"width":1920,"height":1080,"fit":"cover"}}
{"type":"image","source":{"kind":"svg","svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 64 64\\">...</svg>"}}
Place a file that is already in the package. generate is for a picture that does not exist yet. svg is markup you write. width and height on a source are the exact pixels.

kind "pdf" — a complete HTML document in "html", or "from" set to the filename of a pptx or html in this same reply.
In that HTML, list "assets" and write {{asset:id}} where one should appear.
{"id":"hero","filename":"assets/hero.png","source":{"kind":"place","file":"exact-name.png"}}
HTML prints in the browser. "from" a pptx prints only where LibreOffice is installed.

kind "html" — "entry" and "files":[{"path":"index.html","content":"the file"}] plus "assets" as above. {{asset:id}} in the file contents. File contents are written as you wrote them, apart from those tokens.

kind "svg" — "svg" is the full document.

kind "image" — "source" is place, generate, or svg.

kind "video" — "clips" in play order.
{"file":"exact-name.mp4"} places an attached clip.
{"prompt":"...","duration_sec":6,"aspect":"16:9","references":["exact-name.png"]} generates one. A generated clip is 3–10 seconds and 16:9 or 9:16.
width, height, and duration_sec on the deliverable are the finished file. The platform joins the clips and fits that file.

kind "audio" — attached files play first, then speech, and a bed is mixed under that.
"places":["exact-name.wav"] or "source":{"kind":"place","file":"exact-name.wav"}
"speech":[{"text":"...","voice":"Sulafat","style":"..."}]
"music":{"file":"exact-name.wav"} or "music":{"prompt":"...","instrumental":true,"duration_sec":30}

Produce the planned files under the planned filenames. One object per file.

Planned files:
${plan}

Attached filenames you can place:
${attached}`;
}

export function parseComposition(text: string): Composition {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const rawText = fenced ? fenced[1]! : text;
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  const body = start >= 0 && end > start ? rawText.slice(start, end + 1) : rawText;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Deliverable JSON did not parse: ${message}`);
  }
  const parsed = compositionSchema.safeParse(normalizeComposition(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues
      .slice(0, 6)
      .map((item) => `${item.path.join(".") || "deliverables"}: ${item.message}`)
      .join("; ");
    throw new Error(`Deliverable JSON did not match the file shape: ${issue}`);
  }
  assertBuildable(parsed.data);
  return parsed.data;
}

export async function buildComposition(opts: {
  composition: Composition;
  workDir: string;
  filesByName: Map<string, string>;
  ownerId: string;
  onStatus?: (msg: string) => void;
}): Promise<BuiltFile[]> {
  const stagingDir = path.join(opts.workDir, "compose_media");
  const outDir = path.join(opts.workDir, "out");
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const ctx: MediaToolContext = {
    stagingDir,
    staged: new Map(),
    filesByName: opts.filesByName,
    namedReferencesOnly: true,
    onStatus: opts.onStatus,
  };
  const cache = new Map<string, Promise<string>>();
  const slotPath = async (delId: string, slotId: string, source: MediaSource, filename?: string): Promise<string> => {
    const key = cacheKey(source);
    const existing = cache.get(key);
    if (existing) return existing;
    const run = resolveSource({
      source,
      id: safeId(`${delId}-${slotId}`),
      filename: filename || defaultMediaName(source, slotId),
      ctx,
      ownerId: opts.ownerId,
    });
    cache.set(key, run);
    return run;
  };

  const prepared = opts.composition.deliverables.map((item) => ({
    item,
    slots: new Map<string, Promise<string>>(),
  }));

  const pending: Promise<unknown>[] = [];
  for (const row of prepared) {
    const { item, slots } = row;
    const queue = (slotId: string, source: MediaSource, filename?: string) => {
      const task = slotPath(item.id, slotId, source, filename);
      slots.set(slotId, task);
      pending.push(task);
    };
    if (item.kind === "pptx") {
      item.slides?.forEach((slide, slideIndex) => {
        slide.elements.forEach((el, elIndex) => {
          if (el.type === "image" && el.source) queue(`s${slideIndex}e${elIndex}`, el.source);
        });
      });
    } else if (item.kind === "html" || (item.kind === "pdf" && item.html)) {
      for (const asset of item.assets ?? []) queue(asset.id, asset.source, asset.filename);
    } else if (item.kind === "image" && item.source) {
      queue("file", item.source, item.filename);
    } else if (item.kind === "video") {
      pending.push(buildVideo(item, ctx, opts.ownerId, opts.onStatus).then((abs) => slots.set("file", Promise.resolve(abs))));
    } else if (item.kind === "audio") {
      pending.push(buildAudio(item, ctx, opts.onStatus).then((abs) => slots.set("file", Promise.resolve(abs))));
    }
  }
  opts.onStatus?.(`Building ${opts.composition.deliverables.length} file(s)…`);
  await Promise.all(pending);

  const built: BuiltFile[] = [];
  const byFilename = new Map<string, string>();
  for (const row of prepared) {
    if (row.item.kind === "pdf") continue;
    const file = await emitDocument(row.item, row.slots, outDir, opts.onStatus, opts.filesByName);
    built.push(file);
    const printable = file.printPath ?? file.absPath;
    byFilename.set(file.filename.toLowerCase(), row.item.kind === "html" ? printable : file.absPath);
    if (file.printPath) byFilename.set(row.item.filename.toLowerCase(), file.printPath);
  }
  for (const row of prepared) {
    if (row.item.kind !== "pdf") continue;
    const file = await emitPdf(row.item, row.slots, outDir, byFilename, opts.onStatus);
    built.push(file);
    byFilename.set(file.filename.toLowerCase(), file.absPath);
  }
  return built;
}

function assertBuildable(composition: Composition): void {
  const seen = new Set<string>();
  for (const item of composition.deliverables) {
    const name = item.filename.toLowerCase();
    if (seen.has(name)) throw new Error(`Two deliverables use the filename ${item.filename}`);
    seen.add(name);
    if (item.kind === "pptx" && !item.slides?.length) throw new Error(`${item.filename}: a deck needs slides`);
    if (item.kind === "pdf" && !item.html?.trim() && !item.from?.trim()) {
      throw new Error(`${item.filename}: a PDF needs html, or from set to another file in this reply`);
    }
    if (item.kind === "html" && !item.files?.length) throw new Error(`${item.filename}: HTML needs files`);
    if (item.kind === "svg" && !item.svg?.trim()) throw new Error(`${item.filename}: SVG needs the document`);
    if (item.kind === "image" && !item.source) throw new Error(`${item.filename}: an image needs a source`);
    if (item.kind === "video" && !item.clips?.length) throw new Error(`${item.filename}: a video needs clips`);
    if (item.kind === "video" && item.clips && item.clips.length > 12) {
      throw new Error(`${item.filename}: a video can join at most 12 clips`);
    }
    if (item.kind === "video") {
      for (const [index, clip] of (item.clips ?? []).entries()) {
        if (!clip.prompt?.trim() && !clip.file?.trim()) {
          throw new Error(`${item.filename} clip ${index + 1}: needs a prompt or an attached file`);
        }
      }
    }
    const placedAudio =
      item.source?.kind === "place" || (item.places?.length ?? 0) > 0 || Boolean(item.music?.file?.trim());
    const generatedAudio = (item.speech?.length ?? 0) > 0 || Boolean(item.music?.prompt?.trim());
    if (item.kind === "audio" && !placedAudio && !generatedAudio) {
      throw new Error(`${item.filename}: audio needs speech, music, or a placed file`);
    }
    if (item.kind === "pptx") {
      for (const [index, slide] of (item.slides ?? []).entries()) {
        for (const el of slide.elements) {
          if (el.type === "image" && !el.source) {
            throw new Error(`${item.filename} slide ${index + 1}: an image needs place, generate, or svg`);
          }
        }
      }
    }
  }
}

function normalizeComposition(raw: unknown): unknown {
  const root = raw && typeof raw === "object" ? (raw as { deliverables?: unknown }) : {};
  const list = Array.isArray(root.deliverables) ? root.deliverables : [];
  return {
    deliverables: list.map((item, index) => normalizeDeliverable(item, index)).filter(Boolean),
  };
}

function normalizeDeliverable(raw: unknown, index: number): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const kindRaw = String(row.kind ?? row.type ?? row.deliverable ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const kind = KIND_ALIASES[kindRaw];
  if (!kind) throw new Error(`Unknown deliverable kind "${kindRaw || "missing"}"`);
  const filename = String(row.filename ?? row.file ?? row.name ?? "").trim();
  const id = safeId(String(row.id ?? "").trim() || filename.replace(/\.[^.]+$/, "") || `file${index + 1}`);
  const base: Record<string, unknown> = {
    id,
    filename: filename || `${id}.${extensionFor(kind)}`,
    kind,
    font: str(row.font) || str(row.typeface) || str(row.font_family),
    width_in: num(row.width_in),
    height_in: num(row.height_in),
    html: str(row.html),
    from: str(row.from),
    entry: str(row.entry),
    svg: str(row.svg),
    width: num(row.width),
    height: num(row.height),
    duration_sec: num(row.duration_sec),
    fit: fitOf(row.fit),
    pad_color: str(row.pad_color),
    places: strings(row.places),
  };
  if (Array.isArray(row.slides)) {
    base.slides = row.slides.map((slide) => normalizeSlide(slide)).filter(Boolean);
  }
  if (Array.isArray(row.files)) {
    base.files = row.files
      .map((file) => {
        if (!file || typeof file !== "object") return null;
        const f = file as Record<string, unknown>;
        const rel = str(f.path);
        if (!rel) return null;
        return { path: rel, content: String(f.content ?? "") };
      })
      .filter(Boolean);
  }
  if (Array.isArray(row.assets)) {
    base.assets = row.assets
      .map((asset, assetIndex) => normalizeAsset(asset, assetIndex))
      .filter(Boolean);
  }
  if (row.source && typeof row.source === "object") base.source = normalizeSource(row.source);
  if (Array.isArray(row.clips)) {
    base.clips = row.clips
      .map((clip) => {
        if (!clip || typeof clip !== "object") return null;
        const c = clip as Record<string, unknown>;
        const prompt = str(c.prompt);
        let file = str(c.file);
        if (!file && c.source && typeof c.source === "object") {
          const src = c.source as Record<string, unknown>;
          if (String(src.kind ?? src.type ?? "").trim().toLowerCase() === "place") file = str(src.file);
        }
        if (!prompt && !file) return null;
        return {
          prompt,
          file,
          duration_sec: num(c.duration_sec),
          aspect: str(c.aspect),
          references: strings(c.references),
        };
      })
      .filter(Boolean);
  }
  if (Array.isArray(row.speech)) {
    base.speech = row.speech
      .map((cue) => {
        if (!cue || typeof cue !== "object") return null;
        const c = cue as Record<string, unknown>;
        const text = str(c.text);
        if (!text) return null;
        return { text, voice: str(c.voice), style: str(c.style) };
      })
      .filter(Boolean);
  }
  if (row.music && typeof row.music === "object") {
    const music = row.music as Record<string, unknown>;
    const prompt = str(music.prompt);
    const file = str(music.file);
    if (prompt || file) {
      base.music = {
        prompt,
        file,
        instrumental: bool(music.instrumental),
        duration_sec: num(music.duration_sec),
      };
    }
  }
  return base;
}

function normalizeSlide(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const slide = raw as Record<string, unknown>;
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  return {
    notes: str(slide.notes),
    background: str(slide.background),
    font: str(slide.font) || str(slide.typeface),
    elements: elements.map((el) => normalizeElement(el)).filter(Boolean),
  };
}

function normalizeElement(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const el = raw as Record<string, unknown>;
  const typeRaw = String(el.type ?? "text").trim().toLowerCase();
  const type = typeRaw === "shape" ? "shape" : typeRaw === "image" || typeRaw === "image_slot" || typeRaw === "picture" ? "image" : "text";
  let source = el.source && typeof el.source === "object" ? normalizeSource(el.source) : undefined;
  if (!source && type === "image") {
    const prompt = str(el.image_prompt) || str(el.prompt);
    const file = str(el.file) || str(el.image_file);
    const svg = str(el.svg);
    if (svg) source = normalizeSource({ kind: "svg", svg });
    else if (file && !prompt) source = normalizeSource({ kind: "place", file });
    else if (prompt) {
      source = normalizeSource({
        kind: "generate",
        prompt,
        references: strings(el.references),
        width: num(el.width),
        height: num(el.height),
        fit: el.fit,
      });
    }
  }
  return {
    type,
    text: str(el.text),
    x: num(el.x),
    y: num(el.y),
    w: num(el.w),
    h: num(el.h),
    size: num(el.size),
    bold: bool(el.bold),
    color: str(el.color),
    font: str(el.font) || str(el.typeface) || str(el.font_family),
    align: el.align === "center" || el.align === "right" || el.align === "left" ? el.align : undefined,
    fill: str(el.fill),
    source,
  };
}

function normalizeAsset(raw: unknown, index: number): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const asset = raw as Record<string, unknown>;
  const source = asset.source && typeof asset.source === "object" ? normalizeSource(asset.source) : undefined;
  if (!source) return null;
  const id = str(asset.id) || `asset${index + 1}`;
  return {
    id,
    filename: str(asset.filename),
    embed: asset.embed === "data_uri" ? "data_uri" : "path",
    source,
  };
}

function normalizeSource(raw: unknown): MediaSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const kindRaw = String(src.kind ?? src.type ?? "generate").trim().toLowerCase();
  const kind = kindRaw === "place" || kindRaw === "file" ? "place" : kindRaw === "svg" ? "svg" : "generate";
  const mediaRaw = String(src.media ?? "").trim().toLowerCase();
  const media = mediaRaw === "video" || mediaRaw === "audio" || mediaRaw === "image" ? mediaRaw : undefined;
  return {
    kind,
    file: str(src.file),
    prompt: str(src.prompt),
    references: strings(src.references),
    svg: str(src.svg),
    media,
    width: num(src.width),
    height: num(src.height),
    fit: fitOf(src.fit),
    pad_color: str(src.pad_color),
    duration_sec: num(src.duration_sec),
    aspect: str(src.aspect),
    voice: str(src.voice),
    style: str(src.style),
    instrumental: bool(src.instrumental),
  };
}

async function resolveSource(opts: {
  source: MediaSource;
  id: string;
  filename: string;
  ctx: MediaToolContext;
  ownerId: string;
}): Promise<string> {
  const { source, id, ctx } = opts;
  fs.mkdirSync(ctx.stagingDir, { recursive: true });
  if (source.kind === "svg" || source.svg) {
    const svg = source.svg?.trim();
    if (!svg) throw new Error(`${id}: svg source is empty`);
    const rel = `slots/${id}.svg`;
    await runTool(opts.ownerId, id, ctx, "write_svg", { id, svg, filename: rel });
    return ctx.staged.get(id)!.absPath;
  }
  if (source.kind === "place") {
    const file = source.file?.trim();
    if (!file) throw new Error(`${id}: place source needs a filename`);
    const found = findNamed(ctx, file);
    if (!found) throw new Error(`Attached file not found: ${file}`);
    const dest = path.join(ctx.stagingDir, "slots", `${id}${path.extname(found) || ".bin"}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(found, dest);
    return maybeFitImage(dest, source, id, ctx);
  }
  const media = source.media ?? mediaFromName(opts.filename);
  if (media === "video") {
    const prompt = source.prompt?.trim();
    if (!prompt) throw new Error(`${id}: video generate needs a prompt`);
    await runTool(opts.ownerId, id, ctx, "generate_video", {
      id,
      prompt,
      filename: `slots/${id}.mp4`,
      duration_sec: source.duration_sec,
      aspect: source.aspect,
      references: source.references,
    });
    return ctx.staged.get(id)!.absPath;
  }
  if (media === "audio") {
    const prompt = source.prompt?.trim();
    if (!prompt) throw new Error(`${id}: audio generate needs text or a music prompt`);
    const dest = path.join(ctx.stagingDir, "slots", `${id}.wav`);
    if (source.instrumental) {
      await generateLyriaMusic({
        prompt,
        outPath: dest,
        instrumental: true,
        durationSec: source.duration_sec,
        onStatus: ctx.onStatus,
      });
    } else {
      await generateSpeechTts({
        text: prompt,
        outPath: dest,
        voice: source.voice,
        style: source.style,
        onStatus: ctx.onStatus,
      });
    }
    return dest;
  }
  const prompt = source.prompt?.trim();
  if (!prompt) throw new Error(`${id}: image generate needs a prompt`);
  await runTool(opts.ownerId, id, ctx, "generate_image", {
    id,
    prompt,
    filename: `slots/${id}.png`,
    references: source.references,
  });
  return maybeFitImage(ctx.staged.get(id)!.absPath, source, id, ctx);
}

async function maybeFitImage(abs: string, source: MediaSource, id: string, ctx: MediaToolContext): Promise<string> {
  if (!(source.width && source.height) || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(abs)) return abs;
  const fittedId = `${id}-fit`;
  const base = path.basename(abs).toLowerCase();
  ctx.filesByName?.set(base, abs);
  await executeArgonMediaTool(
    "fit_image",
    {
      id: fittedId,
      source: base,
      filename: `slots/${fittedId}.png`,
      width: source.width,
      height: source.height,
      fit: source.fit,
      pad_color: source.pad_color,
    },
    ctx,
  );
  return ctx.staged.get(fittedId)!.absPath;
}

async function runTool(
  ownerId: string,
  id: string,
  ctx: MediaToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  await withGeminiOwner(`${ownerId}:${id}`, () => executeArgonMediaTool(name, args, ctx));
}

async function stagePlaced(
  ctx: MediaToolContext,
  id: string,
  file: string,
  format: "mp4" | "wav" | "png",
): Promise<string> {
  const found = findNamed(ctx, file);
  if (!found) throw new Error(`Attached file not found: ${file}`);
  const dest = path.join(ctx.stagingDir, "slots", `${id}${path.extname(found) || extFallback(format === "mp4" ? "video" : format === "wav" ? "audio" : "image")}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(found) !== path.resolve(dest)) fs.copyFileSync(found, dest);
  ctx.staged.set(id, {
    id,
    format,
    filename: `slots/${path.basename(dest)}`,
    absPath: dest,
    embed: "path",
    mime: format === "mp4" ? "video/mp4" : format === "wav" ? "audio/wav" : "image/png",
  });
  return dest;
}

async function buildVideo(
  item: CompositionDeliverable,
  ctx: MediaToolContext,
  ownerId: string,
  onStatus?: (msg: string) => void,
): Promise<string> {
  const clips = item.clips ?? [];
  const generated = clips.filter((clip) => clip.prompt?.trim()).length;
  onStatus?.(
    generated
      ? `Generating ${generated} clip(s) for ${item.filename}…`
      : `Placing ${clips.length} clip(s) for ${item.filename}…`,
  );
  const ids = await Promise.all(
    clips.map(async (clip, index) => {
      const id = safeId(`${item.id}-clip${index + 1}`);
      if (!clip.prompt?.trim() && clip.file) {
        await stagePlaced(ctx, id, clip.file, "mp4");
        return id;
      }
      await runTool(ownerId, id, ctx, "generate_video", {
        id,
        prompt: clip.prompt,
        filename: `slots/${id}.mp4`,
        duration_sec: clip.duration_sec,
        aspect: clip.aspect,
        references: clip.references,
      });
      return id;
    }),
  );
  let currentId = ids[0]!;
  if (ids.length > 1) {
    const joined = safeId(`${item.id}-joined`);
    await executeArgonMediaTool(
      "join_videos",
      { id: joined, clips: ids, filename: `slots/${joined}.mp4` },
      ctx,
    );
    currentId = joined;
  }
  if (item.width || item.height || item.duration_sec) {
    const fitted = safeId(`${item.id}-fitted`);
    await executeArgonMediaTool(
      "fit_video",
      {
        id: fitted,
        source: currentId,
        filename: `slots/${fitted}.mp4`,
        width: item.width,
        height: item.height,
        duration_sec: item.duration_sec,
        fit: item.fit,
        pad_color: item.pad_color,
      },
      ctx,
    );
    currentId = fitted;
  }
  const abs = ctx.staged.get(currentId)?.absPath;
  if (!abs) throw new Error(`${item.filename}: video was not produced`);
  return abs;
}

async function buildAudio(
  item: CompositionDeliverable,
  ctx: MediaToolContext,
  onStatus?: (msg: string) => void,
): Promise<string> {
  const dir = path.join(ctx.stagingDir, "slots");
  fs.mkdirSync(dir, { recursive: true });
  const pieces: string[] = [];
  const placedNames = [...(item.places ?? [])];
  if (item.source?.kind === "place") {
    const file = item.source.file?.trim();
    if (!file) throw new Error(`${item.filename}: place source needs a filename`);
    if (!placedNames.some((name) => name.toLowerCase() === file.toLowerCase())) placedNames.push(file);
  }
  for (const name of placedNames) {
    const found = findNamed(ctx, name);
    if (!found) throw new Error(`Attached file not found: ${name}`);
    pieces.push(found);
  }
  if (item.speech?.length) {
    onStatus?.(`Generating ${item.speech.length} speech cue(s) for ${item.filename}…`);
    for (let i = 0; i < item.speech.length; i++) {
      const cue = item.speech[i]!;
      const dest = path.join(dir, `${safeId(item.id)}-speech${i + 1}.wav`);
      await generateSpeechTts({
        text: cue.text,
        outPath: dest,
        voice: cue.voice,
        style: cue.style,
        onStatus,
      });
      pieces.push(dest);
    }
  }
  let speechPath: string | undefined;
  if (pieces.length === 1) speechPath = pieces[0];
  else if (pieces.length > 1) {
    speechPath = path.join(dir, `${safeId(item.id)}-speech.wav`);
    await concatAudio(pieces, speechPath);
  }
  let musicPath: string | undefined;
  if (item.music?.file && !item.music.prompt) {
    const found = findNamed(ctx, item.music.file);
    if (!found) throw new Error(`Attached file not found: ${item.music.file}`);
    musicPath = found;
  } else if (item.music?.prompt) {
    onStatus?.(`Generating music for ${item.filename}…`);
    musicPath = path.join(dir, `${safeId(item.id)}-music.wav`);
    await generateLyriaMusic({
      prompt: item.music.prompt,
      outPath: musicPath,
      instrumental: item.music.instrumental ?? true,
      durationSec: item.music.duration_sec,
      onStatus,
    });
  }
  if (speechPath && musicPath) {
    const mixed = path.join(dir, `${safeId(item.id)}-mix.wav`);
    await ffmpeg([
      "-i",
      speechPath,
      "-i",
      musicPath,
      "-filter_complex",
      "[0:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a0];[1:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0",
      "-c:a",
      "pcm_s16le",
      mixed,
    ]);
    return mixed;
  }
  const only = speechPath || musicPath;
  if (!only) throw new Error(`${item.filename}: audio produced no file`);
  return only;
}

async function emitDocument(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
  onStatus?: (msg: string) => void,
  filesByName?: Map<string, string>,
): Promise<BuiltFile> {
  onStatus?.(`Writing ${item.filename}…`);
  if (item.kind === "pptx") return writePptx(item, slots, outDir, filesByName);
  if (item.kind === "html") return writeHtml(item, slots, outDir);
  if (item.kind === "svg") {
    const dest = uniqueDest(outDir, item.filename, ".svg");
    fs.writeFileSync(dest, item.svg ?? "", "utf8");
    return { id: item.id, filename: path.basename(dest), absPath: dest };
  }
  if (item.kind === "image" || item.kind === "video" || item.kind === "audio") {
    const abs = await slots.get("file");
    if (!abs) throw new Error(`${item.filename}: file was not produced`);
    const dest = uniqueDest(outDir, item.filename, path.extname(abs) || extFallback(item.kind));
    fs.copyFileSync(abs, dest);
    return { id: item.id, filename: path.basename(dest), absPath: dest };
  }
  throw new Error(`${item.filename}: unsupported kind ${item.kind}`);
}

async function emitPdf(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
  byFilename: Map<string, string>,
  onStatus?: (msg: string) => void,
): Promise<BuiltFile> {
  onStatus?.(`Writing ${item.filename}…`);
  const dest = uniqueDest(outDir, item.filename, ".pdf");
  if (item.html?.trim()) {
    const folder = path.join(outDir, `${safeId(item.id)}-pdf`);
    fs.mkdirSync(folder, { recursive: true });
    const htmlPath = path.join(folder, "index.html");
    const placed = await placeAssets(item, slots, folder);
    fs.writeFileSync(htmlPath, substituteAssets(item.html, placed, path.dirname(htmlPath)), "utf8");
    const exported = await exportPdf({ sourcePath: htmlPath, outDir: path.dirname(dest), outName: path.basename(dest), onStatus });
    return { id: item.id, filename: path.basename(exported.pdfPath), absPath: exported.pdfPath };
  }
  const from = item.from?.trim().toLowerCase();
  const source = from ? byFilename.get(from) : undefined;
  if (!source) throw new Error(`${item.filename}: from does not match a file in this reply`);
  const exported = await exportPdf({ sourcePath: source, outDir: path.dirname(dest), outName: path.basename(dest), onStatus });
  return { id: item.id, filename: path.basename(exported.pdfPath), absPath: exported.pdfPath };
}

async function writeHtml(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
): Promise<BuiltFile> {
  const folder = path.join(outDir, `${safeId(item.id)}-html`);
  fs.mkdirSync(folder, { recursive: true });
  const placed = await placeAssets(item, slots, folder);
  const written: string[] = [...placed.values()].map((asset) => asset.abs);
  for (const file of item.files ?? []) {
    const rel = safeRel(file.path);
    const dest = path.join(folder, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, substituteAssets(file.content, placed, path.dirname(dest)), "utf8");
    written.push(dest);
  }
  const printPath = htmlEntry(item, folder, written);
  if (written.length === 1 && !(item.assets ?? []).length) {
    const only = written[0]!;
    const dest = uniqueDest(outDir, item.filename, path.extname(only) || ".html");
    fs.copyFileSync(only, dest);
    return { id: item.id, filename: path.basename(dest), absPath: dest, printPath: dest };
  }
  const zipName = item.filename.toLowerCase().endsWith(".zip") ? item.filename : `${stripExt(item.filename)}.zip`;
  const dest = uniqueDest(outDir, zipName, ".zip");
  const zip = new JSZip();
  for (const abs of written) {
    const rel = path.relative(folder, abs).replace(/\\/g, "/");
    zip.file(rel, fs.readFileSync(abs));
  }
  fs.writeFileSync(dest, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return { id: item.id, filename: path.basename(dest), absPath: dest, printPath };
}

function htmlEntry(item: CompositionDeliverable, folder: string, written: string[]): string | undefined {
  const wanted = item.entry?.trim();
  if (wanted) {
    const abs = path.join(folder, safeRel(wanted));
    if (fs.existsSync(abs)) return abs;
  }
  return written.find((abs) => /\.html?$/i.test(abs));
}

async function placeAssets(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  folder: string,
): Promise<Map<string, { abs: string; embed?: "path" | "data_uri" }>> {
  const placed = new Map<string, { abs: string; embed?: "path" | "data_uri" }>();
  for (const asset of item.assets ?? []) {
    const abs = await slots.get(asset.id);
    if (!abs) throw new Error(`${item.filename}: asset ${asset.id} was not produced`);
    const rel = safeRel(asset.filename || `assets/${safeId(asset.id)}${path.extname(abs) || ".bin"}`);
    const dest = path.join(folder, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(abs) !== path.resolve(dest)) fs.copyFileSync(abs, dest);
    placed.set(asset.id, { abs: dest, embed: asset.embed });
  }
  return placed;
}

function substituteAssets(
  content: string,
  placed: Map<string, { abs: string; embed?: "path" | "data_uri" }>,
  fromDir: string,
): string {
  let out = content;
  for (const [id, asset] of placed) {
    const token = `{{asset:${id}}}`;
    const replacement =
      asset.embed === "data_uri" && /\.(png|jpe?g|svg|webp|gif)$/i.test(asset.abs)
        ? `data:${mimeForPath(asset.abs)};base64,${fs.readFileSync(asset.abs).toString("base64")}`
        : path.relative(fromDir, asset.abs).replace(/\\/g, "/");
    out = out.split(token).join(replacement);
  }
  return out;
}

function latinTypeface(font: string | undefined): string {
  if (!font?.trim()) return "";
  return `<a:latin typeface="${escXml(font.trim())}"/>`;
}

type FontFace = { family: string; subfamily: string; abs: string; bytes: Buffer };
type EmbeddedFile = { guid: string; rId: string; bytes: Buffer; slot: "regular" | "bold" | "italic" | "boldItalic" };
type EmbeddedFamily = { typeface: string; files: EmbeddedFile[] };

function typefacesIn(item: CompositionDeliverable): string[] {
  const used = new Map<string, string>();
  const add = (font?: string) => {
    const name = font?.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!used.has(key)) used.set(key, name);
  };
  for (const slide of item.slides ?? []) {
    add(slide.font || item.font);
    for (const el of slide.elements) add(el.font || slide.font || item.font);
  }
  return [...used.values()];
}

function embedNamedFonts(typefaces: string[], filesByName: Map<string, string> | undefined, firstRid: number): EmbeddedFamily[] {
  const faces = readAttachedFaces(filesByName);
  if (!faces.length || !typefaces.length) return [];
  let nextRid = firstRid;
  const embedded: EmbeddedFamily[] = [];
  for (const typeface of typefaces) {
    const matches = faces.filter((face) => faceMatches(face, typeface));
    if (!matches.length) continue;
    const chosen = new Map<EmbeddedFile["slot"], FontFace>();
    for (const face of matches) {
      const { slot, rank } = fontSlot(face.subfamily);
      const current = chosen.get(slot);
      if (!current || rank > fontSlot(current.subfamily).rank) chosen.set(slot, face);
    }
    if (!chosen.has("regular")) {
      const fallback = matches.find((face) => fontSlot(face.subfamily).slot === "bold") ?? matches[0]!;
      chosen.set("regular", fallback);
    }
    const byPath = new Map<string, EmbeddedFile>();
    const files: EmbeddedFile[] = [];
    for (const slot of ["regular", "bold", "italic", "boldItalic"] as const) {
      const face = chosen.get(slot);
      if (!face) continue;
      let file = byPath.get(face.abs);
      if (!file) {
        const guid = randomUUID();
        file = { guid, rId: `rId${nextRid}`, bytes: obfuscateFont(face.bytes, guid), slot };
        nextRid += 1;
        byPath.set(face.abs, file);
        files.push(file);
      }
      if (file.slot !== slot) files.push({ ...file, slot });
    }
    embedded.push({ typeface, files });
  }
  return embedded;
}

function embeddedFontListXml(embedded: EmbeddedFamily[]): string {
  if (!embedded.length) return "";
  const items = embedded
    .map((face) => {
      const styles = ["regular", "bold", "italic", "boldItalic"]
        .map((slot) => {
          const file = face.files.find((item) => item.slot === slot);
          return file ? `<p:${slot} r:id="${file.rId}"/>` : "";
        })
        .join("");
      return `<p:embeddedFont><p:font typeface="${escXml(face.typeface)}"/>${styles}</p:embeddedFont>`;
    })
    .join("");
  return `<p:embeddedFontLst>${items}</p:embeddedFontLst>`;
}

function faceMatches(face: FontFace, requested: string): boolean {
  const want = requested.trim().toLowerCase();
  const family = face.family.toLowerCase();
  const full = `${family} ${face.subfamily.toLowerCase()}`;
  const stem = path.basename(face.abs, path.extname(face.abs)).toLowerCase();
  return want === family || want === full || want === stem || want.replace(/[-_]+/g, " ") === stem.replace(/[-_]+/g, " ");
}

function fontSlot(subfamily: string): { slot: EmbeddedFile["slot"]; rank: number } {
  const name = subfamily.toLowerCase();
  const italic = /italic|oblique/.test(name);
  const heavy = /\b(bold|black|heavy)\b/.test(name) && !/semi|demi/.test(name);
  const semi = /semi|demi|medium/.test(name);
  if (heavy && italic) return { slot: "boldItalic", rank: 2 };
  if (heavy) return { slot: "bold", rank: 2 };
  if (semi && italic) return { slot: "boldItalic", rank: 1 };
  if (semi) return { slot: "bold", rank: 1 };
  if (italic) return { slot: "italic", rank: 2 };
  return { slot: "regular", rank: /light|thin/.test(name) ? 0 : 1 };
}

function readAttachedFaces(filesByName?: Map<string, string>): FontFace[] {
  if (!filesByName) return [];
  const seen = new Set<string>();
  const faces: FontFace[] = [];
  for (const abs of filesByName.values()) {
    if (!/\.(ttf|otf)$/i.test(abs) || !fs.existsSync(abs)) continue;
    const key = path.resolve(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = fs.readFileSync(abs);
    const names = readFontNames(bytes);
    if (!names) continue;
    faces.push({ ...names, abs, bytes });
  }
  return faces;
}

function readFontNames(buf: Buffer): { family: string; subfamily: string } | null {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) === "ttcf") return null;
  const numTables = buf.readUInt16BE(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString("latin1", rec, rec + 4) !== "name") continue;
    nameOffset = buf.readUInt32BE(rec + 8);
    break;
  }
  if (nameOffset < 0 || nameOffset + 6 > buf.length) return null;
  const count = buf.readUInt16BE(nameOffset + 2);
  const stringOffset = buf.readUInt16BE(nameOffset + 4);
  const found = new Map<number, { score: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > buf.length) break;
    const platformID = buf.readUInt16BE(rec);
    const nameID = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = buf.readUInt16BE(rec + 10);
    if (![1, 2, 16, 17].includes(nameID)) continue;
    const start = nameOffset + stringOffset + offset;
    if (start < 0 || start + length > buf.length) continue;
    const text = (platformID === 3 || platformID === 0 ? decodeUtf16BE(buf.subarray(start, start + length)) : platformID === 1 ? buf.toString("latin1", start, start + length) : "")
      .replace(/\0/g, "")
      .trim();
    if (!text) continue;
    const score = (platformID === 3 ? 2 : 1) + (nameID >= 16 ? 1 : 0);
    const prev = found.get(nameID);
    if (!prev || score > prev.score) found.set(nameID, { score, text });
  }
  const family = found.get(16)?.text || found.get(1)?.text;
  if (!family) return null;
  return { family, subfamily: found.get(17)?.text || found.get(2)?.text || "Regular" };
}

function decodeUtf16BE(buf: Buffer): string {
  let text = "";
  for (let i = 0; i + 1 < buf.length; i += 2) text += String.fromCharCode((buf[i]! << 8) | buf[i + 1]!);
  return text;
}

function obfuscateFont(bytes: Buffer, guid: string): Buffer {
  const key = guidBytes(guid);
  const out = Buffer.from(bytes);
  const n = Math.min(32, out.length);
  for (let i = 0; i < n; i++) out[i] = out[i]! ^ key[i % 16]!;
  return out;
}

function guidBytes(guid: string): Buffer {
  const raw = Buffer.from(guid.replace(/-/g, ""), "hex");
  if (raw.length !== 16) throw new Error(`Bad font id ${guid}`);
  const out = Buffer.alloc(16);
  out[0] = raw[3]!;
  out[1] = raw[2]!;
  out[2] = raw[1]!;
  out[3] = raw[0]!;
  out[4] = raw[5]!;
  out[5] = raw[4]!;
  out[6] = raw[7]!;
  out[7] = raw[6]!;
  raw.copy(out, 8, 8, 16);
  return out;
}

async function writePptx(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
  filesByName?: Map<string, string>,
): Promise<BuiltFile> {
  const slides = item.slides ?? [];
  const slideW = Math.round((item.width_in ?? 13.333) * EMU_PER_INCH);
  const slideH = Math.round((item.height_in ?? 7.5) * EMU_PER_INCH);
  const zip = new JSZip();
  const noteSlides = slides.flatMap((slide, index) => (slide.notes?.trim() ? [index + 1] : []));
  const embedded = embedNamedFonts(typefacesIn(item), filesByName, slides.length + 2);
  zip.file("[Content_Types].xml", contentTypes(slides.length, noteSlides, embedded.length > 0));
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
  );
  const ppt = zip.folder("ppt")!;
  const sldIdLst = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  ppt.file(
    "presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst/>
  <p:sldIdLst>${sldIdLst}</p:sldIdLst>
  <p:sldSz cx="${slideW}" cy="${slideH}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  ${embeddedFontListXml(embedded)}
</p:presentation>`,
  );
  const fontFiles = [...new Map(embedded.flatMap((face) => face.files).map((file) => [file.rId, file])).values()];
  if (fontFiles.length) {
    const fontFolder = ppt.folder("fonts")!;
    for (const file of fontFiles) fontFolder.file(`${file.guid}.fntdata`, file.bytes);
  }
  ppt.folder("_rels")!.file(
    "presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  )
  .join("\n")}
${fontFiles
  .map(
    (file) =>
      `<Relationship Id="${file.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${file.guid}.fntdata"/>`,
  )
  .join("\n")}
</Relationships>`,
  );
  if (noteSlides.length) {
    ppt.folder("notesMasters")!.file("notesMaster1.xml", notesMasterXml());
  }
  const slidesFolder = ppt.folder("slides")!;
  const relFolder = slidesFolder.folder("_rels")!;
  const mediaFolder = ppt.folder("media")!;
  let mediaIndex = 0;
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!;
    const rels: string[] = [];
    const images: Array<{ rId: string; abs: string }> = [];
    for (let e = 0; e < slide.elements.length; e++) {
      const el = slide.elements[e]!;
      if (el.type !== "image" || !el.source) continue;
      const abs = await slots.get(`s${i}e${e}`);
      if (!abs) throw new Error(`${item.filename} slide ${i + 1}: image was not produced`);
      mediaIndex += 1;
      const packed = await packImage(abs, path.join(outDir, ".pptx_media"), `${item.id}-${mediaIndex}`);
      const name = `image${mediaIndex}.${packed.ext}`;
      mediaFolder.file(name, fs.readFileSync(packed.abs));
      const rId = `rId${rels.length + 1}`;
      images.push({ rId, abs: packed.abs });
      rels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`,
      );
    }
    let notesRid = "";
    if (slide.notes?.trim()) {
      notesRid = `rId${rels.length + 1}`;
      rels.push(
        `<Relationship Id="${notesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`,
      );
      const notesFolder = ppt.folder("notesSlides")!;
      notesFolder.file(`notesSlide${i + 1}.xml`, notesSlideXml(slide.notes, slide.font || item.font));
      notesFolder.folder("_rels")!.file(
        `notesSlide${i + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${i + 1}.xml"/>
</Relationships>`,
      );
    }
    slidesFolder.file(`slide${i + 1}.xml`, slideXml(slide, slideW, slideH, images.map((image) => image.rId), item.font));
    relFolder.file(
      `slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join("\n")}
</Relationships>`,
    );
  }
  const dest = uniqueDest(outDir, item.filename, ".pptx");
  fs.writeFileSync(dest, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return { id: item.id, filename: path.basename(dest), absPath: dest };
}

function slideXml(
  slide: z.infer<typeof slideSchema>,
  slideW: number,
  slideH: number,
  imageRids: string[],
  deckFont?: string,
): string {
  const shapes: string[] = [];
  let shapeId = 2;
  let imageCursor = 0;
  const bg = hex6(slide.background, "FFFFFF");
  for (const el of slide.elements) {
    const box = pctBox(slideW, slideH, el.x ?? 5, el.y ?? 5, el.w ?? (el.type === "text" ? 90 : 40), el.h ?? 20);
    if (el.type === "image") {
      const rId = imageRids[imageCursor];
      imageCursor += 1;
      if (rId) {
        shapes.push(`<p:pic>
        <p:nvPicPr>
          <p:cNvPr id="${shapeId}" name="Picture ${shapeId}"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="${rId}"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>`);
      }
      shapeId += 1;
      continue;
    }
    const fill = hex6(el.fill, "");
    const solid = el.type === "shape" && fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : `<a:noFill/>`;
    const color = hex6(el.color, "111111");
    const size = Math.min(96, Math.max(8, Math.round(el.size ?? (el.bold ? 28 : 16))));
    const align = el.align === "center" ? "ctr" : el.align === "right" ? "r" : "l";
    const bold = el.bold ? "<a:b/>" : "";
    const latin = latinTypeface(el.font || slide.font || deckFont);
    const paragraphs = (el.text ?? "").split(/\n/).map((line) => `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="en-US" sz="${size * 100}" dirty="0">${bold}<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${latin}</a:rPr><a:t>${escXml(line)}</a:t></a:r></a:p>`).join("");
    shapes.push(`<p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${shapeId}" name="Shape ${shapeId}"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          ${solid}
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/>
          <a:lstStyle/>
          ${paragraphs || `<a:p><a:endParaRPr lang="en-US"/></a:p>`}
        </p:txBody>
      </p:sp>`);
    shapeId += 1;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes.join("\n")}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function notesSlideXml(notes: string, font?: string): string {
  const latin = latinTypeface(font);
  const paragraphs = notes.split(/\n/).map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="1200" dirty="0">${latin}</a:rPr><a:t>${escXml(line)}</a:t></a:r></a:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;
}

function notesMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:notesMaster>`;
}

function contentTypes(slideCount: number, noteSlides: number[], fonts = false): string {
  const slides = Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const noteParts = noteSlides
    .map((n) => `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`)
    .join("");
  const noteMaster = noteSlides.length
    ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  ${fonts ? `<Default Extension="fntdata" ContentType="application/x-fontdata"/>` : ""}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slides}
  ${noteMaster}
  ${noteParts}
</Types>`;
}

async function packImage(src: string, dir: string, id: string): Promise<{ abs: string; ext: "png" | "jpeg" | "svg" }> {
  const ext = path.extname(src).toLowerCase();
  if (ext === ".png") return { abs: src, ext: "png" };
  if (ext === ".jpg" || ext === ".jpeg") return { abs: src, ext: "jpeg" };
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${safeId(id)}.png`);
  if (ext === ".svg") {
    if (await rasterizeSvg(src, dest)) return { abs: dest, ext: "png" };
    return { abs: src, ext: "svg" };
  }
  await ffmpeg(["-i", src, "-frames:v", "1", dest]);
  return { abs: dest, ext: "png" };
}

async function rasterizeSvg(src: string, dest: string): Promise<boolean> {
  try {
    await ffmpeg(["-i", src, "-frames:v", "1", dest]);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
  } catch {
    /* This ffmpeg build has no SVG decoder. */
  }
  fs.rmSync(dest, { force: true });
  const size = svgPixelSize(fs.readFileSync(src, "utf8"));
  const fileUrl = `file:///${src.replace(/\\/g, "/")}`;
  for (const bin of chromeBins()) {
    try {
      await execFileAsync(bin, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        `--window-size=${size.width},${size.height}`,
        `--screenshot=${dest}`,
        fileUrl,
      ], { timeout: 60_000, windowsHide: true });
    } catch {
      /* try the next browser */
    }
    if (fs.existsSync(dest) && fs.statSync(dest).size > 32) return true;
    fs.rmSync(dest, { force: true });
  }
  const dir = path.dirname(dest);
  const staged = path.join(dir, `${path.basename(dest, ".png")}.svg`);
  if (path.resolve(staged) !== path.resolve(src)) fs.copyFileSync(src, staged);
  for (const bin of officeBins()) {
    try {
      await execFileAsync(bin, [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "png",
        "--outdir",
        dir,
        staged,
      ], { timeout: 120_000, windowsHide: true });
    } catch {
      /* try the next LibreOffice */
    }
    if (fs.existsSync(dest) && fs.statSync(dest).size > 32) {
      if (path.resolve(staged) !== path.resolve(src)) fs.rmSync(staged, { force: true });
      return true;
    }
  }
  if (path.resolve(staged) !== path.resolve(src)) fs.rmSync(staged, { force: true });
  return false;
}

function svgPixelSize(svg: string): { width: number; height: number } {
  const width = Number(svg.match(/\bwidth="([\d.]+)/)?.[1]);
  const height = Number(svg.match(/\bheight="([\d.]+)/)?.[1]);
  const viewBox = svg.match(/\bviewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/);
  const w = Math.round(width || Number(viewBox?.[1]) || 256);
  const h = Math.round(height || Number(viewBox?.[2]) || 256);
  return {
    width: Math.min(2048, Math.max(16, w)),
    height: Math.min(2048, Math.max(16, h)),
  };
}

function officeBins(): string[] {
  return existingBins([
    process.env.LIBREOFFICE_BIN,
    process.env.SOFFICE_BIN,
    "soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
  ]);
}

function chromeBins(): string[] {
  return existingBins([
    process.env.CHROMIUM_BIN,
    process.env.CHROME_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]);
}

function existingBins(candidates: Array<string | undefined>): string[] {
  const bins: string[] = [];
  for (const bin of candidates) {
    if (!bin) continue;
    if ((bin.includes("\\") || bin.includes("/")) && !fs.existsSync(bin)) continue;
    bins.push(bin);
  }
  return bins;
}

async function concatAudio(files: string[], dest: string): Promise<void> {
  const chains = files.map(
    (_, index) => `[${index}:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a${index}]`,
  );
  const labels = files.map((_, index) => `[a${index}]`).join("");
  await ffmpeg([
    ...files.flatMap((file) => ["-i", file]),
    "-filter_complex",
    `${chains.join(";")};${labels}concat=n=${files.length}:v=0:a=1[a]`,
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    dest,
  ]);
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg failed: ${message.slice(0, 500)}`);
  }
}

function findNamed(ctx: MediaToolContext, name: string): string | undefined {
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

function cacheKey(source: MediaSource): string {
  if (source.kind === "place") {
    return `place|${source.file?.toLowerCase()}|${source.width ?? ""}|${source.height ?? ""}|${source.fit ?? ""}`;
  }
  if (source.kind === "svg") return `svg|${source.svg ?? ""}`;
  return [
    "gen",
    source.media ?? "",
    source.prompt ?? "",
    (source.references ?? []).join(","),
    source.width ?? "",
    source.height ?? "",
    source.fit ?? "",
    source.duration_sec ?? "",
    source.aspect ?? "",
    source.instrumental ? "1" : "0",
  ].join("|");
}

function defaultMediaName(source: MediaSource, slotId: string): string {
  if (source.kind === "svg") return `${slotId}.svg`;
  if (source.media === "video") return `${slotId}.mp4`;
  if (source.media === "audio") return `${slotId}.wav`;
  return `${slotId}.png`;
}

function mediaFromName(filename: string): "image" | "video" | "audio" {
  if (/\.(mp4|mov|webm)$/i.test(filename)) return "video";
  if (/\.(wav|mp3|m4a|aac)$/i.test(filename)) return "audio";
  return "image";
}

function mimeForPath(abs: string): string {
  if (/\.png$/i.test(abs)) return "image/png";
  if (/\.jpe?g$/i.test(abs)) return "image/jpeg";
  if (/\.svg$/i.test(abs)) return "image/svg+xml";
  if (/\.webp$/i.test(abs)) return "image/webp";
  if (/\.gif$/i.test(abs)) return "image/gif";
  return "application/octet-stream";
}

function extensionFor(kind: CompositionDeliverable["kind"]): string {
  if (kind === "pptx") return "pptx";
  if (kind === "pdf") return "pdf";
  if (kind === "svg") return "svg";
  if (kind === "video") return "mp4";
  if (kind === "audio") return "wav";
  if (kind === "image") return "png";
  return "html";
}

function extFallback(kind: "image" | "video" | "audio"): string {
  if (kind === "video") return ".mp4";
  if (kind === "audio") return ".wav";
  return ".png";
}

function uniqueDest(dir: string, filename: string, fallbackExt: string): string {
  const base = path.basename(filename).replace(/[^\w.\-()+ ]+/g, "_") || `file${fallbackExt}`;
  const ext = path.extname(base) ? "" : fallbackExt;
  let dest = path.join(dir, `${base}${ext}`);
  if (!fs.existsSync(dest)) return dest;
  const stem = path.basename(dest, path.extname(dest));
  const useExt = path.extname(dest);
  let n = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem}-${n}${useExt}`);
    n += 1;
  }
  return dest;
}

function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.split("/").includes("..")) throw new Error(`Unsafe path: ${rel}`);
  return norm;
}

function safeId(raw: string): string {
  const id = raw.replace(/[^\w.-]+/g, "_").replace(/^_+/, "").slice(0, 60);
  return id || "file";
}

function stripExt(filename: string): string {
  const base = path.basename(filename);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function fitOf(value: unknown): "contain" | "cover" | "stretch" | undefined {
  const fit = String(value ?? "").trim().toLowerCase();
  if (fit === "contain" || fit === "cover" || fit === "stretch") return fit;
  return undefined;
}

function hex6(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9A-Fa-f]{6}$/.test(raw)) return raw.toUpperCase();
  if (/^[0-9A-Fa-f]{3}$/.test(raw)) return raw.split("").map((ch) => ch + ch).join("").toUpperCase();
  return fallback;
}

function escXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pctBox(slideW: number, slideH: number, x: number, y: number, w: number, h: number) {
  const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));
  return {
    x: Math.round((clamp(x, 100) / 100) * slideW),
    y: Math.round((clamp(y, 100) / 100) * slideH),
    cx: Math.max(1, Math.round((clamp(w, 100) / 100) * slideW)),
    cy: Math.max(1, Math.round((clamp(h, 100) / 100) * slideH)),
  };
}
