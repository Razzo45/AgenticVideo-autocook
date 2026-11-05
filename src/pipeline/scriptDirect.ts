import type { RunRow } from "../db";
import { formatInputsForScript, operatorAudioAssets, parseRunInputs } from "./inputs";
import { brainCompletion } from "./geminiBrain";
import { BRAIN_MODEL } from "./constants";
import { scriptPlanSchema, type ScriptPlan } from "./schema";

export type SegmentKind = "spoken" | "action";

function bucketTexts(items: string[], parts: number): string[] {
  if (parts <= 0) return [];
  if (!items.length) return Array.from({ length: parts }, () => "");
  if (items.length <= parts) {
    const out = items.map((s) => s.trim());
    while (out.length < parts) out.push("");
    return out;
  }
  const out: string[] = Array.from({ length: parts }, () => "");
  const per = items.length / parts;
  for (let i = 0; i < items.length; i++) {
    const bucket = Math.min(parts - 1, Math.floor(i / per));
    out[bucket] += (out[bucket] ? " " : "") + items[i];
  }
  return out.map((s) => s.trim());
}

/** Split operator script / beat sheet into N sequential segments for clip boundaries. */
export function segmentOperatorScript(text: string, parts: number): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) throw new Error("Operator script is empty");
  if (parts <= 0) throw new Error("Invalid shot count");
  if (parts === 1) return [cleaned];

  const paragraphs = cleaned
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length >= parts) return bucketTexts(paragraphs, parts);

  const sentences =
    cleaned.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [cleaned];
  if (sentences.length >= parts) return bucketTexts(sentences, parts);

  const words = cleaned.split(/\s+/);
  const chunk = Math.ceil(words.length / parts);
  const chunks: string[] = [];
  for (let i = 0; i < parts; i++) {
    chunks.push(words.slice(i * chunk, (i + 1) * chunk).join(" ").trim());
  }
  const nonEmpty = chunks.filter(Boolean);
  return nonEmpty.length >= parts ? chunks : bucketTexts(nonEmpty.length ? nonEmpty : [cleaned], parts);
}

export function resolveOperatorScript(run: RunRow): string {
  const fromField = run.operator_script?.trim();
  if (fromField) return fromField;
  const assets = parseRunInputs(run.input_assets_json);
  const textParts = assets.filter((a) => a.textContent).map((a) => a.textContent!);
  if (textParts.length) return textParts.join("\n\n");
  throw new Error("Direct pipeline requires an operator script (textarea or .md/.txt attachment).");
}

/**
 * Heuristic: spoken dialogue / VO vs production / camera / timing beats.
 * Prefer "action" when timing, plates, composites, or directive stage language dominate.
 */
