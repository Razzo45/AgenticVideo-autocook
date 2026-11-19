/**
 * One brain reply is the deliverable. The platform builds the file and generates
 * only the pictures, clips, and audio that reply names.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { z } from "zod";
import { executeMediaTool, type MediaToolContext } from "../autocook/mediaTools";
import { exportPdf } from "../autocook/exportPdf";
import { withGeminiOwner } from "./geminiAdmission";
import type { BrainLabel } from "./brainChoice";
import { generateLyriaMusic, generateSpeechTts } from "./geminiAudio";
import { assertInlinable, expandInlineFiles, inlineNames, lookupInlineFile } from "./inlineFiles";
import { stage } from "./stageLog";
import { convertImage, encodeMediaTo, extensionFor as imageExtension, formatForFilename, sniffImage } from "./mediaFormat";
import { embeddingAllowed, toEot } from "./eot";
import { installedFontsLine, libreOfficeBinary } from "./renderEnv";
import { VIDEO_PROMPT_MAX_CHARS } from "./videoLimits";
import { recordPlatformNote, takePlatformNotes } from "./platformNotes";
import { prepareFonts, substitutionNote } from "./fontFetch";

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
  /** Gain on the music in dB (0 = as generated). */
  level_db: z.number().optional(),
  /** How long the mix runs: the speech (default), the music, or the longer of the two. */
  until: z.enum(["speech", "music", "longest"]).optional(),
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
  /** Brain intent: keep plate/generator audio, or strip it before the platform encode. */
  audio: z.enum(["keep", "mute"]).optional(),
  speech: z.array(speechSchema).optional(),
  /** Gain on the speech in dB when music is mixed under it. */
  speech_level_db: z.number().optional(),
  music: musicSchema.optional(),
  places: z.array(z.string().min(1)).optional(),
});
export type CompositionDeliverable = z.infer<typeof deliverableSchema>;

export const compositionSchema = z.object({
  deliverables: z.array(deliverableSchema).min(1),
});
export type Composition = z.infer<typeof compositionSchema>;

export type BuiltFile = {
  id: string;
  filename: string;
  absPath: string;
  printPath?: string;
  /** What the platform did to this file that the brain did not write (a cut prompt, a fallback). */
  notes?: string[];
};

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

export { VIDEO_PROMPT_MAX_CHARS } from "./videoLimits";

/**
 * What the generators and renderers on this worker do, stated as facts. Shared by the
 * plan brief and the execute instruction so the brain plans within them.
 */
export function generatorFacts(): string {
  const fonts = installedFontsLine();
  const office = Boolean(libreOfficeBinary());
  return `Generator and renderer facts:
- Pictures: the image model chooses its own pixel size; width and height on a source resize the result. References must be pictures (png, jpg, webp, gif, svg).
- Video clips: 3–10 seconds, 16:9 or 9:16. References are pictures only; an attached video can be placed, fitted and joined, not used as generator input. A video prompt is sent as written up to ${VIDEO_PROMPT_MAX_CHARS} characters; a longer prompt is cut there and the cut is recorded with the deliverable.
- Music prompts: artist names, record labels and "in the style of …" phrases are removed before sending, and "kids"/"children's" are reworded, because the music model refuses them.
- PDF: HTML prints in Chromium. ${office ? "A pptx prints through LibreOffice." : "A pdf cannot be made from a pptx on this worker (no LibreOffice); write its HTML instead."}
- Decks: ${pptxEmbedFonts() ? "an attached font file whose family a deck names is embedded in the deck." : "fonts are not embedded; a viewer without the named family installed substitutes another."}${
    fonts
      ? `\n- Fonts where the worker draws (a PDF printed from HTML, a picture drawn from SVG): ${fonts} are installed. Any other family the markup names is fetched by name from the Google Fonts collection before drawing. A family that is neither (a commercial face) is drawn in a substitute, and the substitution is recorded with the file, unless its font file is attached and loaded with @font-face. SVG, HTML and pptx files you deliver are drawn by the viewer, with whatever fonts the viewer has.`
      : ""
  }`;
}

