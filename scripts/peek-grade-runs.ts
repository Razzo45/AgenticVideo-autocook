import { getDb } from "../src/db";

const ids = process.argv.slice(2);
const db = getDb();
for (const id of ids) {
  const run = db.prepare(`SELECT id, status, error, current_shot_index FROM runs WHERE id=?`).get(id);
  const jobs = db
    .prepare(`SELECT type, status, substr(coalesce(error,''),1,160) AS error FROM jobs WHERE run_id=? ORDER BY created_at`)
    .all(id);
  console.log(JSON.stringify({ run, jobs }, null, 2));
}
const busy = db
  .prepare(`SELECT id, status, substr(coalesce(error,''),1,100) AS error FROM runs WHERE status IN ('generating','stitching','exporting')`)
  .all();
console.log("busy", busy);
