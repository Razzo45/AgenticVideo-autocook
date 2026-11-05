/**
 * Mark a finished run as failed so retryRun / redo-keyframe can resume it (e.g. to redo one delivered scene).
 *
 * Usage: npx tsx scripts/reopen-run.ts <runId> [note]
 */
import { getDb } from "../src/db";

const [runId, note = "Reopened for scene redo"] = process.argv.slice(2);
if (!runId) throw new Error("usage: reopen-run.ts <runId> [note]");
const res = getDb().prepare("UPDATE runs SET status = 'failed', error = ? WHERE id = ?").run(note, runId);
console.log(`[reopened] ${runId} (${res.changes} row)`);
