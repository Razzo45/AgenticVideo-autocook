import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("task resume", () => {
  it("enqueues another deliverable build and clears a storyboard gate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-resume-"));
    process.env.RUNS_DIR = root;
    process.env.SQLITE_PATH = path.join(root, "pipeline.db");
    delete process.env.DATABASE_URL;
    const { createRun, retryRun } = await import("../../src/pipeline/orchestrator");
    const { getDb, getRun, updateRun } = await import("../../src/db/index");
    const run = await createRun({
      prompt: "Make the deck and the pdf.",
      category: "E-commerce & Advertising",
      duration: 1,
      aspect: "16:9",
      pipelineMode: "task",
      userId: "unit-user",
    });
    await updateRun(run.id, {
      status: "failed",
      gate: "script",
      script_json: JSON.stringify({ title: "storyboard" }),
      error: "Attached file not found",
    });

    await retryRun(run.id);

    const fresh = await getRun(run.id);
    assert.equal(fresh?.status, "queued");
    assert.equal(fresh?.gate, null);
    assert.equal(fresh?.script_json, null);
    assert.match(fresh?.error ?? "", /Resuming the deliverables/);

    const jobs = getDb()
      .prepare("SELECT type, status FROM jobs WHERE run_id=? ORDER BY created_at")
      .all(run.id) as Array<{ type: string; status: string }>;
    assert.equal(jobs.some((job) => job.type === "script"), false);
    assert.equal(jobs.find((job) => job.type === "argon_plan")?.status, "error");
    assert.equal(jobs.filter((job) => job.type === "argon_execute" && job.status === "pending").length, 1);
  });
});
