import { fail, ok } from "@/src/api";
import { isAuthError, requireOperator } from "@/src/auth/resolve";
import { queueSnapshot } from "@/src/db";
import { formatQueueLines } from "@/src/pipeline/queueStatus";

/** Shared cook queue. Service token, or local dev with no token configured. */
export async function GET(req: Request) {
  try {
    requireOperator(req);
    const snapshot = await queueSnapshot();
    return ok({ ...snapshot, lines: formatQueueLines(snapshot) });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}
