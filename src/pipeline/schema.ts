import { z } from "zod";

export const generationTypeSchema = z.enum([
  "agent_image",
  "agent_video",
  "agent_audio",
  "user_image",
  "user_video",
  "edit_image",
  "edit_video",
  "local_edit",
]);

const extJsonShape = {
  code_type: z.string().nullable().optional(),
  aspect_ratio: z.string().nullable().optional(),
  content_safety: z.enum(["pass", "flagged"]).nullable().optional(),
  source_platform: z.string().nullable().optional(),
  aesthetic_score: z.number().min(0).max(10).nullable().optional(),
  consistency_score: z.number().min(0).max(100).nullable().optional(),
  narrative_quality: z.enum(["low", "medium", "high"]).nullable().optional(),
  visual_style: z.string().nullable().optional(),
  origin_instruction: z.string().optional(),
  human_instruction: z.string().optional(),
  score: z.number().optional(),
  inpainting_mode: z.string().optional(),
  preserved_pixel_ratio: z.number().min(0).max(1).optional(),
};

/** Lenient: reads older packs that stuffed extra keys into ext_json. */
export const extJsonSchema = z.object(extJsonShape).passthrough();

/** Write path: only documented non-path metadata. */
export const deliveryExtJsonSchema = z.object(extJsonShape).strict();

export const metaRecordSchema = z.object({
  uniq_id: z.string().min(1),
  modality: z.enum(["image", "video", "audio"]),
  generation_type: generationTypeSchema,
  media_id: z.string().min(1),
  media_desc: z.string(),
  media_path: z.string().min(1),
  format: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().nullable(),
  fps: z.number().int().nullable(),
  resolution: z.tuple([z.number().int(), z.number().int()]).nullable(),
  prompt: z.string(),
  model_name: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string()),
  session_id: z.string().nullable(),
  round_index: z.number().int().nullable(),
  parent_uniq_id: z.string().nullable(),
  audio_path: z.string().nullable(),
  origin_media_id: z.string().nullable(),
  origin_media_path: z.string().nullable(),
  mask_path: z.string().nullable(),
  reference_images: z.array(z.string()),
  ext_json: extJsonSchema,
});

export type MetaRecord = z.infer<typeof metaRecordSchema>;

const AGENT_OR_USER = new Set(["agent_image", "agent_video", "agent_audio", "user_image", "user_video"]);

export const deliveryRecordSchema = metaRecordSchema.extend({ ext_json: deliveryExtJsonSchema }).superRefine((rec, ctx) => {
  if (rec.media_path.includes("\\")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "media_path must use /", path: ["media_path"] });
  }
  if (AGENT_OR_USER.has(rec.generation_type)) {
    if (rec.origin_media_id !== null || rec.origin_media_path !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "origin_* must be null unless generation_type is edit_image / edit_video / local_edit",
        path: ["origin_media_path"],
      });
    }
  }
  if (rec.generation_type !== "local_edit" && rec.mask_path !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mask_path must be null unless local_edit", path: ["mask_path"] });
  }
  if (
    (rec.generation_type === "edit_image" || rec.generation_type === "edit_video" || rec.generation_type === "local_edit") &&
    !rec.origin_media_path
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "origin_media_path is required for edit types",
      path: ["origin_media_path"],
    });
  }
  if (rec.generation_type === "agent_image" && !rec.media_path.startsWith("image/agent_generated/")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agent_image must live under image/agent_generated/", path: ["media_path"] });
  }
  if (rec.generation_type === "agent_video" && !rec.media_path.startsWith("video/agent_generated/")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agent_video must live under video/agent_generated/", path: ["media_path"] });
  }
  if (rec.generation_type === "agent_audio" && !rec.media_path.startsWith("audio/agent_generated/")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agent_audio must live under audio/agent_generated/", path: ["media_path"] });
  }
  if (rec.generation_type === "edit_video" && !rec.media_path.startsWith("video/edited/")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "edit_video must live under video/edited/", path: ["media_path"] });
  }
  rec.reference_images.forEach((ref, i) => {
    if (!ref.startsWith("reference/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reference_images must be under reference/",
        path: ["reference_images", i],
      });
    }
  });
});

export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;

export const antiPromptSchema = z.object({
  session_id: z.string(),
  uniq_id: z.string(),
  category: z.string(),
  media_desc: z.string(),
  prompt_digest: z.string(),
  tags: z.array(z.string()),
  subjects: z.array(z.string()),
  setting: z.string(),
  visual_style: z.string(),
  duration: z.number(),
  aspect_ratio: z.string(),
  shots: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        media_desc: z.string(),
        still: z.string().optional().default(""),
        motion: z.string().optional().default(""),
      }),
    )
    .optional()
    .default([]),
});

export type AntiPromptRecord = z.infer<typeof antiPromptSchema>;

