/**
 * Media tools Argon can call during document cooks — mirrors gemini.google.com
 * (generate image / video / SVG, then reference or inline in the deliverable).
 * Platform executes tools with Argon's prompts only — no creative wrappers.
 */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import { generateOmniVideo } from "../pipeline/geminiOmni";
import { withGeminiAdmission } from "../pipeline/geminiAdmission";
import type { HtmlMediaAsset } from "../pipeline/schemaDocs";

const IMAGE_MODEL = process.env.PRODUCT_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error("GEMINI_API_KEY is missing for Argon media tools.");
  }
  return key;
}

export const ARGON_MEDIA_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "generate_image",
    description:
      "Generate a PNG still (Gemini image). Use for photos, UI mock stills, textures to embed in HTML/PPTX. Returns relative path + optional data_uri for inlining.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "Stable asset id used as {{asset:id}} in HTML." },
        prompt: { type: Type.STRING, description: "Full image prompt — used verbatim." },
        filename: {
          type: Type.STRING,
          description: "Relative path in the bundle, e.g. assets/hero.png",
        },
        width: { type: Type.NUMBER },
        height: { type: Type.NUMBER },
        embed: {
          type: Type.STRING,
          description: "path (default) or data_uri for <img src=data:...>",
        },
      },
      required: ["id", "prompt", "filename"],
    },
  },
  {
    name: "generate_video",
    description:
      "Generate a short MP4 clip via Omni (Argon-owned prompt, no platform rewrite). Embed with <video src=...>. Always written as a file (not data URI).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        prompt: { type: Type.STRING, description: "Full motion prompt — used verbatim." },
        filename: {
          type: Type.STRING,
          description: "Relative path, e.g. assets/loop.mp4",
        },
        duration_sec: { type: Type.NUMBER, description: "3–10 seconds." },
        aspect: { type: Type.STRING, description: "16:9 or 9:16" },
      },
      required: ["id", "prompt", "filename"],
    },
  },
  {
    name: "write_svg",
    description:
      "Register SVG markup Argon authored (no rasterization). Prefer for logos/icons that must stay crisp.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        svg: { type: Type.STRING, description: "Full SVG document." },
        filename: { type: Type.STRING, description: "e.g. assets/mark.svg" },
        embed: { type: Type.STRING, description: "path or data_uri" },
      },
      required: ["id", "svg", "filename"],
    },
  },
];

export type StagedMedia = {
  id: string;
  format: HtmlMediaAsset["format"];
  filename: string;
  absPath: string;
  embed: "path" | "data_uri";
  mime: string;
  /** Set for png/svg when embed=data_uri or when caller needs inline. */
  dataUri?: string;
};

function mimeFor(format: HtmlMediaAsset["format"]): string {
  if (format === "png") return "image/png";
  if (format === "svg") return "image/svg+xml";
  if (format === "mp4") return "video/mp4";
  return "audio/wav";
}

function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("..")) throw new Error(`Unsafe media path: ${rel}`);
  return norm;
}

async function generatePngBytes(prompt: string): Promise<Buffer> {
  const ai = new GoogleGenAI({ apiKey: requireGeminiKey() });
  return withGeminiAdmission("image", async () => {
    const result = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt.trim() }] }],
      config: { responseModalities: ["IMAGE", "TEXT"] },
    });
    for (const c of result.candidates ?? []) {
      for (const part of c.content?.parts ?? []) {
        const data = (part as { inlineData?: { data?: string } }).inlineData;
        if (data?.data) return Buffer.from(data.data, "base64");
      }
    }
    throw new Error("generate_image: model returned no image bytes");
  });
}

export type MediaToolContext = {
  stagingDir: string;
  staged: Map<string, StagedMedia>;
  referenceImagePaths?: string[];
  onStatus?: (msg: string) => void;
};

