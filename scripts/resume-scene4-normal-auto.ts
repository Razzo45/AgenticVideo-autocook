/**
 * Resume scene 4 on normal auto path: proven Marcus frame from shot 0 clip + shot-0-style motion.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getRun,
  updateRun,
  listVariants,
  rejectBatch,
  insertVariant,
  selectVariant,
} from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";
import { extractFirstFrame } from "../src/pipeline/stitch";
import { runDir } from "../src/pipeline/paths";

async function main() {
  const runId = process.argv[2] || "run_51a7fa64";
  const run = getRun(runId);
  if (!run) throw new Error(`missing ${runId}`);

  const prior = listVariants(runId, 0, "clip").find((v) => v.selected && fs.existsSync(v.path));
  if (!prior) throw new Error("no selected shot 0 clip to borrow a proven frame from");

  const script = JSON.parse(run.script_json!);
  const shot = script.shots[3];
  if (!shot) throw new Error("no shot 3");

  shot.image_prompt =
    "Medium shot of Marcus Reed matching the attached headshot identity, navy collared shirt, warehouse background. Looking at camera. Soft even lighting, natural skin tones. No text, no logos, no graphics in frame.";
  shot.motion_prompt =
    "Marcus Reed stands still and speaks clearly to camera in a calm instructional tone. Small natural hand gesture only. Single continuous talking-head take. No cuts, no title cards, no lower thirds, no logos, no on-screen text, no UI.";
  shot.media_desc =
    "Marcus on camera explaining required PPE items. Section graphics are handled in the final edit, not in this live take.";
  shot.transition = "cut";

  updateRun(runId, { script_json: JSON.stringify(script) });

  rejectBatch(runId, 3, "keyframe");
  rejectBatch(runId, 3, "clip");

  const kfId = crypto.randomUUID();
  const kfPath = path.join(runDir(runId), "shot_3", "keyframes", `${kfId}.png`);
  await extractFirstFrame(prior.path, kfPath);
  insertVariant({
    id: kfId,
    run_id: runId,
    shot_index: 3,
    kind: "keyframe",
    variant_index: 0,
    path: kfPath,
    prompt: "Proven first frame borrowed from accepted scene 1 clip (normal auto filter recovery).",
    model_name: "join:prior_clip_frame",
    selected: 1,
    rejected: 0,
    probe_json: null,
    uniq_id: null,
  });
  selectVariant(kfId);

  fs.writeFileSync(
    path.join(runDir(runId), "astra_orch.json"),
    JSON.stringify({ filterRewrites: {}, gateRegens: {}, replans: 0 }, null, 2),
    "utf8",
  );

  updateRun(runId, {
    error: "Scene 4: normal auto resume with proven Marcus frame + talking-head motion…",
  });
  retryRun(runId);

  const fresh = getRun(runId)!;
  console.log(`[resumed] status=${fresh.status} shot=${fresh.current_shot_index}`);
  console.log(`[msg] ${fresh.error}`);
  console.log(`[kf] ${kfPath} exists=${fs.existsSync(kfPath)}`);
  console.log(`[open] http://127.0.0.1:3000/runs/${runId}`);
  console.log("Restart worker so normal-auto (no Astra replan) code is loaded: npm run worker");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
