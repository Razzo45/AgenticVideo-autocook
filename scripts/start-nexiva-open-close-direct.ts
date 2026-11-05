/**
 * Two Direct Veo runs: NEXIVA Summit 2027 opening (~17s) + closing (~8s).
 * Usage: npx tsx scripts/start-nexiva-open-close-direct.ts
 */
import fs from "node:fs";
import path from "node:path";

const TASK = path.resolve("C:/Wirestock/250Video/task-nexiva-summit-2027");
const INPUTS = path.join(TASK, "02 - Inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const sharedBrief = `Motion graphics for NEXIVA Global Connectivity Summit 2027 — Plenary main LED screen.
Premium, cinematic, modern, technological, clean and sophisticated.
NEXIVA navy background, approved blue/cyan accents, luminous geometric lines, digital networks, particles, connected elements.
Main motif: NEXIVA X and official white logo from attachments. Exact brand proportions from NEXIVA Brand Guidelines.
Typography, colors, and logo treatment must follow the brand guidelines PDF. Use only attached brand assets — do not invent alternate logos or marks.
Not a talking-head piece. No live presenters. Event open/close animation language only.
Music bed attached — sync energy to the motion; keep premium and restrained.`;

const openingPrompt = `${sharedBrief}

DELIVERABLE: Opening animation only.
Target ~17 seconds, 16:9, 1920×1080, 30 fps, MP4.
Visual progression (in order):
CONNECT → MOVE FURTHER → People. Places. Possibilities. → A MORE CONNECTED WORLD → ANYWHERE. → ANYTIME. → NEXIVA X → NEXIVA LOGO
Prefer cut to clean title/logo stills for lockups (avoid morphing dense readable type mid-clip). Continue only for same-background network/camera motion between beats.`;

const closingPrompt = `${sharedBrief}

DELIVERABLE: Closing animation only.
Target ~8 seconds, 16:9, 1920×1080, 30 fps, MP4.
Progression: digital network → NEXIVA X → complete NEXIVA logo → THANK YOU / NEXIVA GLOBAL CONNECTIVITY SUMMIT 2027 → hold briefly → fade to black.
Keep visual language consistent with the opening (navy, cyan lines, X, logo).`;

const openingScript = `SECTION 1 — CONNECT → MOVE FURTHER (≈0:00–0:05).
Navy field. Geometric line structures / luminous tunnel sense of depth. On-screen: CONNECT, then MOVE FURTHER. Premium tech motion graphics. Cut-friendly title plates; no alternate logos.

SECTION 2 — NETWORK + WORLD (≈0:05–0:11).
Digital network / particles / connected nodes. On-screen in order: People. Places. Possibilities. → A MORE CONNECTED WORLD → ANYWHERE. → ANYTIME. Clean typography, cyan accents on navy. Prefer hard cuts between title beats rather than morphing text.

SECTION 3 — X → LOGO LOCKUP (≈0:11–0:17).
NEXIVA X forms / resolves at center from the network language, then complete NEXIVA white logo lockup. Hold the approved logo proportions from brand assets. End on a stable logo hold suitable for a plenary LED open.`;

const closingScript = `SECTION 1 — NETWORK → X → LOGO → THANK YOU (≈0:00–0:08).
Dark navy. Digital network of lines and connected points. NEXIVA X emerges fully at center, then the complete NEXIVA logo. Then on-screen: THANK YOU and NEXIVA GLOBAL CONNECTIVITY SUMMIT 2027 over the connected background. Hold briefly, then fade smoothly to black. One continuous closing beat; logo-accurate; no alternate marks.`;

/** Brand kit only — skip goldens and the large reference MOV (avoid per-clip video-ref bill). */
const attachFiles = [
  path.join(INPUTS, "NEXIVA-Brand-Guidelines.pdf"),
  path.join(INPUTS, "nexiva-logo-white.png"),
  path.join(INPUTS, "nexiva-logo.svg"),
  path.join(INPUTS, "nexiva-x.svg"),
  path.join(INPUTS, "music.wav"),
  path.join(TASK, "opening-closing-script.txt"),
];

type Kick = {
  label: string;
  prompt: string;
  operatorScript: string;
  duration: number;
  sessionLabel: string;
};

async function kick(run: Kick) {
  const form = new FormData();
  form.set("pipelineMode", "direct");
  form.set("prompt", run.prompt);
  form.set("operatorScript", run.operatorScript);
  form.set("category", "Creative Works");
  form.set("aspect", "16:9");
  form.set("duration", String(run.duration));
  form.set("outputResolution", "1080p");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", run.sessionLabel);

  for (const abs of attachFiles) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([buf]), path.basename(abs));
  }

  console.log(`\n[${run.label}] posting ${run.sessionLabel} duration=${run.duration}s …`);
  const res = await fetch(`${BASE}/api/runs`, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`${run.label}: ${res.status} ${text.slice(0, 800)}`);
  const json = JSON.parse(text) as { run?: { id: string; session_id: string } };
  console.log(`[${run.label}] ok session=${json.run?.session_id} id=${json.run?.id}`);
  console.log(`[${run.label}] open ${BASE}/runs/${json.run?.id}`);
  return json.run;
}

async function main() {
  for (const abs of attachFiles) {
    const buf = fs.readFileSync(abs);
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(2)} MB)`);
  }

  const open = await kick({
    label: "opening",
    prompt: openingPrompt,
    operatorScript: openingScript,
    duration: 24, // 3×8s scenes covering ~17s progression
    sessionLabel: "nexiva-summit-2027-opening",
  });

  const close = await kick({
    label: "closing",
    prompt: closingPrompt,
    operatorScript: closingScript,
    duration: 8,
    sessionLabel: "nexiva-summit-2027-closing",
  });

  console.log("\n[done]", { open: open?.id, close: close?.id });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
