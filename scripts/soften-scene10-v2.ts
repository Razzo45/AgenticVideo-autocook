/**
 * Re-soften scene 10 after GRAPHICS CUES re-injection caused second empty.
 * Keeps the clean talking-head keyframe; clip-only resume.
 */
import { getRun, listVariants, updateRun } from "../src/db";
import { autoOptionsFromRun, parseAutoOptions } from "../src/pipeline/autoOptions";

const RUN_ID = "run_f2c457c0";
const SHOT = 9;

const run = getRun(RUN_ID);
if (!run?.script_json) throw new Error("run missing");

const script = JSON.parse(run.script_json) as {
  subjects?: string[];
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
shot.motion_prompt =
  "Single presenter Brad Smith speaks to camera. Small natural hand gesture. Same framing and wardrobe as the first frame. Spoken dialogue only (no sound effects): 'Step two give them a training structure. Next, give your trainer a repeatable process they can use when teaching someone something new.' Absolute rules for this take: no on-screen text, no title cards, no bullet lists, no logos, no motion graphics, no whoosh.";
shot.media_desc = "Brad introduces Step 2 as a clean talking-head beat with no graphics.";
script.shots[SHOT] = shot;

// Clean polluted cast list for continuity locks
if (Array.isArray(script.subjects)) {
  script.subjects = script.subjects.filter(
    (s) => s.trim() && !/\b(session|structure|graphic|office|room|step|process|framework)\b/i.test(s),
  );
  if (!script.subjects.includes("Brad Smith")) script.subjects.unshift("Brad Smith");
}

const opts = parseAutoOptions(run.auto_options_json);
// Keep timedGraphics for the run, but pipeline now scopes it per-shot.
// Still force a hard revise line so Veo cannot reintroduce graphics on this resume.
updateRun(RUN_ID, {
  script_json: JSON.stringify(script),
  current_shot_index: SHOT,
  status: "failed",
  gate: null,
  revise_comment:
    "THIS TAKE ONLY: talking-head, zero on-screen text/graphics/logos. Ignore any global graphics toggle for this scene.",
  auto_options_json: JSON.stringify({ ...opts, timedGraphics: opts.timedGraphics }),
  error:
    "Scene 10 re-softened (no GRAPHICS CUES on talking-head). Clean keyframe kept. Resume = clip only. Soften retry enabled if empty again.",
});

const kf = listVariants(RUN_ID, SHOT, "keyframe").find((v) => v.selected && !v.rejected);
console.log("kept keyframe", kf?.path?.split(/[/\\]/).pop(), "sel", kf?.selected);
console.log("motion:", shot.motion_prompt.slice(0, 120));
console.log("subjects:", script.subjects);
console.log("Resume scene 10/" + script.shots.length + " (clip only)");
