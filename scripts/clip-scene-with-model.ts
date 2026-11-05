/**
 * Render one scene's clip on a different video model (from that scene's selected keyframe),
 * select it, and resume the run.
 *
 * Usage: npx tsx scripts/clip-scene-with-model.ts <runId> <shotIndex> <videoModel>
 */
import path from "node:path";
import crypto from "node:crypto";
import { getRun, updateRun, listVariants, insertVariant, selectVariant } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";
import { generateVideo, inspectVideoModel, snapDuration } from "../src/pipeline/openrouter";
import { detectBlackBars, probeFile } from "../src/pipeline/stitch";
import { evaluateClip } from "../src/pipeline/conformance";
import { runDir } from "../src/pipeline/paths";
import type { OutputResolution } from "../src/pipeline/constants";

async function main() {
  const [runId, shotArg, model] = process.argv.slice(2);
  if (!runId || shotArg === undefined || !model) {
    throw new Error("usage: clip-scene-with-model.ts <runId> <shotIndex> <videoModel>");
  }
  const shotIndex = Number(shotArg);
  const run = getRun(runId);
  if (!run?.script_json) throw new Error(`run ${runId} has no storyboard`);
  const shot = JSON.parse(run.script_json).shots[shotIndex];
  if (!shot) throw new Error(`no shot ${shotIndex}`);
  const kf = listVariants(runId, shotIndex, "keyframe").find((v) => v.selected && !v.rejected);
  if (!kf) throw new Error(`shot ${shotIndex} has no selected keyframe`);

  const info = await inspectVideoModel(model);
  const resolution = (run.output_resolution ?? "1080p") as OutputResolution;
  const id = crypto.randomUUID();
  const out = path.join(runDir(runId), `shot_${shotIndex}`, "clips", `${id}.mp4`);
  updateRun(runId, { error: `Scene ${shotIndex + 1}: rendering on ${model}…` });
  await generateVideo({
    model,
    prompt: shot.motion_prompt,
    aspectRatio: run.aspect_ratio,
    duration: snapDuration(shot.duration, info.durations) ?? shot.duration,
    firstFramePath: kf.path,
    outPath: out,
    outputResolution: resolution,
    persistOnCapacity: true,
    maxFilterAttempts: 2,
    onStatus: (msg) => {
      console.log(`[${model}] ${msg}`);
      updateRun(runId, { error: `Scene ${shotIndex + 1} (${model}): ${msg}` });
    },
  });

  const probe = await probeFile(out);
  probe.crop = await detectBlackBars(out);
  const report = evaluateClip(probe, run.aspect_ratio, resolution);
  insertVariant({
    id,
    run_id: runId,
    shot_index: shotIndex,
    kind: "clip",
    variant_index: listVariants(runId, shotIndex, "clip").length,
    path: out,
    prompt: shot.motion_prompt,
    model_name: model,
    selected: 1,
    rejected: 0,
    probe_json: JSON.stringify({ probe, report }),
    uniq_id: null,
  });
  selectVariant(id);
  console.log(`[clip] ${out} ${probe.width}x${probe.height} ${probe.duration}s`);

  retryRun(runId);
  const fresh = getRun(runId)!;
  console.log(`[resumed] status=${fresh.status} ${fresh.error}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
