/**
 * Autocook brain — Gemini 4 (Argon or Carbon) via GEMINI_API_KEY only.
 * Used for storyboard, audio extract, EDL refine, and input vision cataloguing.
 * Document cooks may use brainWithTools (image/video/SVG) like gemini.google.com.
 */
import fs from "node:fs";
import path from "node:path";
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { BRAIN_MODEL } from "./constants";
import { brainLabel } from "./brainChoice";
import { currentGeminiOwnerId, withGeminiAdmission } from "./geminiAdmission";
import {
  BRAIN_ROUND_TIMEOUT_MS,
  getRunSignal,
  isCancelledError,
  isPlatformFaultError,
  withDeadline,
  withStatusHeartbeat,
} from "./runControl";

function brainCallSignal(): AbortSignal | undefined {
  const owner = currentGeminiOwnerId();
  return owner ? getRunSignal(owner) : undefined;
}

async function generateContentBounded<T>(
  label: string,
  work: () => Promise<T>,
  onStatus?: (msg: string) => void,
): Promise<T> {
  return withGeminiAdmission(
    "brain",
    () =>
      withDeadline(work(), {
        timeoutMs: BRAIN_ROUND_TIMEOUT_MS,
        label,
        signal: brainCallSignal(),
        onStatus,
      }),
    { onStatus },
  );
}

export type BrainMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

const STAGED_MARKUP_TOOLS = new Set(["write_html", "write_svg"]);
const STAGED_MARKUP_SCRUB_CHARS = 400;

/**
 * After write_html / write_svg succeed, the full markup sits in the functionCall
 * args and would be re-sent every later round — that blows the context and hangs
 * round 2+. Keep a short stub; the platform already staged the bytes on disk.
 */
function scrubStagedMarkupArgs(parts: Part[]): Part[] {
  return parts.map((part) => {
    const call = (part as { functionCall?: { name?: string; args?: Record<string, unknown>; id?: string } })
      .functionCall;
    if (!call?.name || !STAGED_MARKUP_TOOLS.has(call.name) || !call.args) return part;
    const args = { ...call.args };
    for (const key of ["html", "svg"] as const) {
      const value = args[key];
      if (typeof value !== "string" || value.length <= STAGED_MARKUP_SCRUB_CHARS) continue;
      args[key] = `[staged ${value.length} chars — already stored by ${call.name}; do not repeat]`;
    }
    return {
      functionCall: {
        name: call.name,
        id: call.id,
        args,
      },
    } as Part;
  });
}

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env (Google AI Studio key) for the autocook brain.",
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

/** Text (optional JSON) completion via the selected brain. */
export async function brainCompletion(opts: {
  model?: string;
  messages: BrainMessage[];
  json?: boolean;
  /** Cap the reply. Gemini's sync default is 65536; composition needs the full document. */
  maxOutputTokens?: number;
  /** Operator turn, including attached files. When set, message text parts are not used. */
  userParts?: Part[];
  onStatus?: (msg: string) => void;
}): Promise<string> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const { system, parts } = flattenMessages(opts.messages);
  const userParts = opts.userParts?.length ? opts.userParts : (parts as Part[]);
  if (!userParts.length) throw new Error("brainCompletion: empty user content");
  const label = `${brainLabel(model)} is writing the deliverables`;
  opts.onStatus?.(`${label}…`);

  // JSON composition (HTML in the reply) must wait for Gemini — a 13m deadline
  // plus admission retry on "timed out" discarded the document and looped.
  const result = await withGeminiAdmission(
    "brain",
    () =>
      withStatusHeartbeat(
        ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: userParts }],
          config: {
            ...(system ? { systemInstruction: system } : {}),
            ...(opts.json ? { responseMimeType: "application/json" } : {}),
            ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            abortSignal: brainCallSignal(),
          },
        }),
        { label, onStatus: opts.onStatus },
      ),
    { onStatus: opts.onStatus },
  );
  const text = (result.text ?? "").trim();
  if (!text) throw new Error(`${brainLabel(model)} brain (${model}) returned no content`);
  return text;
}

