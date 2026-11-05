import { getRun, listVariants } from "../src/db";
const run = getRun("run_f2c457c0")!;
const script = JSON.parse(run.script_json!);
for (const i of [31, 32, 33]) {
  const s = script.shots[i];
  console.log(`\n=== ${i + 1} ===`, s.transition);
  console.log("image:", s.image_prompt);
  console.log("motion:", s.motion_prompt);
  const kf = listVariants(run.id, i, "keyframe").find((v) => v.selected);
  console.log("kf", kf?.model_name);
}
