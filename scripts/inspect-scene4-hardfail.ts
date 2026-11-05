import fs from "node:fs";
import path from "node:path";
import { getDb, getRun, listVariants } from "../src/db";

const id = "run_51a7fa64";
const run = getRun(id)!;
const db = getDb();

console.log("=== RUN ===");
console.log({
  status: run.status,
  shot: run.current_shot_index,
  error: run.error,
  script_model: run.script_model,
  video: run.video_model,
  updated: run.updated_at,
});

const jobs = db
  .prepare(
    `SELECT type, status, substr(coalesce(error,''),1,300) AS err, payload_json, created_at, updated_at
     FROM jobs WHERE run_id=? AND payload_json LIKE '%"shotIndex":3%' ORDER BY updated_at DESC LIMIT 10`,
  )
  .all(id);
console.log("=== SHOT3 JOBS ===");
for (const j of jobs) console.log(j);

console.log("=== SHOT3 VARIANTS (filtered) ===");
for (const v of listVariants(id, 3)) {
  console.log({
    kind: v.kind,
    shot: v.shot_index,
    sel: v.selected,
    rej: v.rejected,
    model: v.model_name,
    exists: fs.existsSync(v.path),
    bytes: fs.existsSync(v.path) ? fs.statSync(v.path).size : 0,
    path: v.path,
    promptHead: (v.prompt || "").slice(0, 180),
  });
}

const script = JSON.parse(run.script_json!);
console.log("=== SHOT 3 FULL ===");
console.log(JSON.stringify(script.shots[3], null, 2));
console.log("=== SHOT 0 MOTION (worked) ===");
console.log(script.shots[0].motion_prompt);
console.log("=== SHOT 1 MOTION (worked) ===");
console.log(script.shots[1].motion_prompt);

const orch = path.join("runs", id, "astra_orch.json");
if (fs.existsSync(orch)) console.log("ORCH", fs.readFileSync(orch, "utf8"));

// Compare keyframe paths
const kf3 = listVariants(id, 3, "keyframe").find((v) => v.selected);
const kf0 = listVariants(id, 0, "keyframe").find((v) => v.selected);
console.log("KF0", kf0?.path, kf0 && fs.existsSync(kf0.path));
console.log("KF3", kf3?.path, kf3 && fs.existsSync(kf3.path));
