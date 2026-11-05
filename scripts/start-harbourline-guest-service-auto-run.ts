/**
 * Auto cook: Harbourline Hotels — Guest Service Training (~3:00–3:30, 4K).
 * Legacy AgenticVideo staged auto pipeline (not Astra).
 *
 * Usage: npx tsx scripts/start-harbourline-guest-service-auto-run.ts
 * Requires web+worker on http://127.0.0.1:3000
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-harbourline-guest-service");
const INPUTS = path.join(ROOT, "inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const operatorPrompt = fs.readFileSync(path.join(PREP, "prompt.txt"), "utf8").trim();
const creativeBrief = fs.readFileSync(path.join(PREP, "creative-brief.txt"), "utf8").trim();
const voScript = fs.readFileSync(path.join(PREP, "vo-script.txt"), "utf8").trim();
const brandGuidelines = fs.readFileSync(path.join(PREP, "brand-guidelines.txt"), "utf8").trim();

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
- Target length ~3:20 (pipeline duration 200s). Cover the full VO script as short scenes in order, then stitch.
- Presenter: Eric Bay — match Eric Bay_Headshot.jpg when on camera (dark short hair, light-blue collared shirt, dark trousers). Lower third on first appearance: ERIC BAY / Harbourline Hotels.
- Voice: confident, warm, approachable, briefing colleagues; guided by Eric Bay_VO Sample.mp3 (tone/pace — not a guaranteed clone).
- Environment: harbourline_Loactions_ref.jpg is the workplace reference (contemporary hotel meeting room / back-of-house: warm timber, dark charcoal wall, soft daylight). Presenter scenes in a clean premium hotel interior; B-roll in hotel front desk / lobby / corridor / back-office contexts.
- B-roll must match the point being made: acknowledging a waiting guest at the front desk, confirming a room/booking on screen, housekeeping call, bill query, supervisor escalation, staff handover between colleagues, updating a guest. No generic hospitality filler.
- Music: Commercial Upbeat_MUSIC.wav as a background bed throughout, mixed beneath the presenter (never competes with VO).
- Brand: Harbour Navy #081F30, Warm Ivory #F7F4ED, Stone #D2CCC2, Ink #131B20; Georgia / Georgia Bold titles. Use only the supplied Harbourline logos (blue on light, white on navy). Restrained, spacious layouts.
- Title cards (from script): HARBOURLINE HOTELS / GUEST SERVICE TRAINING, IDENTIFY THE GUEST'S NEEDS, PROTECT GUEST INFORMATION, RESPONDING TO COMPLAINTS, KNOW WHEN TO ESCALATE, SAFETY & SECURITY, HAND OVER CLEARLY, KEEP THE GUEST UPDATED, IN SUMMARY.
- Opening: Harbourline logo centered. Close: Harbourline logo centered on a clean branded end frame.
- Live-action presenter and B-roll takes must contain NO logos, signage text, or on-screen graphics — branding lives only on title cards / lower third / end frame.
- This is an internal training resource, not a promotional video. Do not add policies, procedures or guest service rules beyond the supplied script.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
BRAND GUIDELINES (reference)
${brandGuidelines}

---
VO SCRIPT — VERBATIM SPOKEN + TITLE CARD CUES (controlling sequence)
${voScript}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "vo-script.txt"),
  path.join(PREP, "brand-guidelines.txt"),
  path.join(INPUTS, "Eric Bay_Headshot.jpg"),
  path.join(INPUTS, "harbourline_Loactions_ref.jpg"),
  path.join(INPUTS, "Harbourline_Hotels_LOGO_Blue.png"),
  path.join(INPUTS, "Harbourline_Hotels_LOGO_White.png"),
  path.join(INPUTS, "Eric Bay_VO Sample.mp3"),
  path.join(INPUTS, "Commercial Upbeat_MUSIC.wav"),
  path.join(INPUTS, "Harbourline_Hotels_Creative_Brief.pdf"),
  path.join(INPUTS, "Harbourline_Hotels_Guest_Service_Training_VO_Script.pdf"),
  path.join(INPUTS, "Harbourline_Hotels_Brand_Guidelines.pptx"),
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
  form.set("duration", "200");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "harbourline-guest-service-training");
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
