import fs from "node:fs";
import { spawnSync } from "node:child_process";

const pulled = spawnSync(
  "npx",
  ["--yes", "@railway/cli@latest", "logs", "--service", "worker", "--lines", "2000"],
  { encoding: "utf8", shell: true, maxBuffer: 20 * 1024 * 1024 },
);
const text = `${pulled.stdout || ""}\n${pulled.stderr || ""}`;
fs.writeFileSync("tmp/worker-peak-raw.log", text);

const jobs = new Map();
const errors = [];
for (const line of text.split(/\r?\n/)) {
  let m = line.match(/\[worker\] (\S+) run=(run_\S+) id=([0-9a-f-]{36}) lane=(\d+) heavy=(\d)/);
  if (m) {
    jobs.set(m[3], {
      type: m[1],
      runId: m[2],
      lane: +m[4],
      heavy: +m[5],
      status: "running",
    });
    continue;
  }
  m = line.match(/\[worker\] done (\S+) ([0-9a-f-]{36})/);
  if (m) {
    const j = jobs.get(m[2]) || { type: m[1], runId: "?" };
    j.status = "done";
    j.type = m[1];
    jobs.set(m[2], j);
    continue;
  }
  m = line.match(/\[worker\] failed (\S+) ([0-9a-f-]{36})/);
  if (m) {
    const j = jobs.get(m[2]) || { type: m[1], runId: "?" };
    j.status = "failed";
    j.type = m[1];
    j.error = line.includes("ZodError")
      ? "ZodError (plan schema)"
      : line.includes("429")
        ? "429"
        : "error";
    jobs.set(m[2], j);
    errors.push(line.slice(0, 240));
    continue;
  }
}

const all = [...jobs.values()];
const byType = {};
for (const j of all) {
  byType[j.type] ??= { claimed: 0, done: 0, failed: 0, running: 0 };
  byType[j.type].claimed++;
  byType[j.type][j.status] = (byType[j.type][j.status] || 0) + 1;
}
const byStatus = all.reduce((a, j) => {
  a[j.status] = (a[j.status] || 0) + 1;
  return a;
}, {});

const summary = {
  pulledAt: new Date().toISOString(),
  logBytes: text.length,
  totalJobsSeen: all.length,
  byStatus,
  byType,
  failedRuns: all.filter((j) => j.status === "failed"),
  doneRuns: all.filter((j) => j.status === "done").map((j) => ({ type: j.type, runId: j.runId })),
  sampleErrors: [...new Set(errors)].slice(0, 8),
};
fs.writeFileSync("tmp/peak-parse-summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
