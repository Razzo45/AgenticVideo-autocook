import { getDb, getRun } from "../src/db";
const r = getRun("run_5f59ce50");
console.log({
  status: r?.status,
  err: r?.error,
  mode: r?.pipeline_mode,
  dur: r?.target_duration,
  res: r?.output_resolution,
  session: r?.session_id,
});
const j = getDb()
  .prepare("SELECT type, status FROM jobs WHERE run_id=?")
  .all("run_5f59ce50");
console.log(j);
