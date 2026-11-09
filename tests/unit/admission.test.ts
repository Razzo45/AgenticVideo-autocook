import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdaptiveAdmission, sharedAdmissionLimits } from "../../src/pipeline/geminiAdmissionCore";

function gate(initial: number) {
  return new AdaptiveAdmission({
    floor: 1,
    ceiling: 2,
    initial,
    ownerCeiling: 2,
    now: () => 1_000_000,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
}

describe("gemini admission", () => {
  it("holds a second call until the first slot is free", async () => {
    const admission = gate(1);
    let releaseFirst: () => void = () => undefined;
    const first = admission.use(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
      { lane: "image", requestClass: "background", ownerId: "cook" },
    );
    let entered = false;
    const second = admission.use(
      async () => {
        entered = true;
      },
      { lane: "image", requestClass: "background", ownerId: "cook" },
    );
    await Promise.resolve();
    assert.equal(entered, false);
    assert.equal(admission.snapshot().active, 1);
    assert.equal(admission.snapshot().queued, 1);
    releaseFirst();
    await first;
    await second;
    assert.equal(entered, true);
    assert.equal(admission.snapshot().active, 0);
  });

  it("halves the target on a 429 and steps down after three failures", () => {
    const admission = gate(2);
    const delay = admission.onThrottle("image", 500, 1000);
    assert.equal(admission.snapshot().target, 1);
    assert.ok(delay >= 500);
    assert.equal(admission.limitsFor("image").intervalMs, 2000);

    const healthy = gate(2);
    healthy.onFailure("image", "timeout");
    healthy.onFailure("image", "timeout");
    assert.equal(healthy.snapshot().target, 2);
    healthy.onFailure("image", "server");
    assert.equal(healthy.snapshot().target, 1);
  });

  it("spaces the files lane only while a cooldown is up", () => {
    assert.deepEqual(
      sharedAdmissionLimits({ lane: "files", target: 2, filesTarget: 2, recent429s: 1, cooldownMsRemaining: 100 }),
      { maxActive: 2, intervalMs: 2000 },
    );
    assert.equal(
      sharedAdmissionLimits({ lane: "image", target: 2, filesTarget: 2, recent429s: 0, cooldownMsRemaining: 0 }).intervalMs,
      0,
    );
  });
});
