/** Loads .env exactly like src/worker.ts, then tries one Gemini Files upload. */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 1) continue;
  const k = trimmed.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = trimmed.slice(eq + 1).trim();
}

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  try {
    const up = await ai.files.upload({ file: process.argv[2], config: { mimeType: "image/png" } });
    console.log("[ok]", up.name);
  } catch (err) {
    console.log("[fail]", err instanceof Error ? err.message : err);
  }
}

main();
