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
  it("treats leftover argon_* queue rows as the same jobs", () => {
    assert.equal(isTaskPlanJob("task_plan"), true);
    assert.equal(isTaskPlanJob("argon_plan"), true);
    assert.equal(isTaskExecuteJob("task_execute"), true);
    assert.equal(isTaskExecuteJob("argon_execute"), true);
    assert.equal(isTaskExecuteJob("argon_task"), true);
    assert.equal(isTaskPlanJob("task_execute"), false);
  });

  it("reads argon_plan.json when the renamed file is not on disk yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-jobs-"));
    try {
      assert.equal(path.basename(taskPlanPath(dir)), "task_plan.json");
      fs.writeFileSync(path.join(dir, "argon_plan.json"), '{"deliverables":[]}');
      assert.equal(path.basename(taskPlanPath(dir)), "argon_plan.json");
      fs.writeFileSync(path.join(dir, "task_plan.json"), '{"deliverables":[]}');
      assert.equal(path.basename(taskPlanPath(dir)), "task_plan.json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps both new and leftover plan files after hygiene", () => {
    assert.equal(isKeptTaskMetaFile("task_plan.json"), true);
    assert.equal(isKeptTaskMetaFile("argon_plan.json"), true);
    assert.equal(isKeptTaskMetaFile("task_composition.json"), true);
    assert.equal(isKeptTaskMetaFile("argon_composition.json"), true);
    assert.equal(isKeptTaskMetaFile("compose_media"), false);
  });
});