export function composeInstructions(
  planned: unknown[],
  attachedNames: string[],
  brain: BrainLabel = "Argon",
  otherPlannedFilenames: string[] = [],
  shared?: string,
): string {
  const plan = planned.length ? JSON.stringify(planned) : "(none — the operator message names the files)";
  const attached = attachedNames.length ? attachedNames.join(", ") : "(none)";
  const others = otherPlannedFilenames.map((name) => name.trim()).filter(Boolean);
  const onlyThis =
    planned.length === 1
      ? `\nThis turn is only the planned file above. Reply with one deliverable for that file. Do not add other files.\n`
      : "";
  const otherBlock = others.length
    ? `\nOther files named in this task. A pdf may set "from" to one of these filenames. Do not rewrite those files in this reply.\n${others.join("\n")}\n`
    : "";
  const sharedBlock = shared?.trim() ? `\nDecisions shared by every file of this task (from your plan):\n${shared.trim()}\n` : "";
  return `You are ${brain}. The operator message and the attached files are the whole job.
Reply with one JSON object and nothing else. This reply is the deliverable. Write the copy, the notes, the layout, the HTML, and the SVG here.
${onlyThis}
{"deliverables":[{"id":"<string>","filename":"<string>","kind":"pptx"|"pdf"|"html"|"svg"|"image"|"video"|"audio"}]}

<…> marks a value you choose. A field you leave out takes the default named beside it.

kind "pptx" — "width_in", "height_in" (default 13.333 and 7.5), "font" (optional), "slides":[]. A slide has "notes" (the full speaker notes), "background":"<hex colour>" (optional), "font" (optional) and "elements":[].
x, y, w, h are percentages of the slide; below 0 or above 100 sits past the edge.
{"type":"text","text":"<text>","x":<number>,"y":<number>,"w":<number>,"h":<number>,"size":<points>,"bold":<true|false>,"color":"<hex colour>","align":"left"|"center"|"right","font":"<family name>"}
Text defaults: size 28 when bold, else 16; color 111111; align left. A font on the slide or the deck applies where a text element does not name one. Text with no font names no typeface.
{"type":"shape","x":<number>,"y":<number>,"w":<number>,"h":<number>,"fill":"<hex colour>"}
{"type":"image","x":<number>,"y":<number>,"w":<number>,"h":<number>,"source":{"kind":"place","file":"<attached filename>"}}
{"type":"image","x":<number>,"y":<number>,"w":<number>,"h":<number>,"source":{"kind":"generate","prompt":"<prompt>","references":["<attached filename>"],"width":<pixels>,"height":<pixels>,"fit":"contain"|"cover"|"stretch"}}
{"type":"image","x":<number>,"y":<number>,"w":<number>,"h":<number>,"source":{"kind":"svg","svg":"<svg markup>"}}
Place a file that is already in the package. generate is for a picture that does not exist yet. svg is markup you write. width and height on a source are the exact pixels (fit default contain, padded white). A picture fills its x, y, w, h box exactly.

kind "pdf" — a complete HTML document in "html", or "from" set to the filename of a pptx or html named in this task (this reply or another planned file).
In that HTML, list "assets" and write {{asset:id}} where one should appear.
{"id":"<asset id>","filename":"<path in the package>","source":{"kind":"place","file":"<attached filename>"}}

kind "html" — "entry" and "files":[{"path":"<path>","content":"<the file>"}] plus "assets" as above. {{asset:id}} in the file contents. File contents are written as you wrote them, apart from those tokens.

kind "svg" — "svg" is the full document.
Optional tool write_svg: when a mark is large (outlined logos, many paths), call write_svg once per file with the full markup, then in this JSON use the same id and filename and omit "svg" (or leave it empty). Small SVGs may still be inlined here. Tools are optional — ordinary tasks can reply with JSON only and never call them. When several large SVGs are planned, prefer one write_svg per turn (not all marks in one reply), then thin JSON.

kind "image" — "source" is place, generate, or svg. The file is written in the format its filename names.

kind "video" — "clips" in play order.
{"file":"<attached filename>"} places an attached clip.
{"prompt":"<prompt>","duration_sec":<3 to 10>,"aspect":"16:9"|"9:16","references":["<attached picture>"]} generates one (default 5 seconds, 16:9).
width, height, and duration_sec on the deliverable are the finished file. The platform joins the clips and fits that file, and writes it in the format its filename names.
"audio":"keep" keeps plate/generator audio through join/fit (only the size/duration/order work you asked for). "audio":"mute" strips audio before that encode. Set this from the job — the platform does not invent mute vs keep.

kind "audio" — attached files play first, then speech, and music is mixed under that. The file is written in the format its filename names.
"places":["<attached filename>"] or "source":{"kind":"place","file":"<attached filename>"}
"speech":[{"text":"<text>","voice":"<voice name>","style":"<delivery>"}] (default voice Sulafat)
"music":{"file":"<attached filename>"} or "music":{"prompt":"<prompt>","instrumental":<true|false>,"duration_sec":<seconds>} (default instrumental)
Mix, optional: "speech_level_db":<dB> on the deliverable, and on music "level_db":<dB> and "until":"speech"|"music"|"longest" (how long the mix runs; default speech). With no level set, speech and music are mixed at equal weight.

Attached files inside your markup — write {{inline:exact-name.svg}} where the file should go, in any HTML or SVG you write. The platform pastes the file there, unchanged. An SVG is pasted as its markup, so your CSS can still size and recolour it. Its ids are prefixed, so the same token may be used several times and two marks never collide. A png or jpg becomes a data: URI for src or url(), and so does an SVG when the token sits inside src="…" or url(…). Do not retype the contents of an attached file. Name it.

${generatorFacts()}

Produce the planned files under the planned filenames. One object per file.

Planned files:
${plan}
${sharedBlock}${otherBlock}
Attached filenames you can place:
${attached}`;
}

