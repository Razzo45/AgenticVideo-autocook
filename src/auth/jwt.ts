/**
 * Minimal HS256 JWT (no jose dependency). Launch tokens + session cookies.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function parseB64urlJson<T>(part: string): T {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(padded + pad, "base64").toString("utf8")) as T;
}

export type LaunchClaims = {
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  tenant_id?: string;
  kind?: string;
};

export function jwtSecret(): string {
  const s = process.env.AUTOCOOK_JWT_SECRET?.trim();
  if (s) return s;
  if ((process.env.AUTH_MODE ?? "dev").toLowerCase() === "dev") {
    return "dev-insecure-autocook-jwt-secret-change-me";
  }
  throw new Error("AUTOCOOK_JWT_SECRET is required when AUTH_MODE=strict");
}

export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

export function verifyHs256(token: string, secret: string): LaunchClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  const got = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((sig.length % 4) || 4), "base64");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new Error("invalid signature");
  }
  const claims = parseB64urlJson<LaunchClaims>(body);
  if (claims.aud !== "autocook") throw new Error("invalid audience");
  if (!claims.sub?.trim()) throw new Error("missing sub");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) throw new Error("token expired");
  return claims;
}

export function mintLaunchToken(opts: {
  userId: string;
  tenantId?: string;
  /** seconds; default 15 minutes for launch, longer for session */
  ttlSec?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? 15 * 60;
  return signHs256(
    {
      sub: opts.userId,
      aud: "autocook",
      iat: now,
      exp: now + ttl,
      ...(opts.tenantId ? { tenant_id: opts.tenantId } : {}),
      kind: "launch",
    },
    jwtSecret(),
  );
}
