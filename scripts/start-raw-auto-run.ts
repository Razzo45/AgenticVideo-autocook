/**
 * Auto cook from ONLY the operator's prompt and their original files — no production notes,
 * no renames, no pre-extracted text. The pipeline does its own reading of the inputs.
 *
 * Usage: npx tsx scripts/start-raw-auto-run.ts <taskDir> <sessionLabel> <durationSec> [4K|1080p]
 *   <taskDir>/raw-prompt.txt  operator prompt, verbatim
 *   <taskDir>/raw/            operator files, original names
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const BASE = process.env.AGENTIC_BASE_URL ?? "http://localhost:3000";

async function main() {
  const [taskDir, sessionLabel, duration, resolution = "4K"] = process.argv.slice(2);
  if (!taskDir || !sessionLabel || !duration) {
    throw new Error("usage: start-raw-auto-run.ts <taskDir> <sessionLabel> <durationSec> [4K|1080p]");
  }
  const root = path.resolve(taskDir);
  const prompt = fs.readFileSync(path.join(root, "raw-prompt.txt"), "utf8").trim();
  const rawDir = path.join(root, "raw");
  const files = fs.readdirSync(rawDir).map((f) => path.join(rawDir, f));

  const autoOptions: AutoOptions = {
    ...DEFAULT_AUTO_OPTIONS,
    deliver4k: resolution === "4K",
    timedGraphics: true,
  };

  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", process.env.AUTO_CATEGORY?.trim() || "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", duration);
  form.set("outputResolution", resolution);
  form.set("videoModel", process.env.AUTO_VIDEO_MODEL?.trim() || "google/veo-3.1-fast");
  form.set("sessionLabel", sessionLabel);
  form.set("autoOptions", JSON.stringify(autoOptions));
  for (const abs of files) {
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([new Uint8Array(buf)]), path.basename(abs));
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(2)} MB)`);
  }

  console.log(`[post] ${BASE}/api/runs … (${files.length} files, prompt ${prompt.length} chars, ${duration}s ${resolution})`);
  const res = await fetch(`${BASE}/api/runs`, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 800)}`);
  const json = JSON.parse(text) as { run?: { id: string; session_id: string } };
  console.log(`[ok] session=${json.run?.session_id} id=${json.run?.id}`);
  console.log(`[open] ${BASE}/runs/${json.run?.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
