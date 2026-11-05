import fs from "node:fs";
import { getDb, getRun, updateRun, listVariants } from "../src/db";

const id = "run_51a7fa64";
const db = getDb();
const ts = new Date().toISOString();
const r = db
  .prepare(
    `UPDATE jobs SET status='error', error=?, updated_at=? WHERE run_id=? AND status IN ('pending','running')`,
  )
  .run("Paused: stopping empty-filter credit burn on scene 4", ts, id);

updateRun(id, {
  status: "failed",
  gate: null,
  error:
    "Paused scene 4 — Veo empty-filter loop was burning credits with no clip. Fixing recovery then resume.",
});

const run = getRun(id)!;
console.log({ cleared: r.changes, status: run.status, error: run.error });
console.log(
  "shot3 keyframes",
  listVariants(id, 3, "keyframe").map((v) => ({
    sel: v.selected,
    rej: v.rejected,
    id: v.id.slice(0, 8),
  })),
);
console.log(
  "shot3 clips",
  listVariants(id, 3, "clip").map((v) => ({
    sel: v.selected,
    rej: v.rejected,
    exists: fs.existsSync(v.path),
  })),
);
