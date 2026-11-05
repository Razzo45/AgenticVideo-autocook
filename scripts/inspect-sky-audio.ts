import fs from "node:fs";
import { getRun, listVariants } from "../src/db";

const id = "run_6aaef579";
const run = getRun(id);
if (!run) {
  console.log("missing");
  process.exit(1);
}
console.log({
  status: run.status,
  video: run.video_model,
  res: run.output_resolution,
  duration: run.target_duration,
  mode: run.pipeline_mode,
  err: (run.error || "").slice(0, 120),
});
console.log("\n--- prompt head ---\n", (run.initial_prompt || "").slice(0, 900));
console.log("\n--- operator_script ---\n", (run.operator_script || "").slice(0, 1200));
const clips = listVariants(id).filter((v) => v.kind === "clip");
for (const c of clips) {
  console.log("\nclip", c.shot_index, "sel", c.selected, "model", c.model_name);
  console.log("motion/prompt used:\n", (c.prompt || "").slice(0, 800));
}
const final = `runs/${id}/final.mp4`;
if (fs.existsSync(final)) {
  console.log("\nfinal exists", fs.statSync(final).size);
}