/**
 * The instruction shared by every call of one task. It lists the whole plan, and is
 * the same for every file, so it can sit in a context cache with the operator's files.
 */
export function composeTaskInstructions(
  planned: unknown[],
  attachedNames: string[],
  brain: BrainLabel = "Argon",
  shared?: string,
): string {
  // Each file's own brief goes in its turn, not here, so this text is the same for every call.
  const list = planned.map((item) => {
    if (!item || typeof item !== "object") return item;
    const { brief: _brief, ...rest } = item as Record<string, unknown>;
    return rest;
  });
  return `${composeInstructions(list, attachedNames, brain, [], shared)}
Each turn names the planned file or files to write in that reply. Write only those.`;
}

/** The short turn after the shared instruction and files: which planned file to write now. */
export function sliceTurnText(slice: unknown[], otherPlannedFilenames: string[] = []): string {
  const others = otherPlannedFilenames.map((name) => name.trim()).filter(Boolean);
  const otherBlock = others.length
    ? `\nOther files named in this task. A pdf may set "from" to one of these filenames. Do not rewrite those files in this reply.\n${others.join("\n")}\n`
    : "";
  const one = slice.length === 1;
  return `Write ${one ? "this planned file" : "these planned files"} now. Reply with one JSON object holding ${
    one ? "one deliverable for it" : "one deliverable per file listed"
  }. Do not add other files.
${JSON.stringify(slice)}
${otherBlock}`;
}

/**
 * Fill empty kind:"svg" bodies from files the brain already wrote with write_svg
 * (same id or filename). Keeps one-shot JSON for small marks; tools for large ones.
 */
export function hydrateSvgFromStaged(
  composition: Composition,
  stagedSvg: Map<string, string>,
): Composition {
  if (!stagedSvg.size) return composition;
  return {
    ...composition,
    deliverables: composition.deliverables.map((item) => {
      if (item.kind !== "svg" || item.svg?.trim()) return item;
      const byId = stagedSvg.get(item.id);
      const byFile = stagedSvg.get(item.filename) ?? stagedSvg.get(item.filename.toLowerCase());
      const svg = (byId ?? byFile ?? "").trim();
      return svg ? { ...item, svg } : item;
    }),
  };
}

export type StagedHtmlFile = { content: string; path: string };

/**
 * Fill empty kind:"html" files from write_html (same id or filename).
 * Platform stores the markup unchanged.
 */
export function hydrateHtmlFromStaged(
  composition: Composition,
  stagedHtml: Map<string, StagedHtmlFile>,
): Composition {
  if (!stagedHtml.size) return composition;
  return {
    ...composition,
    deliverables: composition.deliverables.map((item) => {
      if (item.kind !== "html") return item;
      const hasContent = (item.files ?? []).some((file) => file.content.trim());
      if (hasContent) return item;
      const byId = stagedHtml.get(item.id);
      const byFile = stagedHtml.get(item.filename) ?? stagedHtml.get(item.filename.toLowerCase());
      const staged = byId ?? byFile;
      if (!staged?.content.trim()) return item;
      const entry = item.entry?.trim() || staged.path || "index.html";
      return {
        ...item,
        entry,
        files: [{ path: entry, content: staged.content }],
      };
    }),
  };
}

