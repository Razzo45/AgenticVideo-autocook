import fs from "node:fs";
import path from "node:path";
import { getDb, getRun, listRuns, listVariants } from "../src/db";

const db = getDb();
const hit = db
  .prepare(
    `SELECT id, session_id, status, current_shot_index, error, script_json, video_model, output_resolution, auto_options_json
     FROM runs WHERE error LIKE '%Scene 10%' OR error LIKE '%scene 10%' OR error LIKE '%5rab71pDlasSpgD5OrZG%'
     ORDER BY updated_at DESC LIMIT 5`,
  )
  .all() as Array<Record<string, unknown>>;

let runId = hit[0]?.id as string | undefined;
if (!runId) {
  const failed = listRuns().filter((r) => r.status === "failed" && /filter|empty|Scene \d+/i.test(r.error || ""));
  console.log(
    "candidates",
    failed.slice(0, 8).map((r) => ({ id: r.id, err: (r.error || "").slice(0, 100), shot: r.current_shot_index })),
  );
  runId = failed[0]?.id;
}
if (!runId) {
  console.log("no matching run");
  process.exit(1);
}

const run = getRun(runId)!;
const script = JSON.parse(run.script_json!);
const shotIndex = 9; // scene 10
const shot = script.shots[shotIndex];
console.log("=== RUN ===");
console.log({
  id: run.id,
  session: run.session_id,
  status: run.status,
  video: run.video_model,
  res: run.output_resolution,
  err: run.error,
  toggles: run.auto_options_json,
});

console.log("\n=== SCENE 10 (index 9) ===");
console.log(JSON.stringify(shot, null, 2));

const kfs = listVariants(run.id, shotIndex, "keyframe");
const clips = listVariants(run.id, shotIndex, "clip");
console.log("\n=== KEYFRAMES ===");
for (const v of kfs) {
  const exists = fs.existsSync(v.path);
  console.log({
    sel: v.selected,
    rej: v.rejected,
    model: v.model_name,
    mb: exists ? +(fs.statSync(v.path).size / 1e6).toFixed(2) : 0,
    path: v.path,
    prompt: (v.prompt || "").slice(0, 500),
  });
}
console.log("\n=== CLIPS ===", clips.length);

const jobs = db
  .prepare(
    `SELECT type, status, payload_json, error, created_at, updated_at FROM jobs WHERE run_id=? AND payload_json LIKE '%"shotIndex":9%' ORDER BY created_at`,
  )
  .all(run.id) as Array<{ type: string; status: string; error: string | null; created_at: string; updated_at: string }>;
console.log("\n=== JOBS shot 9 ===");
for (const j of jobs) {
  console.log(j.status, j.type, ((Date.parse(j.updated_at) - Date.parse(j.created_at)) / 60000).toFixed(1) + "m", (j.error || "").slice(0, 200));
}

// Risk heuristics on motion + image prompts
const text = `${shot?.image_prompt || ""}\n${shot?.motion_prompt || ""}`;
const flags: string[] = [];
if (/weapon|gun|blood|kill|fight|punch|slash|stab/i.test(text)) flags.push("violence lexicon");
if (/\b(1\.|2\.|3\.|bullet|list|numbered)\b/i.test(text)) flags.push("numbered/list graphics");
if (/logo|watermark|brand|trademark/i.test(text)) flags.push("logo/brand language");
if (/text on screen|on-screen|lower.?third|title card|graphic/i.test(text)) flags.push("on-screen text/graphics");
if ((text.match(/"/g) || []).length >= 2) flags.push("quoted verbatim VO / text");
if (/UI|interface|screenshot|chrome/i.test(text)) flags.push("UI chrome");
console.log("\n=== HEURISTIC FLAGS ===", flags);

// Compare nearby scenes that succeeded
console.log("\n=== NEIGHBOR SCENES (8–11) media_desc ===");
for (const i of [7, 8, 9, 10, 11]) {
  const s = script.shots[i];
  if (!s) continue;
  const has = listVariants(run.id, i, "clip").some((v) => v.selected);
  console.log(`scene ${i + 1} clip=${has ? "OK" : "—"} ${s.transition} ${(s.media_desc || "").slice(0, 110)}`);
}
