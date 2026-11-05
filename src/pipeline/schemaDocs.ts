/**
 * Argon-owned plans for non-AV deliverables (html / image / pptx / pdf).
 * Platform only writes bytes and runs export steps the plan marks.
 */
import { z } from "zod";

export const cookKindSchema = z.enum(["video", "audio", "html", "image", "pptx", "pdf"]);
export type CookKind = z.infer<typeof cookKindSchema>;

export const htmlFileSchema = z.object({
  /** Relative path inside the deliverable bundle, e.g. index.html or js/app.js */
  path: z.string().min(1),
  /** Full file contents — Argon owns this; platform writes verbatim. */
  content: z.string(),
});

/**
 * Media Argon asked the platform to generate (same role as gemini.google.com tools).
 * Reference in HTML as {{asset:ID}} or the relative filename; embed chooses path vs data URI.
 */
export const htmlMediaAssetSchema = z.object({
  id: z.string().min(1),
  format: z.enum(["png", "svg", "mp4", "wav"]),
  /** Relative path inside the site bundle, e.g. assets/hero.png */
  filename: z.string().min(1),
  /** Prompt for png/mp4/wav generators (ignored for svg). */
  prompt: z.preprocess((v) => (v == null ? "" : v), z.string()).optional().default(""),
  /** Full SVG when format is svg. Models often emit null for png/mp4 — treat as absent. */
  svg: z.preprocess((v) => (v == null ? undefined : v), z.string().optional()),
  width: z.preprocess((v) => (v == null ? 1024 : v), z.number().int().positive()).optional().default(1024),
  height: z.preprocess((v) => (v == null ? 1024 : v), z.number().int().positive()).optional().default(1024),
  /** Video/audio duration hint (seconds). Coerce 0/null → undefined (default later). */
  duration_sec: z.preprocess((v) => {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, z.number().positive().optional()),
  /**
   * path = write file and rewrite {{asset:id}} → relative URL.
   * data_uri = inline as data:...;base64,... (png/svg only; mp4/wav always path).
   */
  embed: z.enum(["path", "data_uri"]).optional().default("path"),
});
export type HtmlMediaAsset = z.infer<typeof htmlMediaAssetSchema>;

export const htmlPlanSchema = z.object({
  kind: z.literal("html"),
  media_desc: z.string().min(1),
  /** Entry HTML relative path (usually index.html). */
  entry: z.string().min(1).default("index.html"),
  files: z.array(htmlFileSchema).min(1),
  /** Media to generate/inline before packaging (Argon-owned tool asks). */
  assets: z.array(htmlMediaAssetSchema).optional().default([]),
  /** Optional: ask platform to screenshot entry after write (QA only). */
  screenshot: z.boolean().optional().default(false),
  /** When true, also export PDF from the entry HTML (plan-owned post). */
  export_pdf: z.boolean().optional().default(false),
  notes: z.string().nullable().optional(),
});
export type HtmlPlan = z.infer<typeof htmlPlanSchema>;

export const imageAssetSchema = z.object({
  id: z.string().min(1),
  /** png = media model; svg = Argon markup in `svg` field. */
  format: z.enum(["png", "svg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Prompt for PNG generation (ignored for svg). */
  prompt: z.preprocess((v) => (v == null ? "" : v), z.string()).optional().default(""),
  /** Full SVG when format is svg. Null from the model is fine for png assets. */
  svg: z.preprocess((v) => (v == null ? undefined : v), z.string().optional()),
  filename: z.string().min(1),
});

export const imagePlanSchema = z.object({
  kind: z.literal("image"),
  media_desc: z.string().min(1),
  assets: z.array(imageAssetSchema).min(1),
  notes: z.string().nullable().optional(),
});
export type ImagePlan = z.infer<typeof imagePlanSchema>;

export const pptxElementSchema = z.object({
  type: z.enum(["title", "body", "image_slot", "shape"]),
  text: z.string().optional(),
  /** 0–100 EMU-ish percentages of slide for placement. */
  x: z.number().min(0).max(100).optional().default(5),
  y: z.number().min(0).max(100).optional().default(5),
  w: z.number().min(1).max(100).optional().default(90),
  h: z.number().min(1).max(100).optional().default(20),
  /** For image_slot: Argon image prompt (generated then embedded). */
  image_prompt: z.string().optional(),
  /** Optional path to media already produced by Argon tools (relative to workDir/argon_media or absolute). */
  image_file: z.string().optional(),
  fill: z.string().optional(),
});

export const pptxSlideSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().optional(),
  notes: z.string().optional(),
  elements: z.array(pptxElementSchema).min(1),
});

export const pptxPlanSchema = z.object({
  kind: z.literal("pptx"),
  media_desc: z.string().min(1),
  /** Slide size in inches (widescreen default). */
  width_in: z.number().positive().optional().default(13.333),
  height_in: z.number().positive().optional().default(7.5),
  slides: z.array(pptxSlideSchema).min(1),
  export_pdf: z.boolean().optional().default(false),
  notes: z.string().nullable().optional(),
});
export type PptxPlan = z.infer<typeof pptxPlanSchema>;

export const pdfPlanSchema = z.object({
  kind: z.literal("pdf"),
  media_desc: z.string().min(1),
  /** Argon chooses the source cook that produces PDF. */
  source: z.enum(["html", "pptx"]),
  /** Nested plan for the source (html or pptx). */
  source_plan: z.union([htmlPlanSchema, pptxPlanSchema]),
  notes: z.string().nullable().optional(),
});
export type PdfPlan = z.infer<typeof pdfPlanSchema>;

export type DocumentPlan = HtmlPlan | ImagePlan | PptxPlan | PdfPlan;

export const documentPlanSchema = z.discriminatedUnion("kind", [
  htmlPlanSchema,
  imagePlanSchema,
  pptxPlanSchema,
  pdfPlanSchema,
]);
