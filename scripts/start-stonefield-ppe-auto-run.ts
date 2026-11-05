/**
 * Auto cook: Stonefield Logistics — PPE Safety Training (~2:00–2:15, 4K).
 * Legacy AgenticVideo staged auto pipeline (not Astra).
 *
 * Usage: npx tsx scripts/start-stonefield-ppe-auto-run.ts
 * Requires web+worker on http://127.0.0.1:3000
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-stonefield-ppe-safety");
const INPUTS = path.join(ROOT, "inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const operatorPrompt = fs.readFileSync(path.join(PREP, "prompt.txt"), "utf8").trim();
const creativeBrief = fs.readFileSync(path.join(PREP, "creative-brief.txt"), "utf8").trim();
const avScript = fs.readFileSync(path.join(PREP, "av-script.txt"), "utf8").trim();

const autoOptions: AutoOptions = {
  ...DEFAULT_AUTO_OPTIONS,
  deliver4k: true,
  longCook: true,
  presenterIdentity: true,
  voiceGuidance: true,
  verbatimScript: true,
  brandLock: true,
  timedGraphics: true,
};

const prompt = `${operatorPrompt}

---
PRODUCTION NOTES FOR THIS AUTO RUN
- Target length just over 2 minutes (pipeline duration 130s). Cover the full AV script as short scenes in order, then stitch.
- Presenter: Marcus Reed — match Marcus_Headshot.jpg when on camera. Lower third: MARCUS REED / Training & Development Specialist.
- Voice: warm, clear, instructional; guided by Marcus_VO_sample.mp3 (tone/pace — not a guaranteed clone).
- Environment: Location.jpg is the warehouse / industrial plate reference for B-roll and presenter context.
- Music: Cinematic_Corporate_Music.wav as a gentle bed throughout, mixed under dialogue (never compete with VO). No distracting SFX.
- Brand: navy + safety-orange + white; use only attached Stonefield logos. Section cards: REQUIRED PPE, USING PPE CORRECTLY, DAMAGED OR MISSING PPE, PPE RESPONSIBILITIES.
- Opening: centered Stonefield logo (~0–3s). Close: centered Stonefield logo.
- This is an internal safety module, not a promotional ad.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
AV SCRIPT — VERBATIM SPOKEN + GRAPHICS / B-ROLL CUES (controlling sequence)
${avScript}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "av-script.txt"),
  path.join(INPUTS, "Marcus_Headshot.jpg"),
  path.join(INPUTS, "Location.jpg"),
  path.join(INPUTS, "Stonefield_Logistics_Color_Logo.png"),
  path.join(INPUTS, "Stonefield_Logistics_White_Logo.png"),
  path.join(INPUTS, "Marcus_VO_sample.mp3"),
  path.join(INPUTS, "Cinematic_Corporate_Music.wav"),
  path.join(INPUTS, "Stonefield_Logistics_Creative_Brief.pdf"),
  path.join(INPUTS, "STONEFIELD_LOGISTICS_PPE_SAFETY_TRAINING_AV_SCRIPT.docx"),
  path.join(INPUTS, "Stonefield_Logistics_Brand_Guidelines.pptx"),
];

async function main() {
  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
  }

  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", "130");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "stonefield-ppe-safety-training");
  form.set("autoOptions", JSON.stringify(autoOptions));

  for (const abs of files) {
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([new Uint8Array(buf)]), path.basename(abs));
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(2)} MB)`);
  }

  console.log(`[toggles] ${JSON.stringify(autoOptions)}`);
  console.log(`[post] ${BASE}/api/runs … (${files.length} attachments, prompt ${prompt.length} chars)`);
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
