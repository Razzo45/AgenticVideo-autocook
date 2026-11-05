import { getRun } from "../src/db";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "../src/pipeline/paths";
import fs from "node:fs";
import path from "node:path";

const db = new DatabaseSync(DB_PATH);
const rows = db
  .prepare(
    "SELECT id, session_id, status, gate, error, video_model, target_duration, current_shot_index FROM runs WHERE session_id LIKE ?",
  )
  .all("%northline%");
console.log("runs", JSON.stringify(rows, null, 2));

const id = (rows[0] as { id: string } | undefined)?.id ?? "run_5889454d";
const r = getRun(id);
let script: { shots?: Array<{ duration?: number; motion_prompt?: string }> } | null = null;
try {
  script = r?.script_json ? JSON.parse(r.script_json) : null;
} catch {
  script = null;
}
console.log(
  JSON.stringify(
    {
      id,
      status: r?.status,
      model: r?.video_model,
      shots: script?.shots?.length,
      shotDurations: script?.shots?.map((s) => s.duration),
    },
    null,
    2,
  ),
);

const variants = db
  .prepare(
    "SELECT shot_index, kind, rejected, selected, path FROM variants WHERE run_id = ? ORDER BY shot_index, kind",
  )
  .all(id);
console.log("variants", JSON.stringify(variants, null, 2));

const frames = path.join("runs", id, "inputs", "video_frames");
if (fs.existsSync(frames)) {
  console.log(
    "video_frames",
    fs.readdirSync(frames).map((n) => ({ n, kb: Math.round(fs.statSync(path.join(frames, n)).size / 1024) })),
  );
}
