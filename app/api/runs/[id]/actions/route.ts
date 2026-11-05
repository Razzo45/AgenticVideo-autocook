import { fail, ok, readJson } from "@/src/api";
import { assertRunOwner, isOwnerError } from "@/src/auth/assertOwner";
import { isAuthError, requireUser } from "@/src/auth/resolve";
import type { Checklist } from "@/src/pipeline/schema";
import {
  approveFinal,
  approveScript,
  editClip,
  failFinal,
  rejectClips,
  rejectKeyframes,
  reopenShot,
  retryRun,
  reviseScript,
  selectClip,
  selectKeyframe,
} from "@/src/pipeline/orchestrator";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const user = await requireUser(req);
    await assertRunOwner(id, user);
    const body = await readJson<{
      action: string;
      comment?: string;
      variantId?: string;
      aesthetic?: number;
      consistency?: number;
      checklist?: Checklist;
      useXfade?: boolean;
      shotIndex?: number;
      gate?: "keyframe" | "clip";
    }>(req);
    switch (body.action) {
      case "approve_script":
        await approveScript(id);
        break;
      case "revise_script":
        if (!body.comment?.trim()) return fail("comment required");
        await reviseScript(id, body.comment);
        break;
      case "select_keyframe":
        if (!body.variantId) return fail("variantId required");
        await selectKeyframe(id, body.variantId);
        break;
      case "reject_keyframes":
        if (!body.comment?.trim()) return fail("Write a direction for the next generation before rejecting.");
        await rejectKeyframes(id, body.comment);
        break;
      case "select_clip":
        if (!body.variantId || !body.checklist) return fail("variant + checklist required");
        await selectClip(
          id,
          body.variantId,
          { aesthetic: body.aesthetic ?? -1, consistency: body.consistency ?? -1 },
          body.checklist,
          Boolean(body.useXfade),
        );
        break;
      case "reject_clips":
        if (!body.comment?.trim()) return fail("Write a direction for the next generation before rejecting.");
        await rejectClips(id, body.comment);
        break;
      case "edit_clip":
        if (!body.variantId) return fail("Select the take to keep as the base.");
        if (!body.comment?.trim()) return fail("Write the one change to make on this take.");
        await editClip(id, body.variantId, body.comment);
        break;
      case "approve_final":
        if (!body.checklist) return fail("checklist required");
        await approveFinal(id, body.checklist, Boolean(body.useXfade));
        break;
      case "fail_final":
        if (!body.comment?.trim()) return fail("Write a direction for the next generation before rejecting.");
        await failFinal(id, body.comment);
        break;
      case "reopen_shot":
        if (typeof body.shotIndex !== "number") return fail("shotIndex required");
        await reopenShot(id, body.shotIndex, body.gate === "keyframe" ? "keyframe" : "clip");
        break;
      case "retry":
        await retryRun(id);
        break;
      default:
        return fail("unknown action");
    }
    return ok({ ok: true });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    if (isOwnerError(err)) return fail(err.message, err.status);
    return fail(err instanceof Error ? err.message : String(err), 400);
  }
}
