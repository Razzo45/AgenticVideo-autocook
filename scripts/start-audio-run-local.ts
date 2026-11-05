/**
 * Launch an audio-only cook from a task dir (raw/ + raw-prompt.txt).
 * Usage: npx tsx scripts/start-audio-run-local.ts <taskDir> <sessionLabel> <durationSec>
 */
import fs from "node:fs";
import path from "node:path";
import { createRun } from "../src/pipeline/orchestrator";
import type { Category } from "../src/pipeline/constants";

const [taskDir, sessionLabel, durationArg] = process.argv.slice(2);
if (!taskDir || !sessionLabel || !durationArg) {
  throw new Error("usage: start-audio-run-local.ts <taskDir> <sessionLabel> <durationSec>");
}
const root = path.resolve(taskDir);
const prompt = fs.readFileSync(path.join(root, "raw-prompt.txt"), "utf8").trim();
const rawDir = path.join(root, "raw");
const inputFiles = fs.readdirSync(rawDir).map((f) => {
  const sourcePath = path.join(rawDir, f);
  const mb = fs.statSync(sourcePath).size / 1e6;
  console.log(`[attach] ${f} (${mb.toFixed(2)} MB via path)`);
  return { originalName: f, sourcePath };
});

const run = createRun({
  prompt,
  category: (process.env.AUTO_CATEGORY?.trim() || "E-commerce & Advertising") as Category,
  duration: Number(durationArg),
  aspect: "16:9",
  pipelineMode: "audio",
  sessionLabel,
  scriptModel: process.env.AUTO_SCRIPT_MODEL?.trim() || undefined,
  inputFiles,
});
console.log(`[ok] session=${run.session_id} id=${run.id}`);
