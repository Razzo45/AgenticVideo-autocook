import { getRun } from "../src/db";

const r = getRun("run_04c53bd2");
if (!r) {
  console.log("no run");
  process.exit(1);
}
console.log(
  JSON.stringify(
    { status: r.status, error: r.error, shot: r.current_shot_index, model: r.video_model },
    null,
    2,
  ),
);

const script = r.script_json ? JSON.parse(r.script_json) : null;
console.log("shots", script?.shots?.length ?? 0);
const violence = /\b(blood|gore|weapon|dismember|injur|kill|murder|combat|fight)\b/i;
for (const [i, s] of (script?.shots ?? []).entries()) {
  const blob = [s.media_desc, s.motion_prompt, s.image_prompt].join("\n");
  console.log(`\n===== SHOT ${i} (${s.duration}s) violenceHits=${violence.test(blob)} =====`);
  console.log(blob.slice(0, 800));
}

const VIDEO_SAFETY =
  "Fictional cinematic. No blood, no gore, no injury, no weapons striking anyone, no dismemberment.";
console.log("\n===== APPENDED ON EVERY OMNI SUBMIT =====\n", VIDEO_SAFETY);
