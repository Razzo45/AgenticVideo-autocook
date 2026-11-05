import { getDb, getRun, updateRun } from "../src/db";

const id = process.argv[2] ?? "run_e68704af";
const ts = new Date().toISOString();
const result = getDb()
  .prepare(
    `UPDATE jobs SET status='error', error=?, updated_at=? WHERE run_id=? AND status IN ('pending','running')`,
  )
  .run("Stopped by operator", ts, id);
updateRun(id, {
  status: "failed",
  gate: null,
  error: "Stopped by operator.",
});
const run = getRun(id);
console.log(JSON.stringify({ cleared: result.changes, status: run?.status, error: run?.error }, null, 2));
