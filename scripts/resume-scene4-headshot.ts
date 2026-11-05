/**
 * Unblock scene 4: logo-free headshot I2V + lean motion. Worker must load latest recovery
 * (1080p-first after filter history, then continuity, then reuse prior accepted clip).
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
import { parseRunInputs } from "../src/pipeline/inputs";
import { retryRun } from "../src/pipeline/orchestrator";
import { runDir } from "../src/pipeline/paths";

async function main() {
  const runId = process.argv[2] || "run_51a7fa64";
  const run = getRun(runId);
  if (!run) throw new Error(`missing ${runId}`);

  const assets = parseRunInputs(run.input_assets_json);
  const headshot = assets.find(
    (a) => a.kind === "image" && /marcus|headshot|portrait/i.test(a.filename),
  );
  if (!headshot || !fs.existsSync(headshot.path)) {
    throw new Error("Marcus headshot input missing — need a logo-free first frame");
  }

  const script = JSON.parse(run.script_json!);
  const shot = script.shots[3];
  if (!shot) throw new Error("no shot 3");

  // Lean motion — identical to the take that already cleared Veo on scene 1.
  shot.motion_prompt =
    "Same person as the first-frame still. Speaks clearly to camera in a calm instructional tone. Small natural hand gesture only. Single continuous talking-head take. Static camera. No cuts, no title cards, no lower thirds, no logos, no on-screen text, no UI.";
  shot.image_prompt =
    "Presenter matching attached headshot, navy collared shirt, clean warehouse. Looking at camera. No text, no logos, no graphics.";
  shot.media_desc =
    "Marcus on camera for the required-PPE section. Graphics are handled later in edit.";
  shot.transition = "cut";
  updateRun(runId, { script_json: JSON.stringify(script) });

  rejectBatch(runId, 3, "keyframe");
  rejectBatch(runId, 3, "clip");

  const kfId = crypto.randomUUID();
  const kfPath = path.join(runDir(runId), "shot_3", "keyframes", `${kfId}.png`);
  fs.mkdirSync(path.dirname(kfPath), { recursive: true });
  // Headshot has no burned-in Stonefield logo (warehouse frames from scene 1 do — Veo empty-filters those).
  fs.copyFileSync(headshot.path, kfPath);
  insertVariant({
    id: kfId,
    run_id: runId,
    shot_index: 3,
    kind: "keyframe",
    variant_index: 0,
    path: kfPath,
    prompt: "Operator Marcus headshot — logo-free I2V first frame",
    model_name: "operator:headshot",
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
    error:
      "Scene 4: logo-free headshot I2V + lean talking-head. Restart worker first if not already on latest code.",
  });
  retryRun(runId);

  const fresh = getRun(runId)!;
  console.log(`[resumed] status=${fresh.status} shot=${fresh.current_shot_index}`);
  console.log(`[msg] ${fresh.error}`);
  console.log(`[kf] headshot → ${kfPath}`);
  console.log(`[open] http://127.0.0.1:3000/runs/${runId}`);
  console.log("REQUIRED: restart worker so 1080p-first + reuse-prior-clip recovery is loaded.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
