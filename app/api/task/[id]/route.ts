import { fail, ok } from "@/src/api";
import { assertRunOwner, isOwnerError } from "@/src/auth/assertOwner";
import { isAuthError, requireUser } from "@/src/auth/resolve";
import type { AuthUser } from "@/src/auth/types";
import { findCookTask, type CookTaskItem } from "@/src/db";
import { runDetail } from "@/src/pipeline/orchestrator";
import { parseRunAbsPath } from "@/src/pipeline/storage";

function downloadUrl(finalPath: string | null): string | null {
  if (!finalPath) return null;
  const parsed = parseRunAbsPath(finalPath);
  const rel = parsed ? `runs/${parsed.runId}/${parsed.rel}` : finalPath.replaceAll("\\", "/");
  return `/api/media?path=${encodeURIComponent(rel)}&download=1`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const taskId = decodeURIComponent(id).trim();
    const cooks = await findCookTask(taskId, user.userId);
    if (!cooks) return fail("not found", 404);

    const items = [];
    for (const cook of cooks) {
      items.push(await cookStatus(cook, user));
    }
    const ready = items.filter((c) => c.status === "exported").length;
    return ok({
      taskId,
      total: items.length,
      ready,
      done: items.every((c) => c.status === "exported" || c.status === "failed" || c.status === "rejected"),
      cooks: items,
    });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    if (isOwnerError(err)) return fail(err.message, err.status);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

async function cookStatus(cook: CookTaskItem, user: AuthUser) {
  try {
    await assertRunOwner(cook.runId, user);
  } catch {
    return {
      ...publicCook(cook),
      status: "missing",
      error: "run not found",
      finalPath: null,
      downloadUrl: null,
    };
  }
  const detail = await runDetail(cook.runId);
  const run = detail?.run;
  const finalPath = detail?.finalPath ?? null;
  return {
    ...publicCook(cook),
    status: run?.status ?? "missing",
    error: run?.error ?? null,
    finalPath,
    downloadUrl: run?.status === "exported" ? downloadUrl(finalPath) : null,
  };
}

function publicCook(cook: CookTaskItem) {
  return {
    kind: cook.kind,
    label: cook.label,
    runId: cook.runId,
    requestId: cook.requestId,
  };
}
