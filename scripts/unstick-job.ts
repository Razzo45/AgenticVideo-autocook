/**
 * Fail a stuck running job so retry can re-enqueue script.
 * Usage: npx tsx scripts/unstick-job.ts run_91d794cf
 */
import { getDb, getRun, updateRun } from "../src/db";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: npx tsx scripts/unstick-job.ts <runId>");
  process.exit(1);
}
const run = getRun(runId);
if (!run) {
  console.error("Unknown run");
  process.exit(1);
}
const ts = new Date().toISOString();
const result = getDb()
  .prepare(
    `UPDATE jobs SET status='error', error=?, updated_at=? WHERE run_id=? AND status IN ('pending','running')`,
  )
  .run("Unstuck — hung Astra storyboard await (no progress). Retry to re-call.", ts, runId);
updateRun(runId, {
  status: "failed",
  gate: null,
  error: "Stuck on Astra storyboard (worker await never returned after API pulse). Retry to resume.",
});
console.log(`cleared ${result.changes} job(s); run=${runId} → failed`);
