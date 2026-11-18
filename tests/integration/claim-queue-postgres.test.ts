/**
 * The same queue scenarios on real Postgres. Runs only when PG_TEST_URL is set:
 *   PG_TEST_URL=postgres://postgres:pw@localhost/autocook_test npm run test:integration
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe } from "node:test";
import { claimScenarios } from "../helpers/claimScenarios";

const url = process.env.PG_TEST_URL?.trim();
process.env.RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claim-pg-"));
if (url) process.env.DATABASE_URL = url;
delete process.env.TASK_EXECUTE_CONCURRENCY;

describe("job queue (Postgres)", { skip: url ? false : "set PG_TEST_URL to run" }, () => {
  claimScenarios(async () => {
    const db = await import("../../src/db");
    const { ensureRailwaySchema } = await import("../../src/pipeline/ensureSchema");
    const { pgQuery } = await import("../../src/pipeline/pg");
    await ensureRailwaySchema();
    return {
      db,
      reset: async () => {
        await pgQuery("DELETE FROM app.jobs");
        await pgQuery("DELETE FROM app.cook_requests");
        await pgQuery("DELETE FROM app.runs");
      },
      setCreatedMinutesAgo: async (jobId, minutes) => {
        await pgQuery(`UPDATE app.jobs SET created_at = now() - make_interval(mins => $1) WHERE id=$2`, [minutes, jobId]);
      },
    };
  });
});
