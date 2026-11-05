import { getRun, getDb } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";

const id = "run_5f59ce50";
retryRun(id);
const r = getRun(id)!;
console.log({ status: r.status, err: r.error, shot: r.current_shot_index });
console.log(
  getDb()
    .prepare("SELECT type, status FROM jobs WHERE run_id=? ORDER BY created_at DESC LIMIT 5")
    .all(id),
);
