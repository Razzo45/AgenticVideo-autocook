/**
 * Direct AI-baseline: sky-change VFX plate (Sony FX3, 210 frames @ 24fps).
 * Usage: npx tsx scripts/start-vfx-sky-change-run.ts
 */
import fs from "node:fs";
import path from "node:path";

const TASK = path.resolve("C:/Wirestock/250Video/task-vfx-sky-change");
const INPUTS = path.join(TASK, "02 - Inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const brief = fs.readFileSync(path.join(TASK, "prompt.md"), "utf8").trim();

const script = `SECTION 1 — HOLD DAYTIME SKY (through 00:00:04:19 / frame 115).
Plate is 01_Raw_Footage.mov — original Sony FX3 Rec.709, no creative grade. Preserve exact edit, framing, performance, camera move, timing, grain, focus, and motion blur. Woman, rooftops, antennas, buildings, wardrobe, and skin remain untouched. Original blue daytime sky only. No sunset yet. No text, logos, particles, light rays, or extra effects. Audio files are timing context only — do not mix a soundtrack.

SECTION 2 — SKY CHANGE ON THE POINT (00:00:04:20 / frame 116).
As the woman raises her hand and points upward, snap the sky to the supplied 02_Replacement_Sky.jpg. Land the change on the pointing gesture — not a long dissolve. Reframe the portrait sky still into a convincing wide-sky behind her and the buildings. Keep the recognizable pink-orange cloud structure and a blue opening near the center of the sky. Clean matte around head, ponytail, glasses, raised hand and fingers, rooftops, antennas, and building edges. Follow the plate camera; stable; no halos, chatter, hard cutouts, or seams. Integration grade only — match exposure, contrast, white balance, saturation, edge color, and atmospheric perspective to Rec.709. Do not apply a full-shot cool-to-warm finish.

SECTION 3 — HOLD SUNSET SKY (frame 116 through final frame 209).
Hold the completed sunset-sky composite through the last frame. Same plate performance and camera. No further sky morph. No audio mix in the visual master.`;

const files = [
  path.join(INPUTS, "01_Raw_Footage.mov"),
  path.join(INPUTS, "01_Raw_Footage_frame000.jpg"),
  path.join(INPUTS, "01_Raw_Footage_frame115.jpg"),
  path.join(INPUTS, "02_Replacement_Sky.jpg"),
  path.join(INPUTS, "Ambience_SFX.wav"),
  path.join(INPUTS, "Sky_Transformation_Whoosh.wav"),
  path.join(INPUTS, "Commercial_Soundtrack.wav"),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "direct");
  form.set("prompt", brief);
  form.set("operatorScript", script);
  form.set("category", "Short Drama / Film & TV");
  form.set("aspect", "16:9");
  form.set("duration", "8"); // plate is 8.75s / 210f @ 24fps — one Veo max-length take
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "vfx-sky-change-sunset-point");

  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([buf]), path.basename(abs));
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(2)} MB)`);
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
