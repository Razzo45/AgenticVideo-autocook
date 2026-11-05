import fs from "node:fs";

const path =
  "C:/Users/RazvanHome/.cursor/projects/c-Users-RazvanHome-Documents-AgenticVideo/agent-tools/cd7b6fed-a81b-4520-9884-915832a620df.txt";
const j = JSON.parse(fs.readFileSync(path, "utf8"));
const models = j.data ?? j;
const want = new Set([
  "google/veo-3.1-fast",
  "google/veo-3.1",
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
]);
for (const m of models) {
  if (!want.has(m.id)) continue;
  console.log("====", m.id);
  console.log(JSON.stringify({ name: m.name, pricing: m.pricing }, null, 2));
}

function seedTokens(w: number, h: number, sec: number) {
  return (h * w * sec * 24) / 1024;
}
function usd(tokens: number, perM: number) {
  return (tokens / 1e6) * perM;
}

console.log("\nSeedance token-derived $/sec @ $7/M (no video input):");
for (const [label, w, h] of [
  ["480p", 854, 480],
  ["720p", 1280, 720],
  ["1080p", 1920, 1080],
  ["4K", 3840, 2160],
] as const) {
  const t = seedTokens(w, h, 1);
  console.log(label, "tokens/s", t.toFixed(0), "$/s", usd(t, 7).toFixed(4), "video-in@$4.3", usd(t, 4.3).toFixed(4));
}
