import { z } from "zod";
import type { RunRow } from "../db";

/** Hands-off requirement toggles for auto pipeline runs. */
export const autoOptionsSchema = z.object({
  /** Request 4K delivery (3840×2160 class). */
  deliver4k: z.boolean().default(false),
  /**
   * Long cook — allows the full auto duration window (up to ~5 min of short scenes).
   * Off = shorter plan (fewer scenes).
   */
  longCook: z.boolean().default(true),
  /**
   * Lock named presenter / talent to attached headshot / portrait stills.
   * Best-effort face match — not a guaranteed identity clone.
   */
  presenterIdentity: z.boolean().default(true),
  /**
   * Use attached voice samples as tone/pace guidance for narration.
   * Not a true voice clone or lip-sync guarantee.
   */
  voiceGuidance: z.boolean().default(true),
  /** Preserve spoken lines from attached script / brief; do not paraphrase dialogue. */
  verbatimScript: z.boolean().default(true),
  /** Prefer attached logos/brand kit; do not invent alternate marks or off-brand palettes. */
  brandLock: z.boolean().default(true),
  /**
   * Ask for on-screen callouts / lower-thirds from the script.
   * Best-effort only — not frame-accurate NLE cueing.
   */
  timedGraphics: z.boolean().default(false),
});

export type AutoOptions = z.infer<typeof autoOptionsSchema>;

export const DEFAULT_AUTO_OPTIONS: AutoOptions = autoOptionsSchema.parse({});

export const AUTO_OPTION_FIELDS: Array<{
  key: keyof AutoOptions;
  label: string;
  note: string;
}> = [
  {
    key: "deliver4k",
    label: "4K delivery",
    note: "Requests 4K output when the video model supports it.",
  },
  {
    key: "longCook",
    label: "Long cook (up to 5 min)",
    note: "Plans enough short scenes to reach the long duration, then concatenates. Off = shorter assembly.",
  },
  {
    key: "presenterIdentity",
    label: "Presenter identity lock",
    note: "Match attached headshot/portrait when a named presenter appears. Best-effort face match.",
  },
  {
    key: "voiceGuidance",
    label: "Voice sample guidance",
    note: "Match attached voice tone/pace in narration prompts — not a true voice clone.",
  },
  {
    key: "verbatimScript",
    label: "Verbatim script lock",
    note: "Keep spoken lines from the attached script; do not rewrite dialogue.",
  },
  {
    key: "brandLock",
    label: "Brand lock",
    note: "Use attached logos/brand cues only; no invented marks or off-brief branding.",
  },
  {
    key: "timedGraphics",
    label: "Timed graphics cues",
    note: "Ask for on-screen callouts from the script. Not frame-accurate like an NLE.",
  },
];

export function parseAutoOptions(raw: unknown): AutoOptions {
  if (raw == null || raw === "") return { ...DEFAULT_AUTO_OPTIONS };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return autoOptionsSchema.parse({ ...DEFAULT_AUTO_OPTIONS, ...(parsed as object) });
  } catch {
    return { ...DEFAULT_AUTO_OPTIONS };
  }
}

export function autoOptionsFromRun(run: Pick<RunRow, "auto_options_json">): AutoOptions {
  return parseAutoOptions(run.auto_options_json);
}

