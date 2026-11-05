/**
 * Run hygiene for Railway / shared hosts.
 *
 * Storage model (s3 mode): bucket is canonical; local RUNS_DIR is scratch only.
 *
 * - When a cook finishes: drop staging (shots/inputs/plates) from local + bucket;
 *   keep final.* + small plan/result JSON for download.
 * - Last interaction older than RUN_TTL_MS (24h): delete the entire run (bucket + local).
 * - Worker also clears local cache after each job once artifacts are committed to S3.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, listRuns, type RunRow } from "../db";
import { RUNS_DIR, runDir } from "./paths";
import { deleteRunPrefix, storageMode } from "./storage";
import { reapGeminiFiles } from "./geminiStaging";

/** After finish, staging may linger this long if sanitize wasn't called inline. */
export const STAGING_IDLE_MS = Number(process.env.STAGING_IDLE_MS) || 5 * 60 * 60_000;
/** Whole run (including download) expires after this since last interaction. */
export const RUN_TTL_MS = Number(process.env.RUN_TTL_MS) || 24 * 60 * 60_000;

const STAGING_NAMES = new Set([
  "inputs",
  "site",
  "assets",
  "pptx_media",
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
  return (
    /^final(\.|$)/i.test(name) ||
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
export function purgeRunStaging(runId: string): { removed: string[] } {
  const dir = runDir(runId);
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return { removed };
  for (const name of fs.readdirSync(dir)) {
    if (shouldKeepName(name)) continue;
    const abs = path.join(dir, name);
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* busy file */
    }
  }
  for (const name of STAGING_NAMES) {
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
 * After a cook finishes: drop staging from local + bucket, keep finals/metadata in bucket.
 * Call this as soon as status hits exported/failed/rejected (don't wait for the 5h idle sweep).
 */
export async function sanitizeFinishedRun(runId: string): Promise<{ removed: string[] }> {
  const { removed } = purgeRunStaging(runId);
  if (storageMode() === "s3") {
    const prefixes = new Set(removed);
    for (const name of STAGING_NAMES) prefixes.add(name);
    // Always try shot_* cleanup on bucket even if local was already empty.
    for (let i = 0; i < 32; i++) prefixes.add(`shot_${i}`);
    for (const name of prefixes) {
      await deleteRunPrefix(runId, name).catch(() => undefined);
    }
  }
  return { removed };
}

export async function deleteEntireRun(runId: string): Promise<void> {
  await deleteRunPrefix(runId);
  const dir = runDir(runId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sweep finished / expired runs. Safe to call from the worker every few minutes.
 */
export async function runHygieneSweep(): Promise<{
  stagingPurged: number;
  runsDeleted: number;
  geminiCulled: number;
}> {
  let stagingPurged = 0;
  let runsDeleted = 0;
  const now = Date.now();

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
      await deleteEntireRun(run.id);
      try {
        getDb().prepare(`DELETE FROM cook_requests WHERE run_id = ?`).run(run.id);
        getDb().prepare(`DELETE FROM jobs WHERE run_id = ?`).run(run.id);
        getDb().prepare(`DELETE FROM variants WHERE run_id = ?`).run(run.id);
        getDb().prepare(`DELETE FROM assets WHERE run_id = ?`).run(run.id);
        getDb().prepare(`DELETE FROM reviews WHERE run_id = ?`).run(run.id);
        getDb().prepare(`DELETE FROM runs WHERE id = ?`).run(run.id);
      } catch {
        /* ignore — Postgres path uses deleteRunRows elsewhere */
      }
      runsDeleted += 1;
      continue;
    }
    // Finished cooks: drop staging from local + bucket; keep finals only.
    if (isFinished(run)) {
      const { removed } = await sanitizeFinishedRun(run.id);
      if (removed.length) stagingPurged += 1;
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
        fs.rmSync(abs, { recursive: true, force: true });
        runsDeleted += 1;
      }
    }
  }

  const { culled } = await reapGeminiFiles();
  return { stagingPurged, runsDeleted, geminiCulled: culled };
}
