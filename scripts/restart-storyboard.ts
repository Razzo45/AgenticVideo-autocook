/**
 * Throw away a run's storyboard and every still/clip, then resume from the script step.
 *
 * Usage: npx tsx scripts/restart-storyboard.ts <runId>
 */
import { getDb, getRun } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";

const runId = process.argv[2];
if (!runId) throw new Error("usage: restart-storyboard.ts <runId>");
const db = getDb();
const v = db.prepare("UPDATE variants SET selected = 0, rejected = 1 WHERE run_id = ?").run(runId);
db.prepare("UPDATE runs SET script_json = NULL, status = 'failed', gate = NULL, error = 'Storyboard restart' WHERE id = ?").run(runId);
console.log(`[rejected] ${v.changes} variant(s)`);
retryRun(runId);
const fresh = getRun(runId)!;
console.log(`[resumed] status=${fresh.status} msg=${fresh.error}`);
