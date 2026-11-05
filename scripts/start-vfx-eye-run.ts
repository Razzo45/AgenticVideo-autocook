/**
 * Kick off a Direct run for task-27-1014-vfx-eye (bathroom black-eye VFX).
 * Usage: npx tsx scripts/start-vfx-eye-run.ts
 */
import fs from "node:fs";
import path from "node:path";

const TASK = path.resolve("C:/Wirestock/250Video/task-27-1014-vfx-eye");
const INPUTS = path.join(TASK, "inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const brief = fs.readFileSync(path.join(TASK, "prompt.md"), "utf8").trim();

/** Timed beat sheet → Direct segments (before / flip / hold). */
const script = `SECTION 1 — PRE-TRANSFORM (hold natural eyes and complexion through 00:00:07:15 / frame 183).
Plate is 01_Bathroom_Shot_PreVFX.mov. Preserve framing, handheld, focus, motion blur, grain, bathroom, wardrobe, teal grade. Character looks normal. No black eyes yet. No gore, bite, veins, glow, smoke, or particles.

SECTION 2 — EYE FLIP (00:00:07:16–00:00:07:18 / frames 184–186).
As eyes open, both eyes turn fully black (iris, pupil, sclera). Use the glossy black-eye look from 03_Black_Eye_Stylistic_Reference.png only — do not copy dark veins or surrounding skin texture. Keep catchlights and reflections so eyes stay wet and 3D. Align with tracked element 02_Black_Eye_Graphic_Element_AlphaMatte.mov timing from first frame. Transparent until the change begins.

SECTION 3 — SKIN DRAIN + HOLD (from ~00:00:08:00 / frame 192 through end).
Gradually pull warmth and saturation from the face; noticeably paler/colder by frame 192, finished zombie look by 00:00:09:00 / frame 216, hold through final frame (~289 frames / ~12s total plate). Photoreal, grounded. No audio in the creative intent for the master (soundtrack files are context only).`;

const files = [
  "01_Bathroom_Shot_PreVFX.mov",
  "02_Black_Eye_Graphic_Element_AlphaMatte.mov",
  "03_Black_Eye_Stylistic_Reference.png",
  "04_Scene_Soundtrack.wav",
  "City Traffic Police Siren_Ambience SFX.wav",
  "Pulse_Sound Effect.wav",
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "direct");
  form.set("prompt", brief);
  form.set("operatorScript", script);
  form.set("category", "Short Drama / Film & TV");
  form.set("aspect", "16:9");
  form.set("duration", "16"); // ~2×8s Veo clips covering the ~12s plate
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "vfx-eye-bathroom-infection");

  for (const name of files) {
    const abs = path.join(INPUTS, name);
    if (!fs.existsSync(abs)) throw new Error(`Missing input: ${abs}`);
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([buf]), name);
    console.log(`[attach] ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }

  console.log(`[post] ${BASE}/api/runs …`);
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
