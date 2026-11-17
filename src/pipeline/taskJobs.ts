/**
 * Task-pipeline job types and run files.
 */
import fs from "node:fs";
import path from "node:path";
import { runDir } from "./paths";
import { ensureAbsRunFile } from "./storage";

export const TASK_PLAN_JOB = "task_plan";
export const TASK_EXECUTE_JOB = "task_execute";

export const TASK_PLAN_FILE = "task_plan.json";
export const TASK_COMPOSITION_FILE = "task_composition.json";

export function isTaskPlanJob(type: string | null | undefined): boolean {
  return String(type ?? "") === TASK_PLAN_JOB;
}

export function isTaskExecuteJob(type: string | null | undefined): boolean {
  return String(type ?? "") === TASK_EXECUTE_JOB;
}

/** SQLite / Postgres IN-list. */
export const TASK_PLAN_JOB_SQL = `'${TASK_PLAN_JOB}'`;
export const TASK_EXECUTE_JOB_SQL = `'${TASK_EXECUTE_JOB}'`;

export function isKeptTaskMetaFile(name: string): boolean {
  return name === TASK_PLAN_FILE || name === TASK_COMPOSITION_FILE;
}

export function taskPlanPath(dir: string): string {
  return path.join(dir, TASK_PLAN_FILE);
}

export function taskCompositionPath(dir: string): string {
  return path.join(dir, TASK_COMPOSITION_FILE);
}

export function taskPlanWritePath(dir: string): string {
  return taskPlanPath(dir);
}

export function taskCompositionWritePath(dir: string): string {
  return taskCompositionPath(dir);
}

async function ensureNamedRunFile(runId: string, rel: string): Promise<string | null> {
  const abs = path.join(runDir(runId), rel);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
  try {
    await ensureAbsRunFile(abs);
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
  } catch {
    /* not in the bucket yet */
  }
  return null;
}

/** Local file, or the same object under the live bucket. */
export async function ensureTaskPlanFile(runId: string): Promise<string | null> {
  return ensureNamedRunFile(runId, TASK_PLAN_FILE);
}

export async function ensureTaskCompositionFile(runId: string): Promise<string | null> {
  return ensureNamedRunFile(runId, TASK_COMPOSITION_FILE);
}
