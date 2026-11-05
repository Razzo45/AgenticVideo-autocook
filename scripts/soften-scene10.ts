/**
 * Soften scene 10 (shot index 9) on run_f2c457c0 for Veo I2V resume.
 * Usage: npx tsx scripts/soften-scene10.ts
 */
import { getRun, listVariants, rejectBatch, updateRun } from "../src/db";

const RUN_ID = "run_f2c457c0";
const SHOT = 9; // scene 10

const run = getRun(RUN_ID);
if (!run?.script_json) throw new Error("run missing");

const script = JSON.parse(run.script_json) as {
  shots: Array<{
    index: number;
    duration: number;
    transition: string;
    image_prompt: string;
    motion_prompt: string;
    media_desc: string;
  }>;
};

const shot = script.shots[SHOT];
if (!shot) throw new Error(`no shot ${SHOT}`);

console.log("BEFORE image:", shot.image_prompt.slice(0, 160));
console.log("BEFORE motion:", shot.motion_prompt.slice(0, 160));

shot.image_prompt =
  "Medium shot of Brad Smith, off-center in his modern office, looking to camera with a calm professional expression. Clean frame — no title cards, no bullet lists, no on-screen text overlays, no logos. Soft natural office lighting.";

shot.motion_prompt =
  "Brad speaks to camera with a small natural gesture. Hold the same framing and wardrobe. Voiceover: 'Step two give them a training structure. Next, give your trainer a repeatable process they can use when teaching someone something new.' No graphic fades, no animating text, no whoosh.";

shot.media_desc =
  "Brad introduces Step 2 (training structure) as a clean talking-head beat — text graphics deferred.";

script.shots[SHOT] = shot;

rejectBatch(RUN_ID, SHOT, "keyframe");
rejectBatch(RUN_ID, SHOT, "clip");

const leftKf = listVariants(RUN_ID, SHOT, "keyframe").filter((v) => !v.rejected);
const leftCl = listVariants(RUN_ID, SHOT, "clip").filter((v) => !v.rejected);

updateRun(RUN_ID, {
  script_json: JSON.stringify(script),
  current_shot_index: SHOT,
  status: "failed",
  gate: null,
  error:
    "Scene 10 softened (talking-head, no title-card I2V). Prior scenes kept. Resume regenerates scene 10 keyframe + clip only.",
});

console.log("AFTER image:", shot.image_prompt);
console.log("AFTER motion:", shot.motion_prompt);
console.log("rejected variants; live keyframes", leftKf.length, "clips", leftCl.length);
console.log("ready — Resume scene 10/" + script.shots.length);
