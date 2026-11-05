/**
 * Resume Stonefield cook with LLM filter-recovery (real Veo retakes — no freeze skips).
 */
import { getRun, updateRun } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";

const runId = process.argv[2] || "run_51a7fa64";
const run = getRun(runId);
if (!run) throw new Error(`missing ${runId}`);

updateRun(runId, {
  error: "Resuming with LLM filter-recovery (rewrite → new keyframe/clip as needed)…",
});

if (run.status === "failed" || (run.status === "waiting_human" && run.gate === "clip")) {
  retryRun(runId);
} else if (run.status !== "generating") {
  retryRun(runId);
}

const fresh = getRun(runId)!;
console.log(`[resumed] status=${fresh.status} shot=${fresh.current_shot_index}`);
console.log(`[msg] ${fresh.error}`);
console.log(`[open] http://127.0.0.1:3000/runs/${runId}`);
console.log("Restart worker if needed so rewrite recovery is loaded: npm run worker");
