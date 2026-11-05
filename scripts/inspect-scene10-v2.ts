/**
 * Deep-inspect scene 10 after second filter fail.
 */
import fs from "node:fs";
import { getDb, getRun, listVariants } from "../src/db";
import {
  autoOptionsFromRun,
  autoRequirementsPrompt,
} from "../src/pipeline/autoOptions";
import { operatorModelImageRefs, parseRunInputs, operatorAudioAssets } from "../src/pipeline/inputs";
import { isLikelyPresenterStill } from "../src/pipeline/autoOptions";

const RUN = "run_f2c457c0";
const SHOT = 9;
const run = getRun(RUN)!;
const script = JSON.parse(run.script_json!);
const shot = script.shots[SHOT];

console.log("=== STATUS ===");
console.log({ status: run.status, err: run.error, shot: run.current_shot_index, res: run.output_resolution, video: run.video_model });

console.log("\n=== SHOT 9 STORYBOARD ===");
console.log(JSON.stringify(shot, null, 2));

const kfs = listVariants(RUN, SHOT, "keyframe");
console.log("\n=== KEYFRAMES (incl rejected) ===");
for (const v of kfs) {
  console.log({
    sel: v.selected,
    rej: v.rejected,
    model: v.model_name,
    bytes: fs.existsSync(v.path) ? fs.statSync(v.path).size : 0,
    path: v.path,
    promptHead: (v.prompt || "").slice(0, 350),
  });
}

const clips = listVariants(RUN, SHOT, "clip");
console.log("\n=== CLIPS ===", clips.length);

// Reconstruct approximate clip prompt the way jobClips does
const cast = (script.subjects || []).filter(Boolean).join("; ");
const who = cast
  ? `Cast lock: ${cast}. Keep every one of them if they appear in the first-frame still. Do not drop, recast, or replace a main character.`
  : `Keep every person and product already visible in the first-frame still. Do not drop or recast a main subject.`;
const continuation = `\n\nThe first frame image is the approved storyboard keyframe. Hold that exact pose, face, body, wardrobe, and camera for the opening frames. ${who} Do not morph, reshape, fade, or reset the scene. Then play the motion. Sound follows the brief and stays synced to visible action.`;
const autoExtra = autoRequirementsPrompt(autoOptionsFromRun(run));
const fullPrompt = `${shot.motion_prompt}${continuation}${autoExtra}`;
console.log("\n=== APPROX FULL CLIP PROMPT ===\n");
console.log(fullPrompt);
console.log("\n=== PROMPT LEN ===", fullPrompt.length);

const assets = parseRunInputs(run.input_assets_json);
console.log(
  "\n=== INPUTS ===",
  assets.map((a) => `${a.kind}:${a.filename}`),
);
let imagePaths = [...operatorModelImageRefs(run.input_assets_json)];
const portraits = assets
  .filter((a) => a.kind === "image" && isLikelyPresenterStill(a.filename))
  .map((a) => a.path);
console.log("portraits", portraits.map((p) => p.split(/[/\\]/).pop()));
console.log("image refs sent (model)", imagePaths.map((p) => p.split(/[/\\]/).pop()));
const audio = operatorAudioAssets(run.input_assets_json).filter(
  (a) => !/\b(music|bed|score|whoosh|sfx|stinger|underscore)\b/i.test(a.filename),
);
console.log(
  "audio refs",
  audio.map((a) => a.filename),
);

const jobs = getDb()
  .prepare(
    `SELECT status, type, error, created_at, updated_at FROM jobs WHERE run_id=? AND payload_json LIKE '%"shotIndex":9%' ORDER BY created_at`,
  )
  .all(RUN) as Array<{ status: string; type: string; error: string | null; created_at: string; updated_at: string }>;
console.log("\n=== JOBS shot 9 ===");
for (const j of jobs) {
  console.log(j.status, j.type, ((Date.parse(j.updated_at) - Date.parse(j.created_at)) / 60000).toFixed(1) + "m", (j.error || "").slice(0, 140));
}
