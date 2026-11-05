/**
 * Resume a failed run from its first scene without a selected clip.
 *
 * Usage: npx tsx scripts/resume-run.ts <runId>
 */
import { getRun } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";

const [runId] = process.argv.slice(2);
if (!runId) throw new Error("usage: resume-run.ts <runId>");
retryRun(runId);
const r = getRun(runId)!;
console.log({ status: r.status, error: r.error, shot: r.current_shot_index });
