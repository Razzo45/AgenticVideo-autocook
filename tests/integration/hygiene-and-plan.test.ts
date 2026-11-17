import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

let root = "";
let purgeRunStaging: typeof import("../../src/pipeline/hygiene").purgeRunStaging;
let failOrphanGeneratingRuns: typeof import("../../src/pipeline/hygiene").failOrphanGeneratingRuns;
let scheduleForJob: typeof import("../../src/pipeline/taskWeight").scheduleForJob;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-hygiene-"));
  process.env.RUNS_DIR = root;
  process.env.SQLITE_PATH = path.join(root, "pipeline.db");
  delete process.env.DATABASE_URL;
  const hygiene = await import("../../src/pipeline/hygiene");
  purgeRunStaging = hygiene.purgeRunStaging;
  failOrphanGeneratingRuns = hygiene.failOrphanGeneratingRuns;
  scheduleForJob = (await import("../../src/pipeline/taskWeight")).scheduleForJob;
});

describe("finished-run hygiene", () => {
  it("keeps the deliverables and drops staging, and can keep inputs after a failure", () => {
    const runId = "run_hygiene";
    const dir = path.join(root, runId);
    fs.mkdirSync(path.join(dir, "out"), { recursive: true });
    fs.mkdirSync(path.join(dir, "inputs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "compose_media"), { recursive: true });
    fs.mkdirSync(path.join(dir, "shot_1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "out", "Deck.pptx"), "deck");
    fs.writeFileSync(path.join(dir, "inputs", "logo.png"), "logo");
    fs.writeFileSync(path.join(dir, "argon_composition.json"), "{}");
    fs.writeFileSync(path.join(dir, "argon_plan.json"), "{}");
    fs.writeFileSync(path.join(dir, "compose_media", "slot.png"), "x");

    const removed = purgeRunStaging(runId, { keepInputs: true }).removed.sort();
    assert.deepEqual(removed, ["compose_media", "shot_1"]);
    assert.equal(fs.existsSync(path.join(dir, "inputs", "logo.png")), true);
    assert.equal(fs.existsSync(path.join(dir, "argon_composition.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "out", "Deck.pptx")), true);

    purgeRunStaging(runId);
    assert.equal(fs.existsSync(path.join(dir, "inputs")), false);
    assert.equal(fs.existsSync(path.join(dir, "out", "Deck.pptx")), true);
    assert.equal(fs.existsSync(path.join(dir, "argon_plan.json")), true);
  });
});

describe("orphan generating runs", () => {
  it("fails a generating run with no job after the idle window", async () => {
    const { createRun } = await import("../../src/pipeline/orchestrator");
    const { getDb, getRun, updateRun } = await import("../../src/db/index");
    const run = await createRun({
      prompt: "fit a cover",
      category: "Short Drama / Film & TV",
      duration: 1,
      aspect: "9:16",
      pipelineMode: "task",
      userId: "unit-user",
    });
    await updateRun(run.id, {
      status: "generating",
      error: "Carbon tool fit_image (cover, 1080x1920 cover)…",
    });
    // Drop any plan/execute queue rows so this looks like a lost mid-tool cook.
    getDb().prepare("UPDATE jobs SET status='error', error=? WHERE run_id=?").run("superseded", run.id);
    // Force an old updated_at — updateRun stamps now, so patch via SQL.
    getDb()
      .prepare("UPDATE runs SET updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 15 * 60_000).toISOString(), run.id);

    const failed = await failOrphanGeneratingRuns();
    assert.ok(failed >= 1);
    const fresh = await getRun(run.id);
    assert.equal(fresh?.status, "failed");
    assert.match(fresh?.error ?? "", /no worker job|fit_image/);
  });
});

describe("execute weight from the saved plan", () => {
  it("sums the plan instead of a flat score", () => {
    const runId = "run_plan";
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "argon_plan.json"),
      JSON.stringify({
        deliverables: [
          { deliverable: "pptx", filename: "Deck.pptx" },
          { deliverable: "pdf", filename: "Deck.pdf" },
        ],
      }),
    );
    assert.equal(scheduleForJob(runId, "task", "task_execute").weight, 35);
    assert.equal(scheduleForJob(runId, "task", "argon_execute").weight, 35);
    assert.equal(scheduleForJob(runId, "task", "task_plan").weight, 1);
    assert.equal(scheduleForJob("missing", "task", "task_execute").weight, 10);
  });
});

describe("stuck task_plan release", () => {
  it("marks hung plan done when execute is pending and run is queued", async () => {
    const { createRun } = await import("../../src/pipeline/orchestrator");
    const { enqueueJob, getDb, releaseStuckTaskPlanJobs, updateRun } = await import("../../src/db/index");
    const run = await createRun({
      prompt: "stuck plan",
      category: "Short Drama / Film & TV",
      duration: 1,
      aspect: "9:16",
      pipelineMode: "task",
      userId: "unit-stuck-plan",
    });
    getDb().prepare("UPDATE jobs SET status='error' WHERE run_id=?").run(run.id);
    const planId = await enqueueJob(run.id, "task_plan", {});
    const execId = await enqueueJob(run.id, "task_execute", {});
    getDb().prepare("UPDATE jobs SET status='running' WHERE id=?").run(planId);
    getDb().prepare("UPDATE jobs SET status='pending' WHERE id=?").run(execId);
    await updateRun(run.id, { status: "queued" });

    const released = await releaseStuckTaskPlanJobs();
    assert.ok(released >= 1);
    const plan = getDb().prepare("SELECT status FROM jobs WHERE id=?").get(planId) as { status: string };
    assert.equal(plan.status, "done");
  });
});

