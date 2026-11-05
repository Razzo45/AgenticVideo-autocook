import { getDb, listRuns } from "../src/db";
import { loadModelsConfig } from "../src/pipeline/config";

const cfg = loadModelsConfig();
console.log({ maxParallelRuns: cfg.maxParallelRuns });

const cooking = listRuns().filter((r) =>
  ["generating", "queued", "stitching", "waiting_human"].includes(r.status),
);
console.log(
  "active runs",
  cooking.map((r) => ({
    id: r.id,
    mode: r.pipeline_mode,
    status: r.status,
    session: r.session_id,
    ticker: (r.error || "").slice(0, 80),
  })),
);

const jobs = getDb()
  .prepare(
    `SELECT status, type, COUNT(*) AS c FROM jobs
     WHERE status IN ('pending','running')
     GROUP BY status, type`,
  )
  .all();
console.log("inflight jobs", jobs);
