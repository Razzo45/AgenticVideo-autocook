/**
 * Raw Gemini Omni call: the operator prompt verbatim + every original file, nothing added.
 * Usage: npx tsx --env-file=.env scripts/omni-raw.ts <taskDir> [resolution=4k] [duration e.g. 10s]
 * Reads <taskDir>/raw-prompt.txt and <taskDir>/raw/*; writes <taskDir>/out/omni_<ts>.mp4
 */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, FileState } from "@google/genai";
import { OMNI_API_MODEL } from "../src/pipeline/geminiOmni";

const MIME: Record<string, { type: "video" | "image" | "audio" | "document"; mime: string }> = {
  ".mov": { type: "video", mime: "video/quicktime" },
  ".mp4": { type: "video", mime: "video/mp4" },
  ".png": { type: "image", mime: "image/png" },
  ".jpg": { type: "image", mime: "image/jpeg" },
  ".jpeg": { type: "image", mime: "image/jpeg" },
  ".wav": { type: "audio", mime: "audio/wav" },
  ".mp3": { type: "audio", mime: "audio/mpeg" },
  ".pdf": { type: "document", mime: "application/pdf" },
};

async function main() {
  const [taskDir, resolution = "4k", duration] = process.argv.slice(2);
  if (!taskDir) throw new Error("usage: omni-raw.ts <taskDir> [resolution] [duration]");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const prompt = fs.readFileSync(path.join(taskDir, "raw-prompt.txt"), "utf8").trim();
  const rawDir = path.join(taskDir, "raw");
  const outDir = path.join(taskDir, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const input: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(rawDir).sort()) {
    const kind = MIME[path.extname(name).toLowerCase()];
    if (!kind || kind.type === "audio") {
      console.log(`[skip] ${name}${kind ? " (Omni: audio input modality not enabled)" : ""}`);
      continue;
    }
    console.log(`[upload] ${name} (${kind.mime})`);
    let file = await ai.files.upload({ file: path.join(rawDir, name), config: { mimeType: kind.mime, displayName: name } });
    while (file.state === FileState.PROCESSING) {
      await new Promise((r) => setTimeout(r, 4000));
      file = await ai.files.get({ name: file.name! });
    }
    if (file.state === FileState.FAILED) throw new Error(`upload failed: ${name}`);
    input.push({ type: kind.type, uri: file.uri, mime_type: kind.mime });
  }
  input.push({ type: "text", text: prompt });

  const request = {
    model: OMNI_API_MODEL,
    input: input as never,
    response_format: {
      type: "video" as const,
      aspect_ratio: "16:9" as const,
      resolution: resolution as "4k",
      ...(duration ? { duration } : {}),
    },
  };
  fs.writeFileSync(
    path.join(outDir, "request.json"),
    JSON.stringify({ ...request, input: input.map((p) => (p.type === "text" ? p : { ...p, uri: String(p.uri) })) }, null, 2),
  );
  console.log(`[submit] ${OMNI_API_MODEL} ${resolution}${duration ? ` ${duration}` : ""} — ${input.length - 1} files + prompt (${prompt.length} chars)`);
  const started = Date.now();
  const interaction = (await ai.interactions.create(request)) as {
    status?: string;
    output_video?: { data?: string };
    steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; text?: string }> }>;
  };
  console.log(`[done] status=${interaction.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  let data = interaction.output_video?.data;
  for (const step of interaction.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block.type === "video" && block.data) data ??= block.data;
      if (block.type === "text" && block.text) console.log(`[text] ${block.text.slice(0, 800)}`);
    }
  }
  if (!data) {
    fs.writeFileSync(path.join(outDir, "response.json"), JSON.stringify(interaction, null, 2));
    throw new Error("no video in response (saved response.json)");
  }
  const out = path.join(outDir, `omni_${Date.now()}.mp4`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`[ok] ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
