/**
 * Isolate which Omni prompt text Google policy-blocks.
 * Usage: npx tsx scripts/probe-omni-policy.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getRun } from "../src/db";
import { generateOmniVideo, OMNI_PIPELINE_SLUG } from "../src/pipeline/geminiOmni";

function loadEnv() {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    if (!process.env[k]) process.env[k] = m[2].trim();
  }
}

async function tryOnce(label: string, prompt: string, withVideo: boolean) {
  const out = path.join("runs", "omni_probe", `${label}.mp4`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = getRun("run_04c53bd2");
  const vids = withVideo
    ? (JSON.parse(r?.input_assets_json ?? "[]") as Array<{ kind: string; path: string }>)
        .filter((a) => a.kind === "video" && fs.existsSync(a.path))
        .map((a) => a.path)
        .slice(0, 1)
    : [];
  console.log(`\n=== ${label} (video=${vids.length}) len=${prompt.length} ===`);
  try {
    await generateOmniVideo({
      prompt,
      aspectRatio: "16:9",
      duration: 4,
      referenceVideoPaths: vids.length ? vids : undefined,
      outPath: out,
      resolution: "720p",
      onStatus: (m) => console.log(" ", m),
    });
    console.log("OK", out, fs.statSync(out).size);
  } catch (err) {
    console.log("FAIL", err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240));
  }
}

async function main() {
  loadEnv();
  const r = getRun("run_04c53bd2");
  if (!r?.script_json) throw new Error("no script");
  const shot = JSON.parse(r.script_json).shots[0];
  const motion = String(shot.motion_prompt ?? "");

  await tryOnce("A_harmless", "A calm corporate office desk with a laptop screen showing a simple website. Soft ambient light.", false);
  await tryOnce("B_motion_only", motion, false);
  await tryOnce(
    "C_bodies_line",
    `${motion}\n\nWhen people appear on screen, their faces, ages, hair, and bodies must match the attached reference footage plates — do not invent lookalikes or substitute different people.`,
    false,
  );
  await tryOnce(
    "D_suffix_ui",
    `${motion}\n\nCRITICAL: Never render filenames, file extensions, folder paths, or asset labels as on-screen text.\nNo UI chrome, watermarks, or metadata overlays unless the brief explicitly requires designed titles.`,
    false,
  );
  await tryOnce("E_motion_plus_video", motion, true);
  console.log("\ndone", OMNI_PIPELINE_SLUG);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
