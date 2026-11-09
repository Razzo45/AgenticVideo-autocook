import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduleForRun, weightFromDeliverables } from "../../src/pipeline/taskWeight";

describe("task weight", () => {
  it("scores each file from its kind", () => {
    const schedule = weightFromDeliverables([
      { deliverable: "svg" },
      { deliverable: "image" },
      { deliverable: "html" },
      { deliverable: "pdf" },
      { deliverable: "pptx" },
      { deliverable: "audio" },
      { deliverable: "video" },
    ]);
    assert.equal(schedule.weight, 5 + 10 + 10 + 15 + 20 + 20 + 30);
  });

  it("accepts aliases and multiplies by count", () => {
    const schedule = weightFromDeliverables([
      { deliverable: "powerpoint", count: 2 },
      { deliverable: "mp4" },
      { deliverable: "podcast" },
      { deliverable: "png" },
    ]);
    assert.equal(schedule.weight, 20 * 2 + 30 + 20 + 10);
  });

  it("caps a count at 12 and treats an empty plan as one unspecified file", () => {
    assert.equal(weightFromDeliverables([{ deliverable: "image", count: 40 }]).weight, 120);
    const empty = weightFromDeliverables([]);
    assert.equal(empty.weight, 10);
    assert.equal(empty.parts[0]?.deliverable, "unspecified");
  });

  it("gives the plan step a token weight and legacy modes their single file", () => {
    assert.equal(scheduleForRun("task", "argon_plan").weight, 1);
    assert.equal(scheduleForRun("pptx", "doc_cook").weight, 20);
    assert.equal(scheduleForRun("auto", "script").weight, 30);
    assert.equal(scheduleForRun("audio", "audio_plan").weight, 20);
    assert.equal(scheduleForRun("task", "argon_execute").weight, 10);
  });
});
