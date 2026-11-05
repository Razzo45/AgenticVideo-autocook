/**
 * Live short auto cook against GEMINI_API_KEY (Omni). Leaves the run for the worker.
 * Usage: npx tsx scripts/smoke-live-cook.ts
 */
import fs from "node:fs";
import path from "node:path";
import { preflightCook } from "../src/autocook/preflightCook";
import { createRun } from "../src/pipeline/orchestrator";
import { PRODUCT_VIDEO_MODEL, BRAIN_MODEL } from "../src/pipeline/constants";
import { getRun } from "../src/db";

function loadDotEnv() {
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

async function main() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") throw new Error("GEMINI_API_KEY missing");
  console.log(`[live] GEMINI_API_KEY len=${key.length} video=${PRODUCT_VIDEO_MODEL} brain=${BRAIN_MODEL}`);

  const prompt =
    "A calm 8-second product beat in 16:9: soft daylight, a ceramic mug on a wooden table, steam rises gently. No people, no text, no logos. Cut once if needed.";

  console.log("[live] preflight…");
  const pre = await preflightCook({
    prompt,
    mode: "video",
    durationSec: 8,
    aspect: "16:9",
  });
  if (pre.status === "hardBlock") {
    throw new Error(`hardBlock: ${JSON.stringify(pre.risks)}`);
  }
  console.log("[live] preflight=", pre.status);

  const run = createRun({
    prompt: pre.rewrittenBrief,
    category: "E-commerce & Advertising",
    duration: 8,
    aspect: "16:9",
    pipelineMode: "auto",
    sessionLabel: "live-mug-8s",
    outputResolution: "1080p",
    autoOptions: {
      longCook: false,
      deliver4k: false,
      presenterIdentity: false,
      voiceGuidance: false,
      verbatimScript: true,
      brandLock: false,
      timedGraphics: false,
    },
  });
  const fresh = getRun(run.id)!;
  console.log(
    JSON.stringify(
      {
        id: fresh.id,
        session: fresh.session_id,
        status: fresh.status,
        video: fresh.video_model,
        script: fresh.script_model,
      },
      null,
      2,
    ),
  );
  console.log("[live] enqueued — start worker with: npm run worker");
}

main().catch((err) => {
  console.error("[live] FAILED", err);
  process.exit(1);
});
