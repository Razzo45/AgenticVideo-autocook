import fs from "node:fs";
import path from "node:path";
import { getRun, listVariants, getDb } from "../src/db";

const runId = "run_f2c457c0";
const run = getRun(runId)!;
const variants = listVariants(runId);

console.log("status", run.status, "shot", run.current_shot_index);
console.log("error", run.error);

for (const v of variants) {
  const st = fs.existsSync(v.path) ? fs.statSync(v.path).size : -1;
  console.log(
    [v.kind, `shot${v.shot_index}`, `#${v.variant_index}`, `sel${v.selected}`, `rej${v.rejected}`, (v.model_name || "").slice(0, 40), st, v.created_at].join(" | "),
  );
}

const script = JSON.parse(run.script_json!);
console.log("shotCount", script.shots.length);
console.log(
  "per-shot durations",
  script.shots.map((s: { duration: number }, i: number) => `${i}:${s.duration}s`).join(" "),
);

const db = getDb();
const jobs = db
  .prepare("SELECT type, status, payload_json, error, created_at, updated_at FROM jobs WHERE run_id=? ORDER BY created_at")
  .all(runId) as Array<{
  type: string;
  status: string;
  payload_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}>;

console.log("\njobs timeline:");
for (const j of jobs) {
  const start = Date.parse(j.created_at);
  const end = Date.parse(j.updated_at);
  const mins = ((end - start) / 60000).toFixed(1);
  console.log(`${j.type} ${j.payload_json} ${j.status} ${mins}m  ${j.created_at} -> ${j.updated_at}${j.error ? " ERR " + j.error.slice(0, 120) : ""}`);
}

const clipsJobs = jobs.filter((j) => j.type === "clips");
console.log("\nclips jobs count", clipsJobs.length);
console.log(
  "done clips",
  clipsJobs.filter((j) => j.status === "done").length,
  "running",
  clipsJobs.filter((j) => j.status === "running").length,
  "error",
  clipsJobs.filter((j) => j.status === "error").length,
);

const clipFiles = variants.filter((v) => v.kind === "clip" && fs.existsSync(v.path));
console.log("successful clip files on disk", clipFiles.length);
console.log(
  "by shot",
  [0, 1, 2, 3, 4, 5].map((s) => ({
    shot: s,
    clips: variants.filter((v) => v.kind === "clip" && v.shot_index === s).length,
    kfs: variants.filter((v) => v.kind === "keyframe" && v.shot_index === s).length,
    clipBytes: variants
      .filter((v) => v.kind === "clip" && v.shot_index === s && fs.existsSync(v.path))
      .map((v) => fs.statSync(v.path).size),
  })),
);

const runDir = path.join("runs", runId);
function walk(d: string, acc: Array<{ p: string; size: number; mtime: string }> = []) {
  if (!fs.existsSync(d)) return acc;
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else acc.push({ p, size: s.size, mtime: s.mtime.toISOString() });
  }
  return acc;
}
const files = walk(runDir);
console.log("\nmp4 files:", files.filter((f) => f.p.endsWith(".mp4")).length);
for (const f of files.filter((f) => f.p.endsWith(".mp4"))) {
  console.log(f.size, f.mtime, f.p);
}
