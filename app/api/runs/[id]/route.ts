import { fail, ok, readJson } from "@/src/api";
import { assertRunOwner, isOwnerError } from "@/src/auth/assertOwner";
import { isAuthError, requireUser } from "@/src/auth/resolve";
import { deleteRun, patchRunModels, runDetail } from "@/src/pipeline/orchestrator";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    await assertRunOwner(id, user);
    const detail = await runDetail(id);
    if (!detail) return fail("not found", 404);
    return ok(detail);
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    if (isOwnerError(err)) return fail(err.message, err.status);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const user = await requireUser(req);
    await assertRunOwner(id, user);
    const body = await readJson<{
      scriptModel?: string;
      keyframeModel?: string;
      videoModel?: string;
    }>(req);
    const run = await patchRunModels(id, body);
    return ok({ run });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    if (isOwnerError(err)) return fail(err.message, err.status);
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, message === "Unknown run" ? 404 : 400);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const user = await requireUser(req);
    await assertRunOwner(id, user);
    const result = await deleteRun(id);
    return ok({ ok: true, ...result });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    if (isOwnerError(err)) return fail(err.message, err.status);
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, message === "Unknown run" ? 404 : 400);
  }
}
