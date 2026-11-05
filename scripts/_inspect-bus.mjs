import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("runs/pipeline.db");
const run = db
  .prepare("SELECT * FROM runs WHERE session_id LIKE ? ORDER BY created_at DESC LIMIT 1")
  .get("%late-bus%");
if (!run) {
  console.log("no run");
  process.exit(0);
}
const { script_json, ...rest } = run;
console.log(JSON.stringify({ ...rest, hasScript: Boolean(script_json) }, null, 2));
const clips = db
  .prepare(
    "SELECT id, shot_index, variant_index, selected, rejected, model_name, substr(prompt,1,600) AS prompt, path, created_at FROM variants WHERE run_id=? AND kind='clip' ORDER BY created_at DESC LIMIT 20",
  )
  .all(run.id);
console.log("--- clips ---");
for (const c of clips) console.log(JSON.stringify(c, null, 2));
const jobs = db
  .prepare(
    "SELECT id, type, status, substr(payload_json,1,200) AS payload, substr(error,1,300) AS error, created_at, updated_at FROM jobs WHERE run_id=? ORDER BY created_at DESC LIMIT 15",
  )
  .all(run.id);
console.log("--- jobs ---");
for (const j of jobs) console.log(JSON.stringify(j, null, 2));
