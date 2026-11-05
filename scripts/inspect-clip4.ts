import fs from "node:fs";
import { getDb, getRun, listVariants } from "../src/db";

const runId = "run_f2c457c0";
const run = getRun(runId);
if (!run) {
  console.log("run missing");
  process.exit(1);
}
console.log({
  status: run.status,
  shot: run.current_shot_index,
  error: run.error,
});

const db = getDb();
const jobs = db
  .prepare(
    "SELECT id, type, status, payload_json, error, created_at, updated_at FROM jobs WHERE run_id=? ORDER BY created_at",
  )
  .all(runId) as Array<{
  id: string;
  type: string;
  status: string;
  payload_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}>;

const clip4 = jobs.filter((j) => j.type === "clips" && j.payload_json.includes('"shotIndex":3'));
console.log("\nclip/shot3 jobs:", clip4.length);
for (const j of clip4) {
  const mins = ((Date.parse(j.updated_at) - Date.parse(j.created_at)) / 60000).toFixed(1);
  console.log({
    id: j.id.slice(0, 8),
    status: j.status,
    mins,
    created: j.created_at,
    updated: j.updated_at,
    error: j.error?.slice(0, 200) ?? null,
  });
}

console.log("\nall clips jobs:");
for (const j of jobs.filter((j) => j.type === "clips")) {
  console.log(j.created_at, j.status, j.payload_json, (j.error || "").slice(0, 120));
}

const variants = listVariants(runId).filter((v) => v.kind === "clip" && v.shot_index === 3);
console.log("\nshot3 clip variants", variants.length);
for (const v of variants) {
  console.log({
    idx: v.variant_index,
    sel: v.selected,
    rej: v.rejected,
    exists: fs.existsSync(v.path),
    bytes: fs.existsSync(v.path) ? fs.statSync(v.path).size : 0,
    created: v.created_at,
  });
}

const active = db
  .prepare("SELECT id, run_id, type, status, payload_json FROM jobs WHERE status IN ('pending','running')")
  .all() as Array<{ id: string; run_id: string; type: string; status: string; payload_json: string }>;
console.log("\nglobal active jobs", active.length);
for (const j of active) console.log(j);