export function parseComposition(
  text: string,
  opts?: {
    stagedSvg?: Map<string, string>;
    stagedHtml?: Map<string, StagedHtmlFile>;
    /** When set, every {{inline:name}} must name one of these files. */
    filesByName?: Map<string, string>;
  },
): Composition {
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
  let data = parsed.data;
  if (opts?.stagedSvg?.size) data = hydrateSvgFromStaged(data, opts.stagedSvg);
  if (opts?.stagedHtml?.size) data = hydrateHtmlFromStaged(data, opts.stagedHtml);
  assertBuildable(data);
  if (opts?.filesByName) assertInlineFilesExist(data, opts.filesByName);
  return data;
}

/** Every markup string of one deliverable that may carry {{inline:...}}. */
function markupOf(item: CompositionDeliverable): string[] {
  const out: string[] = [];
  if (item.html) out.push(item.html);
  if (item.svg) out.push(item.svg);
  if (item.source?.svg) out.push(item.source.svg);
  for (const file of item.files ?? []) out.push(file.content);
  for (const asset of item.assets ?? []) if (asset.source.svg) out.push(asset.source.svg);
  for (const slide of item.slides ?? []) {
    for (const el of slide.elements) if (el.source?.svg) out.push(el.source.svg);
  }
  return out;
}

