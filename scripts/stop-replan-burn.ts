import { getDb, getRun, updateRun } from "../src/db";

const id = "run_51a7fa64";
const db = getDb();
const ts = new Date().toISOString();
const r = db
  .prepare(
    `UPDATE jobs SET status='error', error=?, updated_at=? WHERE run_id=? AND status IN ('pending','running')`,
  )
  .run("Stopped: cancel mid-replan credit burn; switching to normal auto recovery", ts, id);
updateRun(id, {
  status: "failed",
  gate: null,
  error: "Stopped mid-replan. Fixing scene 4 with normal auto path (proven Marcus frame).",
});
console.log({ cleared: r.changes, status: getRun(id)?.status });
