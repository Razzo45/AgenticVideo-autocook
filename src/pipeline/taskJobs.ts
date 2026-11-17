/**
 * Task-pipeline job types and run files.
 * New writes use task_*; readers still accept the old argon_* names
 * so a live worker can drain jobs and S3 objects written before the rename.
 */
import fs from "node:fs";
import path from "node:path";
import { runDir } from "./paths";
import { ensureAbsRunFile } from "./storage";

export const TASK_PLAN_JOB = "task_plan";
export const TASK_EXECUTE_JOB = "task_execute";

export const TASK_PLAN_FILE = "task_plan.json";
export const TASK_COMPOSITION_FILE = "task_composition.json";

const LEGACY_PLAN_JOBS = new Set(["argon_plan"]);
const LEGACY_EXECUTE_JOBS = new Set(["argon_execute", "argon_task"]);
const LEGACY_PLAN_FILES = ["argon_plan.json"];
const LEGACY_COMPOSITION_FILES = ["argon_composition.json"];

export function isTaskPlanJob(type: string | null | undefined): boolean {
  const value = String(type ?? "");
  return value === TASK_PLAN_JOB || LEGACY_PLAN_JOBS.has(value);
}

export function isTaskExecuteJob(type: string | null | undefined): boolean {
  const value = String(type ?? "");
  return value === TASK_EXECUTE_JOB || LEGACY_EXECUTE_JOBS.has(value);
}

/** SQLite / Postgres IN-list, including names still sitting in the queue. */
export const TASK_PLAN_JOB_SQL = `'${TASK_PLAN_JOB}','argon_plan'`;
export const TASK_EXECUTE_JOB_SQL = `'${TASK_EXECUTE_JOB}','argon_execute','argon_task'`;

export function isKeptTaskMetaFile(name: string): boolean {
  return (
    name === TASK_PLAN_FILE ||
    name === TASK_COMPOSITION_FILE ||
    name === "argon_notes.txt" ||
    LEGACY_PLAN_FILES.includes(name) ||
    LEGACY_COMPOSITION_FILES.includes(name)
  );
}

function existingOrPreferred(dir: string, preferred: string, legacy: string[]): string {
  const next = path.join(dir, preferred);
  for (const name of [preferred, ...legacy]) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) return abs;
  }
  return next;
}

export function taskPlanPath(dir: string): string {
  return existingOrPreferred(dir, TASK_PLAN_FILE, LEGACY_PLAN_FILES);
}

export function taskCompositionPath(dir: string): string {
  return existingOrPreferred(dir, TASK_COMPOSITION_FILE, LEGACY_COMPOSITION_FILES);
}

export function taskPlanWritePath(dir: string): string {
  return path.join(dir, TASK_PLAN_FILE);
}

export function taskCompositionWritePath(dir: string): string {
  return path.join(dir, TASK_COMPOSITION_FILE);
}

async function ensureNamedRunFile(runId: string, names: string[]): Promise<string | null> {
  const dir = runDir(runId);
  for (const name of names) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    try {
      await ensureAbsRunFile(abs);
      if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    } catch {
      /* Live buckets may still hold argon_plan.json / argon_composition.json. */
    }
  }
  return null;
}

/** Local file, or the same object under the live bucket (new or pre-rename key). */
export async function ensureTaskPlanFile(runId: string): Promise<string | null> {
  return ensureNamedRunFile(runId, [TASK_PLAN_FILE, ...LEGACY_PLAN_FILES]);
}

export async function ensureTaskCompositionFile(runId: string): Promise<string | null> {
  return ensureNamedRunFile(runId, [TASK_COMPOSITION_FILE, ...LEGACY_COMPOSITION_FILES]);
}
