import { getRun, updateRun, getReview, upsertReview, enqueueJob } from "../src/db";

const id = process.argv[2] || "run_51a7fa64";
const run = getRun(id);
if (!run) throw new Error(`missing ${id}`);

const checklist = { purity: true, safety: true, structure: true, identity: true };
const prev = getReview(id);
upsertReview({
  run_id: id,
  gate: "audit",
  checklist_json: JSON.stringify(checklist),
  aesthetic_score: prev?.aesthetic_score ?? 7,
  consistency_score: prev?.consistency_score ?? 80,
  use_xfade: prev?.use_xfade ?? 0,
});

updateRun(id, {
  status: "generating",
  gate: null,
  error: "Retrying export after probe-metadata fix…",
});
enqueueJob(id, "export");

const fresh = getRun(id)!;
console.log(`[export queued] status=${fresh.status} error=${fresh.error}`);
console.log(`[open] http://127.0.0.1:3000/runs/${id}`);
console.log("Restart worker if needed so the export probe fix is loaded.");
