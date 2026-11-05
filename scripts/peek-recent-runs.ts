import { getDb } from "../src/db";

const db = getDb();
const runs = db
  .prepare(
    `SELECT id, session_id, status, current_shot_index, substr(coalesce(error,''),1,240) AS error
     FROM runs ORDER BY updated_at DESC LIMIT 8`,
  )
  .all();
console.log(JSON.stringify(runs, null, 2));
