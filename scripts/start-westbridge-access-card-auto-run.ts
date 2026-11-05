/**
 * Auto cook: Westbridge Health — new employee access card rollout (~2:30, 4K).
 * Legacy AgenticVideo staged auto pipeline (not Astra).
 *
 * Usage: npx tsx scripts/start-westbridge-access-card-auto-run.ts
 * Requires web+worker on http://localhost:3000
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-westbridge-access-card");
const INPUTS = path.join(ROOT, "inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://localhost:3000";

const read = (name: string) => fs.readFileSync(path.join(PREP, name), "utf8").trim();
const operatorPrompt = read("prompt.txt");
const creativeBrief = read("creative-brief.txt");
const script = read("script.txt");
const brandGuidelines = read("brand-guidelines.txt");

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
- Target length ~2:30 (pipeline duration 150s — matches Corporate Music.mp3, 2:32). Follow the APPROVED SCRIPT order; Darren's spoken lines verbatim. No added access rules, procedures, permissions or escalation steps.
- Presenter: Darren — match Darren - Headshot.jpg (short dark swept-back hair, trimmed salt-and-pepper beard, cream/stone button-up shirt, dark jeans, brown belt, gold watch). Calm, professional, matter-of-fact, speaking directly to staff. Stable medium / medium-close framing, minimal camera movement.
- Voice: Darren_VO sample.wav sets tone and pace — calm, clear, confident.
- Presenter location: match Westbridge Location Reference.jpg — modern workplace breakout area, polished concrete floor, raw concrete wall, black-framed frosted glass partition, tan leather sofa, slatted light-timber bench, a tall leafy plant. Keep it clean: leave out wall-mounted electrical equipment, warning labels, branded devices, and anything visible behind the frosted glass. Soft natural light, natural skin tones.
- Access card: match Access Card Image.png — white rounded card holder with slot, card face white with a thin Westbridge Teal vertical stripe on the left, a soft blue-grey footer band, and a small square "W" mark. Printed lettering stays small and soft so no wording is prominent or legible.
- B-roll, only what the script and brief call for:
  - Close-up of the access card held up to camera.
  - Workplace locations: an emergency entrance, an empty meeting room, an office, a hospital corridor.
  - Close-up of a hand holding the card to a wall-mounted card reader; the reader indicator changes from red to green.
  - Hospital double doors closing securely behind an employee.
  - An employee scanning their own card at a reader, then two doctors walking down a hospital hallway.
  - Return to Darren for the card-issue section; optional supporting card detail.
  - Darren to camera for the recap, then Westbridge Health branding.
  Keep it practical and specific to the card — no generic hospital montage.
- Title cards, exactly as scripted (Calibri Bold, high-contrast, short and functional, no decorative animation):
  - Opening: Westbridge Health logo centred.
  - SECURE ACCESS AT WESTBRIDGE
  - USING YOUR ACCESS CARD
  - NEVER SHARE YOUR ACCESS CARD
  - CARD ISSUE? REPORT IT.
  - YOUR CARD. YOUR RESPONSIBILITY.
  - Closing: Westbridge Health logo centred.
- Brand: Westbridge Teal #1F434F, Clinical Grey #91969A, Soft Blue Grey #ECF4F4, White #FFFFFF. Calibri only. Blue-grey logo on light backgrounds, white logo on teal/dark. Never stretch, recolour or add effects. Generous white space, minimal graphics.
- Audio: Corporate Music.mp3 subtle beneath Darren throughout; clear stereo dialogue.
- Live-action takes must contain NO logos, text or graphics — branding lives only on title cards and the open/close logo frames.
- Internal staff communication, not a promotional video. Use only the supplied materials.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
BRAND GUIDELINES (reference)
${brandGuidelines}

---
APPROVED SCRIPT — VERBATIM DIALOGUE, TITLE CARDS, B-ROLL (controlling sequence)
${script}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "script.txt"),
  path.join(PREP, "brand-guidelines.txt"),
  path.join(INPUTS, "Darren - Headshot.jpg"),
  path.join(INPUTS, "Westbridge Location Reference.jpg"),
  path.join(INPUTS, "Access Card Image.png"),
  path.join(INPUTS, "Westbridge_logo_blue_grey.png"),
  path.join(INPUTS, "Westbridge_logo_white.png"),
  path.join(INPUTS, "Darren_VO sample.wav"),
  path.join(INPUTS, "Corporate Music.mp3"),
  path.join(INPUTS, "Westbridge_Health_Access_Card_Rollout_Brief.docx.pdf"),
  path.join(INPUTS, "Westbridge_Access_Card_Script.docx"),
  path.join(INPUTS, "Westbridge_Health_Brand_Guidelines.pptx"),
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
  form.set("duration", "150");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "westbridge-access-card-rollout");
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
