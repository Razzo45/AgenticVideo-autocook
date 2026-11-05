/**
 * In-process createRun for audio mode (enqueues audio_plan). Does not burn Gemini.
 * Usage: npx tsx scripts/smoke-audio-create.ts
 */
import { createRun } from "../src/pipeline/orchestrator";
import { getRun, getDb } from "../src/db";

const run = createRun({
  prompt:
    "A 20-second tension cue under two short lines: \"We found the room.\" then \"Don't touch anything.\" Instrumental only.",
  category: "Short Drama / Film & TV",
  duration: 20,
  aspect: "16:9",
  pipelineMode: "audio",
  sessionLabel: "smoke-audio",
});

const jobs = getDb()
  .prepare(`SELECT type, status FROM jobs WHERE run_id=? ORDER BY created_at`)
  .all(run.id) as Array<{ type: string; status: string }>;

const fresh = getRun(run.id)!;
console.log(
  JSON.stringify(
    {
      id: fresh.id,
      session: fresh.session_id,
      mode: fresh.pipeline_mode,
      status: fresh.status,
      jobs,
    },
    null,
    2,
  ),
);

// Cancel so a worker does not pick it up and burn Gemini during smoke.
getDb()
  .prepare(`UPDATE jobs SET status='error', error=? WHERE run_id=? AND status IN ('pending','running')`)
  .run("smoke-audio-create cancelled", run.id);
getDb().prepare(`UPDATE runs SET status='failed', error=? WHERE id=?`).run("smoke create only — cancelled", run.id);
console.log("[ok] created and cancelled before worker pickup");
