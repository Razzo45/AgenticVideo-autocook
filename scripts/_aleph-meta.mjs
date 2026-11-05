import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 1) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

const res = await fetch("https://openrouter.ai/api/v1/videos/models", {
  headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY },
});
const json = await res.json();
const list = json.data || json.models || json;
const aleph = list.find((m) => String(m.id).includes("aleph"));
console.log(JSON.stringify(aleph, null, 2));
