export const DATASET_NAME = "agentic_poc";

export const CATEGORIES = [
  "E-commerce & Advertising",
  "Short Drama / Film & TV",
  "Anime & Gaming",
  "Creative Works",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "2.35:1"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

export const IMAGE_ASPECTS = ["16:9", "9:16", "1:1", "2.35:1", "4:3", "3:2"] as const;

export const POC_TARGET = 8;
export const SLOTS_PER_CATEGORY = 2;
export const MIN_DURATION_SEC = 30;
export const MAX_DURATION_SEC = 120;
/** Direct pipeline: short VFX masters (~one Veo clip) up to long stitched sessions (~2–3 min). */
export const MIN_DURATION_DIRECT_SEC = 8;
export const MAX_DURATION_DIRECT_SEC = 180;
/**
 * Auto pipeline: long form = N short scenes (model max clip, typically ~8s) concatenated.
 * Duration is a minimum plan length — storyboard fills with max-length scenes, then stitch.
 */
/** Floor for §3.1 session duration — short Omni product spots are often ~6s. */
export const MIN_DURATION_AUTO_SEC = 4;
export const MAX_DURATION_AUTO_SEC = 300;
/** Typical Veo max clip — used for UI estimates only (planner reads the model catalog). */
export const TYPICAL_AUTO_CLIP_SEC = 8;
/** When longCook is off, clamp requested duration (still scene-assembled, just shorter). */
export const MAX_DURATION_AUTO_SHORT_SEC = 120;

export const PIPELINE_MODES = [
  "agentic",
  "direct",
  "auto",
  "audio",
  "html",
  "image",
  "pptx",
  "pdf",
] as const;
export type PipelineMode = (typeof PIPELINE_MODES)[number];

/** Document / non-AV cooks — share the FIFO worker + GEMINI_API_KEY with video/audio. */
export const DOC_PIPELINE_MODES = ["html", "image", "pptx", "pdf"] as const;
export type DocPipelineMode = (typeof DOC_PIPELINE_MODES)[number];

export function isDocPipelineMode(mode: string | null | undefined): mode is DocPipelineMode {
  return DOC_PIPELINE_MODES.includes(mode as DocPipelineMode);
}

/** Audio-only cooks — always Gemini extract + TTS (unless music-only) + Lyria. */
export const MIN_DURATION_AUDIO_SEC = 15;
/** Podcast episode masters may run up to ~16 minutes (incl. silence pads). */
export const MAX_DURATION_AUDIO_SEC = 960;
/** Autocook brain — Gemini 4 Argon via GEMINI_API_KEY only (storyboard / extract / EDL). */
export const BRAIN_MODEL = "gemini-4-argon";
/** Product video — Omni on GEMINI_API_KEY (no Seedream / OpenRouter). */
export const PRODUCT_VIDEO_MODEL = "google/gemini-omni-1.1-flash";
/** Google Interactions models — direct GEMINI_API_KEY only. */
export const AUDIO_TTS_MODEL = "gemini-3.8-flash-tts";
export const AUDIO_MUSIC_MODEL = "lyria-3.5";
export const AUDIO_MUSIC_CLIP_MODEL = "lyria-3-clip-preview";
/** Audio plan / podcast EDL refine — same Argon brain as video storyboard. */
export const AUDIO_EXTRACT_MODEL = BRAIN_MODEL;

/** Omni API only accepts 16:9 and 9:16 — map delivery aspect to nearest canvas. */
export function omniNativeAspect(aspect: VideoAspect | string): "16:9" | "9:16" {
  if (aspect === "9:16") return "9:16";
  return "16:9";
}

/** True when delivery aspect differs from Omni canvas (needs stitch crop/pad). */
export function needsAspectReshape(aspect: VideoAspect | string): boolean {
  return aspect === "1:1" || aspect === "2.35:1";
}

export function durationBounds(mode: PipelineMode): { min: number; max: number } {
  if (mode === "direct") return { min: MIN_DURATION_DIRECT_SEC, max: MAX_DURATION_DIRECT_SEC };
  if (mode === "auto") return { min: MIN_DURATION_AUTO_SEC, max: MAX_DURATION_AUTO_SEC };
  if (mode === "audio") return { min: MIN_DURATION_AUDIO_SEC, max: MAX_DURATION_AUDIO_SEC };
  if (isDocPipelineMode(mode)) return { min: 1, max: 1 };
  return { min: MIN_DURATION_SEC, max: MAX_DURATION_SEC };
}
export const VARIANT_COUNT_DEFAULT = 5;
export const MAX_REWORK_ROUNDS = 2;
export const MIN_PARALLEL_RUNS = 1;
export const MAX_PARALLEL_RUNS = 12;
/** GDP worker default — light jobs can overlap; heavy capped separately in claimNextJob. */
export const DEFAULT_PARALLEL_RUNS = 2;
export const RESOLUTION_FLOOR = 1080;
/** Delivery / request resolution for video + stitch. */
export const OUTPUT_RESOLUTIONS = ["1080p", "4K"] as const;
export type OutputResolution = (typeof OUTPUT_RESOLUTIONS)[number];

export function normalizeOutputResolution(value: unknown): OutputResolution {
  return value === "4K" ? "4K" : "1080p";
}

export function resolutionFloor(res: OutputResolution = "1080p"): number {
  return res === "4K" ? 2160 : RESOLUTION_FLOOR;
}

/** OpenRouter `resolution` field for video (and image when targeting 4K). */
export function providerResolutionToken(res: OutputResolution): string {
  return res;
}

export const MIN_IMAGE_PIXELS = 3_686_400;
export const FPS_FLOOR = 23.97;
export const BITRATE_FLOOR_BPS = 1_500_000;
export const STITCH_FPS = 30;

const DELIVERY_FPS: Record<string, string> = {
  "23.976": "24000/1001",
  "23.98": "24000/1001",
  "24": "24",
  "25": "25",
  "29.97": "30000/1001",
  "30": "30",
  "50": "50",
  "59.94": "60000/1001",
  "60": "60",
};

/** ffmpeg fps value for the stitch: first delivery rate named in the brief ("25fps", "23.976 fps"), else STITCH_FPS. */
export function deliveryFpsFromPrompt(prompt: string | null | undefined): string {
  for (const m of (prompt ?? "").matchAll(/\b(\d{2}(?:\.\d{1,3})?)\s*fps\b/gi)) {
    const hit = DELIVERY_FPS[m[1]!];
    if (hit) return hit;
  }
  return String(STITCH_FPS);
}
export const CONTINUATION_TRIM_SEC = 0.16;
export const VIDEO_FILTER_RETRIES = 3;
/** Wait between resubmits when Veo/OpenRouter returns high-load / 503. */
export const VIDEO_CAPACITY_BACKOFF_MS = [30_000, 60_000, 90_000, 120_000];
/**
 * Auto / hands-off: after the finite ladder, keep retrying at this interval until the
 * provider accepts the job — but only up to VIDEO_CAPACITY_PERSIST_MAX extra waits
 * (avoids infinite billable resubmits on a stuck take).
 */
export const VIDEO_CAPACITY_PERSIST_MS = 120_000;
/** Extra overload waits after the finite ladder for auto persist mode. */
export const VIDEO_CAPACITY_PERSIST_MAX = 3;
/**
 * Same-field occupied premises injected as "do not repeat".
 * Full field until this many sessions; then keep the closest to the new prompt.
 */
export const ANTI_PROMPT_INJECT_CAP = 250;
/** Jaccard overlap vs catalog that triggers one storyboard rewrite. */
export const ANTI_PROMPT_OVERLAP = 0.42;
/** Truncate each sidecar premise line. */
export const ANTI_PROMPT_LINE_MAX = 140;

export const POC_ASPECT_PLAN: VideoAspect[] = [
  "16:9",
  "16:9",
  "16:9",
  "9:16",
  "9:16",
  "1:1",
  "1:1",
  "2.35:1",
];

export const RUN_STATUSES = [
  "queued",
  "generating",
  "waiting_human",
  "stitching",
  "auditing",
  "exported",
  "rework",
  "rejected",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const GATES = ["script", "keyframe", "clip", "audit"] as const;
export type Gate = (typeof GATES)[number];

export function categorySlug(category: string): string {
  if (category.startsWith("E-commerce")) return "ecom";
  if (category.startsWith("Short Drama")) return "drama";
  if (category.startsWith("Anime")) return "anime";
  if (category.startsWith("Creative")) return "creative";
  return "misc";
}

/** Session keeps 2.35:1 for PoC; Seedream/Veo/Seedance catalogs use 21:9. 1:1 stays 1:1. */
export function providerImageAspect(aspect: string): string {
  if (aspect === "2.35:1") return "21:9";
  return aspect;
}

export function providerVideoAspect(aspect: string): string {
  if (aspect === "2.35:1") return "21:9";
  return aspect;
}

export function dimensionsForAspect(
  aspect: VideoAspect,
  outputResolution: OutputResolution = "1080p",
): { width: number; height: number } {
  if (outputResolution === "4K") {
    switch (aspect) {
      case "16:9":
        return { width: 3840, height: 2160 };
      case "9:16":
        return { width: 2160, height: 3840 };
      case "1:1":
        return { width: 2160, height: 2160 };
      case "2.35:1":
        // 4K-tall cinemascope (height 2160, width = 2160 × 2.35).
        return { width: 5076, height: 2160 };
      default:
        return { width: 3840, height: 2160 };
    }
  }
  switch (aspect) {
    case "16:9":
      return { width: 1920, height: 1080 };
    case "9:16":
      return { width: 1080, height: 1920 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "2.35:1":
      // 1080p-tall scope. 21:9 sources (~2.33) crop a few pixels of height to 2.35.
      return { width: 2538, height: 1080 };
    default:
      return { width: 1920, height: 1080 };
  }
}

/** Storyboard stills sized for the session delivery resolution. */
export function imageDimensionsForAspect(
  aspect: VideoAspect,
  outputResolution: OutputResolution = "1080p",
): { width: number; height: number } {
  if (outputResolution === "4K") {
    // Seedream/Seed "4K" = longest edge 4096 (not UHD 3840). Video stitch stays 3840×2160.
    switch (aspect) {
      case "16:9":
        return { width: 4096, height: 2304 };
      case "9:16":
        return { width: 2304, height: 4096 };
      case "1:1":
        return { width: 4096, height: 4096 };
      case "2.35:1":
        return { width: 4096, height: 1743 };
    }
  }
  switch (aspect) {
    case "16:9":
      return { width: 2560, height: 1440 };
    case "9:16":
      return { width: 1440, height: 2560 };
    case "1:1":
      return { width: 1920, height: 1920 };
    case "2.35:1":
      return { width: 2944, height: 1253 };
  }
}

export function nearestAspect(width: number, height: number): string {
  const r = width / height;
  const candidates: Array<{ name: string; value: number }> = [
    { name: "16:9", value: 16 / 9 },
    { name: "9:16", value: 9 / 16 },
    { name: "1:1", value: 1 },
    { name: "2.35:1", value: 2.35 },
    { name: "4:3", value: 4 / 3 },
    { name: "3:2", value: 3 / 2 },
  ];
  let best = candidates[0];
  let bestDiff = Math.abs(r - best.value);
  for (const c of candidates.slice(1)) {
    const d = Math.abs(r - c.value);
    if (d < bestDiff) {
      best = c;
      bestDiff = d;
    }
  }
  return best.name;
}
