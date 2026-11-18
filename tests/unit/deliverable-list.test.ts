import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runDir } from "../../src/pipeline/paths";
import { loadTaskDeliverables } from "../../src/pipeline/taskPipeline";

describe("loadTaskDeliverables", () => {
  it("lists a file on disk and skips one that is not there", async () => {
    const runId = `run_list_${Date.now().toString(36)}`;
    const dir = runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const present = path.join(dir, "Hero.png");
    fs.writeFileSync(present, "png");
    const missing = path.join(dir, "Gone.pdf");
    fs.writeFileSync(
      path.join(dir, "deliverables.json"),
      JSON.stringify([
        { id: "1", label: "Hero.png", path: present },
        { id: "2", label: "Gone.pdf", path: missing },
        { id: "3", label: "Empty.svg", path: path.join(dir, "Empty.svg") },
      ]),
    );
    fs.writeFileSync(path.join(dir, "Empty.svg"), "");
    try {
      const rows = await loadTaskDeliverables(runId);
      assert.deepEqual(
        rows.map((row) => row.label),
        ["Hero.png"],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
