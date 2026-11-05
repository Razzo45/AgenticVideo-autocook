import fs from "node:fs";
import path from "node:path";
import { runDetail } from "../src/pipeline/orchestrator";

const id = process.argv[2] || "run_4fdb8fec";
const d = runDetail(id);
if (!d) throw new Error("missing run");
const r = d.run;
const dir = path.join("runs", id);

console.log("--- session ---");
console.log({
  status: r.status,
  aspect: r.aspect_ratio,
  target: r.target_duration,
  res: r.output_resolution,
  video: r.video_model,
  script: r.script_model,
  final: d.finalPath,
});

console.log("--- stitch probe ---");
console.log(d.stitch?.probe ?? d.stitch);

console.log("--- storyboard ---");
console.log((d.script?.media_desc || "").slice(0, 400));
for (const s of d.script?.shots ?? []) {
  console.log(`\n[shot ${s.index}] ${s.duration}s ${s.transition ?? ""}`);
  console.log("  media:", (s.media_desc || "").slice(0, 120));
  console.log("  motion:", (s.motion_prompt || "").slice(0, 160));
}

console.log("\n--- disk ---");
function walk(p: string, depth = 0) {
  if (depth > 3) return;
  for (const name of fs.readdirSync(p)) {
    const abs = path.join(p, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      console.log(`${"  ".repeat(depth)}${name}/`);
      walk(abs, depth + 1);
    } else {
      console.log(`${"  ".repeat(depth)}${name} (${(st.size / 1e6).toFixed(2)} MB)`);
    }
  }
}
walk(dir);

const omniPrompts = [] as string[];
function findOmni(p: string) {
  for (const name of fs.readdirSync(p)) {
    const abs = path.join(p, name);
    if (fs.statSync(abs).isDirectory()) findOmni(abs);
    else if (name.endsWith(".omni_prompt.txt")) omniPrompts.push(abs);
  }
}
findOmni(dir);
console.log("\n--- omni prompts ---");
for (const p of omniPrompts) {
  console.log(`\n${p}`);
  console.log(fs.readFileSync(p, "utf8").slice(0, 500));
}
