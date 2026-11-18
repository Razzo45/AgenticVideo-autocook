import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCacheError, roughPromptTokens, shouldCacheTask } from "../../src/pipeline/geminiCache";
import { composeTaskInstructions, sliceTurnText } from "../../src/pipeline/composition";

describe("task context cache", () => {
  const big = [{ text: "x".repeat(2_000_000) }]; // ~500k tokens, like run_87814344
  const small = [{ text: "short brief" }];

  it("caches a large package used by more than one call", () => {
    delete process.env.TASK_CACHE;
    assert.ok(roughPromptTokens(big) > 400_000);
    assert.equal(shouldCacheTask(big, 3), true);
  });

  it("skips one call, a small package, or TASK_CACHE=0", () => {
    assert.equal(shouldCacheTask(big, 1), false);
    assert.equal(shouldCacheTask(small, 3), false);
    process.env.TASK_CACHE = "0";
    assert.equal(shouldCacheTask(big, 3), false);
    delete process.env.TASK_CACHE;
  });

  it("counts staged files and inline PDFs, not just text", () => {
    assert.ok(roughPromptTokens([{ fileData: { fileUri: "https://x/files/a", mimeType: "application/pdf" } }]) >= 40_000);
    const pdf = Buffer.alloc(600_000, 1).toString("base64");
    assert.ok(roughPromptTokens([{ inlineData: { mimeType: "application/pdf", data: pdf } }]) > 100_000);
    assert.ok(roughPromptTokens([{ inlineData: { mimeType: "image/png", data: pdf } }]) < 2_000);
  });

  it("recognises a refused or expired cache, not other errors", () => {
    assert.equal(isCacheError(new Error("404 NOT_FOUND: CachedContent not found (or permission denied)")), true);
    assert.equal(isCacheError(new Error("cachedContents/abc123 has expired")), true);
    assert.equal(isCacheError(new Error("429 RESOURCE_EXHAUSTED")), false);
    assert.equal(isCacheError(new Error("Deliverable JSON did not parse")), false);
  });

  it("every file of a task shares one instruction; the turn names the file", () => {
    const planned = [
      { deliverable: "pdf", id: "a", filename: "A.pdf" },
      { deliverable: "png", id: "b", filename: "B.png" },
    ];
    const shared = composeTaskInstructions(planned, ["logo.svg"], "Carbon");
    assert.match(shared, /A\.pdf/);
    assert.match(shared, /B\.png/);
    assert.match(shared, /Each turn names the planned file/);
    const turn = sliceTurnText([planned[0]], ["B.png"]);
    assert.match(turn, /Write this planned file now/);
    assert.match(turn, /"filename":"A\.pdf"/);
    assert.match(turn, /may set "from" to one of these filenames[\s\S]*B\.png/);
    assert.ok(!/B\.png/.test(sliceTurnText([planned[0]])));
  });
});
