/**
 * Auto cook: Field & Grove Markets — new employee onboarding (~3:25, 4K).
 * Legacy AgenticVideo staged auto pipeline (not Astra).
 *
 * Usage: npx tsx scripts/start-field-grove-onboarding-auto-run.ts
 * Requires web+worker on http://localhost:3000
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-field-grove-onboarding");
const INPUTS = path.join(ROOT, "inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://localhost:3000";

const read = (name: string) => fs.readFileSync(path.join(PREP, name), "utf8").trim();
const operatorPrompt = read("prompt.txt");
const creativeBrief = read("creative-brief.txt");
const avScript = read("av-script.txt");
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
- Target length ~3:25 (pipeline duration 205s — matches UPBEAT CORPORATE.wav, 3:25). Follow the AV SCRIPT section order; Claire's spoken lines verbatim, no added policies or rules.
- Presenter: Claire, Training & Development — match Claire - Headshot.jpg (long wavy blonde hair, blue eyes, pearl stud earrings, light blue blazer over white knit top, black skirt). Calm, friendly, conversational, natural eye contact, relaxed professional body language. Stable medium / medium-close framing, minimal camera movement. Standing or seated on a simple stool.
- Name badge: small plain white rectangular badge on the blazer lapel, kept small in frame so no logo or lettering is legible. Never frame a close-up on the badge.
- Location: match Field & Grove Studio Location.jpg — clean white cyclorama studio, white walls and floor, soft overhead diffusion, no props or clutter. Bright, soft, even lighting; natural skin tones; no dramatic contrast or stylised colour.
- Voice: Claire - Voice Sample.wav sets tone and pace — warm, clear, reassuring.
- Opening title card: Field Green primary logo on Warm White with NEW EMPLOYEE ONBOARDING centred.
- Section title cards (Arial Bold, Field Green on Warm White): YOUR FIRST SHIFT, WORKPLACE SAFETY, CUSTOMER SERVICE.
- Text callouts, timed to the matching lines in the AV Script:
  - Intro (check in with supervisor / meet team / tour of key areas): CHECK IN, MEET YOUR TEAM, KEY AREAS
  - Your First Shift (tasks list / working alongside a team member / first shifts are about learning): DAILY TASK, TEAM SUPPORT, LEARN YOUR ROLE
  - Workplace Safety (keep walkways clear / follow procedures / report spills and hazards): KEEP AREAS CLEAR, FOLLOW RULES, REPORT HAZARDS
  - Customer Service (be welcoming / understand what they need / find someone who can help): BE WELCOMING, LISTEN FIRST, ASK FOR HELP
- Closing title card: Field Green logo, WANT TO LEARN MORE? For more information, resources and support, visit www.fieldandgrovemarkets.com — centred, then clean fade.
- Supporting B-roll (natural, believable supermarket workplace): supervisor greeting a new starter, team introductions, staff room / storage / emergency exit signage walk-through, assisting a customer, stocking shelves, preparing a work area, handling fresh produce, clear walkways, a team member reporting a spill to a supervisor, a tidy aisle. Staff in neutral clean workplace attire with subtle Field Green accents.
- Audio: UPBEAT CORPORATE.wav as a subtle music bed throughout, well below Claire's voice; natural room ambience.
- Brand: Field Green #0B4F2C, Warm White #F4F2EA, Charcoal #1E1E1E, Soft Grey #D9DDD5. Arial only. Primary green logo on light backgrounds, white logo on Field Green/dark. Never stretch, rotate, recolour or add effects. Minimal animation, no sales-style treatments.
- Live-action takes must contain NO logos, text or graphics — branding lives only on title cards, callouts and the end frame.
- Genuine internal training, not an advertisement. Use only the supplied materials.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
BRAND GUIDELINES (reference)
${brandGuidelines}

---
APPROVED AV SCRIPT — VERBATIM DIALOGUE, GRAPHICS, SECTION ORDER (controlling sequence)
${avScript}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "av-script.txt"),
  path.join(PREP, "brand-guidelines.txt"),
  path.join(INPUTS, "Claire - Headshot.jpg"),
  path.join(INPUTS, "Field & Grove Studio Location.jpg"),
  path.join(INPUTS, "Field & Grove Markets Logo - Field Green.png"),
  path.join(INPUTS, "Field & Grove Markets Logo - Field White.png"),
  path.join(INPUTS, "Claire - Voice Sample.wav"),
  path.join(INPUTS, "UPBEAT CORPORATE.wav"),
  path.join(INPUTS, "Field_and_Grove_Markets_Creative_Brief_3_Page_REVISED.docx"),
  path.join(INPUTS, "Field_and_Grove_Markets_New_Employee_Onboarding_Script.docx"),
  path.join(INPUTS, "Field & Grove Markets Brand Guidelines.pptx"),
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
  form.set("duration", "205");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "field-grove-new-employee-onboarding");
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
