import { getDb, getRun, listVariants } from "../src/db";
import fs from "node:fs";
import path from "node:path";

const id = "run_51a7fa64";
const run = getRun(id)!;
const db = getDb();

console.log("=== RUN ===");
console.log({
  status: run.status,
  shot: run.current_shot_index,
  error: run.error,
  updated: run.updated_at,
  res: run.output_resolution,
});

const orchPath = path.join("runs", id, "astra_orch.json");
if (fs.existsSync(orchPath)) {
  console.log("=== ASTRA ORCH ===");
  console.log(fs.readFileSync(orchPath, "utf8"));
}

console.log("=== JOBS (last 25) ===");
const jobs = db
  .prepare(
    `SELECT type, status, substr(coalesce(error,''),1,220) AS err, payload_json, created_at, updated_at
     FROM jobs WHERE run_id=? ORDER BY updated_at DESC LIMIT 25`,
  )
  .all(id);
for (const j of jobs) console.log(j);

console.log("=== SHOT 3 VARIANTS ===");
for (const v of listVariants(id, 3)) {
  console.log({
    kind: v.kind,
    sel: v.selected,
    rej: v.rejected,
    model: v.model_name,
    exists: fs.existsSync(v.path),
    bytes: fs.existsSync(v.path) ? fs.statSync(v.path).size : 0,
    id: v.id.slice(0, 8),
    updated: (v as { updated_at?: string }).updated_at,
  });
}

const clipsDir = path.join("runs", id, "shot_3", "clips");
console.log("=== CLIP FILES ===");
if (fs.existsSync(clipsDir)) {
  for (const f of fs.readdirSync(clipsDir)) {
    const p = path.join(clipsDir, f);
    console.log(f, fs.statSync(p).size, fs.statSync(p).mtime.toISOString());
  }
} else console.log("(no clips dir)");

const script = JSON.parse(run.script_json!);
const shot = script.shots[3];
console.log("=== CURRENT SHOT 3 PROMPTS (lens) ===");
console.log("image_len", shot.image_prompt?.length);
console.log("motion_len", shot.motion_prompt?.length);
console.log("image_head", shot.image_prompt?.slice(0, 200));
console.log("motion_head", shot.motion_prompt?.slice(0, 200));
