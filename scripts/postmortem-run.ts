/**
 * Post-mortem dump for run_f2c457c0
 */
import fs from "node:fs";
import { getDb, getRun, listVariants } from "../src/db";

const runId = process.argv[2] || "run_f2c457c0";
const run = getRun(runId);
if (!run) {
  console.log("missing run", runId);
  process.exit(1);
}
const db = getDb();
const jobs = db
  .prepare(
    `SELECT id, type, status, payload_json, error, created_at, updated_at
     FROM jobs WHERE run_id=? ORDER BY created_at`,
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

const script = run.script_json ? JSON.parse(run.script_json) : null;
const shots = script?.shots ?? [];
const transitions = shots.reduce(
  (acc: Record<string, number>, s: { transition?: string }) => {
    const t = s.transition || "?";
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  },
  {},
);

console.log("=== RUN ===");
console.log({
  id: run.id,
  session: run.session_id,
  status: run.status,
  mode: run.pipeline_mode,
  duration_target: run.target_duration,
  res: run.output_resolution,
  video: run.video_model,
  keyframe: run.keyframe_model,
  shot_index: run.current_shot_index,
  created: run.created_at,
  updated: run.updated_at,
  error: (run.error || "").slice(0, 300),
  auto_options: run.auto_options_json,
});
console.log("shots planned", shots.length, "transitions", transitions);
console.log(
  "planned total sec",
  shots.reduce((a: number, s: { duration: number }) => a + (s.duration || 0), 0),
);

console.log("\n=== JOBS (chronological) ===");
for (const j of jobs) {
  const mins = ((Date.parse(j.updated_at) - Date.parse(j.created_at)) / 60000).toFixed(1);
  console.log(
    `${j.created_at}  ${j.status.padEnd(6)} ${j.type.padEnd(10)} ${j.payload_json.padEnd(24)} ${mins}m  ${(j.error || "").replace(/\s+/g, " ").slice(0, 160)}`,
  );
}

const variants = listVariants(runId);
console.log("\n=== VARIANTS ===");
for (const v of variants.sort((a, b) => a.shot_index - b.shot_index || a.kind.localeCompare(b.kind) || a.variant_index - b.variant_index)) {
  const sz = fs.existsSync(v.path) ? `${(fs.statSync(v.path).size / 1e6).toFixed(1)}MB` : "MISSING";
  console.log(
    `shot ${v.shot_index} ${v.kind} #${v.variant_index} sel=${v.selected} rej=${v.rejected} ${v.model_name} ${sz}`,
  );
}

// Per-shot synopsis from script
console.log("\n=== SHOT BOARD (first media_desc / transition) ===");
for (const s of shots.slice(0, 12)) {
  console.log(
    `  ${String(s.index).padStart(2)} ${s.transition} ${s.duration}s  ${(s.media_desc || s.image_prompt || "").slice(0, 100)}`,
  );
}
if (shots.length > 12) console.log(`  … +${shots.length - 12} more`);

// Error taxonomy
const errs = jobs.filter((j) => j.error).map((j) => j.error!);
const taxonomy: Record<string, number> = {};
for (const e of errs) {
  let k = "other";
  if (/filter|empty|safety|content/i.test(e)) k = "filter/empty";
  else if (/overload|capacity|503|high load|try again/i.test(e)) k = "capacity/overload";
  else if (/Abort|operator|Interrupted|worker/i.test(e)) k = "operator/abort";
  else if (/Auto advance/i.test(e)) k = "auto-advance";
  taxonomy[k] = (taxonomy[k] || 0) + 1;
}
console.log("\n=== ERROR TAXONOMY (jobs with error text) ===", taxonomy);
