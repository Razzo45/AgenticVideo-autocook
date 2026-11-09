import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCookJob,
  cookJobWeight,
  laneLabel,
  LANE_DEFAULT,
  LANE_FAST,
  LANE_GENERATE,
  LANE_HELPER,
} from "../../src/pipeline/jobLanes";

describe("job lanes", () => {
  it("keeps a task plan light and a task execute heavy", () => {
    const plan = classifyCookJob("task", "argon_plan");
    const execute = classifyCookJob("task", "argon_execute");
    assert.deepEqual(plan, { lane: LANE_FAST, heavy: false, archive: false });
    assert.equal(execute.lane, LANE_DEFAULT);
    assert.equal(execute.heavy, true);
  });

  it("lanes image, deck, page, and audio apart", () => {
    assert.equal(classifyCookJob("image", "doc_cook").lane, LANE_FAST);
    assert.equal(classifyCookJob("pptx", "doc_cook").lane, LANE_GENERATE);
    assert.equal(classifyCookJob("html", "doc_cook").lane, LANE_DEFAULT);
    assert.equal(classifyCookJob("pdf", "doc_cook").heavy, false);
    assert.equal(classifyCookJob("audio", "audio_plan").lane, LANE_HELPER);
    assert.equal(classifyCookJob("audio", "audio_mix").heavy, true);
  });

  it("treats video stages as heavy default work", () => {
    for (const type of ["script", "keyframes", "clips", "stitch", "export"]) {
      const job = classifyCookJob("auto", type);
      assert.equal(job.lane, LANE_DEFAULT);
      assert.equal(job.heavy, true);
    }
    assert.equal(cookJobWeight("task", "argon_execute"), LANE_DEFAULT);
    assert.equal(laneLabel(LANE_GENERATE), "generate");
  });
});
