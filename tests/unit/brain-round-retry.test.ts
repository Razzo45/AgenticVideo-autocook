import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRAIN_ROUND_TIMEOUT_MS, PlatformFaultError, isPlatformFaultError } from "../../src/pipeline/runControl";

describe("brain round budget", () => {
  it("defaults to 13 minutes", () => {
    assert.equal(BRAIN_ROUND_TIMEOUT_MS, 13 * 60_000);
  });

  it("treats brain-round timeouts as platform faults (retryable once upstream)", () => {
    const err = new PlatformFaultError("Carbon tool round 1/16 timed out after 780s");
    assert.ok(isPlatformFaultError(err));
    assert.match(err.message, /timed out/);
  });
});
