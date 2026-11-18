/**
 * Queue scenarios run against whichever backend the importing test configured
 * (SQLite via RUNS_DIR, or Postgres via DATABASE_URL). Import this only after
 * the environment is set.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

type Db = typeof import("../../src/db");

export function claimScenarios(load: () => Promise<{ db: Db; setCreatedMinutesAgo: (jobId: string, minutes: number) => Promise<void>; reset: () => Promise<void> }>) {
  let n = 0;
  const runsDir = () => process.env.RUNS_DIR!;

  async function task(db: Db, user: string, deliverables: string[], opts?: { plan?: boolean }) {
    n += 1;
    const id = `run_t${String(n).padStart(6, "0")}`;
    await db.insertRun({
      id,
      session_id: `${id}-s`,
      status: "queued",
      category: "Creative Works",
      aspect_ratio: "16:9",
      target_duration: 1,
      output_resolution: "1080p",
      initial_prompt: "x",
      script_model: "gemini-4-argon",
      keyframe_model: "k",
      video_model: "v",
      current_shot_index: 0,
      rework_round: 0,
      gate: null,
      revise_comment: null,
      script_json: null,
      input_assets_json: null,
      pipeline_mode: "task",
      operator_script: null,
      auto_options_json: null,
      error: null,
      counted: 0,
      user_id: user,
      tenant_id: null,
      created_by_kind: "dev",
    });
    fs.mkdirSync(path.join(runsDir(), id), { recursive: true });
    fs.writeFileSync(
      path.join(runsDir(), id, "task_plan.json"),
      JSON.stringify({ deliverables: deliverables.map((d, i) => ({ deliverable: d, id: `f${i}`, filename: `f${i}.${d}` })) }),
    );
    const jobId = await db.enqueueJob(id, opts?.plan ? "task_plan" : "task_execute");
    return { runId: id, jobId };
  }

  async function claimAll(db: Db) {
    const got = [];
    for (;;) {
      const job = await db.claimNextJob();
      if (!job) return got;
      got.push(job);
    }
  }

  it("runs two people's tasks at once and holds the third", async () => {
    const { db, reset } = await load();
    await reset();
    const a = await task(db, "alice", ["pdf", "pdf", "pdf"]);
    const b = await task(db, "bob", ["pptx"]);
    const c = await task(db, "carol", ["image"]);
    const first = await claimAll(db);
    assert.equal(first.length, 2, "two deliverable slots");
    const running = new Set(first.map((j) => j.run_id));
    assert.ok(!running.has(a.runId) || !running.has(b.runId) || !running.has(c.runId));
    await db.finishJob(first[0]!.id, "done");
    const next = await claimAll(db);
    assert.equal(next.length, 1, "a slot frees, the waiting task starts");
  });

  it("someone with nothing running goes before someone who already has a task running", async () => {
    const { db, reset } = await load();
    await reset();
    const running = await task(db, "alice", ["image"]);
    assert.equal((await db.claimNextJob())?.run_id, running.runId);
    await task(db, "alice", ["image"]); // light, earlier
    const bob = await task(db, "bob", ["video", "image"]); // heavy, later
    assert.equal((await db.claimNextJob())?.run_id, bob.runId);
  });

  it("only one task that makes video generates at a time", async () => {
    const { db, reset } = await load();
    await reset();
    const v1 = await task(db, "alice", ["video"]);
    await task(db, "bob", ["video"]);
    const doc = await task(db, "carol", ["pdf"]);
    const got = await claimAll(db);
    const ids = got.map((j) => j.run_id).sort();
    assert.deepEqual(ids, [v1.runId, doc.runId].sort());
  });

  it("plans are read even when every deliverable slot is busy", async () => {
    const { db, reset } = await load();
    await reset();
    await task(db, "alice", ["pdf"]);
    await task(db, "bob", ["pdf"]);
    const plan = await task(db, "carol", [], { plan: true });
    const got = await claimAll(db);
    assert.equal(got.length, 3);
    assert.ok(got.some((j) => j.run_id === plan.runId && j.type === "task_plan"));
  });

  it("a heavy task that has waited long enough goes before a new light one", async () => {
    const { db, reset, setCreatedMinutesAgo } = await load();
    await reset();
    const busyA = await task(db, "x1", ["pdf"]);
    const busyB = await task(db, "x2", ["pdf"]);
    assert.equal((await claimAll(db)).length, 2);
    const heavy = await task(db, "alice", ["video", "pptx", "pptx"]); // 70
    const light = await task(db, "bob", ["svg"]); // 5
    await db.finishJob(busyA.jobId, "done");
    assert.equal((await db.claimNextJob())?.run_id, light.runId, "fresh: the light task wins");
    await db.finishJob(busyB.jobId, "done");
    const light2 = await task(db, "carol", ["svg"]);
    await setCreatedMinutesAgo(heavy.jobId, 30); // 70 - 10*30/2 = -80
    assert.equal((await db.claimNextJob())?.run_id, heavy.runId, "after 30 minutes the heavy task wins");
    void light2;
  });

  it("never runs two jobs of one run", async () => {
    const { db, reset } = await load();
    await reset();
    const t = await task(db, "alice", ["pdf"]);
    await db.enqueueJob(t.runId, "task_execute");
    const got = await claimAll(db);
    assert.equal(got.filter((j) => j.run_id === t.runId).length, 1);
  });
}