/** Vision cataloguing via the brain (replaces OpenRouter visionCompletion for brain tasks). */
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
 * Multi-turn brain completion with function tools (media generate/inline).
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
  const label = brainLabel(model);
  const maxRounds = opts.maxRounds ?? 16;

  const contents: Content[] = [
    { role: "user", parts: opts.userParts?.length ? opts.userParts : [{ text: opts.user }] },
  ];
  let emptyStreak = 0;

  for (let round = 0; round < maxRounds; round++) {
    opts.onStatus?.(`${label} tool round ${round + 1}/${maxRounds}…`);
    const roundLabel = `${label} tool round ${round + 1}/${maxRounds}`;
    const callRound = () =>
      generateContentBounded(
        roundLabel,
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
        opts.onStatus,
      );
    let result;
    try {
      result = await callRound();
    } catch (err) {
      // One retry on a hung/timed-out brain round — same as the composition mistake pingback.
      if (isCancelledError(err)) throw err;
      const timedOut =
        isPlatformFaultError(err) && /timed out/i.test(err instanceof Error ? err.message : String(err));
      if (!timedOut) throw err;
      opts.onStatus?.(`${roundLabel} timed out — one retry…`);
      result = await callRound();
    }

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
      if (text) return text;
      emptyStreak += 1;
      if (emptyStreak >= 3) {
        throw new Error(`${label} brain (${model}) returned no content after tools`);
      }
      contents.push({
        role: "user",
        parts: [
          {
            text: "Your previous reply was empty. Call write_svg if the markup is large, or reply with the JSON object only. Do not return an empty message.",
          },
        ],
      });
      continue;
    }

    emptyStreak = 0;
    contents.push({ role: "model", parts: modelParts });

    const responseParts: Part[] = [];
    let scrubMarkup = false;
    for (const fc of calls) {
      const name = fc.name ?? "";
      const args = (fc.args ?? {}) as Record<string, unknown>;
      opts.onStatus?.(`Executing tool ${name}…`);
      let response: Record<string, unknown>;
      try {
        response = await opts.onTool(name, args);
        if (STAGED_MARKUP_TOOLS.has(name) && response.ok !== false) scrubMarkup = true;
      } catch (err) {
        // Cancel / platform timeout → stop the cook. Tool contract mistakes → one pingback.
        if (isCancelledError(err) || isPlatformFaultError(err)) throw err;
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
    // Drop staged markup from prior model turns so the next round stays thin.
    if (scrubMarkup) {
      for (let i = 0; i < contents.length; i++) {
        const turn = contents[i];
        if (turn?.role !== "model" || !turn.parts?.length) continue;
        contents[i] = { role: "model", parts: scrubStagedMarkupArgs(turn.parts) };
      }
    }
  }

  throw new Error(`${label} tool loop exceeded ${maxRounds} rounds without a final plan`);
}

export type GuidedSvgTarget = { id: string; filename: string; note?: string };

function writeSvgMatchesTarget(
  args: Record<string, unknown>,
  target: GuidedSvgTarget,
): boolean {
  const id = String(args.id ?? "").trim();
  const filename = String(args.filename ?? "").trim();
  return (
    id === target.id ||
    filename === target.filename ||
    filename.endsWith(target.filename) ||
    path.basename(filename) === path.basename(target.filename)
  );
}

/**
 * One session for multi-SVG tasks: write_svg one file per turn (forced tool), then thin JSON.
 * Avoids asking the brain for several outlined logos in a single completion.
 */
