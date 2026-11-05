import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Gate browser pages when AUTH_MODE=strict and no session cookie.
 * API auth is enforced in route handlers (service token / JWT / cookie).
 * /api/health and /api/auth/launch stay public.
 */
export function middleware(req: NextRequest) {
  const mode = (process.env.AUTH_MODE ?? "dev").trim().toLowerCase();
  if (mode !== "strict") return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/health")) return NextResponse.next();
  if (pathname.startsWith("/api/auth/launch")) return NextResponse.next();
  if (pathname.startsWith("/_next")) return NextResponse.next();
  if (pathname === "/favicon.ico") return NextResponse.next();

  // API routes: let handlers return 401 JSON (Bearer / cookie checked there).
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const session = req.cookies.get("autocook_session")?.value;
  if (session) return NextResponse.next();

  // No HTML login — mother (or mint script) must launch with a JWT.
  return new NextResponse(
    "Autocook requires a signed launch. Open via the mother platform, or POST /api/auth/launch with a mint token.",
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
