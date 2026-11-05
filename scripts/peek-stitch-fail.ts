import { getDb, getRun } from "../src/db";

const id = "run_51a7fa64";
const run = getRun(id)!;
console.log({
  status: run.status,
  error: run.error,
  aspect: run.aspect_ratio,
  res: run.output_resolution,
  mode: run.pipeline_mode,
});
const jobs = getDb()
  .prepare(
    `SELECT type, status, substr(coalesce(error,''),1,250) AS err, updated_at
     FROM jobs WHERE run_id=? ORDER BY updated_at DESC LIMIT 10`,
  )
  .all(id);
for (const j of jobs) console.log(j);
