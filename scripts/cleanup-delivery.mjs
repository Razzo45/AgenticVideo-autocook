import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ds = path.join(root, "dataset", "agentic_poc");
const run = path.join(root, "runs", "run_3716eae0");
const SESSION = "sess_anime_3716eae0";

function rel(...parts) {
  return path.join(ds, ...parts);
}

function copyFile(src, destRel) {
  if (!fs.existsSync(src)) throw new Error(`missing source ${src}`);
  const dest = rel(destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return destRel.split(path.sep).join("/");
}

for (const dir of [
  ["image", "agent_generated"],
  ["image", "user_generated"],
  ["image", "edited"],
  ["video", "agent_generated"],
  ["video", "user_generated"],
  ["video", "edited"],
  ["audio", "generated"],
  ["reference", "input_images"],
  ["reference", "masks"],
  ["meta", "scripts"],
]) {
  fs.mkdirSync(rel(...dir), { recursive: true });
}

for (let i = 0; i < 6; i++) {
  copyFile(
    rel("image", "agent_generated", `${SESSION}_shot${i}_kf.png`),
    path.join("reference", "input_images", `${SESSION}_shot${i}_kf.png`),
  );
}

for (let i = 0; i < 5; i++) {
  const src = path.join(run, `shot_${i + 1}`, "ref_prev_tail.png");
  copyFile(src, path.join("reference", "input_images", `${SESSION}_shot${i}_tail.png`));
}

const finalSrc = rel("video", "agent_generated", `${SESSION}_final.mp4`);
const finalDestRel = path.join("video", "edited", `${SESSION}_final.mp4`);
if (fs.existsSync(finalSrc)) {
  copyFile(finalSrc, finalDestRel);
  fs.unlinkSync(finalSrc);
} else if (!fs.existsSync(rel("video", "edited", `${SESSION}_final.mp4`))) {
  throw new Error("final mp4 missing");
}

const schemaSrc = path.join(root, "config", "aigc-meta.schema.json");
fs.copyFileSync(schemaSrc, rel("meta", "aigc-meta.schema.json"));

const prettyPath = rel("meta", `${SESSION}.json`);
const pretty = JSON.parse(fs.readFileSync(prettyPath, "utf8"));
pretty.$schema = "./aigc-meta.schema.json";
pretty.dataset_name = "agentic_poc";
pretty.session_id = SESSION;
fs.writeFileSync(prettyPath, JSON.stringify(pretty, null, 2) + "\n", "utf8");

const missing = [];
for (const rec of pretty.records) {
  for (const p of [rec.media_path, rec.audio_path, rec.origin_media_path, rec.mask_path, ...(rec.reference_images || [])]) {
    if (!p) continue;
    if (!fs.existsSync(rel(...p.split("/")))) missing.push(`${rec.uniq_id}: ${p}`);
  }
}
if (missing.length) {
  console.error(missing.join("\n"));
  process.exit(1);
}

const jsonl = pretty.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
fs.writeFileSync(rel("meta", "meta.jsonl"), jsonl, "utf8");

fs.writeFileSync(
  rel("dataset_info.json"),
  JSON.stringify(
    {
      dataset_name: "agentic_poc",
      source_platform: "Internal Pipeline",
      generated_at: new Date().toISOString(),
      meta_records: pretty.records.length,
      last_session: SESSION,
      delivery_json: `meta/${SESSION}.json`,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`cleaned ${pretty.records.length} records`);
console.log(`final -> video/edited/${SESSION}_final.mp4`);
console.log(`refs  -> reference/input_images/ (${6} keyframes + ${5} tails)`);
