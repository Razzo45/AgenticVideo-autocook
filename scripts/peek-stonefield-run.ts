import fs from "node:fs";
import { getRun, listVariants } from "../src/db";

const id = process.argv[2] || "run_51a7fa64";
const run = getRun(id);
if (!run) {
  console.error("missing", id);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      id: run.id,
      status: run.status,
      gate: run.gate,
      error: run.error,
      shot: run.current_shot_index,
      video: run.video_model,
      aspect: run.aspect_ratio,
      res: run.output_resolution,
    },
    null,
    2,
  ),
);
const script = run.script_json ? JSON.parse(run.script_json) : null;
if (script?.shots) {
  console.log("shots", script.shots.length);
  for (const s of script.shots) {
    console.log("\n=== shot", s.index, "dur", s.duration, "trans", s.transition, "===");
    console.log("IMAGE:\n", s.image_prompt);
    console.log("MOTION:\n", s.motion_prompt);
    console.log("DESC:", s.media_desc);
  }
}
const vars = listVariants(id);
for (const v of vars) {
  console.log(
    `[var] ${v.kind} shot=${v.shot_index} sel=${v.selected} rej=${v.rejected} model=${v.model_name} exists=${fs.existsSync(v.path)} id=${v.id.slice(0, 8)}`,
  );
}