export async function executeArgonMediaTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MediaToolContext,
): Promise<Record<string, unknown>> {
  fs.mkdirSync(ctx.stagingDir, { recursive: true });
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error(`${name}: id required`);

  if (name === "generate_image") {
    const filename = safeRel(String(args.filename ?? `assets/${id}.png`));
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("generate_image: prompt required");
    const embed = String(args.embed ?? "path") === "data_uri" ? "data_uri" : "path";
    ctx.onStatus?.(`Argon tool generate_image (${id})…`);
    const buf = await generatePngBytes(prompt);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buf);
    const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
    const staged: StagedMedia = {
      id,
      format: "png",
      filename,
      absPath,
      embed,
      mime: "image/png",
      dataUri,
    };
    ctx.staged.set(id, staged);
    return {
      ok: true,
      id,
      filename,
      mime: "image/png",
      embed,
      bytes: buf.length,
      placeholder: `{{asset:${id}}}`,
      data_uri_available: true,
      hint:
        embed === "data_uri"
          ? `Use {{asset:${id}}} — platform will inline as data URI.`
          : `Use src="{{asset:${id}}}" or src="${filename}".`,
    };
  }

  if (name === "write_svg") {
    const filename = safeRel(String(args.filename ?? `assets/${id}.svg`));
    const svg = String(args.svg ?? "").trim();
    if (!svg) throw new Error("write_svg: svg required");
    const embed = String(args.embed ?? "path") === "data_uri" ? "data_uri" : "path";
    ctx.onStatus?.(`Argon tool write_svg (${id})…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, svg, "utf8");
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    ctx.staged.set(id, {
      id,
      format: "svg",
      filename,
      absPath,
      embed,
      mime: "image/svg+xml",
      dataUri,
    });
    return {
      ok: true,
      id,
      filename,
      mime: "image/svg+xml",
      embed,
      placeholder: `{{asset:${id}}}`,
      hint: `Use {{asset:${id}}} in HTML (path or data URI per embed).`,
    };
  }

  if (name === "generate_video") {
    const filename = safeRel(String(args.filename ?? `assets/${id}.mp4`));
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("generate_video: prompt required");
    const duration = Math.min(10, Math.max(3, Number(args.duration_sec) || 5));
    const aspect = String(args.aspect ?? "16:9") === "9:16" ? "9:16" : "16:9";
    ctx.onStatus?.(`Argon tool generate_video (${id}, ${duration}s)…`);
    const absPath = path.join(ctx.stagingDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    await generateOmniVideo({
      prompt,
      outPath: absPath,
      duration,
      aspectRatio: aspect,
      brainOwnedPrompt: true,
      referenceImagePaths: ctx.referenceImagePaths,
      onStatus: ctx.onStatus,
    });
    ctx.staged.set(id, {
      id,
      format: "mp4",
      filename,
      absPath,
      embed: "path",
      mime: "video/mp4",
    });
    return {
      ok: true,
      id,
      filename,
      mime: "video/mp4",
      embed: "path",
      duration_sec: duration,
      placeholder: `{{asset:${id}}}`,
      hint: `Use <video src="{{asset:${id}}}" controls autoplay muted loop></video>`,
    };
  }

  throw new Error(`Unknown Argon media tool: ${name}`);
}

/** Materialize declarative plan assets (when Argon listed them without calling tools). */
export async function materializePlanAssets(
  assets: HtmlMediaAsset[],
  ctx: MediaToolContext,
): Promise<StagedMedia[]> {
  const out: StagedMedia[] = [];
  for (const asset of assets) {
    if (ctx.staged.has(asset.id)) {
      out.push(ctx.staged.get(asset.id)!);
      continue;
    }
    if (asset.format === "png") {
      await executeArgonMediaTool(
        "generate_image",
        {
          id: asset.id,
          prompt: asset.prompt,
          filename: asset.filename,
          width: asset.width,
          height: asset.height,
          embed: asset.embed,
        },
        ctx,
      );
    } else if (asset.format === "svg") {
      await executeArgonMediaTool(
        "write_svg",
        { id: asset.id, svg: asset.svg, filename: asset.filename, embed: asset.embed },
        ctx,
      );
    } else if (asset.format === "mp4") {
      await executeArgonMediaTool(
        "generate_video",
        {
          id: asset.id,
          prompt: asset.prompt,
          filename: asset.filename,
          duration_sec: asset.duration_sec,
        },
        ctx,
      );
    } else {
      // wav deferred — treat as missing
      throw new Error(`HTML asset format ${asset.format} not supported yet (use png/svg/mp4)`);
    }
    out.push(ctx.staged.get(asset.id)!);
  }
  return out;
}

/** Rewrite {{asset:id}} placeholders using staged media (path or data URI). */
export function rewriteAssetPlaceholders(content: string, staged: Iterable<StagedMedia>): string {
  let out = content;
  for (const m of staged) {
    const token = `{{asset:${m.id}}}`;
    const replacement =
      m.embed === "data_uri" && m.dataUri && (m.format === "png" || m.format === "svg")
        ? m.dataUri
        : m.filename.replace(/\\/g, "/");
    out = out.split(token).join(replacement);
  }
  return out;
}

export { mimeFor };
