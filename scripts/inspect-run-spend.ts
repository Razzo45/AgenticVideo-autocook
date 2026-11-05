import fs from "node:fs";
import path from "node:path";
import { getDb, getRun, listVariants } from "../src/db";

const runId = "run_f2c457c0";
const run = getRun(runId)!;
const db = getDb();
const jobs = db
  .prepare(
    "SELECT type, status, payload_json, error, created_at, updated_at FROM jobs WHERE run_id=? ORDER BY created_at",
  )
  .all(runId) as Array<{
  type: string;
  status: string;
  payload_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}>;

console.log("RUN", {
  status: run.status,
  shot: run.current_shot_index,
  duration: run.target_duration,
  res: run.output_resolution,
  err: (run.error || "").slice(0, 200),
  toggles: run.auto_options_json,
});

const script = run.script_json ? JSON.parse(run.script_json) : null;
console.log("shots planned", script?.shots?.length);
console.log(
  "job counts",
  Object.fromEntries(
    ["script", "keyframes", "clips", "stitch", "export"].map((t) => [
      t,
      {
        done: jobs.filter((j) => j.type === t && j.status === "done").length,
        error: jobs.filter((j) => j.type === t && j.status === "error").length,
        other: jobs.filter((j) => j.type === t && !["done", "error"].includes(j.status)).length,
      },
    ]),
  ),
);

const variants = listVariants(runId);
const clips = variants.filter((v) => v.kind === "clip");
const kfs = variants.filter((v) => v.kind === "keyframe");
console.log("variants", { keyframes: kfs.length, clips: clips.length });
console.log(
  "clip files",
  clips.map((v) => ({
    shot: v.shot_index,
    sel: v.selected,
    mb: fs.existsSync(v.path) ? +(fs.statSync(v.path).size / 1e6).toFixed(1) : 0,
  })),
);

const clipJobs = jobs.filter((j) => j.type === "clips");
let clipBillMin = 0;
for (const j of clipJobs) {
  clipBillMin += (Date.parse(j.updated_at) - Date.parse(j.created_at)) / 60000;
}
console.log("clip jobs wall minutes (approx)", clipBillMin.toFixed(1));
console.log("keyframes jobs", jobs.filter((j) => j.type === "keyframes").length);

const runDir = path.join("runs", runId);
function walk(d: string, acc: string[] = []) {
  if (!fs.existsSync(d)) return acc;
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = walk(runDir);
console.log("mp4s on disk", files.filter((f) => f.endsWith(".mp4")).length);
console.log("pngs on disk", files.filter((f) => f.endsWith(".png")).length);

console.log("\nCOST MODEL RISK:");
console.log(
  `  ${script?.shots?.length ?? "?"} shots × (1–2 keyframes + 1–2 Veo submits) ≈ up to ${(script?.shots?.length ?? 0) * 4} billable gens if run to completion`,
);
