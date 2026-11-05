/**
 * Auto long cook: Northline Architects PM Platform Walkthrough (~1:00).
 * Usage: npx tsx scripts/start-northline-pm-walkthrough-auto-run.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-pm-platform-walkthrough");
const TASK = path.join(
  ROOT,
  "13-1111 - Management Analyst - PM Platform Walkthrough",
);
const INPUTS = path.join(TASK, "02 - Inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const operatorPrompt = fs.readFileSync(path.join(PREP, "prompt.txt"), "utf8").trim();
const creativeBrief = fs.readFileSync(path.join(PREP, "creative-brief.txt"), "utf8").trim();
const avScript = fs.readFileSync(path.join(PREP, "av-script.txt"), "utf8").trim();

const autoOptions: AutoOptions = {
  ...DEFAULT_AUTO_OPTIONS,
  deliver4k: true,
  longCook: true,
  presenterIdentity: false,
  voiceGuidance: true,
  verbatimScript: true,
  brandLock: true,
  // Brief forbids decorative overlays; outro branding only.
  timedGraphics: false,
};

const prompt = `${operatorPrompt}

---
PRODUCTION NOTES FOR THIS AUTO RUN
- Target length ~1:00 (pipeline duration 64s). Assemble as short scenes from the screen-recording workflow, then stitch.
- Primary visual: attached Northline Projects screen recording — real UI, deliberate cursor, smooth scroll. No digital zooms, cursor halos, highlight effects, or flashy transitions.
- VO: female-presenting, calm, professional, instructional. Preserve VERBATIM lines from the script below. Sync narration to on-screen actions.
- Music: attached Corporate Music.mp3 — subtle bed under VO; never compete with narration. No SFX.
- Brand: Northline Architects logos + brand guidelines only (black/white/#F2F2F2/#6F6F6F, accent #2855FF). Arial. Clean branded outro after Submit confirmation.
- Form data must match Beacon House / Meridian Developments / Boston, MA / Design / Sarah Mitchell / 250,000 / 15 Sep 2026 / 30 Jun 2027 exactly.
- Internal training resource — not a promotional ad. Do not invent alternate portals, fields, or logos.

SECTION ORDER (required):
1. Portal homepage intro
2. Project Management section
3. Start a New Project → Project Request
4. Basic project information
5. Project details
6. Dates
7. Review
8. Submit for Approval + confirmation
9. Branded NORTHLINE ARCHITECTS outro

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
AV SCRIPT — VERBATIM SPOKEN (follow sequence; preserve lines)
${avScript}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "av-script.txt"),
  path.join(INPUTS, "Northline Architects Brand Guidelines.pdf"),
  path.join(INPUTS, "Northline Architects Training Video Script.pdf"),
  path.join(TASK, "01 - Creative Brief", "Northline Architects Creative Brief .pdf"),
  path.join(INPUTS, "Northline Architects Logo - Black.png"),
  path.join(INPUTS, "Northline Architects Logo - White.png"),
  path.join(INPUTS, "Corporate Music.mp3"),
  // Compressed plate (~3MB) — full RAW is ~190MB; stills/video refs come from this.
  path.join(PREP, "northline-projects-screen-recording.mp4"),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "auto");
  form.set("prompt", prompt);
  form.set("category", "E-commerce & Advertising");
  form.set("aspect", "16:9");
  form.set("duration", "64");
  form.set("outputResolution", "4K");
  form.set(
    "videoModel",
    process.env.NORTHLINE_VIDEO_MODEL?.trim() || "google/gemini-omni-1.1-flash",
  );
  form.set(
    "sessionLabel",
    process.env.NORTHLINE_SESSION_LABEL?.trim() || "northline-pm-platform-walkthrough-omni-ai",
  );
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
