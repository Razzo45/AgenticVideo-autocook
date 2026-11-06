/**
 * Queue cost of one operator task, taken from Argon's deliverable plan.
 * The plan is a text step. Generation waits in line by the sum of that plan.
 *
 * image 10 · svg 5 · html 10 · pdf 15 · pptx 20 · audio 20 · video 30
 * Three image files = 30. One video and two images = 50.
 */

import fs from "node:fs";
import path from "node:path";
import { runDir } from "./paths";

export const DELIVERABLE_UNITS = {
  image: 10,
  svg: 5,
  html: 10,
  pdf: 15,
  pptx: 20,
  audio: 20,
  video: 30,
} as const;

export type DeliverableUnit = keyof typeof DELIVERABLE_UNITS;

export type TaskPart = {
  deliverable: DeliverableUnit | "unspecified";
  count: number;
  unit: number;
};

export type TaskSchedule = {
  weight: number;
  parts: TaskPart[];
};

export type PlannedDeliverable = {
  deliverable?: string;
  id?: string;
  filename?: string;
  note?: string;
  count?: number;
};

const MAX_PER_DELIVERABLE = 12;
const UNSPECIFIED_WEIGHT = DELIVERABLE_UNITS.image;

const ALIASES: Record<string, DeliverableUnit> = {
  image: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  still: "image",
  thumbnail: "image",
  photo: "image",
  svg: "svg",
  html: "html",
  webpage: "html",
  pdf: "pdf",
  pptx: "pptx",
  powerpoint: "pptx",
  deck: "pptx",
  slides: "pptx",
  audio: "audio",
  wav: "audio",
  mp3: "audio",
  podcast: "audio",
  video: "video",
  mp4: "video",
  clip: "video",
};

export function normalizeDeliverable(raw: string | undefined): DeliverableUnit | "unspecified" {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return ALIASES[key] ?? "unspecified";
}

/** One planned file is one unit. A count on the row means that many files of that type. */
export function weightFromDeliverables(items: PlannedDeliverable[]): TaskSchedule {
  const buckets = new Map<DeliverableUnit | "unspecified", number>();
  for (const item of items) {
    const deliverable = normalizeDeliverable(item.deliverable);
    const count = Math.min(MAX_PER_DELIVERABLE, Math.max(1, Math.round(Number(item.count) || 1)));
    buckets.set(deliverable, (buckets.get(deliverable) ?? 0) + count);
  }
  if (!buckets.size) {
    return {
      weight: UNSPECIFIED_WEIGHT,
      parts: [{ deliverable: "unspecified", count: 1, unit: UNSPECIFIED_WEIGHT }],
    };
  }
  const parts: TaskPart[] = [...buckets.entries()].map(([deliverable, count]) => ({
    deliverable,
    count,
    unit: deliverable === "unspecified" ? UNSPECIFIED_WEIGHT : DELIVERABLE_UNITS[deliverable],
  }));
  const weight = parts.reduce((sum, part) => sum + part.count * part.unit, 0);
  return { weight, parts };
}

/** Legacy single-mode cooks are one file. Task generation uses the saved Argon plan. */
export function scheduleForRun(
  pipelineMode: string | null | undefined,
  jobType: string,
): TaskSchedule {
  if (jobType === "argon_plan") {
    return { weight: 1, parts: [{ deliverable: "unspecified", count: 1, unit: 1 }] };
  }
  const single: Record<string, DeliverableUnit> = {
    image: "image",
    html: "html",
    pdf: "pdf",
    pptx: "pptx",
    audio: "audio",
    auto: "video",
    direct: "video",
    agentic: "video",
  };
  const id = single[pipelineMode ?? ""] ?? (jobType.startsWith("audio_") ? "audio" : null);
  if (!id) return weightFromDeliverables([]);
  return { weight: DELIVERABLE_UNITS[id], parts: [{ deliverable: id, count: 1, unit: DELIVERABLE_UNITS[id] }] };
}

/** Deliverable jobs use the plan Argon already wrote. The plan job itself is text. */
export function scheduleForJob(
  runId: string,
  pipelineMode: string | null | undefined,
  jobType: string,
): TaskSchedule {
  if (jobType === "argon_execute" || jobType === "argon_task") {
    try {
      const raw = fs.readFileSync(path.join(runDir(runId), "argon_plan.json"), "utf8");
      const parsed = JSON.parse(raw) as { deliverables?: PlannedDeliverable[] };
      return weightFromDeliverables(parsed.deliverables ?? []);
    } catch {
      return weightFromDeliverables([]);
    }
  }
  return scheduleForRun(pipelineMode, jobType);
}
