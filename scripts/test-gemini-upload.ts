/** Usage: npx tsx --env-file=.env scripts/test-gemini-upload.ts <file> [mime] */
import { GoogleGenAI } from "@google/genai";

async function main() {
  const [file, mime = "image/png"] = process.argv.slice(2);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  try {
    const up = await ai.files.upload({ file, config: { mimeType: mime } });
    console.log("[ok]", up.name, up.state);
  } catch (err) {
    console.log("[fail]", err instanceof Error ? err.message : err);
  }
  const pager = await ai.files.list({ config: { pageSize: 100 } });
  let n = 0;
  let bytes = 0;
  for await (const f of pager) {
    n++;
    bytes += Number(f.sizeBytes ?? 0);
  }
  console.log(`[files] ${n}+ stored, ${(bytes / 1e9).toFixed(2)} GB`);
}

main();
