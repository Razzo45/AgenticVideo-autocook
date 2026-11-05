/**
 * Per-segment generation via Omni (no Seedream). cut = T2V; continue = join-frame I2V.
 */
import fs from "node:fs";
import path from "node:path";
import { omniNativeAspect, PRODUCT_VIDEO_MODEL } from "../pipeline/constants";
import { generateOmniVideo, OMNI_DURATIONS } from "../pipeline/geminiOmni";
import { extractLastFrameKeyframe } from "../pipeline/stitch";
import { imageDimensionsForAspect } from "../pipeline/constants";
import { rewriteSceneForFilter, applySceneRewrite } from "./rewriteScene";
import type { GenerateSegmentInput, GenerateSegmentResult } from "./types";
import type { ScriptPlan } from "../pipeline/schema";

function snapOmni(dur: number): number {
  let best: number = OMNI_DURATIONS[0]!;
  let bestDist = Math.abs(dur - best);
  for (const d of OMNI_DURATIONS) {
    const dist = Math.abs(dur - d);
    if (dist < bestDist || (dist === bestDist && d > best)) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

export async function generateSegment(input: GenerateSegmentInput): Promise<GenerateSegmentResult> {
  let plan: ScriptPlan = input.plan;
  let shot = plan.shots[input.shotIndex];
  if (!shot) throw new Error(`No shot at index ${input.shotIndex}`);
  const videoModel = input.videoModel ?? PRODUCT_VIDEO_MODEL;
  const transition = input.shotIndex === 0 ? "cut" : shot.transition === "continue" ? "continue" : "cut";
  const aspect = omniNativeAspect(input.aspect);
  const dim = imageDimensionsForAspect(aspect, input.outputResolution ?? "1080p");
  const duration = snapOmni(shot.duration);

  fs.mkdirSync(path.dirname(input.keyframeOutPath), { recursive: true });
  fs.mkdirSync(path.dirname(input.clipOutPath), { recursive: true });

  let firstFrame: string | undefined;
  if (transition === "continue" && input.previousClipPath && fs.existsSync(input.previousClipPath)) {
    input.onStatus?.(`Scene ${input.shotIndex + 1}: hard-join keyframe from previous clip…`);
    await extractLastFrameKeyframe(input.previousClipPath, input.keyframeOutPath, dim.width, dim.height);
    firstFrame = input.keyframeOutPath;
  }

  const maxRewrites = 2;
  let lastErr = "";
  for (let pass = 0; pass <= maxRewrites; pass++) {
    if (pass > 0) {
      input.onStatus?.(`Adjusting scene ${input.shotIndex + 1} (rewrite ${pass}/${maxRewrites})…`);
      const rewritten = await rewriteSceneForFilter({
        plan,
        shotIndex: input.shotIndex,
        filterMessage: lastErr || "content filtered",
      });
      plan = applySceneRewrite(plan, input.shotIndex, rewritten);
      shot = plan.shots[input.shotIndex]!;
    }
    try {
      input.onStatus?.(
        `Scene ${input.shotIndex + 1}: Omni ${firstFrame ? "image_to_video" : "text_to_video"} (${videoModel}, ${duration}s)…`,
      );
      await generateOmniVideo({
        prompt: shot.motion_prompt,
        aspectRatio: aspect,
        duration,
        firstFramePath: firstFrame,
        outPath: input.clipOutPath,
        outputResolution: input.outputResolution ?? "1080p",
        onStatus: input.onStatus,
      });
      return {
        shotIndex: input.shotIndex,
        keyframePath: firstFrame ?? input.keyframeOutPath,
        clipPath: input.clipOutPath,
        transition,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (pass >= maxRewrites) throw err;
      if (!/filter|blocked|no output|empty|safety|prohibited/i.test(lastErr)) throw err;
    }
  }
  throw new Error(lastErr || "generateSegment failed");
}