export async function brainGuidedWriteSvgThenJson(opts: {
  model?: string;
  system: string;
  userParts: Part[];
  svgTargets: GuidedSvgTarget[];
  tools: FunctionDeclaration[];
  onTool: BrainToolHandler;
  onStatus?: (msg: string) => void;
  perSvgAttempts?: number;
}): Promise<string> {
  const ai = brainClient();
  const model = opts.model?.trim() || BRAIN_MODEL;
  const label = brainLabel(model);
  const perSvgAttempts = opts.perSvgAttempts ?? 4;
  const writeSvgTools = opts.tools.filter((tool) => tool.name === "write_svg");
  if (!writeSvgTools.length) throw new Error("brainGuidedWriteSvgThenJson requires write_svg");

  const contents: Content[] = [{ role: "user", parts: opts.userParts }];
  const system = `${opts.system}

Multi-SVG mode: you will be asked for one write_svg at a time. Never emit all marks in one reply. After every mark is staged, you will return thin JSON with empty svg bodies.`;

  for (let i = 0; i < opts.svgTargets.length; i++) {
    const target = opts.svgTargets[i]!;
    const note = target.note?.trim() ? ` Note: ${target.note.trim()}` : "";
    contents.push({
      role: "user",
      parts: [
        {
          text: `Call write_svg exactly once for id="${target.id}" filename="${target.filename}".${note} Put the FULL SVG document in the tool arguments. Do not return the final JSON yet. Only this one file (${i + 1}/${opts.svgTargets.length}).`,
        },
      ],
    });

    let landed = false;
    for (let attempt = 0; attempt < perSvgAttempts; attempt++) {
      opts.onStatus?.(
        `${label} write_svg ${i + 1}/${opts.svgTargets.length} (${target.filename})…`,
      );
      const result = await generateContentBounded(
        `${label} write_svg ${i + 1}/${opts.svgTargets.length}`,
        () =>
          ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: system,
              tools: [{ functionDeclarations: writeSvgTools }],
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.ANY,
                  allowedFunctionNames: ["write_svg"],
                },
              },
              thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            },
          }),
        opts.onStatus,
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
        contents.push({
          role: "user",
          parts: [
            {
              text: `Empty reply. Call write_svg once for id="${target.id}" filename="${target.filename}" with the full SVG markup.`,
            },
          ],
        });
        continue;
      }

      contents.push({ role: "model", parts: modelParts.length ? modelParts : candidateParts });
      const responseParts: Part[] = [];
      let scrubMarkup = false;
      for (const fc of calls) {
        const name = fc.name ?? "";
        const args = (fc.args ?? {}) as Record<string, unknown>;
        opts.onStatus?.(`Executing tool ${name}…`);
        let response: Record<string, unknown>;
        try {
          response = await opts.onTool(name, args);
          if (STAGED_MARKUP_TOOLS.has(name) && response.ok !== false) scrubMarkup = true;
        } catch (err) {
          if (isCancelledError(err) || isPlatformFaultError(err)) throw err;
          response = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        responseParts.push({
          functionResponse: { name, id: fc.id, response },
        } as Part);
      }
      contents.push({ role: "user", parts: responseParts });
      if (scrubMarkup) {
        for (let i = 0; i < contents.length; i++) {
          const turn = contents[i];
          if (turn?.role !== "model" || !turn.parts?.length) continue;
          contents[i] = { role: "model", parts: scrubStagedMarkupArgs(turn.parts) };
        }
      }

      const wroteTarget = calls.some(
        (fc) => fc.name === "write_svg" && writeSvgMatchesTarget((fc.args ?? {}) as Record<string, unknown>, target),
      );
      if (wroteTarget) {
        landed = true;
        break;
      }
      contents.push({
        role: "user",
        parts: [
          {
            text: `That write_svg was not for id="${target.id}" / "${target.filename}". Call write_svg once for that exact id and filename.`,
          },
        ],
      });
    }
    if (!landed) {
      throw new Error(`${label} did not write_svg for ${target.filename} after ${perSvgAttempts} attempts`);
    }
  }

  contents.push({
    role: "user",
    parts: [
      {
        text: `All SVG marks are staged via write_svg. Reply with the JSON object only — one deliverable per planned file, kind "svg", matching ids and filenames, omit "svg" (or leave it empty). No more tool calls.`,
      },
    ],
  });

  let emptyStreak = 0;
  for (let round = 0; round < 4; round++) {
    opts.onStatus?.(`${label} composing thin SVG JSON…`);
    const result = await generateContentBounded(
      `${label} composing thin SVG JSON`,
      () =>
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            tools: [{ functionDeclarations: writeSvgTools }],
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
            },
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          },
        }),
      opts.onStatus,
    );
    const text = (result.text ?? "").trim();
    if (text) return text;
    emptyStreak += 1;
    if (emptyStreak >= 3) {
      throw new Error(`${label} returned no JSON after staged SVGs`);
    }
    contents.push({
      role: "user",
      parts: [
        {
          text: "Your previous reply was empty. Reply with the JSON object only (thin svg deliverables, no tool calls).",
        },
      ],
    });
  }
  throw new Error(`${label} guided SVG session ended without JSON`);
}

export type GuidedHtmlTarget = { id: string; filename: string; note?: string };
