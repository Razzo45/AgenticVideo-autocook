import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe } from "node:test";
import { claimScenarios } from "../helpers/claimScenarios";

process.env.RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claim-sqlite-"));
delete process.env.DATABASE_URL;
delete process.env.TASK_EXECUTE_CONCURRENCY;

describe("job queue (SQLite)", () => {
  claimScenarios(async () => {
    const db = await import("../../src/db");
    return {
      db,
      reset: async () => {
        db.getDb().exec("DELETE FROM jobs; DELETE FROM runs;");
      },
      setCreatedMinutesAgo: async (jobId, minutes) => {
        db.getDb()
          .prepare("UPDATE jobs SET created_at=? WHERE id=?")
          .run(new Date(Date.now() - minutes * 60_000).toISOString(), jobId);
      },
    };
  });
});
