/**
 * Cook-queue lanes — ported from GDP `src/domain/jobs.ts` + `src/lib/jobs/queue.ts`.
 *
 * GDP (stress-tested ~20 users):
 *  - claim order: fast lane → default → generate → helper → archive, then created_at
 *  - light jobs always eligible; heavy/archive only if running heavy < HEAVY_RUNNING_MAX
 *  - helper kind capped at HELPER_RUNNING_MAX
 *
 * Autocook mapping:
 *  - fast (0): image
 *  - default (1): html, pdf, video stages
 *  - generate (2): pptx
 *  - helper (3): audio (TTS/Lyria chain)
 *  - archive (4): reserved
 *  - heavy: video + audio (Gemini/Omni long haul), like GDP video/audio media
 */

import { isDocPipelineMode } from "./constants";

/**
 * GDP uses 2 for text grading. Autocook Omni/image gens are far heavier —
 * only one heavy AV cook at a time; light docs can still use the 2nd worker slot.
 */
export const HEAVY_RUNNING_MAX = 1;
/** Same as GDP rubric_helper — long audio cooks leave slots for everyone else. */
export const HELPER_RUNNING_MAX = 1;

/** GDP statement / fast lane. */
export const LANE_FAST = 0;
/** GDP default (most grades, including heavy video). */
export const LANE_DEFAULT = 1;
/** GDP rubric_generate. */
export const LANE_GENERATE = 2;
/** GDP rubric_helper. */
export const LANE_HELPER = 3;
/** GDP archive / fat unpack. */
export const LANE_ARCHIVE = 4;

export type CookJobClass = {
  /** Lower = higher priority (GDP orderBy case). */
  lane: number;
  /** GDP payload.heavy — Omni / long Gemini AV. */
  heavy: boolean;
  /** GDP payload.archive — reserved for fat bundles. */
  archive: boolean;
};

function isVideoMode(mode: string | null | undefined): boolean {
  return mode === "auto" || mode === "direct" || mode === "agentic" || !mode;
}

function isAudioJob(mode: string | null | undefined, jobType: string): boolean {
  return mode === "audio" || jobType.startsWith("audio_");
}

/**
 * Classify a cook job the way GDP's `weightFlag` + kind lanes do.
 */
export function classifyCookJob(
  pipelineMode: string | null | undefined,
  jobType: string,
): CookJobClass {
  if (isAudioJob(pipelineMode, jobType)) {
    return { lane: LANE_HELPER, heavy: true, archive: false };
  }
  if (pipelineMode === "image" || (jobType === "doc_cook" && pipelineMode === "image")) {
    return { lane: LANE_FAST, heavy: false, archive: false };
  }
  if (pipelineMode === "pptx" || (jobType === "doc_cook" && pipelineMode === "pptx")) {
    return { lane: LANE_GENERATE, heavy: false, archive: false };
  }
  if (pipelineMode === "html" || pipelineMode === "pdf" || isDocPipelineMode(pipelineMode ?? "")) {
    return { lane: LANE_DEFAULT, heavy: false, archive: false };
  }
  if (isVideoMode(pipelineMode) || ["script", "keyframes", "clips", "stitch", "export"].includes(jobType)) {
    return { lane: LANE_DEFAULT, heavy: true, archive: false };
  }
  return { lane: LANE_DEFAULT, heavy: false, archive: false };
}

/** @deprecated use classifyCookJob — kept for any old imports. */
export function cookJobWeight(pipelineMode: string | null | undefined, jobType: string): number {
  return classifyCookJob(pipelineMode, jobType).lane;
}

export function laneLabel(lane: number): string {
  if (lane === LANE_FAST) return "fast";
  if (lane === LANE_DEFAULT) return "default";
  if (lane === LANE_GENERATE) return "generate";
  if (lane === LANE_HELPER) return "helper";
  if (lane === LANE_ARCHIVE) return "archive";
  return `lane-${lane}`;
}
