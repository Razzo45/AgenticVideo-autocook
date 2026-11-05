import { cookies } from "next/headers";
import type { AuthUser } from "./types";
import { SESSION_COOKIE } from "./types";
import { jwtSecret, verifyHs256 } from "./jwt";

function authMode(): "strict" | "dev" {
  const m = (process.env.AUTH_MODE ?? "dev").trim().toLowerCase();
  return m === "strict" ? "strict" : "dev";
}

function serviceToken(): string | null {
  return process.env.AUTOCOOK_SERVICE_TOKEN?.trim() || null;
}

function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

/**
 * Resolve the caller for API routes.
 * Priority: service token + X-User-Id → session cookie JWT → AUTH_MODE=dev fallback.
 */
export async function resolveAuthUser(req: Request): Promise<AuthUser | null> {
  const token = bearer(req);
  const expected = serviceToken();
  if (token && expected && timingSafeStringEq(token, expected)) {
    const userId = (req.headers.get("x-user-id") ?? "").trim();
    if (!userId) return null;
    const tenantId = (req.headers.get("x-tenant-id") ?? "").trim() || null;
    return { userId, tenantId, kind: "service" };
  }

  // Launch / session JWT as Bearer (useful for curl tests without cookie jar).
  if (token && token.includes(".")) {
    try {
      const claims = verifyHs256(token, jwtSecret());
      return {
        userId: claims.sub,
        tenantId: claims.tenant_id?.trim() || null,
        kind: "launch",
      };
    } catch {
      /* fall through */
    }
  }

  try {
    const jar = await cookies();
    const session = jar.get(SESSION_COOKIE)?.value;
    if (session) {
      const claims = verifyHs256(session, jwtSecret());
      return {
        userId: claims.sub,
        tenantId: claims.tenant_id?.trim() || null,
        kind: "launch",
      };
    }
  } catch {
    /* cookies() unavailable outside request context */
  }

  if (authMode() === "dev") {
    const userId = (process.env.DEV_USER_ID ?? "local-dev").trim() || "local-dev";
    return { userId, tenantId: null, kind: "dev" };
  }

  return null;
}

export async function requireUser(req: Request): Promise<AuthUser> {
  const user = await resolveAuthUser(req);
  if (!user) {
    const err = new Error("unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  return user;
}

export function isAuthError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && (err as { status?: number }).status === 401;
}
