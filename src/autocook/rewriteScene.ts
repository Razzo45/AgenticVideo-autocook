/**
 * Silent Argon rewrite of a filtered scene — no HITL / plate UI.
 */
import { brainCompletion } from "../pipeline/geminiBrain";
import { BRAIN_MODEL } from "../pipeline/constants";
import type { ScriptPlan } from "../pipeline/schema";

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Scene rewrite returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export async function rewriteSceneForFilter(opts: {
  plan: ScriptPlan;
  shotIndex: number;
  filterMessage: string;
  operatorBrief?: string;
}): Promise<{ image_prompt: string; motion_prompt: string; media_desc?: string }> {
  const shot = opts.plan.shots[opts.shotIndex];
  if (!shot) throw new Error(`No shot ${opts.shotIndex}`);

  const system = `You rewrite ONE video scene so Gemini Omni will accept it after a content filter.
Return JSON only: {"image_prompt":string,"motion_prompt":string,"media_desc":string}
Keep the same creative intent, duration feel, and continuity. Remove gore, weapon impact, sexual content, copyrighted song lyrics, and real-artist voice clones. Prefer camera, performance, and diegetic sound.`;

  const user = [
    opts.operatorBrief?.trim() ? `OPERATOR BRIEF:\n${opts.operatorBrief.trim()}\n` : "",
    `FILTER ERROR:\n${opts.filterMessage}`,
    `\nSCENE ${opts.shotIndex} image_prompt:\n${shot.image_prompt}`,
    `\nSCENE ${opts.shotIndex} motion_prompt:\n${shot.motion_prompt}`,
  ].join("\n");

  const raw = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const parsed = parseJsonObject(raw) as {
    image_prompt?: string;
    motion_prompt?: string;
    media_desc?: string;
  };
  const image_prompt = parsed.image_prompt?.trim() || shot.image_prompt;
  const motion_prompt = parsed.motion_prompt?.trim() || shot.motion_prompt;
  if (!motion_prompt) throw new Error("Scene rewrite produced empty motion_prompt");
  return {
    image_prompt,
    motion_prompt,
    media_desc: parsed.media_desc?.trim() || shot.media_desc,
  };
}

/** Patch a ScriptPlan shot in place (returns new plan object). */
export function applySceneRewrite(
  plan: ScriptPlan,
  shotIndex: number,
  patch: { image_prompt: string; motion_prompt: string; media_desc?: string },
): ScriptPlan {
  const shots = plan.shots.map((s, i) =>
    i === shotIndex
      ? {
          ...s,
          image_prompt: patch.image_prompt,
          motion_prompt: patch.motion_prompt,
          media_desc: patch.media_desc ?? s.media_desc,
        }
      : s,
  );
  return { ...plan, shots };
}
