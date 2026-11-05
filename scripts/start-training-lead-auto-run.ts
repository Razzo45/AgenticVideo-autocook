/**
 * Auto AI-baseline: task-11-3131 Image Consultants — Leading & Training a Team.
 * Usage: npx tsx scripts/start-training-lead-auto-run.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";
import { MAX_DURATION_AUTO_SEC } from "../src/pipeline/constants";

const TASK = path.resolve("C:/Wirestock/250Video/task-11-3131-training-lead");
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
- Target length ~4:30 (pipeline minimum duration 280s, up to ${MAX_DURATION_AUTO_SEC}s). Cover all five training steps as short scenes in order — platform concatenates at the end.
- Presenter: Brad Smith, Training and Development Manager at Image Consultants — match attached headshot when on camera.
- Voice: warm professional narration guided by the attached voice sample (tone/pace; not a guaranteed clone).
- Visual: clean, modern, minimalist, professional; natural skin tones; soft lighting; subtle camera move; branded graphics; clear on-screen text.
- Music bed + whoosh SFX attached — use for open/transitions/close as appropriate; educational piece, not a promo ad.
- Closing/branding: Image Consultants logos only from attachments.

FIVE STEPS (required order):
1. Set clear expectations
2. Give trainers a repeatable training structure
3. Develop their communication skills
4. Teach them to give effective feedback
5. Teach them to adapt

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
AV SCRIPT — VERBATIM SPOKEN + GRAPHICS CUES (follow sequence; preserve Brad's lines)
${avScript}
`.trim();

const files = [
  path.join(TASK, "prompt.txt"),
  path.join(INPUTS, "creative-brief.txt"),
  path.join(INPUTS, "av-script.txt"),
  path.join(INPUTS, "headshot.jpg"),
  path.join(INPUTS, "Image Consultants Logo FULL.png"),
  path.join(INPUTS, "Image Consultants Logo WHITE.png"),
  path.join(INPUTS, "music bed.wav"),
  path.join(INPUTS, "voice recording.wav"),
  path.join(INPUTS, "Fast twirling whoosh.wav"),
  path.join(INPUTS, "Image Consultants Branding Kit.pdf"),
  path.join(INPUTS, "Logo.svg"),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", "280");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "image-consultants-train-lead-ai");
  form.set("autoOptions", JSON.stringify(autoOptions));

  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([buf]), path.basename(abs));
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
