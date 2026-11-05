/**
 * Image cook — PNG via Gemini image API; SVG written verbatim from Argon.
 */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { ImagePlan } from "../pipeline/schemaDocs";
import { withGeminiAdmission } from "../pipeline/geminiAdmission";

const IMAGE_MODEL = process.env.PRODUCT_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error("GEMINI_API_KEY is missing for image generation.");
  }
  return key;
}

export type GenerateImageResult = {
  paths: string[];
};

async function generatePng(opts: {
  prompt: string;
  outPath: string;
  width: number;
  height: number;
  referenceImagePaths?: string[];
  onStatus?: (msg: string) => void;
}): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: requireGeminiKey() });
  opts.onStatus?.(`Generating PNG with ${IMAGE_MODEL}…`);

  const parts: Array<Record<string, unknown>> = [{ text: opts.prompt.trim() }];
  for (const ref of (opts.referenceImagePaths ?? []).slice(0, 3)) {
    if (!ref || !fs.existsSync(ref)) continue;
    const buf = fs.readFileSync(ref);
    const mime = /\.png$/i.test(ref) ? "image/png" : "image/jpeg";
    parts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
  }

  await withGeminiAdmission(
    "image",
    async () => {
      const result = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: ["IMAGE", "TEXT"],
        },
      });

      const candidates = result.candidates ?? [];
      for (const c of candidates) {
        for (const part of c.content?.parts ?? []) {
          const data = (part as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
          if (data?.data) {
            fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
            fs.writeFileSync(opts.outPath, Buffer.from(data.data, "base64"));
            return;
          }
        }
      }
      throw new Error("Image model returned no image bytes");
    },
    { onStatus: opts.onStatus, maxAttempts: 4 },
  );
}

export async function generateImages(opts: {
  plan: ImagePlan;
  outDir: string;
  referenceImagePaths?: string[];
  onStatus?: (msg: string) => void;
}): Promise<GenerateImageResult> {
  const assetDir = path.join(opts.outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  const paths: string[] = [];

  for (const asset of opts.plan.assets) {
    const outPath = path.join(assetDir, asset.filename.replace(/[\\/]/g, "_"));
    if (asset.format === "svg") {
      const svg = asset.svg?.trim();
      if (!svg) {
        opts.onStatus?.(`Skipping SVG asset ${asset.id} (no markup)`);
        continue;
      }
      opts.onStatus?.(`Writing SVG ${asset.filename}…`);
      fs.writeFileSync(outPath, svg, "utf8");
    } else {
      const prompt = asset.prompt?.trim();
      if (!prompt) throw new Error(`PNG asset ${asset.id} missing prompt from Argon`);
      await generatePng({
        prompt: `${prompt}\n\nOutput size about ${asset.width}x${asset.height}.`,
        outPath,
        width: asset.width,
        height: asset.height,
        referenceImagePaths: opts.referenceImagePaths,
        onStatus: opts.onStatus,
      });
    }
    paths.push(outPath);
  }

  fs.writeFileSync(path.join(opts.outDir, "image_plan.json"), JSON.stringify(opts.plan, null, 2));
  return { paths };
}
