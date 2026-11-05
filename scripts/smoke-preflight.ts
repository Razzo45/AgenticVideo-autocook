/**
 * Smoke: Argon preflight + createRun Omni defaults (cancels jobs — no burn).
 * Usage: npx tsx scripts/smoke-preflight.ts
 */
import { preflightCook } from "../src/autocook/preflightCook";
import { createRun } from "../src/pipeline/orchestrator";
import { PRODUCT_VIDEO_MODEL, BRAIN_MODEL } from "../src/pipeline/constants";
import { getDb, getRun } from "../src/db";
import fs from "node:fs";
import path from "node:path";

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
  console.log("[smoke] clear brief preflight…");
  const clear = await preflightCook({
    prompt:
      "A calm 12-second product demo: logo on white, then a hand holds a phone showing a weather app. Soft daylight. 16:9.",
    mode: "video",
    durationSec: 12,
    aspect: "16:9",
  });
  if (clear.status === "hardBlock") {
    throw new Error(`expected clear/soft, got hardBlock: ${JSON.stringify(clear.risks)}`);
  }
  console.log("[smoke] clear status=", clear.status, "notes=", clear.notes.slice(0, 2));

  console.log("[smoke] soft-risk brief (gore wording)…");
  const soft = await preflightCook({
    prompt:
      "Horror trailer 8s: a bloody corpse with gore and weapon impact in a dark hallway, then cut to title. 16:9.",
    mode: "video",
    durationSec: 8,
    aspect: "16:9",
  });
  if (soft.status === "hardBlock") {
    console.warn("[smoke] soft brief hard-blocked (acceptable if model is strict):", soft.risks);
  } else {
    console.log(
      "[smoke] soft status=",
      soft.status,
      "rewritten shorter?",
      soft.rewrittenBrief.length,
      "risks=",
      soft.risks.length,
    );
  }

  console.log("[smoke] hard blocker (empty plates required)…");
  const hard = await preflightCook({
    prompt:
      "Edit ONLY the attached screen recording plate named MISSING_PLATE.mp4 — do not invent footage. Replace the logo in the top-left. No other assets provided.",
    mode: "video",
    durationSec: 10,
    aspect: "16:9",
    attachmentNames: [],
  });
  console.log("[smoke] hard status=", hard.status, "risks=", hard.risks.map((r) => r.severity));

  const brief = clear.status === "softFixesApplied" ? clear.rewrittenBrief : clear.rewrittenBrief;
  const run = createRun({
    prompt: brief,
    category: "Short Drama / Film & TV",
    duration: 12,
    aspect: "16:9",
    pipelineMode: "auto",
    sessionLabel: "smoke-preflight",
  });
  const fresh = getRun(run.id)!;
  if (fresh.script_model !== BRAIN_MODEL) throw new Error(`script_model ${fresh.script_model}`);
  if (fresh.video_model !== PRODUCT_VIDEO_MODEL) {
    throw new Error(`expected video ${PRODUCT_VIDEO_MODEL}, got ${fresh.video_model}`);
  }
  getDb()
    .prepare(`UPDATE jobs SET status='error', error=? WHERE run_id=? AND status IN ('pending','running')`)
    .run("smoke-preflight cancelled", run.id);
  getDb().prepare(`UPDATE runs SET status='failed', error=? WHERE id=?`).run("smoke cancelled", run.id);
  console.log("[smoke] createRun auto → Omni ok", fresh.id, fresh.video_model);
  console.log("[smoke] all green");
}

main().catch((err) => {
  console.error("[smoke] FAILED", err);
  process.exit(1);
});
