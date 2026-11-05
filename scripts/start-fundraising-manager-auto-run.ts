/**
 * Auto long cook: task-13-1131 Elevate Point — Running Successful Fundraising Campaigns.
 * Usage: npx tsx scripts/start-fundraising-manager-auto-run.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";
import { MAX_DURATION_AUTO_SEC } from "../src/pipeline/constants";

const TASK = path.resolve(
  "C:/Wirestock/250Video/task-13-1131-fundraising-manager/13-1131 - Fundraising Manager - Running Successful Campaigns Educational Video",
);
const INPUTS = path.join(TASK, "02 - Inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const operatorPrompt = fs.readFileSync(path.join(TASK, "prompt.txt"), "utf8").trim();
const creativeBrief = fs.readFileSync(path.join(INPUTS, "creative-brief.txt"), "utf8").trim();
const avScript = fs.readFileSync(path.join(INPUTS, "av-script.txt"), "utf8").trim();

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
- Target length ~4:20 (pipeline minimum duration 270s, up to ${MAX_DURATION_AUTO_SEC}s). Cover all seven fundraising steps in order as short scenes — platform concatenates at the end.
- Presenter: John Anderson, Fundraising Manager at Elevate Point Foundation — match attached headshot when on camera.
- Voice: warm professional narration guided by the attached John Anderson voice sample (tone/pace; not a guaranteed clone).
- Visual: clean, modern, polished, professional; natural skin tones; soft lighting; subtle camera move; branded graphics; clear on-screen text.
- Brand: Elevate Point Foundation only — navy, sage, gold, off-white, charcoal; Baskerville display / Avenir Next support per branding guide. Logos from attachments only.
- Music bed + UI click SFX attached — use for open/transitions/close as appropriate; educational nonprofit training piece, not a promo ad.
- Closing: John sign-off + Elevate Point branding from attachments.
- Do not invent alternate orgs, presenters, or steps. Not a fundraising ask ad — a how-to training film.

SEVEN STEPS (required order):
1. Define your goal
2. Identify your target audience
3. Develop your story and message
4. Build your plan and timeline
5. Make donating easy
6. Promote consistently
7. Follow up and measure results

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
AV SCRIPT — VERBATIM SPOKEN + GRAPHICS CUES (follow sequence; preserve John's lines)
${avScript}
`.trim();

const files = [
  path.join(TASK, "prompt.txt"),
  path.join(INPUTS, "creative-brief.txt"),
  path.join(INPUTS, "av-script.txt"),
  path.join(INPUTS, "Elevate_Point_Fundraising_AV_Script.pdf"),
  path.join(INPUTS, "Elevate_Point_Simple_Creative_Brief.pdf"),
  path.join(INPUTS, "Elevate_Point_Foundation_Branding_Guide.pdf"),
  path.join(INPUTS, "headshot John.jpg"),
  path.join(INPUTS, "elevatepoint logo.png"),
  path.join(INPUTS, "elevate logo.svg"),
  path.join(INPUTS, "John Anderson voice.wav"),
  path.join(INPUTS, "Plastic computer button press.wav"),
  path.join(INPUTS, "background music.wav"),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", "270");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "elevate-fundraising-campaigns-ai");
  form.set("autoOptions", JSON.stringify(autoOptions));

  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    // Presenter detector keys off "headshot" in the filename.
    const name = path.basename(abs) === "headshot John.jpg" ? "headshot-john.jpg" : path.basename(abs);
    form.append("inputs", new Blob([buf]), name);
    console.log(`[attach] ${name} (${(buf.length / 1e6).toFixed(2)} MB)`);
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
