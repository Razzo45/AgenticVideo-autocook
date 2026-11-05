import fs from "node:fs";
import { getRun, listVariants, listAssets } from "../src/db";

const run = getRun("run_f2c457c0")!;
const script = JSON.parse(run.script_json!);

for (const i of [7, 8, 9]) {
  const s = script.shots[i];
  const kf = listVariants(run.id, i, "keyframe").find((v) => v.selected);
  console.log(`\n===== SCENE ${i + 1} =====`);
  console.log("transition", s.transition);
  console.log("image_prompt:\n", s.image_prompt);
  console.log("motion_prompt:\n", s.motion_prompt);
  console.log("kf model", kf?.model_name, "path", kf?.path);
  if (kf?.path && fs.existsSync(kf.path)) {
    // probe via ffprobe not needed — note size
    console.log("kf bytes", fs.statSync(kf.path).size);
  }
}

const assets = listAssets(run.id);
console.log("\n=== ASSETS ===", assets.map((a) => a.role + ":" + a.path.split(/[/\\]/).pop()));
console.log("\ninput_assets_json sample", (run.input_assets_json || "").slice(0, 800));
