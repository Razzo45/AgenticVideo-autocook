/**
 * Direct AI-baseline: task-27-2012 Mother Nature documentary trailer.
 * Lean pack only (not the full footage bank).
 * Usage: npx tsx scripts/start-mother-nature-trailer-run.ts
 */
import fs from "node:fs";
import path from "node:path";

const TASK = path.resolve("C:/Wirestock/250Video/task-27-2012-doc-trailer");
const INPUTS = path.join(TASK, "02 - Inputs");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3000";

const brief = fs.readFileSync(path.join(TASK, "prompt.txt"), "utf8").trim();

const script = `SECTION 1 — OPEN: RESPECT (quiet, contemplative).
ACTION: Pure natural-world imagery — wide landscapes, slow environmental shots, wind through vegetation, water, wildlife, atmospheric light. People small in the frame. Shots breathe. Cinematic, intimate, grounded. No tourism/corporate look.
SPOKEN: "The biggest lesson for us was respect."

SECTION 2 — LIVING LAND / CONNECTION.
ACTION: Interconnectedness of people, land, and animals through emotional association. Tactile close-ups cutting to vast landscape. Earthy natural grade.
SPOKEN: "Because the land is living. We have a symbiotic relationship. It provides for us and we take care of that."

SECTION 3 — TURNING POINT.
ACTION: Slight pause / breath. Human scale vs environmental scale.
SPOKEN: "How can you respect the land?"

SECTION 4 — RECONNECT (intimate, personal).
ACTION: People experiencing nature — walking, working, touching, observing, sitting quietly, interacting with animals and each other.
SPOKEN: "By getting out in the land. The more time you spend out there, the more you have a connection."

SECTION 5 — HEALING (emotional peak).
ACTION: Increasingly beautiful, immersive, still imagery — peace, vulnerability, renewal, sunlight, water, wind, wildlife.
SPOKEN: "The more you get out in the land, the more you're going to realize you're healing. You can start to feel the healing power of the land — how important for the human race to survive."

SECTION 6 — THESIS / RESOLUTION.
ACTION: Land on a powerful expansive environmental image. Let the final statement breathe. Simple elegant closing title treatment as briefed (MOTHER NATURE / A short Film) — graphics extremely minimal.
SPOKEN: "We need to get back in touch with the land."`;

const files = [
  path.join(INPUTS, "music.wav"),
  path.join(INPUTS, "Mother Nature - GRAPHIC.png"),
  path.join(INPUTS, "FOOTAGE", "C9979.mp4"),
  path.join(INPUTS, "FOOTAGE", "C9942.MP4"),
  path.join(INPUTS, "FOOTAGE", "C0207.mp4"),
];

async function main() {
  const form = new FormData();
  form.set("pipelineMode", "direct");
  form.set("prompt", brief);
  form.set("operatorScript", script);
  form.set("category", "Short Drama / Film & TV");
  form.set("aspect", "16:9");
  form.set("duration", "60");
  form.set("outputResolution", "1080p");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "mother-nature-doc-trailer-ai");

  for (const abs of files) {
    if (!fs.existsSync(abs)) throw new Error(`Missing: ${abs}`);
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([buf]), path.basename(abs));
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(1)} MB)`);
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
