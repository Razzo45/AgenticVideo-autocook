/**
 * Watch peak load progress from Railway worker logs (when /api/runs is broken).
 * Parses claim / done / failed / heartbeat lines and prints a rolling summary.
 *
 *   node scripts/watch-peak-from-logs.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const started = Date.now();
const jobs = new Map(); // jobId -> { runId, type, lane, heavy, t0, status, error?, tDone? }
const byType = {};
let heartbeats = 0;
let lastSlots = "";

function bump(type, field) {
  byType[type] ??= { claimed: 0, done: 0, failed: 0 };
  byType[type][field]++;
}

function summarize() {
  const elapsed = Math.round((Date.now() - started) / 1000);
  const all = [...jobs.values()];
  const done = all.filter((j) => j.status === "done");
  const failed = all.filter((j) => j.status === "failed");
  const running = all.filter((j) => j.status === "running");
  const durations = done
    .map((j) => (j.tDone && j.t0 ? (j.tDone - j.t0) / 1000 : null))
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.floor(durations.length * 0.5)] : null;
  const p90 = durations.length ? durations[Math.floor(durations.length * 0.9)] : null;
  const max = durations.length ? durations[durations.length - 1] : null;
  console.log(
    JSON.stringify({
      t: elapsed,
      claimed: all.length,
      running: running.length,
      done: done.length,
      failed: failed.length,
      slots: lastSlots,
      durationSec: { p50, p90, max, n: durations.length },
      byType,
      recentFails: failed.slice(-3).map((j) => ({
        type: j.type,
        runId: j.runId,
        err: (j.error || "").slice(0, 120),
      })),
    }),
  );
}

const child = spawn(
  "npx",
  ["--yes", "@railway/cli@latest", "logs", "--service", "worker"],
  { shell: true, stdio: ["ignore", "pipe", "pipe"] },
);

let buf = "";
function onChunk(chunk) {
  buf += chunk.toString();
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || "";
  for (const line of lines) handle(line);
}

function handle(line) {
  const claim = line.match(
    /\[worker\] (\S+) run=(run_\S+) id=([0-9a-f-]{36}) lane=(\d+) heavy=(\d) slots=(\d+\/\d+)/,
  );
  if (claim) {
    const [, type, runId, id, lane, heavy, slots] = claim;
    lastSlots = slots;
    jobs.set(id, {
      runId,
      type,
      lane: Number(lane),
      heavy: Number(heavy),
      t0: Date.now(),
      status: "running",
    });
    bump(type, "claimed");
    return;
  }
  const done = line.match(/\[worker\] done (\S+) ([0-9a-f-]{36})/);
  if (done) {
    const [, type, id] = done;
    const j = jobs.get(id) || { type, t0: Date.now(), runId: "?" };
    j.status = "done";
    j.tDone = Date.now();
    j.type = type;
    jobs.set(id, j);
    bump(type, "done");
    summarize();
    return;
  }
  const fail = line.match(/\[worker\] failed (\S+) ([0-9a-f-]{36}) (.+)/);
  if (fail) {
    const [, type, id, err] = fail;
    const j = jobs.get(id) || { type, t0: Date.now(), runId: "?" };
    j.status = "failed";
    j.tDone = Date.now();
    j.type = type;
    j.error = err;
    jobs.set(id, j);
    bump(type, "failed");
    summarize();
    return;
  }
  if (line.includes("[worker] heartbeat")) {
    heartbeats++;
    const m = line.match(/slots=(\d+\/\d+)/);
    if (m) lastSlots = m[1];
    if (heartbeats % 1 === 0) summarize();
  }
}

child.stdout.on("data", onChunk);
child.stderr.on("data", onChunk);

const dumpPath = "tmp/peak-watch-summary.json";
setInterval(() => {
  const all = [...jobs.entries()].map(([id, j]) => ({
    id,
    ...j,
    durationSec: j.tDone && j.t0 ? Math.round((j.tDone - j.t0) / 1000) : null,
  }));
  fs.writeFileSync(
    dumpPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), elapsedSec: Math.round((Date.now() - started) / 1000), jobs: all, byType }, null, 2),
  );
}, 15_000);

console.log("[watch] streaming worker logs… summary →", dumpPath);
process.on("SIGINT", () => {
  summarize();
  child.kill();
  process.exit(0);
});
