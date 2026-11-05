/** Imports one module (argv[3]), then tries one Gemini Files upload — finds fetch-breaking imports. */
import { GoogleGenAI } from "@google/genai";

async function main() {
  const [file, mod] = process.argv.slice(2);
  const before = globalThis.fetch;
  if (mod) await import(mod);
  console.log(`[fetch replaced] ${globalThis.fetch !== before}`);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  try {
    const up = await ai.files.upload({ file, config: { mimeType: "image/png" } });
    console.log("[ok]", mod, up.name);
  } catch (err) {
    console.log("[fail]", mod, err instanceof Error ? err.message : err);
  }
}

main();
