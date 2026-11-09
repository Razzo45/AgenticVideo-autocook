import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

let root = "";
let purgeRunStaging: typeof import("../../src/pipeline/hygiene").purgeRunStaging;
let scheduleForJob: typeof import("../../src/pipeline/taskWeight").scheduleForJob;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-hygiene-"));
  process.env.RUNS_DIR = root;
  process.env.SQLITE_PATH = path.join(root, "pipeline.db");
  delete process.env.DATABASE_URL;
  purgeRunStaging = (await import("../../src/pipeline/hygiene")).purgeRunStaging;
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
    assert.equal(scheduleForJob(runId, "task", "argon_execute").weight, 35);
    assert.equal(scheduleForJob(runId, "task", "argon_plan").weight, 1);
    assert.equal(scheduleForJob("missing", "task", "argon_execute").weight, 10);
  });
});
