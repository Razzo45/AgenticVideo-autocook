import { fail, ok } from "@/src/api";
import { mintLaunchToken, verifyHs256, jwtSecret } from "@/src/auth/jwt";
import { SESSION_COOKIE } from "@/src/auth/types";
import { NextResponse } from "next/server";

/** Exchange a short-lived launch JWT for an httpOnly session cookie. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { token?: string };
    const token = String(body.token ?? "").trim();
    if (!token) return fail("token required");
    const claims = verifyHs256(token, jwtSecret());

    // Mint a longer session cookie (8h) from the verified launch identity.
    const session = mintLaunchToken({
      userId: claims.sub,
      tenantId: claims.tenant_id,
      ttlSec: 8 * 60 * 60,
    });

    const res = NextResponse.json({
      ok: true,
      userId: claims.sub,
      tenantId: claims.tenant_id ?? null,
    });
    const secure = process.env.NODE_ENV === "production";
    res.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 401);
  }
}

export async function DELETE() {
  const res = ok({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
