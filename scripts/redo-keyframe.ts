/**
 * Reject the selected keyframe (and any clips) for one scene of a failed run, then resume —
 * the resume regenerates that scene's still before its clip.
 *
 * Usage: npx tsx scripts/redo-keyframe.ts <runId> <shotIndex>
 */
import { getDb, getRun } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";

const [runId, shotArg] = process.argv.slice(2);
const shot = Number(shotArg);
if (!runId || !Number.isInteger(shot)) throw new Error("usage: redo-keyframe.ts <runId> <shotIndex>");

const res = getDb()
  .prepare(
    "UPDATE variants SET selected = 0, rejected = 1 WHERE run_id = ? AND shot_index = ? AND kind IN ('keyframe','clip')",
  )
  .run(runId, shot);
console.log(`[rejected] ${res.changes} variant(s) on scene ${shot + 1}`);

retryRun(runId);
const fresh = getRun(runId)!;
console.log(`[resumed] status=${fresh.status} shot=${fresh.current_shot_index} msg=${fresh.error}`);
