import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("updateRun terminal ticker guard", () => {
  it("keeps failed status and error when a late generating/error ticker arrives", async () => {
    const { createRun } = await import("../../src/pipeline/orchestrator");
    const { getRun, updateRun } = await import("../../src/db/index");
    const run = await createRun({
      prompt: "guard",
      category: "Short Drama / Film & TV",
      duration: 1,
      aspect: "9:16",
      pipelineMode: "task",
      userId: "unit-terminal-guard",
    });
    await updateRun(run.id, { status: "failed", error: "fit_image timed out after 60s" });

    await updateRun(run.id, { status: "generating" });
    await updateRun(run.id, { error: "Argon tool fit_image (cover)…" });

    const fresh = await getRun(run.id);
    assert.equal(fresh?.status, "failed");
    assert.equal(fresh?.error, "fit_image timed out after 60s");
  });
});
