import { claimNextJob, reclaimRunningJobs } from "./db";
import { advanceStuckAutoRuns, processJob } from "./pipeline/orchestrator";
import { loadModelsConfig } from "./pipeline/config";
import { RUNS_DIR } from "./pipeline/paths";
import { runHygieneSweep } from "./pipeline/hygiene";
import { ensureRailwaySchema } from "./pipeline/ensureSchema";
import { logStorageBoot } from "./pipeline/storage";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const LOCK_PATH = path.join(RUNS_DIR, "worker.lock");
let lockFd: number | null = null;

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One worker process only — overlapping workers corrupt the job queue and look like "crashes". */
function acquireWorkerLock(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lockFd = fs.openSync(LOCK_PATH, "wx");
      fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`);
      return;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
      if (code !== "EEXIST") throw err;
      let stalePid = 0;
      try {
        stalePid = Number(fs.readFileSync(LOCK_PATH, "utf8").split(/\r?\n/)[0]);
      } catch {
        stalePid = 0;
      }
      if (stalePid && pidAlive(stalePid)) {
        console.error(
          `[worker] another worker is already running (pid ${stalePid}). Refusing to start a second instance.`,
        );
        process.exit(2);
      }
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        /* race — retry */
      }
    }
  }
  console.error("[worker] could not acquire worker.lock");
  process.exit(2);
}

function releaseWorkerLock(): void {
  if (lockFd != null) {
    try {
      fs.closeSync(lockFd);
    } catch {
      /* ignore */
    }
    lockFd = null;
  }
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const owner = Number(fs.readFileSync(LOCK_PATH, "utf8").split(/\r?\n/)[0]);
      if (!owner || owner === process.pid) fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    /* ignore */
  }
}

acquireWorkerLock();

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  console.error("[worker] ffmpeg/ffprobe not found on PATH");
}

// Don't tear down mid-clip for a stray rejection — log and keep cooking.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection (continuing)", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException — exiting so jobs can reclaim on restart", err);
  releaseWorkerLock();
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`[worker] ${signal} — releasing lock (interrupted jobs reclaim on next start)`);
  releaseWorkerLock();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => releaseWorkerLock());

async function loop() {
  await ensureRailwaySchema();
  await logStorageBoot("worker");
  const reclaimed = await reclaimRunningJobs();
  if (reclaimed) console.log(`[worker] requeued ${reclaimed} interrupted job(s)`);
  console.log("[worker] watching jobs (sqlite or postgres)");
  const inFlight = new Set<Promise<void>>();
  let lastBeat = Date.now();
  let lastAutoTick = 0;
  let lastHygiene = 0;

  for (;;) {
    if (Date.now() - lastAutoTick > 5_000) {
      lastAutoTick = Date.now();
      try {
        const n = await advanceStuckAutoRuns();
        if (n) console.log(`[worker] advanced ${n} stuck auto gate(s)`);
      } catch (err) {
        console.error("[worker] advanceStuckAutoRuns failed", err);
      }
    }
    if (Date.now() - lastHygiene > 60_000) {
      lastHygiene = Date.now();
      try {
        const h = await runHygieneSweep();
        if (h.stagingPurged || h.runsDeleted || h.geminiCulled) {
          console.log(
            `[worker] hygiene staging=${h.stagingPurged} deleted=${h.runsDeleted} gemini=${h.geminiCulled}`,
          );
        }
      } catch (err) {
        console.error("[worker] hygiene failed", err);
      }
    }
    const max = loadModelsConfig().maxParallelRuns;
    while (inFlight.size < max) {
      let job;
      try {
        job = await claimNextJob();
      } catch (err) {
        // SQLITE_BUSY / lock storms must not kill the whole worker mid-cook.
        console.error("[worker] claimNextJob failed — backing off", err);
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
      if (!job) break;
      console.log(
        `[worker] ${job.type} run=${job.run_id} id=${job.id} lane=${job.weight ?? "?"} heavy=${job.heavy ? 1 : 0} slots=${inFlight.size + 1}/${max}`,
      );
      let work!: Promise<void>;
      work = (async () => {
        try {
          await processJob(job);
          console.log(`[worker] done ${job.type} ${job.id}`);
        } catch (err) {
          console.error(`[worker] failed ${job.type} ${job.id}`, err);
        }
      })().finally(() => {
        inFlight.delete(work);
      });
      inFlight.add(work);
    }
    if (Date.now() - lastBeat > 60_000) {
      lastBeat = Date.now();
      const mem = process.memoryUsage();
      console.log(
        `[worker] heartbeat slots=${inFlight.size}/${max} rss=${Math.round(mem.rss / 1e6)}MB heap=${Math.round(mem.heapUsed / 1e6)}MB`,
      );
    }
    if (inFlight.size === 0) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    await Promise.race([...inFlight, new Promise((r) => setTimeout(r, 1500))]);
  }
}

loop().catch((err) => {
  console.error(err);
  releaseWorkerLock();
  process.exit(1);
});
