/**
 * Unstick + recover crime-scene scene 7 after a stale "pending 95s" status.
 * Uses a clean detective frame (no body) and a negation-free prompt (Veo
 * empty-filters on "no blood/gore" wording). Falls back to still-hold.
 *
 * Usage: npx tsx scripts/resume-crime-scene7.ts [runId]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getRun,
  updateRun,
  getDb,
  rejectBatch,
  insertVariant,
  selectVariant,
} from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";
import { generateVideo, inspectVideoModel, snapDuration, isVideoFilterError } from "../src/pipeline/openrouter";
import { detectBlackBars, probeFile, stillToClip } from "../src/pipeline/stitch";
import { evaluateClip } from "../src/pipeline/conformance";
import { runDir } from "../src/pipeline/paths";
import type { OutputResolution } from "../src/pipeline/constants";

const READING_KF = "bf287a51-082f-4475-be7f-20489512dba5.png";
const SAFE_KF = "safe_from_s5.png";

async function main() {
  const runId = process.argv[2] || "run_26dfb0bf";
  const shotIndex = 6;
  const run = getRun(runId);
  if (!run?.script_json) throw new Error(`missing script on ${runId}`);

  const script = JSON.parse(run.script_json);
  const shot6 = script.shots[6];
  const shot7 = script.shots[7];
  if (!shot6 || !shot7) throw new Error("expected 8 shots");

  shot6.image_prompt =
    "Medium shot of the Detective alone in a cool teal-lit modern hallway with windows, holding a paper document at chest height. Natural warm skin tones. No other people. Cinematic 4K.";
  shot6.motion_prompt =
    "He looks down at the page and reads. Eyes scan the paper. Expression shifts to quiet concern. Very slow push-in. Soft paper sound. Low underscore. No dialogue.";
  shot6.media_desc = "Detective reads a document; dawning realization.";
  shot7.image_prompt =
    "Extreme close-up of the Detective's eyes and brow. Focused stare just off-camera. Cool room, warm skin. Cinematic 4K.";
  shot7.motion_prompt =
    "Steady stare. One slow blink. Static camera. Underscore peaks then silence. No dialogue.";
  shot7.media_desc = "Eyes close-up — realization beat.";
  updateRun(runId, { script_json: JSON.stringify(script) });

  const shotDir = path.join(runDir(runId), "shot_6");
  const safePath = path.join(shotDir, "keyframes", SAFE_KF);
  const readingPath = path.join(shotDir, "keyframes", READING_KF);
  if (!fs.existsSync(safePath)) throw new Error(`missing ${safePath}`);

  rejectBatch(runId, shotIndex, "keyframe");
  rejectBatch(runId, shotIndex, "clip");

  const kfId = crypto.randomUUID();
  const kfPath = path.join(shotDir, "keyframes", `${kfId}.png`);
  fs.copyFileSync(safePath, kfPath);
  insertVariant({
    id: kfId,
    run_id: runId,
    shot_index: shotIndex,
    kind: "keyframe",
    variant_index: 0,
    path: kfPath,
    prompt: "Safe detective frame from scene 5 (no body) for scene 7 recovery.",
    model_name: "join:prior_clip_frame",
    selected: 1,
    rejected: 0,
    probe_json: null,
    uniq_id: null,
  });
  selectVariant(kfId);

  const lean = [
    "Same man as the first frame, alone in the hallway.",
    "He holds a paper page at chest height and reads it.",
    "Eyes move across the page. Subtle concern. Very slow push-in.",
    "Paper rustle only. Fictional film. No dialogue.",
  ].join(" ");

  const model = run.video_model;
  const info = await inspectVideoModel(model);
  const wantDur = snapDuration(shot6.duration, info.durations) ?? shot6.duration;
  const clipId = crypto.randomUUID();
  const out = path.join(shotDir, "clips", `${clipId}.mp4`);
  let usedPrompt = lean;
  let modelTag = `${model}|drama-safe-s7`;

  updateRun(runId, {
    status: "generating",
    current_shot_index: shotIndex,
    error: "Scene 7: unstuck — clean-frame Veo retake…",
  });

  console.log(`[kf] ${kfPath}`);
  console.log(`[prompt] ${lean}`);

  let ok = false;
  for (const res of ["4K", "1080p"] as const) {
    if (ok) break;
    try {
      await generateVideo({
        model,
        prompt: lean,
        aspectRatio: run.aspect_ratio,
        duration: wantDur,
        firstFramePath: kfPath,
        outPath: out,
        outputResolution: res,
        preservePrompt: true,
        maxFilterAttempts: 1,
        persistOnCapacity: true,
        onStatus: (msg) => {
          console.log(`[veo ${res}] ${msg}`);
          updateRun(runId, { error: `Scene 7 ${res}: ${msg}` });
        },
      });
      ok = fs.existsSync(out) && fs.statSync(out).size > 10_000;
      if (ok) {
        modelTag = `${model}|drama-safe-s7-${res}`;
        console.log(`[ok] ${res} clip`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${res} failed] ${message.slice(0, 180)}`);
      if (!isVideoFilterError(message)) throw err;
    }
  }

  if (!ok) {
    console.warn("[fallback] still-hold of reading KF");
    const holdSrc = fs.existsSync(readingPath) ? readingPath : kfPath;
    await stillToClip(holdSrc, out, wantDur);
    usedPrompt = "Static hold of reading still (Veo empty-filtered motion takes).";
    modelTag = "ffmpeg:still_hold";
    ok = fs.existsSync(out) && fs.statSync(out).size > 10_000;
  }

  if (!ok) throw new Error("scene 7 clip still empty");

  const probe = await probeFile(out);
  probe.crop = await detectBlackBars(out);
  const report = evaluateClip(probe, run.aspect_ratio, (run.output_resolution ?? "4K") as OutputResolution);
  insertVariant({
    id: clipId,
    run_id: runId,
    shot_index: shotIndex,
    kind: "clip",
    variant_index: 0,
    path: out,
    prompt: usedPrompt,
    model_name: modelTag,
    selected: 1,
    rejected: 0,
    probe_json: JSON.stringify({ probe, report }),
    uniq_id: null,
  });
  selectVariant(clipId);
  console.log(`[clip] ${out} ${probe.width}x${probe.height} ${probe.duration}s tag=${modelTag}`);

  // Clear any stale job rows that keep the UI on "pending 95s"
  getDb()
    .prepare(`UPDATE jobs SET status='done', error=NULL WHERE run_id=? AND status IN ('queued','running')`)
    .run(runId);

  fs.writeFileSync(
    path.join(runDir(runId), "astra_orch.json"),
    JSON.stringify({ filterRewrites: {}, gateRegens: {}, replans: 0 }, null, 2),
    "utf8",
  );

  retryRun(runId);
  const fresh = getRun(runId)!;
  console.log(`[resumed] status=${fresh.status} shot=${fresh.current_shot_index}`);
  console.log(`[msg] ${fresh.error}`);
}

main().catch((err) => {
  console.error(err);
  updateRun(process.argv[2] || "run_26dfb0bf", {
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
