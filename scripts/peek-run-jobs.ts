import { getDb } from "../src/db";

const runId = process.argv[2];
if (!runId) throw new Error("usage: peek-run-jobs.ts <runId>");

const db = getDb();
console.log(
  db
    .prepare("SELECT id, status, current_shot_index AS shot, error FROM runs WHERE id = ?")
    .get(runId),
);
console.log(
  db
    .prepare(
      "SELECT type, status, substr(coalesce(payload_json,''),1,80) AS payload, substr(coalesce(error,''),1,600) AS error, created_at, updated_at FROM jobs WHERE run_id = ? ORDER BY created_at",
    )
    .all(runId),
);
