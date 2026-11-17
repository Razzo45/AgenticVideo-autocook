import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipStatusLine, formatQueueLines, type QueueSnapshot } from "../../src/pipeline/queueStatus";

const now = Date.parse("2026-11-16T11:00:00.000Z");

describe("queue status lines", () => {
  it("strips storage addresses from the live line", () => {
    assert.equal(clipStatusLine("fetch https://files.example/a?sig=secret now"), "fetch [url] now");
  });

  it("prints counts and one line per active task", () => {
    const snapshot: QueueSnapshot = {
      at: "2026-11-16T11:00:00.000Z",
      jobs: { pending: 1, running: 1, done: 4 },
      runs: { queued: 1, generating: 1, exported: 3 },
      tasks: [
        {
          runId: "run_e5a063de",
          sessionId: "gdp:task",
          pipelineMode: "task",
          runStatus: "generating",
          jobType: "task_execute",
          jobStatus: "running",
          taskWeight: 30,
          updatedAt: "2026-11-16T10:40:00.000Z",
          line: "Carbon tool join_videos (tokyo_top_5_video-joined, 12 clips)…",
        },
        {
          runId: "run_orphan",
          sessionId: "",
          pipelineMode: "task",
          runStatus: "queued",
          jobType: null,
          jobStatus: null,
          taskWeight: null,
          updatedAt: "2026-11-16T10:59:00.000Z",
          line: "Queued for deliverables (1 video) — weight 30",
        },
      ],
    };
    const lines = formatQueueLines(snapshot, now);
    assert.equal(lines[0], "queue jobs pending=1 running=1 done=4 error=0");
    assert.match(lines[1], /queue runs queued=1 generating=1 exported=3 failed=0/);
    assert.equal(
      lines[2],
      "run_e5a063de task_execute running weight=30 idle=20m run=generating task Carbon tool join_videos (tokyo_top_5_video-joined, 12 clips)…",
    );
    assert.match(lines[3], /^run_orphan no-job idle=1m run=queued task /);
  });

  it("says when nothing is active", () => {
    const lines = formatQueueLines({ at: "", jobs: {}, runs: {}, tasks: [] }, now);
    assert.equal(lines.at(-1), "queue active none");
  });
});
