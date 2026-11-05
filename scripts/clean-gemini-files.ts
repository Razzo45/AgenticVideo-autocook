/**
 * Delete every file in the Gemini Files API for the project's GEMINI_API_KEY.
 * Omni uploads otherwise accumulate until the 20GB file_storage_bytes quota blocks all submits.
 *
 * Usage: npx tsx scripts/clean-gemini-files.ts
 */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

// Load .env without printing any key material.
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const key = process.env.GEMINI_API_KEY?.trim();
if (!key || key === "replace-me") throw new Error("GEMINI_API_KEY missing");

async function main() {
  const ai = new GoogleGenAI({ apiKey: key });
  let count = 0;
  let bytes = 0;
  const pager = await ai.files.list({ config: { pageSize: 100 } });
  for await (const f of pager) {
    if (!f.name) continue;
    bytes += Number(f.sizeBytes ?? 0);
    try {
      await ai.files.delete({ name: f.name });
      count++;
    } catch (err) {
      console.warn(`[skip] ${f.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[clean] deleted ${count} file(s), ~${(bytes / 1e9).toFixed(2)} GB freed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
