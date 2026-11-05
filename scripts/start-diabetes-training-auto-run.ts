/**
 * Auto AI-baseline: task-21-1091 Trinity Care diabetes home-care training video.
 * Usage: npx tsx scripts/start-diabetes-training-auto-run.ts
 */
import fs from "node:fs";
import path from "node:path";

const TASK = path.resolve("C:/Wirestock/250Video/task-21-1091-diabetes-training");
const INPUTS = path.join(TASK, "02 - Inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const operatorPrompt = fs.readFileSync(path.join(TASK, "prompt.txt"), "utf8").trim();
const creativeBrief = fs.readFileSync(path.join(INPUTS, "creative-brief.txt"), "utf8").trim();
const avScript = fs.readFileSync(path.join(INPUTS, "av-script.txt"), "utf8").trim();

const prompt = `${operatorPrompt}

---
PRODUCTION NOTES FOR THIS AUTO RUN
- Target length ~3:00–4:00 (pipeline minimum duration 240s). Cover every checklist beat in order; do not drop sections.
- Warm, clean, simple 2D flat / vector motion-graphics look. Voiceover-driven educational piece — not a promotional ad.
- Music ONLY in opening and closing. VO: confident, warm, approachable, engaging.
- Brand: Trinity Care logo + brand guidelines when branding is on screen. Closing must include helpline 1-800-555-CARE and patient portal MyTrinityCarePortal.org (prompt wins over any conflicting portal URL in older copy).
- Prefer attached PNG logo and SVG graphics for icons/diagrams/callouts. Preserve VERBATIM spoken content from the AV script below.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
AV SCRIPT — VERBATIM SPOKEN + GRAPHICS CUES (follow sequence order)
${avScript}
`.trim();

const files = [
  path.join(TASK, "prompt.txt"),
  path.join(INPUTS, "creative-brief.txt"),
  path.join(INPUTS, "av-script.txt"),
  path.join(INPUTS, "TrinityCare-export-LOGO.png"),
  path.join(INPUTS, "Video 1 Diabetes Care Music Layer.mp3"),
  path.join(INPUTS, "Trinity Care Video Brand Guidelines.pdf"),
  ...fs
    .readdirSync(INPUTS)
    .filter((n) => /^TrinityCare-export-Graphics-\d+\.svg$/i.test(n))
    .sort()
    .map((n) => path.join(INPUTS, n)),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", "240");
  form.set("outputResolution", "1080p");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "trinity-diabetes-daily-checklist-ai");

  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([buf]), path.basename(abs));
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(2)} MB)`);
  }

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
