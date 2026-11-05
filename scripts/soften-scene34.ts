/**
 * Soften scene 34: mid-speech continue-join → calm talking-head cut.
 * Usage: npx tsx scripts/soften-scene34.ts
 */
import { getRun, listVariants, rejectBatch, updateRun } from "../src/db";

const RUN_ID = "run_f2c457c0";
const SHOT = 33; // scene 34

const run = getRun(RUN_ID);
if (!run?.script_json) throw new Error("run missing");

const script = JSON.parse(run.script_json) as {
  subjects?: string[];
  shots: Array<{
    index: number;
    duration: number;
    transition: "cut" | "continue";
    image_prompt: string;
    motion_prompt: string;
    media_desc: string;
  }>;
};

const shot = script.shots[SHOT];
console.log("BEFORE", { transition: shot.transition, motion: shot.motion_prompt.slice(0, 100) });

shot.transition = "cut";
shot.image_prompt =
  "Medium close-up of Brad Smith in his modern office, calm warm smile, looking to camera. Soft natural light. Clean frame — no title cards, no logos, no on-screen text, no UI.";
shot.motion_prompt =
  "Brad speaks calmly to camera with a small natural gesture. Same framing and wardrobe. Spoken dialogue only: 'They create employees who are more confident, capable, and prepared to succeed.' Absolute rules: no on-screen text, no title cards, no logos, no motion graphics, no whoosh.";
shot.media_desc = "Brad closes Step outcomes as a calm talking-head beat (no graphics).";
script.shots[SHOT] = shot;

if (Array.isArray(script.subjects)) {
  script.subjects = script.subjects.filter(
    (s) => s.trim() && !/\b(session|structure|graphic|office|room|step|process|framework)\b/i.test(s),
  );
  if (!script.subjects.includes("Brad Smith")) script.subjects.unshift("Brad Smith");
}

rejectBatch(RUN_ID, SHOT, "keyframe");
rejectBatch(RUN_ID, SHOT, "clip");

updateRun(RUN_ID, {
  script_json: JSON.stringify(script),
  current_shot_index: SHOT,
  status: "failed",
  gate: null,
  revise_comment:
    "THIS TAKE ONLY: calm talking-head cut (not a hard-join from the previous mid-speech frame). Zero on-screen text/graphics/logos.",
  error:
    "Scene 34 softened: continue-join → calm cut still + talking-head VO. Earlier scenes kept. Resume regenerates scene 34 keyframe + clip.",
});

const live = listVariants(RUN_ID, SHOT, "keyframe").filter((v) => !v.rejected);
console.log("AFTER", { transition: shot.transition, liveKeyframes: live.length });
console.log("Resume scene 34/" + script.shots.length);
