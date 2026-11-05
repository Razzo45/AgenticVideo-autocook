/**
 * Same as start-raw-auto-run.ts but calls createRun in-process — for input sets too large for
 * the web server's multipart parser (multi-GB ProRes plates).
 *
 * Usage: npx tsx scripts/start-raw-auto-run-local.ts <taskDir> <sessionLabel> <durationSec> [4K|1080p] [aspect=16:9]
 * Env: AUTO_VIDEO_MODEL, AUTO_CATEGORY (same as the HTTP launcher).
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";
import { createRun } from "../src/pipeline/orchestrator";
import type { Category } from "../src/pipeline/constants";

const [taskDir, sessionLabel, duration, resolution = "4K", aspect = "16:9"] = process.argv.slice(2);
if (!taskDir || !sessionLabel || !duration) {
  throw new Error("usage: start-raw-auto-run-local.ts <taskDir> <sessionLabel> <durationSec> [4K|1080p] [aspect=16:9]");
}
if (!["16:9", "9:16", "1:1", "2.35:1"].includes(aspect)) {
  throw new Error(`unsupported aspect: ${aspect}`);
}
const root = path.resolve(taskDir);
const prompt = fs.readFileSync(path.join(root, "raw-prompt.txt"), "utf8").trim();
const rawDir = path.join(root, "raw");
// Path-based attach: do NOT read multi-GB plates into Node heap (OOM / silent worker death).
const inputFiles = fs.readdirSync(rawDir).map((f) => {
  const sourcePath = path.join(rawDir, f);
  const mb = fs.statSync(sourcePath).size / 1e6;
  console.log(`[attach] ${f} (${mb.toFixed(2)} MB via path)`);
  return { originalName: f, sourcePath };
});
const autoOptions: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, deliver4k: resolution === "4K", timedGraphics: true };

const run = createRun({
  prompt,
  category: (process.env.AUTO_CATEGORY?.trim() || "E-commerce & Advertising") as Category,
  duration: Number(duration),
  aspect: aspect as "16:9" | "9:16" | "1:1" | "2.35:1",
  videoModel: process.env.AUTO_VIDEO_MODEL?.trim() || "google/veo-3.1-fast",
  sessionLabel,
  pipelineMode: "auto",
  outputResolution: resolution === "4K" ? "4K" : "1080p",
  autoOptions,
  inputFiles,
} as Parameters<typeof createRun>[0]);
console.log(`[ok] session=${run.session_id} id=${run.id}`);
