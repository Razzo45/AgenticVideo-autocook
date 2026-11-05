import { getDb, getRun } from "../src/db";
const id = process.argv[2];
if (!id) {
  console.error("Usage: npx tsx scripts/poll-run.ts <runId>");
  process.exit(1);
}
const r = getRun(id);
const jobs = getDb()
  .prepare(`SELECT type, status, substr(coalesce(error,''),1,160) AS e FROM jobs WHERE run_id=? ORDER BY created_at`)
  .all(id);
console.log(
  JSON.stringify(
    {
      status: r?.status,
      gate: r?.gate,
      error: r?.error,
      shot: r?.current_shot_index,
      jobs,
    },
    null,
    2,
  ),
);
