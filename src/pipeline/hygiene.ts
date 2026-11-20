/**
 * Run hygiene for Railway / shared hosts.
 *
 * Storage model (s3 mode): bucket is canonical; local RUNS_DIR is scratch only.
 *
 * - When a cook finishes: drop staging (shots/inputs/plates/compose_media) from local + bucket.
 *   Keep final.*, the task out/ folder, deliverables.json, and small plan/result JSON for download.
 * - Last interaction older than RUN_TTL_MS (24h): delete the media.
 *   The run row stays, and so does the audit JSON (the plan, the composition, the saved
 *   replies, deliverables.json, and the other small plan/result JSON).
 * - Worker also clears local cache after each job once artifacts are committed to S3.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getRun,
  listRuns,
  releaseStuckTaskPlanJobs,
  runHasBusyJobs,
  updateRun,
  type RunRow,
} from "../db";
import { RUNS_DIR, runDir } from "./paths";
import { isKeptTaskMetaFile } from "./taskJobs";
import { deleteRunObjectsExcept, ensureAbsRunFile, persistRunFile, storageMode } from "./storage";
import { reapGeminiFiles } from "./geminiStaging";

/** How often the worker runs the sweep. It runs beside the claim loop, never inside it. */
export const HYGIENE_INTERVAL_MS = Number(process.env.HYGIENE_INTERVAL_MS) || 5 * 60_000;
/** After finish, staging may linger this long if sanitize wasn't called inline. */
export const STAGING_IDLE_MS = Number(process.env.STAGING_IDLE_MS) || 5 * 60 * 60_000;
/** Media expires after this since last interaction. The run row and the audit JSON stay. */
export const RUN_TTL_MS = Number(process.env.RUN_TTL_MS) || 24 * 60 * 60_000;
/** Generating/queued with no job for this long → mark failed (worker lost mid-tool). */
export const ORPHAN_GENERATING_MS = Number(process.env.ORPHAN_GENERATING_MS) || 10 * 60_000;

const STAGING_NAMES = new Set([
  "inputs",
  "site",
  "assets",
  "pptx_media",
  "compose_media",
  "argon_media",
  "audio",
  "omni_upload",
  ".omni_upload",
]);

function lastTouchMs(run: RunRow): number {
  const t = Date.parse(run.updated_at || run.created_at);
  return Number.isFinite(t) ? t : 0;
}

function isFinished(run: RunRow): boolean {
  return run.status === "exported" || run.status === "failed" || run.status === "rejected";
}

function shouldKeepName(name: string): boolean {
  return isRunMediaName(name) || isAuditName(name);
}

/** Downloaded output. The 24h reap removes these. */
function isRunMediaName(name: string): boolean {
  return /^final(\.|$)/i.test(name) || name === "out";
}

/**
 * Small JSON kept after the reap: what was planned, what the model returned, and what was delivered.
 * task_slices holds one saved reply per file. audit_retained.json marks a run whose media is already gone.
 */
const AUDIT_RETAINED = "audit_retained.json";

export function isAuditName(name: string): boolean {
  return (
    name === AUDIT_RETAINED ||
    name === "deliverables.json" ||
    isKeptTaskMetaFile(name) ||
    name === "cook_result.json" ||
    name === "stitch_report.json" ||
    name === "html_plan.json" ||
    name === "pptx_plan.json" ||
    name === "image_plan.json" ||
    name === "plan.json" ||
    name === "audio_plan.json" ||
    name === "audio_mix_report.json" ||
    name === "preflight.json"
  );
}

