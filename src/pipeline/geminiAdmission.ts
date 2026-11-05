/**
 * Process-wide Gemini admission for autocook — GDP AdaptiveAdmission tuned for
 * heavy media (Omni video / image / Argon tools), not text-only grading.
 *
 * Job-queue lanes decide *which cook runs*. This gate decides *how many Gemini
 * calls may be in flight* so 2 parallel cooks cannot 429-storm the shared key.
 *
 * Defaults (vs GDP text grading ceilings of 16–96):
 *   floor 1 · ceiling 2 · initial 1 · ownerCeiling 1 · filesCeiling 2
 * Lanes: argon (text), image, omni (video), files
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AdaptiveAdmission,
  type AdmissionOptions,
  type AdmissionSnapshot,
  type RequestClass,
  PACE_AFTER_429_MS,
} from "./geminiAdmissionCore";
import { throttleSharedAdmission, withSharedAdmission } from "./sharedAdmission";

export type GeminiLane = "argon" | "image" | "omni" | "files";

export type { AdmissionSnapshot, RequestClass };

type Ctx = { ownerId: string; requestClass: RequestClass };

const ctxStore = new AsyncLocalStorage<Ctx>();

let controller: AdaptiveAdmission | null = null;

function admission(): AdaptiveAdmission {
  if (!controller) {
    controller = new AdaptiveAdmission({
      floor: Math.max(1, Number(process.env.GEMINI_CONCURRENCY_FLOOR) || 1),
      ceiling: Math.max(1, Number(process.env.GEMINI_CONCURRENCY) || 2),
      initial: Math.max(1, Number(process.env.GEMINI_CONCURRENCY_INITIAL) || 1),
      ownerCeiling: Math.max(1, Number(process.env.GEMINI_OWNER_CONCURRENCY) || 1),
      filesCeiling: Math.max(1, Number(process.env.GEMINI_FILES_CONCURRENCY) || 2),
      increaseAfter: Math.max(2, Number(process.env.GEMINI_INCREASE_AFTER) || 4),
      agingMs: 5_000,
      idleAgingMs: 60_000,
    });
  }
  return controller;
}

/** Bind cook run id as fairness owner for nested Gemini calls. */
export function withGeminiOwner<T>(
  ownerId: string,
  fn: () => Promise<T>,
  requestClass: RequestClass = "background",
): Promise<T> {
  return ctxStore.run({ ownerId, requestClass }, fn);
}

function currentCtx(): Ctx {
  return ctxStore.getStore() ?? { ownerId: "anonymous", requestClass: "background" };
}

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: number }).status)
      : NaN;
  return (
    status === 429 ||
    /(?:\b429\b|rate.?limit|resource.?exhausted|too many requests|quota|high load|overloaded|try again later)/i.test(
      msg,
    )
  );
}

export function isTransientServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: number }).status)
      : NaN;
  return status === 503 || status === 500 || /\b503\b|\b502\b|unavailable|timeout|timed out/i.test(msg);
}

function retryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { headers?: { get?: (k: string) => string | null } }).headers;
  const raw = headers?.get?.("retry-after") ?? (err as { retryAfter?: string }).retryAfter;
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * Admit one Gemini call. On 429: AIMD halve + Retry-After cooldown, then retry
 * (capped). Capacity retries stay inside the slot so we do not fan-out storms.
 */
export async function withGeminiAdmission<T>(
  lane: GeminiLane,
  operation: () => Promise<T>,
  opts?: { ownerId?: string; requestClass?: RequestClass; maxAttempts?: number; onStatus?: (m: string) => void },
): Promise<T> {
  const ctx = currentCtx();
  const ownerId = opts?.ownerId ?? ctx.ownerId;
  const requestClass = opts?.requestClass ?? ctx.requestClass;
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 5);
  const adm = admission();
  const options: AdmissionOptions = { lane, ownerId, requestClass };

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await adm.use(async () => {
        const limits = adm.limitsFor(lane);
        const t0 = Date.now();
        try {
          const result = await withSharedAdmission(
            {
              lane: lane === "files" ? "files" : "inference",
              requestClass,
              maxActive: limits.maxActive,
              intervalMs: limits.intervalMs,
            },
            operation,
          );
          adm.onSuccess(lane, Date.now() - t0);
          return result;
        } catch (err) {
          if (isRateLimitError(err)) {
            const wait = adm.onThrottle(lane, retryAfterMs(err), 15_000 + attempt * 5_000);
            void throttleSharedAdmission(lane === "files" ? "files" : "inference", wait);
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
              __geminiThrottleWaitMs: wait,
            });
          }
          if (isTransientServerError(err)) {
            adm.onFailure(
              lane,
              /timeout|timed out/i.test(err instanceof Error ? err.message : String(err))
                ? "timeout"
                : "server",
            );
          }
          throw err;
        }
      }, options);
    } catch (err) {
      lastErr = err;
      const wait =
        err && typeof err === "object" && "__geminiThrottleWaitMs" in err
          ? Number((err as { __geminiThrottleWaitMs: number }).__geminiThrottleWaitMs)
          : isRateLimitError(err)
            ? adm.onThrottle(lane, retryAfterMs(err), 15_000)
            : 0;
      if (wait > 0 && attempt < maxAttempts - 1) {
        const pace = Math.max(wait, PACE_AFTER_429_MS);
        opts?.onStatus?.(
          `Gemini ${lane} rate-limited — cooling ${Math.round(pace / 1000)}s (AIMD), then retry ${attempt + 2}/${maxAttempts}…`,
        );
        await new Promise((r) => setTimeout(r, pace));
        continue;
      }
      if (isTransientServerError(err) && attempt < maxAttempts - 1) {
        const pace = Math.min(60_000, 5_000 * (attempt + 1));
        opts?.onStatus?.(`Gemini ${lane} transient error — retry in ${Math.round(pace / 1000)}s…`);
        await new Promise((r) => setTimeout(r, pace));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function geminiAdmissionSnapshot(): AdmissionSnapshot {
  return admission().snapshot();
}
