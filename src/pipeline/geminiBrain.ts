/**
 * Autocook brain — Gemini 4 Argon via GEMINI_API_KEY only.
 * Used for storyboard, audio extract, EDL refine, and input vision cataloguing.
 * Document cooks may use brainWithTools (image/video/SVG) like gemini.google.com.
 */
import fs from "node:fs";
import {
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { BRAIN_MODEL } from "./constants";
import { withGeminiAdmission } from "./geminiAdmission";

export type BrainMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env (Google AI Studio key) for the Argon autocook brain.",
    );
  }
  return key;
}

function brainClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireGeminiKey() });
}

function dataUrlToInline(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  return { mimeType: m[1]!, data: m[2]! };
}

function flattenMessages(messages: BrainMessage[]): {
  system?: string;
  parts: Array<Record<string, unknown>>;
} {
  const systemBits: string[] = [];
  const parts: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemBits.push(msg.content);
      continue;
    }
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "image_url") {
        const inline = dataUrlToInline(block.image_url.url);
        if (inline) {
          parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
        } else if (fs.existsSync(block.image_url.url)) {
          const buf = fs.readFileSync(block.image_url.url);
          const ext = block.image_url.url.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
          parts.push({ inlineData: { mimeType: ext, data: buf.toString("base64") } });
        }
      }
    }
  }
  return { system: systemBits.length ? systemBits.join("\n\n") : undefined, parts };
}

/** Text (optional JSON) completion via Argon. */
export async function brainCompletion(opts: {
  model?: string;
  messages: BrainMessage[];
  json?: boolean;
}): Promise<string> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const { system, parts } = flattenMessages(opts.messages);
  if (!parts.length) throw new Error("brainCompletion: empty user content");

  return withGeminiAdmission("argon", async () => {
    const result = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        ...(system ? { systemInstruction: system } : {}),
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
        // Argon thinking — medium is the API default; keep explicit for autocook planning.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    const text = (result.text ?? "").trim();
    if (!text) throw new Error(`Argon brain (${model}) returned no content`);
    return text;
  });
}

/** Vision cataloguing via Argon (replaces OpenRouter visionCompletion for brain tasks). */
export async function brainVisionCompletion(opts: {
  model?: string;
  system?: string;
  text: string;
  imageDataUrls: string[];
}): Promise<string> {
  const messages: BrainMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({
    role: "user",
    content: [
      { type: "text", text: opts.text },
      ...opts.imageDataUrls.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ],
  });
  return brainCompletion({ model: opts.model, messages, json: false });
}

export type BrainToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Multi-turn Argon completion with function tools (media generate/inline).
 * Returns the final text (expected JSON plan) after tools finish.
 */
export async function brainWithTools(opts: {
  model?: string;
  system: string;
  user: string;
  /** When set, this is the operator turn (text plus attached files). `user` is ignored. */
  userParts?: Part[];
  tools: FunctionDeclaration[];
  onTool: BrainToolHandler;
  maxRounds?: number;
  onStatus?: (msg: string) => void;
}): Promise<string> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const maxRounds = opts.maxRounds ?? 10;

  const contents: Content[] = [
    { role: "user", parts: opts.userParts?.length ? opts.userParts : [{ text: opts.user }] },
  ];

  for (let round = 0; round < maxRounds; round++) {
    opts.onStatus?.(`Argon tool round ${round + 1}/${maxRounds}…`);
    const result = await withGeminiAdmission(
      "argon",
      () =>
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: opts.system,
            tools: [{ functionDeclarations: opts.tools }],
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          },
        }),
      { onStatus: opts.onStatus },
    );

    const calls = result.functionCalls ?? [];
    const modelParts: Part[] = [];
    const candidateParts = result.candidates?.[0]?.content?.parts ?? [];
    if (candidateParts.length) {
      for (const p of candidateParts) modelParts.push(p as Part);
    } else if (calls.length) {
      for (const fc of calls) {
        modelParts.push({
          functionCall: { name: fc.name, args: fc.args ?? {}, id: fc.id },
        } as Part);
      }
    }

    if (!calls.length) {
      const text = (result.text ?? "").trim();
      if (!text) throw new Error(`Argon brain (${model}) returned no content after tools`);
      return text;
    }

    contents.push({ role: "model", parts: modelParts });

    const responseParts: Part[] = [];
    for (const fc of calls) {
      const name = fc.name ?? "";
      const args = (fc.args ?? {}) as Record<string, unknown>;
      opts.onStatus?.(`Executing tool ${name}…`);
      let response: Record<string, unknown>;
      try {
        response = await opts.onTool(name, args);
      } catch (err) {
        response = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      responseParts.push({
        functionResponse: {
          name,
          id: fc.id,
          response,
        },
      } as Part);
    }
    contents.push({ role: "user", parts: responseParts });
  }

  throw new Error(`Argon tool loop exceeded ${maxRounds} rounds without a final plan`);
}
