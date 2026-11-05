import { getDb } from "../src/db";

const db = getDb();
const rows = db
  .prepare(
    `SELECT id, shot_index, kind, model_name, substr(prompt,1,120) as prompt, selected, path
     FROM variants WHERE run_id=? ORDER BY rowid`,
  )
  .all("run_45470a1c");
console.log(JSON.stringify(rows, null, 2));
const r = db.prepare(`SELECT status, error FROM runs WHERE id=?`).get("run_45470a1c") as {
  status: string;
  error: string | null;
};
console.log("run", r);
