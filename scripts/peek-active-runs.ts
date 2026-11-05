import { getDb } from "../src/db";

const db = getDb();
console.log(
  db
    .prepare(
      `SELECT id, status, current_shot_index AS shot, substr(coalesce(error,''),1,90) AS msg
       FROM runs WHERE status IN ('generating','queued','stitching','waiting_human','rework')
       ORDER BY updated_at DESC`,
    )
    .all(),
);
console.log(
  db.prepare(`SELECT run_id, type, status FROM jobs WHERE status IN ('pending','running')`).all(),
);
