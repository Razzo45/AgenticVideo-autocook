import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadSliceCheckpoint, saveSliceCheckpoint, sliceCheckpointPath, sliceKey } from "../../src/pipeline/taskPipeline";
import { isKeptTaskMetaFile } from "../../src/pipeline/taskJobs";

const slice = [{ deliverable: "pdf", id: "zone3", filename: "Zone3.pdf", note: "60x18in" }];
const reply = [{ id: "zone3", filename: "Zone3.pdf", kind: "pdf" as const, html: "<html></html>", places: [] }];

describe("saved brain replies", () => {
  it("a retry reuses the reply for the same planned file and brain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slices-"));
    const key = sliceKey(slice, "gemini-4-carbon");
    assert.equal(await loadSliceCheckpoint(dir, 2, key), null);
    await saveSliceCheckpoint(dir, 2, key, reply as never);
    assert.ok(fs.existsSync(sliceCheckpointPath(dir, 2)));
    const again = await loadSliceCheckpoint(dir, 2, key);
    assert.equal(again?.[0]?.filename, "Zone3.pdf");
  });

  it("a different plan, brain, or slot does not match", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slices-"));
    await saveSliceCheckpoint(dir, 0, sliceKey(slice, "gemini-4-carbon"), reply as never);
    assert.equal(await loadSliceCheckpoint(dir, 0, sliceKey(slice, "gemini-4-argon")), null);
    assert.equal(await loadSliceCheckpoint(dir, 0, sliceKey([{ ...slice[0]!, note: "other" }], "gemini-4-carbon")), null);
    assert.equal(await loadSliceCheckpoint(dir, 1, sliceKey(slice, "gemini-4-carbon")), null);
  });

  it("a damaged file is ignored", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slices-"));
    const file = sliceCheckpointPath(dir, 0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    assert.equal(await loadSliceCheckpoint(dir, 0, "k"), null);
  });

  it("survives the failed-run cleanup", () => {
    assert.equal(isKeptTaskMetaFile("task_slices"), true);
  });
});
