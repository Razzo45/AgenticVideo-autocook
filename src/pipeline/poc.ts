import {
  CATEGORIES,
  POC_ASPECT_PLAN,
  POC_TARGET,
  SLOTS_PER_CATEGORY,
  VIDEO_ASPECTS,
  type VideoAspect,
} from "./constants";
import {
  countedAspects,
  countedByCategory,
  countedTotal,
  countRunsByStatus,
  jobQueueStats,
} from "../db";
import { loadModelsConfig } from "./config";

export async function pocStatus() {
  const byCat = await countedByCategory();
  const aspects = await countedAspects();
  const counted = await countedTotal();
  const byStatus = await countRunsByStatus();
  const queue = await jobQueueStats();
  const cooking =
    (byStatus.queued ?? 0) + (byStatus.generating ?? 0) + (byStatus.stitching ?? 0);
  const waitingHuman = byStatus.waiting_human ?? 0;
  const rework = byStatus.rework ?? 0;
  const rejected = byStatus.rejected ?? 0;
  const exported = byStatus.exported ?? 0;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const suggestedAspect =
    POC_ASPECT_PLAN.find((a) => (aspects[a] ?? 0) < POC_ASPECT_PLAN.filter((x) => x === a).length) ??
    ("16:9" as VideoAspect);

  return {
    target: POC_TARGET,
    counted,
    remaining: Math.max(0, POC_TARGET - counted),
    rework,
    rejected,
    inFlight: Math.max(0, total - exported - rejected),
    cooking,
    waitingHuman,
    worker: {
      maxParallelRuns: loadModelsConfig().maxParallelRuns,
      runningJobs: queue.running,
      pendingJobs: queue.pending,
    },
    categories: CATEGORIES.map((name) => ({
      name,
      have: byCat[name] ?? 0,
      need: SLOTS_PER_CATEGORY,
    })),
    aspects: VIDEO_ASPECTS.map((name) => ({
      name,
      have: aspects[name] ?? 0,
      planned: POC_ASPECT_PLAN.filter((x) => x === name).length,
    })),
    suggestedAspect,
    aspectWarning: VIDEO_ASPECTS.filter((a) => (aspects[a] ?? 0) === 0 && counted > 0),
  };
}
