/**
 * Smoke: Argon brain + createRun(auto/audio) on the autocook copy.
 * Does not start a long cook — cancels enqueued jobs after verifying wiring.
 *
 * Usage: npx tsx scripts/smoke-autocook.ts
 */
import { brainCompletion } from "../src/pipeline/geminiBrain";
import { BRAIN_MODEL } from "../src/pipeline/constants";
import { createRun } from "../src/pipeline/orchestrator";
import { getDb, getRun } from "../src/db";

function loadDotEnv() {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

async function smokeBrain() {
  console.log(`[smoke] Argon brainCompletion (${BRAIN_MODEL})…`);
  const text = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      {
        role: "system",
        content: 'Return JSON {"ok":true,"model":"gemini-4-argon","beats":[string]}. Exactly 2 short beats.',
      },
      {
        role: "user",
        content: "Plan a 2-beat 8-second product demo: open on logo, then hand holds phone.",
      },
    ],
  });
  const parsed = JSON.parse(text) as { ok?: boolean; model?: string; beats?: string[] };
  if (!parsed.ok || !Array.isArray(parsed.beats) || parsed.beats.length < 1) {
    throw new Error(`unexpected Argon payload: ${text.slice(0, 400)}`);
  }
  console.log("[smoke] Argon plan ok:", JSON.stringify(parsed).slice(0, 240));
}

function cancelRun(runId: string, reason: string) {
  getDb()
    .prepare(`UPDATE jobs SET status='error', error=? WHERE run_id=? AND status IN ('pending','running')`)
    .run(reason, runId);
  getDb().prepare(`UPDATE runs SET status='failed', error=? WHERE id=?`).run(reason, runId);
}

function smokeCreate(mode: "auto" | "audio") {
  const run = createRun({
    prompt:
      mode === "audio"
        ? 'Smoke audio: two lines — "Ready." then "Go." Soft instrumental bed.'
        : "Smoke auto: 8s logo open then phone in hand. Simple cut.",
    category: "Short Drama / Film & TV",
    duration: mode === "audio" ? 20 : 12,
    aspect: "16:9",
    pipelineMode: mode,
    sessionLabel: `smoke-${mode}`,
  });
  const jobs = getDb()
    .prepare(`SELECT type, status FROM jobs WHERE run_id=?`)
    .all(run.id) as Array<{ type: string; status: string }>;
  const fresh = getRun(run.id)!;
  if (fresh.script_model !== BRAIN_MODEL) {
    throw new Error(`expected script_model=${BRAIN_MODEL}, got ${fresh.script_model}`);
  }
  const expectJob = mode === "audio" ? "audio_plan" : "script";
  if (!jobs.some((j) => j.type === expectJob && j.status === "pending")) {
    throw new Error(`expected pending ${expectJob}, got ${JSON.stringify(jobs)}`);
  }
  cancelRun(run.id, "smoke-autocook cancelled");
  console.log(
    `[smoke] createRun(${mode}) ok id=${fresh.id} session=${fresh.session_id} script=${fresh.script_model} jobs=${JSON.stringify(jobs)}`,
  );
}

async function main() {
  await smokeBrain();
  smokeCreate("auto");
  smokeCreate("audio");
  console.log("[smoke] all green");
}

main().catch((err) => {
  console.error("[smoke] FAILED", err);
  process.exit(1);
});
