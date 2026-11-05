/**
 * Inspect scene 34 filter fail on the active auto run.
 */
import fs from "node:fs";
import { getDb, getRun, listRuns, listVariants } from "../src/db";
import { autoOptionsFromRun, autoRequirementsPrompt } from "../src/pipeline/autoOptions";

const db = getDb();
const hit = db
  .prepare(
    `SELECT id, session_id, status, current_shot_index, error, video_model, output_resolution
     FROM runs WHERE error LIKE '%Scene 34%' OR error LIKE '%9cYXoQ0j6ydufhix0hqC%'
     ORDER BY updated_at DESC LIMIT 3`,
  )
  .all() as Array<{ id: string; error: string; current_shot_index: number }>;

let runId = hit[0]?.id;
if (!runId) {
  const failed = listRuns().find((r) => /Scene 34/i.test(r.error || ""));
  runId = failed?.id;
}
if (!runId) {
  console.log("no run");
  process.exit(1);
}

const run = getRun(runId)!;
const SHOT = 33; // scene 34
const script = JSON.parse(run.script_json!);
const shot = script.shots[SHOT];

console.log("=== RUN ===", {
  id: run.id,
  status: run.status,
  err: (run.error || "").slice(0, 220),
  video: run.video_model,
  res: run.output_resolution,
  toggles: run.auto_options_json,
});

console.log("\n=== SCENE 34 ===");
console.log(JSON.stringify(shot, null, 2));

const extra = autoRequirementsPrompt(autoOptionsFromRun(run), { shot });
console.log("\n=== GRAPHICS / TOGGLE LINES ===");
console.log(
  extra
    .split("\n")
    .filter((l) => /GRAPHIC|talking-head|PRESENTER|BRAND/i.test(l))
    .join("\n"),
);

const kfs = listVariants(run.id, SHOT, "keyframe");
console.log("\n=== KEYFRAMES ===");
for (const v of kfs) {
  console.log({
    sel: v.selected,
    rej: v.rejected,
    model: v.model_name,
    mb: fs.existsSync(v.path) ? +(fs.statSync(v.path).size / 1e6).toFixed(2) : 0,
    path: v.path,
    promptHead: (v.prompt || "").slice(0, 280),
  });
}

const jobs = db
  .prepare(
    `SELECT status, type, error, created_at, updated_at FROM jobs
     WHERE run_id=? AND payload_json LIKE '%"shotIndex":33%' ORDER BY created_at`,
  )
  .all(run.id) as Array<{ status: string; type: string; error: string | null; created_at: string; updated_at: string }>;
console.log("\n=== JOBS shot 33 ===");
for (const j of jobs) {
  console.log(
    j.status,
    j.type,
    ((Date.parse(j.updated_at) - Date.parse(j.created_at)) / 60000).toFixed(1) + "m",
    (j.error || "").slice(0, 160),
  );
}

// neighbors
console.log("\n=== NEIGHBORS ===");
for (const i of [31, 32, 33, 34]) {
  const s = script.shots[i];
  if (!s) continue;
  const ok = listVariants(run.id, i, "clip").some((v) => v.selected);
  console.log(`scene ${i + 1} clip=${ok ? "OK" : "—"} ${s.transition} ${(s.media_desc || "").slice(0, 100)}`);
}

// check if code still says one attempt in error path
const clipSrc = fs.readFileSync("src/pipeline/orchestrator.ts", "utf8");
const m = clipSrc.match(/maxFilterAttempts:\s*auto\s*\?\s*([^,\n]+)/);
console.log("\n=== CODE maxFilterAttempts ===", m?.[1]?.trim());