/** Extra system/user rules injected when auto toggles are on. */
export function autoRequirementsPrompt(
  opts: AutoOptions,
  ctx?: { shot?: { image_prompt?: string; motion_prompt?: string; media_desc?: string } },
): string {
  const lines: string[] = [];
  if (opts.presenterIdentity) {
    lines.push(
      "PRESENTER IDENTITY: When a named presenter/talent appears, match the attached headshot/portrait for face, age, hair, and wardrobe continuity. Do not recast or invent a different host.",
      "PRESENTER DESCRIPTION: In image_prompt and motion_prompt, refer to the presenter by name only — never state their hair colour, age, ethnicity or build. The attached headshot alone defines how they look.",
      "PRESENTER LOCATION: Every shot with the presenter on camera must state their setting in image_prompt (the attached location reference when supplied) and that they are alone in frame unless the brief puts others with them. Never leave it implicit — the still otherwise drifts into the previous B-roll setting.",
      "PRESENTER BADGE: Name badges, pins, lanyards or branded wardrobe details stay small in frame (medium / medium-close framing) so no logo or lettering is legible. Never frame a close-up on a badge, and never render a readable logo on clothing — describe it as a small plain badge.",
    );
  }
  if (opts.voiceGuidance) {
    lines.push(
      "VOICE GUIDANCE: Attached voice sample(s) set narration tone, pace, and energy. Aim for that speaking style. This is guidance only — not a guaranteed voice clone or lip-sync lock.",
    );
  }
  if (opts.brandLock) {
    lines.push(
      "BRAND LOCK: When branding appears, use only attached logos/colors. Do not invent marks. If THIS scene forbids on-screen graphics, keep the take live-action with no logos.",
    );
  }
  if (opts.verbatimScript) {
    lines.push(
      "VERBATIM SCRIPT: Preserve spoken lines in the storyboard for editorial intent. For the video model take: natural speech motion only — do NOT burn dialogue as captions or force lip-sync to a full quoted script.",
    );
  }
  // Veo take classification: motion + image only. media_desc is editorial (stitch/title cards)
  // and must NOT force GRAPHICS CUES into the video-model prompt — that empty-filters Veo.
  const takeBlob = [ctx?.shot?.image_prompt, ctx?.shot?.motion_prompt].filter(Boolean).join("\n");
  const shotForbidsGraphics =
    /\b(no on-screen text|no text(?:\s+overlays?)?|zero on-screen|no title cards?|talking-head only|live-action \/ talking-head only|no motion graphics|no logos?|no graphics|absolute rules for this take:\s*no on-screen)\b/i.test(
      takeBlob,
    );
  const shotAsksGraphics =
    !shotForbidsGraphics &&
    /\b(animates? on screen|graphic appears|title card|lower[- ]?third|numbered list|bullet list|callout|motion[- ]?graphic|text overlay|large[, ]+clean graphic|on-screen text\/callouts)\b/i.test(
      takeBlob,
    );
  if (opts.timedGraphics && shotAsksGraphics) {
    lines.push(
      "GRAPHICS CUES (this scene): Include the on-screen text/callouts described in THIS scene's prompts as readable motion-graphics. Timing is best-effort — not frame-accurate NLE cueing.",
    );
  } else if (opts.timedGraphics && ctx?.shot) {
    lines.push(
      "GRAPHICS CUES: This scene is live-action / talking-head only — do NOT invent title cards, bullet lists, or on-screen text. Save graphics for scenes that ask for them.",
    );
  } else if (opts.timedGraphics) {
    lines.push(
      "GRAPHICS CUES: Include clear on-screen text/callouts when a scene's own prompts ask for them. Do not force graphics onto every shot.",
    );
  }
  if (opts.deliver4k) {
    lines.push("DELIVERY: Target sharp 4K-class detail suitable for 3840×2160 finishing.");
  }
  if (opts.longCook) {
    lines.push(
      "PACING: Long-form educational piece assembled from short scenes — cover every required section in order; prefer continue when the presenter stays on camera; cut for graphics/scene changes.",
    );
  }
  if (!lines.length) return "";
  return `\n\nAUTO REQUIREMENT TOGGLES (obey):\n- ${lines.join("\n- ")}`;
}

/** Filenames that look like presenter / talent plates. */
export function isLikelyPresenterStill(filename: string): boolean {
  return /\b(headshot|portrait|presenter|talent|speaker|host|head[\s_-]?shot)\b/i.test(filename.replace(/_+/g, " "));
}
