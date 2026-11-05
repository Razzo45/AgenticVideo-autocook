/** Stop every pending/running job and mark active runs failed. */
import { getDb, listRuns, updateRun } from "../src/db";

const ts = new Date().toISOString();
const db = getDb();
const jobs = db
  .prepare(`SELECT id, run_id, type, status FROM jobs WHERE status IN ('pending','running')`)
  .all() as Array<{ id: string; run_id: string; type: string; status: string }>;
const cleared = db
  .prepare(
    `UPDATE jobs SET status='error', error=?, updated_at=? WHERE status IN ('pending','running')`,
  )
  .run("Stopped by operator", ts);

const active = listRuns().filter((r) =>
  ["queued", "generating", "awaiting_review"].includes(r.status),
);
for (const run of active) {
  updateRun(run.id, {
    status: "failed",
    gate: null,
    error: "Stopped by operator",
  });
}

console.log(
  JSON.stringify(
    {
      clearedJobs: cleared.changes,
      jobs,
      stoppedRuns: active.map((r) => r.id),
    },
    null,
    2,
  ),
);