/** Keep finals / small metadata; drop everything else under the run dir (local). */
export function purgeRunStaging(runId: string, opts?: { keepInputs?: boolean }): { removed: string[] } {
  const dir = runDir(runId);
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return { removed };
  for (const name of fs.readdirSync(dir)) {
    if (shouldKeepName(name)) continue;
    if (opts?.keepInputs && name === "inputs") continue;
    const abs = path.join(dir, name);
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* busy file */
    }
  }
  for (const name of STAGING_NAMES) {
    if (opts?.keepInputs && name === "inputs") continue;
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) {
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        if (!removed.includes(name)) removed.push(name);
      } catch {
        /* ignore */
      }
    }
  }
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (/^shot_\d+$/i.test(name)) {
        try {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          removed.push(name);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { removed };
}

/**
 * After a cook finishes: drop staging from local + bucket, keep finals and task outputs in the bucket.
 * Call this as soon as status hits exported/failed/rejected (don't wait for the 5h idle sweep).
 */
export async function sanitizeFinishedRun(runId: string): Promise<{ removed: string[] }> {
  const run = await getRun(runId);
  const keepInputs = run?.status === "failed" || run?.status === "rejected";
  const { removed } = purgeRunStaging(runId, { keepInputs });
  if (storageMode() === "s3") {
    // Same rule as the local purge, in one listing of the run.
    const purged = await deleteRunObjectsExcept(
      runId,
      (name) => shouldKeepName(name) || (keepInputs && name === "inputs"),
    );
    if (purged && !removed.length) removed.push("(bucket)");
  }
  sanitized.set(runId, run?.status ?? "");
  return { removed };
}

/**
 * Runs this process already sanitized, with the status they had then.
 * The sweep used to re-sanitize every finished run on every pass.
 * A run that fails, is retried, and finishes again is sanitized again.
 */
const sanitized = new Map<string, string>();

export function alreadySanitized(run: Pick<RunRow, "id" | "status">): boolean {
  return sanitized.get(run.id) === run.status;
}

/** Drop everything under a run except the audit JSON. Local, and the bucket when that is the store. */
export function purgeRunExceptAudit(runId: string): { removed: string[] } {
  const dir = runDir(runId);
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return { removed };
  for (const name of fs.readdirSync(dir)) {
    if (isAuditName(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* busy file */
    }
  }
  return { removed };
}

export async function deleteEntireRun(runId: string): Promise<void> {
  purgeRunExceptAudit(runId);
  if (storageMode() === "s3") {
    await deleteRunObjectsExcept(runId, isAuditName);
  }
}

function auditMarkerPath(runId: string): string {
  return path.join(runDir(runId), AUDIT_RETAINED);
}

/** The media for this run was already dropped. The row and the JSON are still there. */
async function auditAlreadyKept(runId: string): Promise<boolean> {
  const marker = auditMarkerPath(runId);
  if (fs.existsSync(marker)) return true;
  try {
    await ensureAbsRunFile(marker);
  } catch {
    return false;
  }
  return fs.existsSync(marker);
}

async function markAuditKept(runId: string): Promise<void> {
  const marker = auditMarkerPath(runId);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({ retained_at: new Date().toISOString() }));
  }
  await persistRunFile(marker);
}

/**
 * Sweep finished / expired runs. Safe to call from the worker every few minutes.
 */
export async function failOrphanGeneratingRuns(now = Date.now()): Promise<number> {
  let failed = 0;
  let runs: RunRow[] = [];
  try {
    runs = await listRuns();
  } catch {
    return 0;
  }
  for (const run of runs) {
    if (run.status !== "generating" && run.status !== "queued") continue;
    const age = now - lastTouchMs(run);
    if (age < ORPHAN_GENERATING_MS) continue;
    if (await runHasBusyJobs(run.id)) continue;
    await updateRun(run.id, {
      status: "failed",
      gate: null,
      error:
        "Stopped: cook was generating with no worker job (often a hung fit_image/ffmpeg). Retry the cook.",
    });
    failed += 1;
  }
  return failed;
}

export async function runHygieneSweep(): Promise<{
  stagingPurged: number;
  runsDeleted: number;
  geminiCulled: number;
  orphansFailed?: number;
}> {
  let stagingPurged = 0;
  let runsDeleted = 0;
  const now = Date.now();
  let stuckPlansReleased = 0;
  try {
    stuckPlansReleased = await releaseStuckTaskPlanJobs();
    if (stuckPlansReleased > 0) {
      console.warn(`[hygiene] released ${stuckPlansReleased} stuck task_plan job(s)`);
    }
  } catch (err) {
    console.warn("[hygiene] releaseStuckTaskPlanJobs failed", err);
  }
  const orphansFailed = await failOrphanGeneratingRuns(now);

  let runs: RunRow[] = [];
  try {
    runs = await listRuns();
  } catch {
    runs = [];
  }

  for (const run of runs) {
    const touch = lastTouchMs(run);
    const age = now - touch;
    if (age >= RUN_TTL_MS) {
      if (await runHasBusyJobs(run.id)) continue;
      if (await auditAlreadyKept(run.id)) continue;
      try {
        await deleteEntireRun(run.id);
        await markAuditKept(run.id);
      } catch (err) {
        // Leave the row. The next sweep retries the media delete.
        console.warn(`[hygiene] reap ${run.id} failed`, err instanceof Error ? err.message : err);
        continue;
      }
      sanitized.delete(run.id);
      continue;
    }
    // Finished cooks: drop staging from local + bucket; keep finals only.
    if (isFinished(run) && !alreadySanitized(run)) {
      try {
        const { removed } = await sanitizeFinishedRun(run.id);
        if (removed.length) stagingPurged += 1;
      } catch (err) {
        console.warn(`[hygiene] sanitize ${run.id} failed`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Orphan local scratch dirs (bucket may still hold objects until TTL)
  if (fs.existsSync(RUNS_DIR)) {
    for (const name of fs.readdirSync(RUNS_DIR)) {
      if (!name.startsWith("run_")) continue;
      const abs = path.join(RUNS_DIR, name);
      if (!fs.statSync(abs).isDirectory()) continue;
      const st = fs.statSync(abs);
      if (now - st.mtimeMs >= RUN_TTL_MS) {
        purgeRunExceptAudit(name);
        const left = fs.existsSync(abs) ? fs.readdirSync(abs) : [];
        if (!left.some((entry) => isAuditName(entry))) {
          fs.rmSync(abs, { recursive: true, force: true });
          runsDeleted += 1;
        }
      }
    }
  }

  const { culled } = await reapGeminiFiles();
  return { stagingPurged, runsDeleted, geminiCulled: culled, orphansFailed };
}
