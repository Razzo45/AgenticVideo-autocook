/**
 * Auto long cook: Pine Valley — Implementing the New Math Standards Grades 3–5 (~2:30–3:00).
 * Usage: npx tsx scripts/start-pinevalley-math-standards-auto-run.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-pinevalley-math-standards");
const TASK = path.join(
  ROOT,
  "25-9031 - Instructional Coordinator - Standards rollout video",
);
const INPUTS = path.join(TASK, "Inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const operatorPrompt = fs.readFileSync(path.join(PREP, "prompt.txt"), "utf8").trim();
const creativeBrief = fs.readFileSync(path.join(PREP, "creative-brief.txt"), "utf8").trim();
const avScript = fs.readFileSync(path.join(PREP, "av-script.txt"), "utf8").trim();

const autoOptions: AutoOptions = {
  ...DEFAULT_AUTO_OPTIONS,
  deliver4k: false,
  longCook: true,
  presenterIdentity: false,
  voiceGuidance: true,
  verbatimScript: true,
  brandLock: true,
  timedGraphics: true,
};

const prompt = `${operatorPrompt}

---
PRODUCTION NOTES FOR THIS AUTO RUN
- Target length ~2:30–3:00 (pipeline duration 154s ≈ golden). Cover the full AV script sequence as short scenes, then stitch.
- Style: warm, clean, simple 2D flat / vector motion graphics (not live-action, not a promo ad). Helvetica / clean sans; Pine Valley brand colors from the brand guide + logos.
- VO: confident, warm, approachable, engaging. Preserve VERBATIM spoken lines from the AV script below.
- Music: opening and closing bumpers ONLY — no bed under the body narration.
- Must cover: Day One standards-aligned goal → three gap areas (visual fractions, multi-step word problems, number patterns) → Textbook Alignment Guide benefits → Grades 3–4 fraction strips/tape diagrams → Grade 5 pattern rules/coordinate planes → equity/consistency → Curriculum Portal CTA (Alignment Guides, Gap Reports, Lesson Plans) → thank-you close.
- Brand: Pine Valley School District logos only. Do not invent alternate districts, portals, or standards.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
AV SCRIPT — VERBATIM SPOKEN + GRAPHICS CUES (follow sequence; preserve VO lines)
${avScript}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "av-script.txt"),
  path.join(INPUTS, "Pine Valley Video Brand Guidelines.pdf"),
  path.join(INPUTS, "PineValley Logo.svg"),
  path.join(INPUTS, "PineValley Logo OLD version.svg"),
  path.join(INPUTS, "Storyboard Implementing the New Math Standards_ Grades 3-5.pptx"),
  path.join(INPUTS, "Script_ Implementing the New Math Standards_ Grades 3-5.docx"),
  path.join(INPUTS, "Creative Brief_ Implementing the New Math Standards_ Grades 3-5.docx"),
].filter((p) => fs.existsSync(p));

const pngLogo = path.join(PREP, "PineValley-Logo.png");
if (fs.existsSync(pngLogo)) files.push(pngLogo);

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", "154");
  form.set("outputResolution", "1080p");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "pinevalley-math-standards-3-5-ai");
  form.set("autoOptions", JSON.stringify(autoOptions));

  for (const abs of files) {
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
