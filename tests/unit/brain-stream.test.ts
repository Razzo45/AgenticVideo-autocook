import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeBrainStream } from "../../src/pipeline/geminiBrain";
import { INTERRUPTED_FINISH, isCutOffFinish } from "../../src/pipeline/deliverableReceive";

type Chunk = { text?: string; candidates?: Array<{ finishReason?: unknown }>; usageMetadata?: Record<string, number> };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function streamOf(steps: Array<Chunk | Error | number>, signal?: AbortSignal) {
  return (async function* () {
    for (const step of steps) {
      if (typeof step === "number") {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, step);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted by signal"));
          });
        });
      } else if (step instanceof Error) throw step;
      else yield step;
    }
  })();
}

describe("streamed brain reply", () => {
  it("joins the chunks and reports finish and token usage", async () => {
    const got = await consumeBrainStream({
      label: "t",
      open: async () =>
        streamOf([
          { text: '{"deliver' },
          { text: 'ables":[]}' },
          { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 900 } },
        ]),
    });
    assert.equal(got.text, '{"deliverables":[]}');
    assert.equal(got.finishReason, "STOP");
    assert.equal(got.usage?.thoughtsTokenCount, 900);
  });

  it("keeps the text when the stream drops, so the caller continues it", async () => {
    const got = await consumeBrainStream({
      label: "t",
      open: async () => streamOf([{ text: '{"deliverables":[{"id":"a","html":"<p>half' }, new Error("503 UNAVAILABLE")]),
    });
    assert.equal(got.finishReason, INTERRUPTED_FINISH);
    assert.ok(got.text.endsWith("<p>half"));
    assert.equal(isCutOffFinish(got.finishReason), true);
  });

  it("throws the provider error when nothing arrived, so admission can retry", async () => {
    await assert.rejects(
      consumeBrainStream({ label: "t", open: async () => streamOf([new Error("503 UNAVAILABLE")]) }),
      /503 UNAVAILABLE/,
    );
    await assert.rejects(
      consumeBrainStream({ label: "t", open: async () => Promise.reject(new Error("429 quota")) }),
      /429 quota/,
    );
  });

  it("a caller that cannot continue gets the error even with partial text", async () => {
    await assert.rejects(
      consumeBrainStream({
        label: "t",
        keepPartial: false,
        open: async () => streamOf([{ text: "half" }, new Error("503 UNAVAILABLE")]),
      }),
      /503 UNAVAILABLE/,
    );
  });

  it("ends a stream that goes silent after text, and keeps that text", async () => {
    const got = await consumeBrainStream({
      label: "t",
      idleMs: 40,
      tickMs: 10,
      graceMs: 20,
      open: async (signal) => streamOf([{ text: "started" }, 5_000, { text: "never" }], signal),
    });
    assert.equal(got.text, "started");
    assert.equal(got.finishReason, INTERRUPTED_FINISH);
  });

  it("does not apply the silence limit before the first text (thinking)", async () => {
    const got = await consumeBrainStream({
      label: "t",
      idleMs: 20,
      tickMs: 5,
      open: async () => streamOf([120, { text: "after thinking" }, { candidates: [{ finishReason: "STOP" }] }]),
    });
    assert.equal(got.text, "after thinking");
    assert.equal(got.finishReason, "STOP");
  });

  it("fails as a platform fault when the whole call runs out of time with no text", async () => {
    await assert.rejects(
      consumeBrainStream({
        label: "Carbon 3/4",
        totalMs: 40,
        tickMs: 10,
        graceMs: 20,
        open: async (signal) => streamOf([5_000], signal),
      }),
      (err: Error) => err.name === "PlatformFaultError" && /Carbon 3\/4 timed out/.test(err.message),
    );
  });

  it("stops even if the SDK ignores the abort", async () => {
    const started = Date.now();
    const got = await consumeBrainStream({
      label: "t",
      idleMs: 30,
      tickMs: 10,
      graceMs: 30,
      open: async () => streamOf([{ text: "x" }, 3_000]),
    });
    assert.equal(got.finishReason, INTERRUPTED_FINISH);
    assert.ok(Date.now() - started < 1_000);
  });

  it("cancel wins over partial text", async () => {
    const ctl = new AbortController();
    const cancel = Object.assign(new Error("Cook cancelled (run_x)"), { name: "RunCancelledError" });
    const pending = consumeBrainStream({
      label: "t",
      runSignal: ctl.signal,
      graceMs: 20,
      open: async (signal) => streamOf([{ text: "half" }, 5_000], signal),
    });
    await wait(20);
    ctl.abort(cancel);
    await assert.rejects(pending, /Cook cancelled/);
  });
});
