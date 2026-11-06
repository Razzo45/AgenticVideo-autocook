/**
 * Argon splits one operator task into one cook per deliverable.
 * The platform then enqueues each kind separately.
 */
import { z } from "zod";
import { brainCompletion } from "../pipeline/geminiBrain";
import { BRAIN_MODEL } from "../pipeline/constants";
import { cookKindSchema, type CookKind } from "../pipeline/schemaDocs";
import { inferCookKind } from "./inferCookKind";

const MAX_PER_KIND = 3;
const MAX_COOKS = 6;

const rawItemSchema = z.object({
  kind: cookKindSchema,
  count: z.preprocess((v) => {
    const n = Number(v);
    const floored = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    return Math.min(MAX_PER_KIND, floored);
  }, z.number().int().min(1).max(MAX_PER_KIND)),
  label: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
  brief: z.preprocess((v) => (v == null ? "" : String(v)), z.string()),
});

export type SplitCook = {
  kind: CookKind;
  label: string;
  brief: string;
};

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Brain returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/** Expand Argon's `{ cooks: [{ kind, count, label, brief }] }` into one entry per file. */
export function normalizeCookSplit(raw: unknown, fallbackPrompt: string): SplitCook[] {
  const body = raw && typeof raw === "object" ? (raw as { cooks?: unknown }) : {};
  const list = Array.isArray(body.cooks) ? body.cooks : Array.isArray(raw) ? raw : [];
  const out: SplitCook[] = [];
  for (const item of list) {
    const parsed = rawItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const brief = parsed.data.brief.trim() || fallbackPrompt.trim();
    const label = parsed.data.label.trim() || parsed.data.kind;
    const count = parsed.data.count;
    for (let n = 0; n < count && out.length < MAX_COOKS; n++) {
      out.push({
        kind: parsed.data.kind,
        label: count > 1 ? `${label} ${n + 1}` : label,
        brief,
      });
    }
  }
  return out;
}

export function fallbackCookSplit(prompt: string, attachmentNames: string[] = []): SplitCook[] {
  const kind = inferCookKind(prompt, attachmentNames);
  return [{ kind, label: kind, brief: prompt.trim() }];
}

export async function splitCooks(input: {
  prompt: string;
  attachmentNames?: string[];
}): Promise<SplitCook[]> {
  const prompt = input.prompt.trim();
  const names = input.attachmentNames ?? [];
  const system = `You split one operator task into separate autocook jobs. Each job produces exactly one file of one type.
Return ONE JSON object:
{"cooks":[{"kind":"video"|"audio"|"html"|"image"|"pptx"|"pdf","count":number,"label":string,"brief":string}]}
Rules:
- Include only deliverable types the task actually asks for. Do not invent extras.
- count is how many separate files of that kind. Usually 1. Never more than ${MAX_PER_KIND}.
- One task that asks for a single video, deck, image, page, pdf, or audio file is ONE cook.
- A task that asks for two types (video and a png, audio and a pdf, a deck and a thumbnail) is one cook per type.
- brief is the focus for that file only (what this file is). Keep required facts out of invention. One or two sentences.
- kind image = png/jpg/still/thumbnail. video = mp4. audio = voice, music, podcast, wav. pptx = slides. pdf = document. html = web page.`;

  const user = [
    `TASK:\n${prompt}`,
    names.length ? `\nATTACHED FILES:\n${names.map((n) => `- ${n}`).join("\n")}` : "\nATTACHED FILES: (none)",
  ].join("\n");

  try {
    const raw = await brainCompletion({
      model: BRAIN_MODEL,
      json: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const cooks = normalizeCookSplit(parseJsonObject(raw), prompt);
    if (cooks.length) return cooks;
  } catch (err) {
    console.warn("[splitCooks] falling back to single kind", err instanceof Error ? err.message : err);
  }
  return fallbackCookSplit(prompt, names);
}
