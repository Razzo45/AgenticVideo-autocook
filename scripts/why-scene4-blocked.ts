import fs from "node:fs";
import path from "node:path";
import { getRun, getDb, listVariants } from "../src/db";

const id = "run_51a7fa64";
const run = getRun(id)!;
const db = getDb();

console.log("RUN", {
  status: run.status,
  shot: run.current_shot_index,
  error: run.error,
  res: run.output_resolution,
  video: run.video_model,
});

const script = JSON.parse(run.script_json!);
console.log("\nSHOT3", JSON.stringify(script.shots[3], null, 2));
console.log("\nSHOT0 motion:", script.shots[0].motion_prompt);
console.log("SHOT2 motion:", script.shots[2].motion_prompt);

console.log("\n=== shot 3 variants ===");
for (const v of listVariants(id, 3)) {
  console.log({
    kind: v.kind,
    sel: v.selected,
    rej: v.rejected,
    model: v.model_name,
    exists: fs.existsSync(v.path),
    bytes: fs.existsSync(v.path) ? fs.statSync(v.path).size : 0,
    path: path.basename(v.path),
    prompt: (v.prompt || "").slice(0, 160),
  });
}

console.log("\n=== shot_3 dir ===");
const d = path.join("runs", id, "shot_3");
function walk(p: string, depth = 0) {
  if (!fs.existsSync(p) || depth > 3) return;
  for (const name of fs.readdirSync(p)) {
    const full = path.join(p, name);
    const st = fs.statSync(full);
    console.log("  ".repeat(depth) + name, st.isDirectory() ? "/" : `${st.size}b`);
    if (st.isDirectory()) walk(full, depth + 1);
  }
}
walk(d);

const job = db
  .prepare(
    `SELECT error, created_at, updated_at FROM jobs WHERE run_id=? AND type='clips' AND payload_json LIKE '%"shotIndex":3%' ORDER BY updated_at DESC LIMIT 1`,
  )
  .get(id) as { error: string; created_at: string; updated_at: string };
console.log("\nLAST JOB", job);

const orch = path.join("runs", id, "astra_orch.json");
if (fs.existsSync(orch)) console.log("ORCH", fs.readFileSync(orch, "utf8"));
