/**
 * Cross-process Gemini admission leases (GDP `sharedAdmission.ts`).
 * Requires DATABASE_URL + sql/001_railway_gemini.sql. Falls back to local-only when missing.
 */
import { randomUUID } from "node:crypto";
import { getPgPool, markPostgresUnavailable, postgresConfigured } from "./pg";
import type { RequestClass } from "./geminiAdmissionCore";

type SharedLane = "inference" | "files";

let disabled = false;

function sharedLane(lane: string): SharedLane {
  return lane === "files" ? "files" : "inference";
}

async function callBool(text: string, params: unknown[]): Promise<boolean | null> {
  if (disabled || !postgresConfigured()) return null;
  const pool = getPgPool();
  if (!pool) return null;
  try {
    const res = await pool.query(text, params);
    const ok = res.rows[0]?.ok ?? res.rows[0]?.acquire_gemini_admission ?? res.rows[0]?.[Object.keys(res.rows[0] ?? {})[0] ?? ""];
    return ok === true || ok === "t" || ok === "true";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist|undefined function/i.test(msg)) {
      disabled = true;
      markPostgresUnavailable("admission functions missing — apply sql/001_railway_gemini.sql");
      return null;
    }
    throw err;
  }
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Cross-instance lease on DATABASE_URL. Local AdaptiveAdmission still owns AIMD.
 */
export async function withSharedAdmission<T>(
  options: {
    lane: string;
    requestClass: RequestClass;
    signal?: AbortSignal;
    maxActive?: number;
    intervalMs?: number;
  },
  operation: () => Promise<T>,
): Promise<T> {
  if (disabled || !postgresConfigured()) return operation();
  const lane = sharedLane(options.lane);
  const ceiling =
    lane === "files"
      ? Number(process.env.GEMINI_FILES_CONCURRENCY) || 2
      : Number(process.env.GEMINI_CONCURRENCY) || 2;
  const maxActive = Math.max(1, Math.min(ceiling, options.maxActive ?? ceiling));
  const maxBackground = lane === "files" ? maxActive : Math.max(1, maxActive - 1);
  const intervalMs = Math.max(0, options.intervalMs ?? 0);
  const leaseSeconds = 180;
  const token = randomUUID();
  let held = false;
  try {
    while (!held) {
      options.signal?.throwIfAborted();
      const ok = await callBool(
        `select app.acquire_gemini_admission($1::uuid, $2, $3, $4, $5, $6, $7) as ok`,
        [token, lane, options.requestClass, leaseSeconds, maxActive, maxBackground, intervalMs],
      );
      if (ok === null) return operation();
      held = ok;
      if (!held) await wait(options.requestClass === "idle" ? 1500 : 400, options.signal);
    }
    return await operation();
  } finally {
    if (held) {
      await callBool(`select app.release_gemini_admission($1::uuid) as ok`, [token]).catch(() => null);
    }
  }
}

export async function throttleSharedAdmission(lane: string, cooldownMs: number): Promise<void> {
  if (disabled || !postgresConfigured()) return;
  await callBool(`select app.throttle_gemini_admission($1, $2) as ok`, [
    sharedLane(lane),
    Math.max(1000, Math.floor(cooldownMs)),
  ]).catch(() => null);
}
