import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepPlannedDeliverables, mapLimit, sliceConcurrency } from "../../src/pipeline/taskPipeline";
import { beginRunControl, cancelRunControl, endRunControl, getRunSignal } from "../../src/pipeline/runControl";

const file = (id: string, filename: string) => ({ id, filename });

describe("one call, one planned file", () => {
  it("drops files a single-file call was not asked for", () => {
    // run_c719479d: the flyer call also rewrote the poster and the invitation.
    const { kept, dropped } = keepPlannedDeliverables(
      [{ deliverable: "pdf", id: "flyer", filename: "Flyer_A5.pdf" }],
      [file("flyer", "Flyer_A5.pdf"), file("poster", "Poster_A2.pdf"), file("vip_invitation", "VIP_Invitation_A5.pdf")],
    );
    assert.deepEqual(kept.map((d) => d.filename), ["Flyer_A5.pdf"]);
    assert.deepEqual(dropped.map((d) => d.filename), ["Poster_A2.pdf", "VIP_Invitation_A5.pdf"]);
  });

  it("matches by id when the reply renamed the file, and keeps a lone renamed reply", () => {
    const byId = keepPlannedDeliverables(
      [{ deliverable: "pdf", id: "flyer", filename: "Flyer_A5.pdf" }],
      [file("poster", "Poster.pdf"), file("flyer", "Flyer-final.pdf")],
    );
    assert.deepEqual(byId.kept.map((d) => d.filename), ["Flyer-final.pdf"]);
    const lone = keepPlannedDeliverables([{ deliverable: "pdf", id: "flyer", filename: "Flyer_A5.pdf" }], [file("x", "Other.pdf")]);
    assert.deepEqual(lone.kept.map((d) => d.filename), ["Other.pdf"]);
    assert.equal(lone.dropped.length, 0);
  });

  it("falls back to the first reply when nothing matches", () => {
    const { kept, dropped } = keepPlannedDeliverables(
      [{ deliverable: "pdf", id: "flyer", filename: "Flyer_A5.pdf" }],
      [file("a", "A.pdf"), file("b", "B.pdf")],
    );
    assert.deepEqual(kept.map((d) => d.filename), ["A.pdf"]);
    assert.deepEqual(dropped.map((d) => d.filename), ["B.pdf"]);
  });

  it("keeps every planned file of a multi-file slice", () => {
    const slice = [
      { deliverable: "svg", id: "a", filename: "a.svg" },
      { deliverable: "svg", id: "b", filename: "b.svg" },
    ];
    const { kept, dropped } = keepPlannedDeliverables(slice, [file("b", "b.svg"), file("a", "a.svg"), file("c", "c.svg")]);
    assert.deepEqual(kept.map((d) => d.id), ["a", "b"]);
    assert.deepEqual(dropped.map((d) => d.id), ["c"]);
  });
});

describe("files of one task run side by side", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return index;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
  });

  it("stops at the first failure", async () => {
    await assert.rejects(
      mapLimit([1, 2, 3], 3, async (n) => {
        if (n === 2) throw new Error("slice failed");
        return n;
      }),
      /slice failed/,
    );
  });

  it("reads TASK_SLICE_CONCURRENCY, default 3", () => {
    const prev = process.env.TASK_SLICE_CONCURRENCY;
    delete process.env.TASK_SLICE_CONCURRENCY;
    assert.equal(sliceConcurrency(), 3);
    process.env.TASK_SLICE_CONCURRENCY = "1";
    assert.equal(sliceConcurrency(), 1);
    if (prev === undefined) delete process.env.TASK_SLICE_CONCURRENCY;
    else process.env.TASK_SLICE_CONCURRENCY = prev;
  });

  it("cancel reaches a per-file admission owner", () => {
    beginRunControl("run_test1234");
    const signal = getRunSignal("run_test1234:slice2");
    assert.ok(signal, "owner run:part resolves to the run's signal");
    cancelRunControl("run_test1234", "stop");
    assert.equal(signal!.aborted, true);
    endRunControl("run_test1234");
    assert.equal(getRunSignal("run_test1234:slice2"), undefined);
  });
});
