import path from "node:path";
import { DATASET_NAME } from "./constants";

export const ROOT = process.cwd();
/** Override with RUNS_DIR=/data/runs on Railway volume / bucket mirror. */
export const RUNS_DIR = process.env.RUNS_DIR?.trim()
  ? path.resolve(process.env.RUNS_DIR.trim())
  : path.join(ROOT, "runs");
export const DB_PATH = process.env.SQLITE_PATH?.trim()
  ? path.resolve(process.env.SQLITE_PATH.trim())
  : path.join(RUNS_DIR, "pipeline.db");
export const MODELS_CONFIG_PATH = path.join(ROOT, "config", "models.json");
export const DATASET_DIR = path.join(ROOT, "dataset", DATASET_NAME);

export function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function relativeToRoot(abs: string): string {
  return toPosix(path.relative(ROOT, abs));
}