function assertInlineFilesExist(composition: Composition, filesByName: Map<string, string>): void {
  for (const item of composition.deliverables) {
    for (const text of markupOf(item)) {
      for (const name of inlineNames(text)) {
        const abs = lookupInlineFile(filesByName, name);
        if (!abs) {
          throw new Error(`${item.filename}: {{inline:${name}}} does not match an attached filename`);
        }
        // Checked while the brain can still be asked to fix it, not at build time.
        try {
          assertInlinable(abs, name);
        } catch (err) {
          throw new Error(`${item.filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

export async function buildComposition(opts: {
  composition: Composition;
  workDir: string;
  filesByName: Map<string, string>;
  ownerId: string;
  brainLabel?: BrainLabel;
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
    brainLabel: opts.brainLabel,
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
      pending.push(
        withGeminiOwner(`${opts.ownerId}:${safeId(item.id)}`, () => buildAudio(item, ctx, opts.onStatus)).then((abs) =>
          slots.set("file", Promise.resolve(abs)),
        ),
      );
    }
  }
  opts.onStatus?.(`Building ${opts.composition.deliverables.length} file(s)…`);
  await Promise.all(pending);

  const built: BuiltFile[] = [];
  const byFilename = new Map<string, string>();
  for (const row of prepared) {
    if (row.item.kind === "pdf") continue;
    // Owned per deliverable so notes recorded while drawing it (a font substitution) land on it.
    const file = await withGeminiOwner(`${opts.ownerId}:${safeId(row.item.id)}`, () =>
      emitDocument(row.item, row.slots, outDir, opts.onStatus, opts.filesByName),
    );
    const notes = takePlatformNotes(`${opts.ownerId}:${safeId(row.item.id)}`);
    if (notes.length) file.notes = [...(file.notes ?? []), ...notes];
    built.push(file);
    const printable = file.printPath ?? file.absPath;
    byFilename.set(file.filename.toLowerCase(), row.item.kind === "html" ? printable : file.absPath);
    if (file.printPath) byFilename.set(row.item.filename.toLowerCase(), file.printPath);
  }
  for (const row of prepared) {
    if (row.item.kind !== "pdf") continue;
    const file = await stage(opts.ownerId, `pdf ${row.item.filename}`, () =>
      withGeminiOwner(`${opts.ownerId}:${safeId(row.item.id)}`, () =>
        emitPdf(row.item, row.slots, outDir, byFilename, opts.onStatus, opts.filesByName),
      ),
    );
    const notes = takePlatformNotes(`${opts.ownerId}:${safeId(row.item.id)}`);
    if (notes.length) file.notes = [...(file.notes ?? []), ...notes];
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
    audio: row.audio === "mute" || row.audio === "keep" ? row.audio : undefined,
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
        level_db: num(music.level_db),
        until: ["speech", "music", "longest"].includes(String(music.until ?? "").trim().toLowerCase())
          ? (String(music.until).trim().toLowerCase() as "speech" | "music" | "longest")
          : undefined,
      };
    }
  }
  if (num(row.speech_level_db) !== undefined) base.speech_level_db = num(row.speech_level_db);
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
    const svg = expandInlineFiles(source.svg?.trim() ?? "", ctx.filesByName);
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
  await executeMediaTool(
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
  await stage(ownerId, `${name} ${id}`, () =>
    withGeminiOwner(`${ownerId}:${id}`, () => executeMediaTool(name, args, ctx)),
  );
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
  const audio = item.audio === "mute" ? "mute" : "keep";
  let currentId = ids[0]!;
  if (ids.length > 1) {
    const joined = safeId(`${item.id}-joined`);
    await executeMediaTool(
      "join_videos",
      { id: joined, clips: ids, filename: `slots/${joined}.mp4`, audio },
      ctx,
    );
    currentId = joined;
  }
  // Fit when size/duration is set, or when mute must strip audio before deliver.
  if (item.width || item.height || item.duration_sec || audio === "mute") {
    const fitted = safeId(`${item.id}-fitted`);
    await executeMediaTool(
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
        audio,
      },
      ctx,
    );
    currentId = fitted;
  }
  const abs = ctx.staged.get(currentId)?.absPath;
  if (!abs) throw new Error(`${item.filename}: video was not produced`);
  return abs;
}

/**
 * Speech (input 0) with music (input 1) under it.
 * No level set: the two are averaged, as before. A level set: each input is played at
 * its own level in dB and summed without averaging, so the numbers mean what they say.
 * "until" is how long the mix runs: the speech, the music, or whichever is longer.
 */
export function mixFilter(item: Pick<CompositionDeliverable, "speech_level_db" | "music">): string {
  const fmt = "aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo";
  const speechDb = item.speech_level_db;
  const musicDb = item.music?.level_db;
  const levelled = speechDb !== undefined || musicDb !== undefined;
  const gain = (db: number | undefined) => (levelled ? `,volume=${(db ?? 0).toFixed(2)}dB` : "");
  const until = item.music?.until ?? "speech";
  const duration = until === "longest" ? "longest" : "first";
  // "first" ends with input 0, so for "music" the music goes first.
  const order = until === "music" ? "[a1][a0]" : "[a0][a1]";
  return `[0:a]${fmt}${gain(speechDb)}[a0];[1:a]${fmt}${gain(musicDb)}[a1];${order}amix=inputs=2:duration=${duration}:dropout_transition=0${
    levelled ? ":normalize=0" : ""
  }`;
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
    await ffmpeg(["-i", speechPath, "-i", musicPath, "-filter_complex", mixFilter(item), "-c:a", "pcm_s16le", mixed]);
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
  if (item.kind === "html") return writeHtml(item, slots, outDir, filesByName);
  if (item.kind === "svg") {
    const svg = expandInlineFiles(item.svg ?? "", filesByName);
    const named = formatForFilename(item.filename);
    if (named && named !== "svg") {
      // kind "svg" with a raster filename contradicts itself. The platform does not pick
      // a winner: the SVG is written under the name the brain gave, as the brain wrote it.
      console.warn(`[build] ${item.filename}: kind is svg but the name says ${named} — written as given`);
    }
    const dest = uniqueDest(outDir, item.filename, ".svg");
    fs.writeFileSync(dest, svg, "utf8");
    return { id: item.id, filename: path.basename(dest), absPath: dest };
  }
  if (item.kind === "image") {
    const abs = await slots.get("file");
    if (!abs) throw new Error(`${item.filename}: file was not produced`);
    return writeImageFile(item, abs, outDir);
  }
  if (item.kind === "video" || item.kind === "audio") {
    const abs = await slots.get("file");
    if (!abs) throw new Error(`${item.filename}: file was not produced`);
    const dest = uniqueDest(outDir, item.filename, path.extname(abs) || extFallback(item.kind));
    // Written in the format its filename names: Podcast.mp3 is MP3, not WAV under that name.
    const result = await encodeMediaTo(item.kind, abs, dest, (args) => ffmpeg(args));
    const built: BuiltFile = { id: item.id, filename: path.basename(dest), absPath: dest };
    if (result === "unsupported") {
      built.notes = [`No ${path.extname(dest)} encoder on this worker; the ${path.extname(abs).slice(1)} file was written under this name as it is.`];
    }
    return built;
  }
  throw new Error(`${item.filename}: unsupported kind ${item.kind}`);
}

/**
 * kind "image": the brain asked for a picture file under this name, from a source it
 * chose (place / generate / svg). Writing that file in the format its name declares is
 * part of building it, like printing HTML to a PDF. The size is the one the brain gave
 * (on the deliverable or in its SVG); the platform does not pick one.
 *
 * What cannot be made is not corrected: a photo named .svg is written as given.
 */
async function writeImageFile(item: CompositionDeliverable, src: string, outDir: string): Promise<BuiltFile> {
  const actual = sniffImage(fs.readFileSync(src));
  const wanted = formatForFilename(item.filename);
  const size = item.width && item.height ? { width: item.width, height: item.height } : {};
  const dest = uniqueDest(outDir, item.filename, actual ? imageExtension(actual) : ".png");
  if (wanted && wanted !== "svg") {
    await convertImage(src, dest, wanted, size);
  } else {
    if (wanted === "svg" && actual && actual !== "svg") {
      console.warn(`[build] ${item.filename}: the picture is ${actual}, not svg — written as given`);
    }
    fs.copyFileSync(src, dest);
  }
  return { id: item.id, filename: path.basename(dest), absPath: dest };
}

/**
 * Before Chromium prints a page: fetch the families its HTML, CSS and SVG files name,
 * where they are openly licensed, and record any it has to substitute.
 */
async function prepareFontsForPrint(htmlPath: string): Promise<void> {
  const texts: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(html?|css|svg)$/i.test(entry.name) && fs.statSync(full).size < 20 * 1024 * 1024) {
        texts.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(path.dirname(htmlPath), 0);
  const report = await prepareFonts(texts);
  const note = substitutionNote(report, "Chromium");
  if (note) recordPlatformNote(note);
}

async function emitPdf(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
  byFilename: Map<string, string>,
  onStatus?: (msg: string) => void,
  filesByName?: Map<string, string>,
): Promise<BuiltFile> {
  onStatus?.(`Writing ${item.filename}…`);
  const dest = uniqueDest(outDir, item.filename, ".pdf");
  if (item.html?.trim()) {
    const folder = path.join(outDir, `${safeId(item.id)}-pdf`);
    fs.mkdirSync(folder, { recursive: true });
    const htmlPath = path.join(folder, "index.html");
    const placed = await placeAssets(item, slots, folder);
    fs.writeFileSync(htmlPath, expandInlineFiles(substituteAssets(item.html, placed, path.dirname(htmlPath)), filesByName), "utf8");
    await prepareFontsForPrint(htmlPath);
    const exported = await exportPdf({ sourcePath: htmlPath, outDir: path.dirname(dest), outName: path.basename(dest), onStatus });
    return { id: item.id, filename: path.basename(exported.pdfPath), absPath: exported.pdfPath };
  }
  const from = item.from?.trim().toLowerCase();
  const source = from ? byFilename.get(from) : undefined;
  if (!source) throw new Error(`${item.filename}: from does not match a file in this reply`);
  if (/\.html?$/i.test(source)) await prepareFontsForPrint(source);
  const exported = await exportPdf({ sourcePath: source, outDir: path.dirname(dest), outName: path.basename(dest), onStatus });
  return { id: item.id, filename: path.basename(exported.pdfPath), absPath: exported.pdfPath };
}

async function writeHtml(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
  filesByName?: Map<string, string>,
): Promise<BuiltFile> {
  const folder = path.join(outDir, `${safeId(item.id)}-html`);
  fs.mkdirSync(folder, { recursive: true });
  const placed = await placeAssets(item, slots, folder);
  const written: string[] = [...placed.values()].map((asset) => asset.abs);
  for (const file of item.files ?? []) {
    const rel = safeRel(file.path);
    const dest = path.join(folder, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, expandInlineFiles(substituteAssets(file.content, placed, path.dirname(dest)), filesByName), "utf8");
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
    zip.file(rel, fs.readFileSync(abs), { createFolders: false });
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

type FontFace = { family: string; subfamily: string; abs: string; bytes: Buffer };

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

function faceMatches(face: FontFace, requested: string): boolean {
  const want = requested.trim().toLowerCase();
  const family = face.family.toLowerCase();
  const full = `${family} ${face.subfamily.toLowerCase()}`;
  const stem = path.basename(face.abs, path.extname(face.abs)).toLowerCase();
  return want === family || want === full || want === stem || want.replace(/[-_]+/g, " ") === stem.replace(/[-_]+/g, " ");
}

function fontSlot(subfamily: string): { slot: "regular" | "bold" | "italic" | "boldItalic"; rank: number } {
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

/** Embed attached fonts in decks. Off until a deck with embedded EOT has been opened in PowerPoint. */
export function pptxEmbedFonts(): boolean {
  const raw = (process.env.PPTX_EMBED_FONTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

const PRESENTATION_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * The brain's slide IR as a PowerPoint deck.
 *
 * The package is written by pptxgenjs, which gives PowerPoint the parts it requires
 * (theme, slide master, slide layout, notes master, presentation properties). The
 * hand-built package had none of them, and its bold flag was not valid DrawingML,
 * so PowerPoint offered to repair every deck. Pictures are packed as PNG or JPEG
 * by their real bytes; an SVG is drawn to pixels first.
 */
async function writePptx(
  item: CompositionDeliverable,
  slots: Map<string, Promise<string>>,
  outDir: string,
  filesByName?: Map<string, string>,
): Promise<BuiltFile> {
  const slides = item.slides ?? [];
  const widthIn = item.width_in ?? 13.333;
  const heightIn = item.height_in ?? 7.5;
  const pres = new PptxGenJS();
  pres.defineLayout({ name: "AUTOCOOK", width: widthIn, height: heightIn });
  pres.layout = "AUTOCOOK";
  if (item.font?.trim()) pres.theme = { headFontFace: item.font.trim(), bodyFontFace: item.font.trim() };

  const mediaDir = path.join(outDir, ".pptx_media");
  // The brain's percentages as given: below 0 or above 100 places the element past the edge.
  const inches = (pct: number | undefined, fallback: number, total: number) => ((pct ?? fallback) / 100) * total;
  let mediaIndex = 0;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!;
    const page = pres.addSlide();
    const bg = hex6(slide.background, "");
    if (bg) page.background = { color: bg };
    for (let e = 0; e < slide.elements.length; e++) {
      const el = slide.elements[e]!;
      const box = {
        x: inches(el.x, 5, widthIn),
        y: inches(el.y, 5, heightIn),
        w: Math.max(0.01, inches(el.w, el.type === "text" ? 90 : 40, widthIn)),
        h: Math.max(0.01, inches(el.h, 20, heightIn)),
      };
      if (el.type === "image") {
        if (!el.source) continue;
        const abs = await slots.get(`s${i}e${e}`);
        if (!abs) throw new Error(`${item.filename} slide ${i + 1}: image was not produced`);
        mediaIndex += 1;
        const packed = await packDeckImage(abs, mediaDir, `${safeId(item.id)}-${mediaIndex}`);
        page.addImage({ path: packed, ...box });
        continue;
      }
      if (el.type === "shape") {
        const fill = hex6(el.fill, "");
        page.addShape(pres.ShapeType.rect, {
          ...box,
          fill: fill ? { color: fill } : { type: "none" },
          line: { type: "none" },
        });
        continue;
      }
      const font = (el.font || slide.font || item.font || "").trim();
      page.addText(el.text ?? "", {
        ...box,
        isTextBox: true,
        valign: "top",
        fontSize: el.size ?? (el.bold ? 28 : 16),
        bold: Boolean(el.bold),
        color: hex6(el.color, "111111"),
        align: el.align === "center" ? "center" : el.align === "right" ? "right" : "left",
        ...(font ? { fontFace: font } : {}),
      });
    }
    if (slide.notes?.trim()) page.addNotes(slide.notes);
  }

  let bytes = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  if (pptxEmbedFonts()) bytes = await embedDeckFonts(bytes, typefacesIn(item), filesByName);
  bytes = await withoutFolderEntries(bytes);
  const dest = uniqueDest(outDir, item.filename, ".pptx");
  fs.writeFileSync(dest, bytes);
  return { id: item.id, filename: path.basename(dest), absPath: dest };
}

/** PNG or JPEG by the real bytes, so the part's content type matches what is in it. */
async function packDeckImage(src: string, dir: string, id: string): Promise<string> {
  const actual = sniffImage(fs.readFileSync(src));
  if (actual === "png" || actual === "jpeg") return src;
  const dest = path.join(dir, `${id}.png`);
  await convertImage(src, dest, "png");
  return dest;
}

/**
 * Add the attached faces the deck names, as EOT (.fntdata), to a written deck.
 * Families with no attached file are left to the viewer's installed fonts.
 */
async function embedDeckFonts(
  deck: Buffer,
  typefaces: string[],
  filesByName: Map<string, string> | undefined,
): Promise<Buffer> {
  const faces = readAttachedFaces(filesByName);
  if (!faces.length || !typefaces.length) return deck;
  const zip = await JSZip.loadAsync(deck);
  const presentationFile = zip.file("ppt/presentation.xml");
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  const typesFile = zip.file("[Content_Types].xml");
  if (!presentationFile || !relsFile || !typesFile) return deck;
  let presentation = await presentationFile.async("string");
  let rels = await relsFile.async("string");
  let types = await typesFile.async("string");

  const usedIds = new Set([...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
  let nextId = Math.max(0, ...usedIds) + 1;
  const entries: string[] = [];
  const newRels: string[] = [];
  let fontIndex = 0;
  for (const typeface of typefaces) {
    const matches = faces.filter((face) => faceMatches(face, typeface));
    if (!matches.length) continue;
    if (!matches.every((face) => embeddingAllowed(face.bytes))) {
      console.warn(`[build] ${typeface}: the font's licence does not allow embedding — left to installed fonts`);
      continue;
    }
    const chosen = new Map<"regular" | "bold" | "italic" | "boldItalic", FontFace>();
    for (const face of matches) {
      const { slot, rank } = fontSlot(face.subfamily);
      const current = chosen.get(slot);
      if (!current || rank > fontSlot(current.subfamily).rank) chosen.set(slot, face);
    }
    if (!chosen.has("regular")) chosen.set("regular", matches.find((f) => fontSlot(f.subfamily).slot === "bold") ?? matches[0]!);
    const byPath = new Map<string, string>();
    const styles: string[] = [];
    for (const slot of ["regular", "bold", "italic", "boldItalic"] as const) {
      const face = chosen.get(slot);
      if (!face) continue;
      let rId = byPath.get(face.abs);
      if (!rId) {
        rId = `rId${nextId++}`;
        fontIndex += 1;
        const part = `fonts/font${fontIndex}.fntdata`;
        zip.file(`ppt/${part}`, toEot(face.bytes));
        newRels.push(`<Relationship Id="${rId}" Type="${PRESENTATION_NS}/font" Target="${part}"/>`);
        byPath.set(face.abs, rId);
      }
      styles.push(`<p:${slot} r:id="${rId}"/>`);
    }
    entries.push(`<p:embeddedFont><p:font typeface="${escXml(typeface)}"/>${styles.join("")}</p:embeddedFont>`);
  }
  if (!entries.length) return deck;
  const list = `<p:embeddedFontLst>${entries.join("")}</p:embeddedFontLst>`;
  // Schema order: ... sldSz, notesSz, embeddedFontLst, ... defaultTextStyle
  presentation = /<p:notesSz\b[^>]*\/>/.test(presentation)
    ? presentation.replace(/(<p:notesSz\b[^>]*\/>)/, `$1${list}`)
    : presentation.replace(/(<p:sldSz\b[^>]*\/>)/, `$1${list}`);
  rels = rels.replace("</Relationships>", `${newRels.join("")}</Relationships>`);
  if (!/Extension="fntdata"/.test(types)) {
    types = types.replace("<Default ", `<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default `);
  }
  zip.file("ppt/presentation.xml", presentation);
  zip.file("ppt/_rels/presentation.xml.rels", rels);
  zip.file("[Content_Types].xml", types);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Rewrite a zip with file entries only. Directory entries make some cloud viewers and
 * co-editing services refuse the file.
 */
export async function withoutFolderEntries(bytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const dirs = Object.values(zip.files).filter((entry) => entry.dir);
  if (!dirs.length) return bytes;
  const out = new JSZip();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    out.file(entry.name, await entry.async("nodebuffer"), { createFolders: false, date: entry.date });
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
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

const COMPOSITION_FFMPEG_TIMEOUT_MS = 10 * 60_000;

async function ffmpeg(args: string[], timeoutMs = COMPOSITION_FFMPEG_TIMEOUT_MS): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const execErr = err as { message?: string; killed?: boolean; code?: string | number };
    if (execErr.killed || execErr.code === "ETIMEDOUT") {
      throw new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
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
