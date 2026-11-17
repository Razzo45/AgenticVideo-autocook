import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  isKeptTaskMetaFile,
  isTaskExecuteJob,
  isTaskPlanJob,
  taskPlanPath,
} from "../../src/pipeline/taskJobs";

describe("task job names", () => {
  it("matches only the task_* job types", () => {
    assert.equal(isTaskPlanJob("task_plan"), true);
    assert.equal(isTaskExecuteJob("task_execute"), true);
    assert.equal(isTaskPlanJob("task_execute"), false);
    assert.equal(isTaskExecuteJob("task_plan"), false);
  });

  it("points at task_plan.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-jobs-"));
    try {
      assert.equal(path.basename(taskPlanPath(dir)), "task_plan.json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the plan files after hygiene", () => {
    assert.equal(isKeptTaskMetaFile("task_plan.json"), true);
    assert.equal(isKeptTaskMetaFile("task_composition.json"), true);
    assert.equal(isKeptTaskMetaFile("compose_media"), false);
  });
});
