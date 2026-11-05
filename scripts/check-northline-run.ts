import { getRun } from "../src/db";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "../src/pipeline/paths";

const id = "run_5889454d";
const r = getRun(id);
console.log(
  JSON.stringify(
    {
      status: r?.status,
      gate: r?.gate,
      error: r?.error,
      model: r?.video_model,
      duration: r?.target_duration,
      updated: r?.updated_at,
      hasScript: Boolean(r?.script_json),
      shot: r?.current_shot_index,
    },
    null,
    2,
  ),
);

const db = new DatabaseSync(DB_PATH);
const jobs = db
  .prepare(
    "SELECT id, type, status, attempts, error, created_at, updated_at FROM jobs WHERE run_id = ? ORDER BY created_at",
  )
  .all(id);
console.log("jobs:", JSON.stringify(jobs, null, 2));
const active = db
  .prepare(
    "SELECT id, status, error FROM runs WHERE status IN ('generating', 'queued', 'stitching')",
  )
  .all();
console.log("active:", JSON.stringify(active, null, 2));

const root = path.join("runs", id);
function walk(d: string, acc: string[] = []): string[] {
  if (!fs.existsSync(d)) return acc;
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(mp4|json)$/i.test(n) && !p.includes(`${path.sep}inputs${path.sep}`)) acc.push(p);
  }
  return acc;
}
console.log("artifacts:", walk(root));
