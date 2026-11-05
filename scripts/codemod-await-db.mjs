import fs from "node:fs";
import path from "node:path";

const fns = [
  "getRun",
  "insertRun",
  "updateRun",
  "listRuns",
  "listRunsForApi",
  "countRunsByStatus",
  "setRunInputAssets",
  "findRunByRequestId",
  "rememberCookRequest",
  "enqueueJob",
  "sessionIdTaken",
  "listWaitingRuns",
  "jobQueueStats",
  "claimNextJob",
  "reclaimRunningJobs",
  "finishJob",
  "insertVariant",
  "listVariants",
  "getVariant",
  "selectVariant",
  "rejectBatch",
  "upsertAsset",
  "listAssets",
  "upsertReview",
  "getReview",
  "nextReviewRun",
  "countedByCategory",
  "countedAspects",
  "countedTotal",
  "deleteRunRows",
  "touchRun",
  "createRun",
  "deleteRun",
  "runDetail",
  "patchRunModels",
];

const files = [
  "src/pipeline/orchestrator.ts",
  "src/pipeline/audioPipeline.ts",
  "src/pipeline/docPipeline.ts",
  "src/pipeline/inputPrep.ts",
  "src/pipeline/hygiene.ts",
  "src/pipeline/poc.ts",
  "src/worker.ts",
  "app/api/runs/route.ts",
  "app/api/runs/[id]/route.ts",
  "app/api/runs/[id]/actions/route.ts",
  "app/api/cook/route.ts",
  "app/api/dataset/route.ts",
  "app/api/review/route.ts",
];

for (const rel of files) {
  const p = path.resolve(rel);
  if (!fs.existsSync(p)) {
    console.log("skip missing", rel);
    continue;
  }
  let s = fs.readFileSync(p, "utf8");
  const before = s;
  for (const n of fns) {
    const re = new RegExp(`(?<!\\bawait\\s)(?<![.\\w])\\b${n}\\s*\\(`, "g");
    s = s.replace(re, `await ${n}(`);
  }
  if (s !== before) {
    fs.writeFileSync(p, s);
    console.log("patched", rel);
  } else {
    console.log("no change", rel);
  }
}
