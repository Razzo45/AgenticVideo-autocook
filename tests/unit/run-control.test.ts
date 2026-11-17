import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beginRunControl,
  cancelRunControl,
  endRunControl,
  isCancelledError,
  isPlatformFaultError,
  PlatformFaultError,
  RunCancelledError,
  withDeadline,
} from "../../src/pipeline/runControl";

describe("runControl", () => {
  it("aborts in-flight withDeadline work on cancel", async () => {
    const runId = `run_cancel_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const signal = beginRunControl(runId);
    try {
      const work = withDeadline(new Promise<string>(() => {}), {
        timeoutMs: 5_000,
        label: "unit hang",
        signal,
      });
      queueMicrotask(() => cancelRunControl(runId, "unit cancel"));
      try {
        await work;
        assert.fail("expected withDeadline to reject on cancel");
      } catch (err) {
        assert.equal((err as Error).name, "RunCancelledError");
        assert.ok(isCancelledError(err));
        assert.ok(isPlatformFaultError(err));
      }
    } finally {
      endRunControl(runId);
    }
  });

  it("fails loud when the deadline elapses", async () => {
    try {
      await withDeadline(new Promise<string>(() => {}), {
        timeoutMs: 30,
        label: "unit timeout",
      });
      assert.fail("expected timeout");
    } catch (err) {
      assert.ok(err instanceof PlatformFaultError);
      assert.match((err as Error).message, /timed out after/);
    }
  });

  it("does not resurrect RunCancelledError as a generic platform fault name", () => {
    const err = new RunCancelledError("run_x");
    assert.equal(err.name, "RunCancelledError");
    assert.ok(isCancelledError(err));
    assert.ok(isPlatformFaultError(err));
  });
});
