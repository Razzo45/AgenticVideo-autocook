/** Usage: npx tsx --env-file=.env scripts/test-omni-plate-upload.ts <video...> */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoogleGenAI } from "@google/genai";
import { trimVideoForOmni } from "../src/pipeline/geminiOmni";

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  for (const src of process.argv.slice(2)) {
    const dest = path.join(os.tmpdir(), `${path.basename(src, path.extname(src))}_omni.mp4`);
    await trimVideoForOmni(src, dest, { startSec: 0, durationSec: 10 });
    console.log(`[trim] ${path.basename(dest)} ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
    try {
      const up = await ai.files.upload({ file: dest, config: { mimeType: "video/mp4" } });
      console.log("[ok]", up.name, up.state);
    } catch (err) {
      console.log("[fail]", err instanceof Error ? err.message : err);
    }
  }
}

main();
