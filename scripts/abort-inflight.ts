/**
 * Emergency stop: abort all running/pending jobs and fail generating auto runs.
 * Usage: npx tsx scripts/abort-inflight.ts
 */
import { getDb, listRuns, updateRun } from "../src/db";

const db = getDb();
const ts = new Date().toISOString();
const msg =
  "Aborted by operator to stop spend. In-flight video/image jobs cancelled locally — provider may still bill accepted submits.";

const active = db
  .prepare("SELECT id, run_id, type, status, payload_json FROM jobs WHERE status IN ('pending','running')")
  .all() as Array<{ id: string; run_id: string; type: string; status: string; payload_json: string }>;

console.log("active jobs before:", active.length);
for (const j of active) {
  console.log(" ", j.status, j.type, j.payload_json, j.run_id, j.id.slice(0, 8));
  db.prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?").run("error", msg, ts, j.id);
}

const cooking = listRuns().filter((r) =>
  ["generating", "queued", "stitching", "rework"].includes(r.status),
);
console.log("cooking runs:", cooking.length);
for (const r of cooking) {
  console.log(" ", r.id, r.session_id, r.status, r.current_shot_index, (r.error || "").slice(0, 100));
  updateRun(r.id, {
    status: "failed",
    gate: null,
    error: msg,
  });
}

const left = db
  .prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('pending','running')")
  .get() as { c: number };
console.log("active jobs after:", left.c);
console.log("aborted.");
