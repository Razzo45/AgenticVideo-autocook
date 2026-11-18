import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUnsupportedThinkingLevel } from "../../src/pipeline/geminiBrain";

describe("thinking level", () => {
  it("recognizes a model that rejects MINIMAL", () => {
    const err = new Error(
      'ApiError: {"error":{"code":400,"message":"Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.","status":"INVALID_ARGUMENT"}}',
    );
    assert.equal(isUnsupportedThinkingLevel(err), true);
    assert.equal(isUnsupportedThinkingLevel(new Error("timed out")), false);
  });
});