export function classifySegmentKind(segment: string): SegmentKind {
  const t = segment.trim();
  if (!t) return "action";

  const lower = t.toLowerCase();
  let actionScore = 0;
  let spokenScore = 0;

  if (/^section\s+\d+/i.test(t)) actionScore += 3;
  if (/\bframes?\s+\d+/i.test(t) || /\b\d{2}:\d{2}:\d{2}/.test(t)) actionScore += 3;
  if (/\b(plate|matte|alpha|vfx|composite|keyframe|timecode|hold through|pre-transform)\b/i.test(t)) {
    actionScore += 3;
  }
  if (
    /\b(preserve framing|use the|gradually|align with|no audio|photoreal|handheld|grain|wardrobe)\b/i.test(
      t,
    )
  ) {
    actionScore += 2;
  }
  if (/\b(do not|must not|keep|match|track|overlay|bookend)\b/i.test(t)) actionScore += 1;

  if (/["“'].{8,}["”']/.test(t)) spokenScore += 4;
  if (/^(VO|V\.O\.|OS|O\.S\.|NARRATOR|HOST|PRESENTER)\s*[:\-]/i.test(t)) spokenScore += 4;
  if (/\b(says?|said|asks?|replies|speaks?|dialogue|line|teleprompter|spoken)\b/i.test(lower)) {
    spokenScore += 2;
  }
  // First-person copy without heavy production jargon
  if (/\b(i |we |i'm |we're )\b/i.test(t) && actionScore < 3) {
    spokenScore += 2;
  }

  if (actionScore >= spokenScore + 1) return "action";
  if (spokenScore >= 2) return "spoken";
  // Longer directive paragraphs without quotes → treat as action beats
  if (t.length > 120 && !/["“']/.test(t) && /[.!].*[.!]/s.test(t)) return "action";
  return spokenScore > actionScore ? "spoken" : "action";
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Model did not return JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

function audioGuidance(brief: string, hasAudioAttachments: boolean): string {
  const wantsScore =
    hasAudioAttachments ||
    /\b(score|soundtrack|music bed|underscore|diegetic music|needle[\s-]?drop)\b/i.test(brief);
  const wantsSilent = /\b(no audio|silent|mute|without (sound|audio)|picture[- ]only)\b/i.test(brief);
  if (wantsSilent) return "Follow the brief: keep this clip silent / no invented soundtrack.";
  if (wantsScore) {
    return "Follow the brief and any attached audio for sound; do not invent a different soundtrack.";
  }
  return "Sound: follow the brief. Prefer diegetic sync to visible action unless the brief asks for score.";
}

function motionPromptForSegment(
  segment: string,
  brief: string,
  kind: SegmentKind,
  reviseNote: string | null | undefined,
  hasAudioAttachments: boolean,
): string {
  const lines: string[] = [];
  if (reviseNote?.trim()) {
    lines.push(`HARD REQUIREMENT — follow exactly: ${reviseNote.trim()}`, "");
  }

  if (kind === "spoken") {
    lines.push(
      `VERBATIM spoken content (do not paraphrase or omit): ${segment}`,
      "",
      "Production brief (visual execution):",
      brief.slice(0, 800),
      "",
      "Deliver dialogue naturally. Camera and performance follow the brief.",
      audioGuidance(brief, hasAudioAttachments),
    );
  } else {
    lines.push(
      "PRODUCTION / ACTION BEATS (execute on screen — these are NOT spoken lines):",
      segment,
      "",
      "Production brief (visual execution):",
      brief.slice(0, 800),
      "",
      "Translate the beats into on-screen action (camera, performance, lighting, effects as the brief requires).",
      "Do NOT narrate, read aloud, or caption these instructions. No invented dialogue.",
      audioGuidance(brief, hasAudioAttachments),
    );
  }
  return lines.join("\n");
}

function defaultImagePrompt(segment: string, brief: string, index: number, total: number, aspect: string): string {
  return [
    `${aspect} opening still, panel ${index + 1} of ${total}.`,
    "Match the brief's visual style and attachments — do not invent a house look.",
    brief.slice(0, 500),
    `Moment for this panel: ${segment.slice(0, 280)}`,
  ].join(" ");
}

export async function buildDirectScriptPlan(opts: {
  run: RunRow;
  durations: number[];
  reviseComment?: string | null;
}): Promise<ScriptPlan> {
  const { run, durations } = opts;
  const brief = run.initial_prompt.trim();
  const scriptText = resolveOperatorScript(run);
  const segments = segmentOperatorScript(scriptText, durations.length);
  while (segments.length < durations.length) segments.push(segments[segments.length - 1] ?? "");
  if (segments.length > durations.length) segments.length = durations.length;

  const hasAudioAttachments = operatorAudioAssets(run.input_assets_json).length > 0;
  const kinds = segments.map((s) => classifySegmentKind(s));
  const shots = segments.map((segment, i) => ({
    index: i,
    duration: durations[i]!,
    media_desc: segment.slice(0, 220) || `Panel ${i + 1}`,
    motion_prompt: motionPromptForSegment(
      segment,
      brief,
      kinds[i]!,
      opts.reviseComment,
      hasAudioAttachments,
    ),
    image_prompt: defaultImagePrompt(segment, brief, i, durations.length, run.aspect_ratio),
  }));

  let meta = {
    media_desc: brief.slice(0, 280),
    tags: ["direct"],
    subjects: [] as string[],
    setting: "As specified in the production brief",
    visual_style: brief.slice(0, 400),
    content_safety_notes: "",
  };

  try {
    const attachments = formatInputsForScript(run.input_assets_json);
    const system = `You prepare shot stills and motion prompts for a Direct video pipeline.
Mold every field to THIS run's brief and attachments — do not assume a genre, brand, presenter, or house look.
Each locked segment is either SPOKEN (meant to be heard/mouthed) or ACTION (production / camera / timing beats).
Return ONLY JSON:
{"media_desc":string,"tags":string[],"subjects":string[],"setting":string,"visual_style":string,"content_safety_notes":string,"shots":[{"index":number,"kind":"spoken"|"action","image_prompt":string,"motion_prompt":string}]}
Rules:
- Exactly ${shots.length} shots with indices 0..${shots.length - 1}.
- Classify each segment from its text. Prefer "action" for SECTION/timecode/frame/plate/matte/composite/directive language. Prefer "spoken" only when the segment is meant to be heard or mouthed on camera.
- SPOKEN: preserve exact wording in motion_prompt under a "VERBATIM spoken content" line. Do not paraphrase dialogue. image_prompt = opening still while that line is delivered.
- ACTION: motion_prompt must instruct visual execution only. Never wrap ACTION text as spoken content. Never invent dialogue or ask the model to read the beat sheet aloud. Keep timing/frame intents from the segment. image_prompt = opening still for that beat.
- subjects/setting/visual_style must come from the brief and attachments (empty subjects array is fine if unnamed).
- Only mention on-screen branding if the brief or logo attachments require it. Category: ${run.category}. Aspect: ${run.aspect_ratio}.`;
    const user = `Production brief:\n${brief}\n\n${attachments ? `${attachments}\n\n` : ""}Locked segments (classify each; do not invent a different story):\n${segments
      .map((s, i) => `[${i}] hint=${kinds[i]}\n${s}`)
      .join("\n\n")}${opts.reviseComment ? `\n\nReviser notes: ${opts.reviseComment}` : ""}`;
    const content = await brainCompletion({
      model: BRAIN_MODEL,
      json: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = parseJsonObject(content) as {
      media_desc?: string;
      tags?: string[];
      subjects?: string[];
      setting?: string;
      visual_style?: string;
      content_safety_notes?: string;
      shots?: Array<{
        index: number;
        kind?: string;
        image_prompt?: string;
        motion_prompt?: string;
      }>;
    };
    meta = {
      media_desc: parsed.media_desc?.trim() || meta.media_desc,
      tags: parsed.tags?.length ? parsed.tags : meta.tags,
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects.filter(Boolean) : meta.subjects,
      setting: parsed.setting?.trim() || meta.setting,
      visual_style: parsed.visual_style?.trim() || meta.visual_style,
      content_safety_notes: parsed.content_safety_notes?.trim() || "",
    };
    for (const row of parsed.shots ?? []) {
      const shot = shots[row.index];
      if (!shot) continue;
      const kind: SegmentKind =
        row.kind === "spoken" || row.kind === "action"
          ? row.kind
          : kinds[row.index] ?? classifySegmentKind(segments[row.index] ?? "");
      if (row.image_prompt?.trim()) shot.image_prompt = row.image_prompt.trim();
      if (row.motion_prompt?.trim()) {
        const mp = row.motion_prompt.trim();
        // Guard: never let action beats ship under the spoken prefix.
        if (kind === "action" && /verbatim spoken content/i.test(mp)) {
          shot.motion_prompt = motionPromptForSegment(
            segments[row.index]!,
            brief,
            "action",
            opts.reviseComment,
            hasAudioAttachments,
          );
        } else if (kind === "spoken" && !/verbatim spoken content/i.test(mp)) {
          shot.motion_prompt = motionPromptForSegment(
            segments[row.index]!,
            brief,
            "spoken",
            opts.reviseComment,
            hasAudioAttachments,
          );
        } else {
          shot.motion_prompt = mp;
        }
      } else {
        shot.motion_prompt = motionPromptForSegment(
          segments[row.index]!,
          brief,
          kind,
          opts.reviseComment,
          hasAudioAttachments,
        );
      }
    }
  } catch {
    // Deterministic fallbacks above are enough to proceed.
  }

  return scriptPlanSchema.parse({ ...meta, shots });
}
