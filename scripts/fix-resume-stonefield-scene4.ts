/**
 * Reset scene 4 prompts to filter-safe talking-head (keep existing KF), clear rewrite budget, resume.
 */
import fs from "node:fs";
import path from "node:path";
import { getRun, updateRun } from "../src/db";
import { retryRun } from "../src/pipeline/orchestrator";
import { runDir } from "../src/pipeline/paths";

const runId = process.argv[2] || "run_51a7fa64";
const run = getRun(runId);
if (!run) throw new Error(`missing ${runId}`);

const script = JSON.parse(run.script_json!);
const shot = script.shots[3];
if (!shot) throw new Error("no shot 3");

shot.image_prompt =
  "Medium shot of Marcus Reed matching Marcus_Headshot.jpg identity, navy collared shirt, warehouse background like Location.jpg. Looking at camera. Soft even lighting, natural skin tones. No text, no logos, no graphics in frame.";
shot.motion_prompt =
  "Marcus Reed speaks clearly to camera in a calm instructional tone. Small natural hand gesture only. Single continuous talking-head take. Static camera. No cuts, no title cards, no lower thirds, no logos, no on-screen text, no UI.";
shot.media_desc =
  "Marcus on camera explaining required PPE items (section title card is added later in edit — not in this take).";
shot.transition = "cut";

updateRun(runId, {
  script_json: JSON.stringify(script),
  error: "Scene 4 reset to filter-safe talking-head (no graphics cues in Veo prompt)…",
});

const orchPath = path.join(runDir(runId), "astra_orch.json");
fs.writeFileSync(
  orchPath,
  JSON.stringify({ filterRewrites: {}, gateRegens: {}, replans: 0 }, null, 2),
  "utf8",
);

retryRun(runId);
const fresh = getRun(runId)!;
console.log(`[resumed] status=${fresh.status} shot=${fresh.current_shot_index}`);
console.log(`[msg] ${fresh.error}`);
console.log(`[open] http://127.0.0.1:3000/runs/${runId}`);
console.log("Restart worker if it is not on watch, so the graphics-cue fix is loaded.");
