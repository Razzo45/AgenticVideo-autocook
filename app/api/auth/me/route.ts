import { fail, ok } from "@/src/api";
import { isAuthError, requireUser } from "@/src/auth/resolve";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    return ok({ userId: user.userId, tenantId: user.tenantId, kind: user.kind });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}
