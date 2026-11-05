/**
 * Auto cook: Angeli Vineyards — donor thank-you & impact film (~2:00, 4K).
 * Legacy AgenticVideo staged auto pipeline (not Astra).
 *
 * Usage: npx tsx scripts/start-angeli-vineyards-thankyou-auto-run.ts
 * Requires web+worker on http://localhost:3000
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTO_OPTIONS, type AutoOptions } from "../src/pipeline/autoOptions";

const ROOT = path.resolve("tasks/task-angeli-vineyards-thankyou");
const INPUTS = path.join(ROOT, "inputs");
const PREP = path.join(ROOT, "prepared");
const BASE = process.env.AGENTIC_BASE_URL ?? "http://localhost:3000";

const read = (name: string) => fs.readFileSync(path.join(PREP, name), "utf8").trim();
const operatorPrompt = read("prompt.txt");
const creativeBrief = read("creative-brief.txt");
const thankYouScript = read("thankyou-script.txt");
const masterScript = read("master-production-script.txt");
const brandGuidelines = read("brand-guidelines.txt");

const autoOptions: AutoOptions = {
  ...DEFAULT_AUTO_OPTIONS,
  deliver4k: true,
  longCook: true,
  presenterIdentity: true,
  voiceGuidance: false,
  verbatimScript: true,
  brandLock: true,
  timedGraphics: true,
};

const prompt = `${operatorPrompt}

---
PRODUCTION NOTES FOR THIS AUTO RUN
- Target length ~2:00 (pipeline duration 120s). Follow the MASTER PRODUCTION SCRIPT shot order and timecodes as the controlling sequence; spoken lines verbatim.
- Presenter: Jose Angeli — match Jose_Headshot.png (young man, dark wavy hair, light stubble, warm smile). Warm, genuine, grounded, slightly emotional; speaks primarily to camera. Medium / medium-close-up framing, minimal camera movement.
- Wardrobe per master script: seated scenes — light blue linen shirt, black shorts, holding a white mug on a simple wooden chair in a dry rocky outdoor area with stone walls and cypress trees. Walking-the-rows scenes — sunglasses, dark polo, white shorts.
- Lower third on first appearance: JOSE ANGELI / Owner, Angeli Vineyards — use the supplied Graphic - Jose - Angeli Vineyards.png look (white serif on dark, simple vine flourish).
- Opening: high aerial drone of the vineyard (green rows, dirt roads, mountains, sea in the distance, soft light) with the Angeli crest appearing.
- Drought section B-roll: shrivelled grape clusters on cracked earth, exposed dry roots, withered leafless vine branches, fallen damaged grapes. Keep it textural and quiet — no people in distress.
- Turning point / recovery B-roll: dry grass seed heads in breeze, stone wall detail, Jose walking up stone steps, low forward drone over lush healthy vine rows, wider aerial of healthy vineyard.
- Thriving section: extreme close-up of dark plump grapes, mixed white/red grapes, wine bottles on a wooden shelf, oak barrel cellar, grape pomace, wine flowing from a press.
- Close: Jose seated, direct to camera ("Gracias… Thank you."), then high aerial drone pull-back at golden hour revealing the full vineyard, winery with solar panels, mountains and sea — Angeli crest fades in over it, clean fade out.
- Look: warm natural light, earthy grade (deep vine greens, warm golds, terracotta). Real texture of soil, leaves, vines. Handheld / lightly stabilised feel. No glossy corporate look, no heavy motion graphics.
- Audio: natural ambient vineyard sound; bgmusic.mp3 as a gentle acoustic underscore kept very low beneath Jose's voice.
- Brand: crest only (black on light, white on dark), never stretched/recoloured. Cormorant Garamond display type; palette Estate Burgundy #6E1F2A, Cellar Gold #B18A4A, Paper Cream #F3EBDD, Vine Leaf #3F5138, Charcoal Ink #211F1C. Minimal graphics.
- Live-action takes must contain NO logos, crest, text or graphics — branding lives only on the opening/end crest and the lower third.
- This is a sincere donor thank-you and impact film, not an advertisement. Do not invent alternate stories, change the core message, or introduce a different presenter.

---
CREATIVE BRIEF (reference)
${creativeBrief}

---
BRAND GUIDELINES (reference)
${brandGuidelines}

---
FINAL APPROVED THANK-YOU SCRIPT (spoken content)
${thankYouScript}

---
MASTER PRODUCTION SCRIPT — TIMECODES, VERBATIM DIALOGUE, VISUALS, GRAPHICS (controlling sequence)
${masterScript}
`.trim();

const files = [
  path.join(PREP, "prompt.txt"),
  path.join(PREP, "creative-brief.txt"),
  path.join(PREP, "thankyou-script.txt"),
  path.join(PREP, "master-production-script.txt"),
  path.join(PREP, "brand-guidelines.txt"),
  path.join(INPUTS, "Jose_Headshot.png"),
  path.join(INPUTS, "AngeliVineyards-BLACK.png"),
  path.join(INPUTS, "AngeliVineyards WHITE.png"),
  path.join(INPUTS, "Graphic - Jose - Angeli Vineyards.png"),
  path.join(INPUTS, "bgmusic.mp3"),
  path.join(INPUTS, "Angeli Vineyards - Creative Breif.pdf"),
  path.join(INPUTS, "Angeli Vineyards Thank-You Script.pdf"),
  path.join(INPUTS, "Angeli_Master_Production_Script.pdf"),
  path.join(INPUTS, "AngeliVineyard_BrandingGuidelines2026.pdf"),
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
  form.set("duration", "120");
  form.set("outputResolution", "4K");
  form.set("videoModel", "google/veo-3.1-fast");
  form.set("sessionLabel", "angeli-vineyards-donor-thankyou");
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
