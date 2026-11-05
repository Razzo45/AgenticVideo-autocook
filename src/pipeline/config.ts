import fs from "node:fs";
import { MODELS_CONFIG_PATH } from "./paths";
import {
  DEFAULT_PARALLEL_RUNS,
  MAX_PARALLEL_RUNS,
  MIN_PARALLEL_RUNS,
  VARIANT_COUNT_DEFAULT,
  VIDEO_ASPECTS,
  type VideoAspect,
} from "./constants";

export type ModelsConfig = {
  script: string;
  keyframe: string;
  video: string;
  edit: string;
  reviewer: string | null;
  variantCount: number;
  defaultDurationSec: number;
  defaultAspect: VideoAspect;
  /** How many different sessions may cook API/ffmpeg at once. */
  maxParallelRuns: number;
  /** Overrides for ratios the default video model cannot emit natively. */
  videoByAspect: Partial<Record<VideoAspect, string>>;
};

const OMNI = "google/gemini-omni-1.1-flash";

const FALLBACK: ModelsConfig = {
  script: "gemini-4-argon",
  keyframe: "omni:text_to_video",
  video: OMNI,
  edit: OMNI,
  reviewer: null,
  variantCount: 1,
  defaultDurationSec: 45,
  defaultAspect: "16:9",
  maxParallelRuns: DEFAULT_PARALLEL_RUNS,
  videoByAspect: {
    "16:9": OMNI,
    "9:16": OMNI,
    "1:1": OMNI,
    "2.35:1": OMNI,
  },
};

export const DEFAULT_VIDEO_BY_ASPECT: Partial<Record<VideoAspect, string>> = {
  "16:9": OMNI,
  "9:16": OMNI,
  "1:1": OMNI,
  "2.35:1": OMNI,
};

export function videoModelForAspect(aspect: VideoAspect, cfg: ModelsConfig = loadModelsConfig()): string {
  return cfg.videoByAspect[aspect] || DEFAULT_VIDEO_BY_ASPECT[aspect] || cfg.video;
}

export function videoModelMap(cfg: ModelsConfig = loadModelsConfig()): Record<VideoAspect, string> {
  return Object.fromEntries(VIDEO_ASPECTS.map((a) => [a, videoModelForAspect(a, cfg)])) as Record<VideoAspect, string>;
}

function clampParallel(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_PARALLEL_RUNS;
  return Math.min(MAX_PARALLEL_RUNS, Math.max(MIN_PARALLEL_RUNS, v));
}

export function loadModelsConfig(): ModelsConfig {
  if (!fs.existsSync(MODELS_CONFIG_PATH)) return { ...FALLBACK };
  const raw = JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, "utf8")) as Partial<ModelsConfig>;
  return {
    script: raw.script ?? FALLBACK.script,
    keyframe: raw.keyframe ?? FALLBACK.keyframe,
    video: raw.video ?? FALLBACK.video,
    edit: raw.edit ?? FALLBACK.edit,
    reviewer: raw.reviewer ?? null,
    variantCount: raw.variantCount ?? FALLBACK.variantCount,
    defaultDurationSec: raw.defaultDurationSec ?? FALLBACK.defaultDurationSec,
    defaultAspect: (raw.defaultAspect as VideoAspect) ?? FALLBACK.defaultAspect,
    maxParallelRuns: clampParallel(raw.maxParallelRuns),
    videoByAspect: {
      ...FALLBACK.videoByAspect,
      ...(raw.videoByAspect ?? {}),
    },
  };
}

export function saveModelsConfig(next: ModelsConfig): void {
  const models = { ...next, maxParallelRuns: clampParallel(next.maxParallelRuns) };
  fs.writeFileSync(
    MODELS_CONFIG_PATH,
    JSON.stringify({ ...models, comment: "Production defaults live in Settings. Swap freely per run." }, null, 2),
    "utf8",
  );
}
