/**
 * Kick off a Direct AI-baseline run for task-27-4032 wedding montage.
 * Lean input pack only (not the full footage bank).
 * Usage: npx tsx scripts/start-wedding-montage-run.ts
 */
import fs from "node:fs";
import path from "node:path";

const TASK = path.resolve("C:/Wirestock/250Video/task-27-4032-wedding-montage");
const INPUTS = path.join(TASK, "02 - Inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const brief = fs.readFileSync(path.join(TASK, "prompt.txt"), "utf8").trim();

/** Trailer beat sheet → Direct segments (action beats, not spoken dialogue). */
const script = `SECTION 1 — OPEN: PLACE (mountain establish).
Cinematic drone / wide mountain establishing shots outside Denver. Breathtaking landscape, cool air, epic scale. Slow push / real-time + slow-mo mix. Mood: trailer open, not a highlight reel.

SECTION 2 — INTIMATE BUILD.
Close-ups and candid moments of Hannah and Owen — glances, hands, quiet connection. Romantic, intimate, timeless. Preserve natural emotion; avoid staged artificial looks.

SECTION 3 — FAMILY THREAD.
Weave Owen's grandmother as a meaningful emotional beat. Soft natural sound under music bed only. No voice-over.

SECTION 4 — CEREMONY RISE.
Gradually raise intensity toward ceremony and vows. Build anticipation. Mix medium, close-up, and detail shots.

SECTION 5 — CLIMAX: SEALING KISS.
The first kiss that seals their marriage is the central emotional payoff. Hold longer on this peak. Cinematic trailer energy.

SECTION 6 — CELEBRATION INTO FINAL IMAGE.
Transition into celebration, then end on Hannah dancing under twinkling lights — powerful, emotional closing hold. Stick to wedding-day look; no heavy VFX. Music.mp3 is the bed for the whole piece.`;

const files = [
  path.join(INPUTS, "music.mp3"),
  path.join(INPUTS, "WIRESTOck - WEDDING Graphic.Still002.png"),
  path.join(INPUTS, "Animated Graphic - Hannah & Owen - WEDDING MONTAGE.mp4"),
  path.join(INPUTS, "Footage", "C1655.MP4.mp4"),
  path.join(INPUTS, "Footage", "C1662.MP4.mp4"),
  path.join(INPUTS, "Footage", "C1663.MP4.mp4"),
  path.join(INPUTS, "Footage", "C1678.MP4.mp4"),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "direct");
  form.set("prompt", brief);
  form.set("operatorScript", script);
  form.set("category", "Short Drama / Film & TV");
  form.set("aspect", "16:9");
  form.set("duration", "48");
  form.set("outputResolution", "1080p");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "wedding-hannah-owen-teaser-ai");

  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    const name = path.basename(abs);
    form.append("inputs", new Blob([buf]), name);
    console.log(`[attach] ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }

  console.log(`[post] ${BASE}/api/runs …`);
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