/** How this panel attaches to the previous clip's last frame. */
export const shotTransitionSchema = z.enum(["cut", "continue"]);
export type ShotTransition = z.infer<typeof shotTransitionSchema>;

export const shotPlanSchema = z.object({
  index: z.number().int().nonnegative(),
  duration: z.number().positive(),
  image_prompt: z.string().min(1),
  motion_prompt: z.string().min(1),
  media_desc: z.string().optional().default(""),
  /** cut = new still (character/location/framing jump). continue = hard-join from previous clip tail. */
  transition: shotTransitionSchema.optional().default("cut"),
  /** Picture from a supplied video segment for this shot; the generated clip still supplies the audio. */
  insert: z
    .object({
      source: z.string().min(1),
      start: z.number().nonnegative(),
      end: z.number().positive().optional(),
    })
    .nullable()
    .optional(),
  /** Whether the attached music bed plays under this shot (absent = plays). */
  music: z.boolean().nullable().optional(),
  /** Composite the supplied logo small in a corner over this shot at stitch. */
  logo_bug: z.boolean().nullable().optional(),
  /** Short pop-up text overlaid on this shot at stitch (not drawn by the image/video model). */
  callout: z.string().nullable().optional(),
});

export const scriptPlanSchema = z.object({
  media_desc: z.string().min(1),
  tags: z.array(z.string()),
  subjects: z.array(z.string()),
  setting: z.string(),
  visual_style: z.string(),
  content_safety_notes: z.string(),
  /** Brand hex for the callout box (e.g. "#195B8C"). */
  callout_color: z.string().nullable().optional(),
  /**
   * Delivery fps for the finished master (e.g. 24, 25, 30).
   * Platform stitches at this rate — Argon owns it from the brief.
   */
  delivery_fps: z.number().positive().nullable().optional(),
  /** Delivery resolution class. Platform finishes at this — Argon owns it from the brief. */
  delivery_resolution: z.enum(["1080p", "4K"]).nullable().optional(),
  shots: z.array(shotPlanSchema).min(1),
});

export type ScriptPlan = z.infer<typeof scriptPlanSchema>;

/** Audio-only cook plan (stored in script_json when pipeline_mode === "audio"). */
export const audioSpeechCueSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.literal("speech"),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string().min(1),
  style: z.string().nullish(),
  voice: z.string().nullish(),
});

export const audioPlanSchema = z.object({
  media_desc: z.string().min(1),
  target_duration: z.number().positive(),
  music: z.object({
    prompt: z.string().min(1),
    instrumental: z.boolean().optional().default(true),
  }),
  cues: z.array(audioSpeechCueSchema).min(1),
  /** Use operator-provided guide/VO audio (level/pan only) — Lyria still generates the bed. */
  use_provided_speech: z.boolean().optional().default(false),
  /** Export instrumental + full/synced masters. */
  dual_masters: z.boolean().optional().default(false),
  /** Also export an N-second preview cut WAV (e.g. publisher website). */
  preview_cut_sec: z.number().positive().optional(),
  /** Master WAV bit depth (16 or 24). */
  wav_bit_depth: z.union([z.literal(16), z.literal(24)]).optional().default(16),
  /** Plate-assembly podcast: edit supplied stems only (no TTS/Lyria). */
  assembly: z.boolean().optional().default(false),
  /** Opaque EDL JSON for assembly cooks. */
  assembly_edl_json: z.string().optional(),
  /** Instrumental music bed only — skip TTS and mix polish; remux Lyria as-is. */
  music_only: z.boolean().optional().default(false),
  /** Guided audio tour from supplied stems (no TTS/Lyria). */
  tour_assembly: z.boolean().optional().default(false),
});

export type AudioPlan = z.infer<typeof audioPlanSchema>;
export type AudioSpeechCue = z.infer<typeof audioSpeechCueSchema>;

export const checklistSchema = z.object({
  purity: z.boolean(),
  safety: z.boolean(),
  structure: z.boolean(),
  identity: z.boolean(),
});

export type Checklist = z.infer<typeof checklistSchema>;

export function checklistComplete(c: Checklist): boolean {
  return c.purity && c.safety && c.structure && c.identity;
}

export const META_FIELD_ORDER = [
  "uniq_id",
  "modality",
  "generation_type",
  "media_id",
  "media_desc",
  "media_path",
  "format",
  "width",
  "height",
  "duration",
  "fps",
  "resolution",
  "prompt",
  "model_name",
  "category",
  "tags",
  "session_id",
  "round_index",
  "parent_uniq_id",
  "audio_path",
  "origin_media_id",
  "origin_media_path",
  "mask_path",
  "reference_images",
  "ext_json",
] as const;

export function serializeMetaRecord(rec: MetaRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of META_FIELD_ORDER) out[key] = rec[key];
  return out;
}
