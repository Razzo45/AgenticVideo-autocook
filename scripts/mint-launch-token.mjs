/**
 * Mint a short-lived launch JWT for local / mother-stub testing.
 *
 *   node scripts/mint-launch-token.mjs --user u_test
 *   node scripts/mint-launch-token.mjs --user u_test --tenant t1 --ttl 900
 */
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv();

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return fallback;
}

const userId = flag("--user", "local-dev");
const tenantId = flag("--tenant", "");
const ttlSec = Number(flag("--ttl", "900"));
const secret =
  process.env.AUTOCOOK_JWT_SECRET?.trim() ||
  ((process.env.AUTH_MODE ?? "dev").toLowerCase() === "dev"
    ? "dev-insecure-autocook-jwt-secret-change-me"
    : "");

if (!secret) {
  console.error("AUTOCOOK_JWT_SECRET required (or AUTH_MODE=dev)");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(
  JSON.stringify({
    sub: userId,
    aud: "autocook",
    iat: now,
    exp: now + ttlSec,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  }),
);
const data = `${header}.${payload}`;
const sig = b64url(createHmac("sha256", secret).update(data).digest());
const token = `${data}.${sig}`;

console.log(token);
console.error(`# user=${userId} ttl=${ttlSec}s`);
console.error(
  `# curl -X POST http://localhost:3000/api/auth/launch -H "content-type: application/json" -d "{\\"token\\":\\"${token}\\"}"`,
);
