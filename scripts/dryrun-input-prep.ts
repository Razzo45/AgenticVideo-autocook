/**
 * Dry-run the perception pass (doc text + video timeline) on a task's raw input folder,
 * without creating a run. Prints what the storyboard writer would see.
 *
 * Usage: npx tsx scripts/dryrun-input-prep.ts <inputsDir>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunRow } from "../src/db";
import { loadModelsConfig } from "../src/pipeline/config";
import { findMusicBed, prepareRunInputs } from "../src/pipeline/inputPrep";
import { formatInputsForScript, saveRunInputs } from "../src/pipeline/inputs";

async function main() {
  const dir = path.resolve(process.argv[2] ?? "");
  const tmpRun = `dryrun_${crypto.randomUUID().slice(0, 8)}`;
  const files = fs.readdirSync(dir).map((f) => ({ originalName: f, data: fs.readFileSync(path.join(dir, f)) }));
  const assets = await saveRunInputs(tmpRun, files);
  const run = {
    id: tmpRun,
    script_model: loadModelsConfig().script,
    input_assets_json: JSON.stringify(assets),
  } as RunRow;
  const prepared = await prepareRunInputs(run, (m) => console.log(`[status] ${m}`));
  const music = await findMusicBed(prepared.input_assets_json);
  console.log(`[music bed] ${music?.filename ?? "none"}`);
  const out = path.join(os.tmpdir(), `${tmpRun}-storyboard-context.txt`);
  fs.writeFileSync(out, formatInputsForScript(prepared.input_assets_json), "utf8");
  console.log(`[context] ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
