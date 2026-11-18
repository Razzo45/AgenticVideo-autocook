/**
 * Platform control plane for cooks.
 *
 * - Brain composition/tool calls are authority (no creative bias).
 * - Cancel aborts in-flight work; delete is cleanup after stop.
 * - Every external wait ends: deadline or abort — platform self-heals or fails loud.
 * - BrainContractError → one pingback opportunity in the cook.
 * - PlatformFaultError → graceful fail (or recover without changing brain intent).
 */

/** Inferred from live generation: brain rounds with tools/thinking often 2–6m; Carbon HTML can sit longer. */
export const BRAIN_ROUND_TIMEOUT_MS = Number(process.env.BRAIN_ROUND_TIMEOUT_MS) || 13 * 60_000;
/**
 * One JSON deliverable call. Gemini bounds a unary request at 10 minutes on its side,
 * so a reply cannot arrive after that. Past this the call is failed, not waited on forever.
 */
export const BRAIN_CALL_TIMEOUT_MS = Number(process.env.BRAIN_CALL_TIMEOUT_MS) || 12 * 60_000;
/**
 * One streamed deliverable call, start to finish. Gemini bounds a streamed request
 * at 20 minutes on its side.
 */
export const BRAIN_STREAM_TIMEOUT_MS = Number(process.env.BRAIN_STREAM_TIMEOUT_MS) || 20 * 60_000;
/**
 * Once text has started arriving, the longest silence before the stream counts as dead.
 * Not applied before the first text: the model may think for minutes first.
 */
export const BRAIN_STREAM_IDLE_MS = Number(process.env.BRAIN_STREAM_IDLE_MS) || 4 * 60_000;
/** One TTS cue. */
export const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) || 5 * 60_000;
/** One Lyria track. */
export const MUSIC_TIMEOUT_MS = Number(process.env.MUSIC_TIMEOUT_MS) || 10 * 60_000;
/** One S3 list / delete / head round trip. */
export const S3_CALL_TIMEOUT_MS = Number(process.env.S3_CALL_TIMEOUT_MS) || 30_000;
/** Image model can sit before first byte; keep below orphan window. */
export const IMAGE_GEN_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 5 * 60_000;
/** Omni submit (also used as fallback if geminiOmni local const missing). */
export const OMNI_SUBMIT_TIMEOUT_MS = Number(process.env.OMNI_SUBMIT_TIMEOUT_MS) || 5 * 60_000;
/** S3 put of a single object. */
export const S3_PUT_TIMEOUT_MS = Number(process.env.S3_PUT_TIMEOUT_MS) || 3 * 60_000;

export class BrainContractError extends Error {
  readonly kind = "brain_contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "BrainContractError";
  }
}

export class PlatformFaultError extends Error {
  readonly kind = "platform_fault" as const;
  constructor(message: string) {
    super(message);
    this.name = "PlatformFaultError";
  }
}

export class RunCancelledError extends PlatformFaultError {
  readonly cancelled = true;
  constructor(runId: string) {
    super(`Cook cancelled (${runId})`);
    this.name = "RunCancelledError";
  }
}

type RunControlEntry = {
  controller: AbortController;
  reason: string | null;
};

const byRun = new Map<string, RunControlEntry>();

/** Start (or replace) the abort scope for a run when a worker job begins. */
export function beginRunControl(runId: string): AbortSignal {
  const existing = byRun.get(runId);
  if (existing && !existing.controller.signal.aborted) {
    return existing.controller.signal;
  }
  const controller = new AbortController();
  byRun.set(runId, { controller, reason: null });
  return controller.signal;
}

/**
 * Admission owners are `runId` or `runId:part` (one per parallel file or media slot).
 * Both must reach the run's abort signal, or Cancel/Delete cannot stop that part.
 */
export function getRunSignal(runId: string): AbortSignal | undefined {
  const entry = byRun.get(runId) ?? byRun.get(runId.split(":")[0] ?? runId);
  return entry?.controller.signal;
}

export function isRunCancelled(runId: string): boolean {
  return Boolean(byRun.get(runId)?.controller.signal.aborted);
}

/** Operator cancel — abort in-flight Gemini/ffmpeg/sharp waits for this run. */
export function cancelRunControl(runId: string, reason = "cancelled"): void {
  let entry = byRun.get(runId);
  if (!entry) {
    entry = { controller: new AbortController(), reason };
    byRun.set(runId, entry);
  }
  entry.reason = reason;
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(new RunCancelledError(runId));
  }
}

export function endRunControl(runId: string): void {
  byRun.delete(runId);
}

export function throwIfCancelled(runId: string): void {
  if (isRunCancelled(runId)) throw new RunCancelledError(runId);
}

export function isBrainContractError(err: unknown): boolean {
  return err instanceof BrainContractError || (err instanceof Error && err.name === "BrainContractError");
}

export function isPlatformFaultError(err: unknown): boolean {
  return (
    err instanceof PlatformFaultError ||
    err instanceof RunCancelledError ||
    (err instanceof Error && (err.name === "PlatformFaultError" || err.name === "RunCancelledError"))
  );
}

export function isCancelledError(err: unknown): boolean {
  if (err instanceof RunCancelledError) return true;
  if (err instanceof Error && err.name === "RunCancelledError") return true;
  if (err && typeof err === "object" && "cancelled" in err) return Boolean((err as { cancelled?: boolean }).cancelled);
  const msg = err instanceof Error ? err.message : String(err);
  return /cook cancelled|RunCancelledError|aborted/i.test(msg);
}

/** Ticker only — does not time out. Honors AbortSignal so Delete can stop a wait. */
export async function withStatusHeartbeat<T>(
  work: Promise<T>,
  opts: { label: string; onStatus?: (msg: string) => void; heartbeatMs?: number; signal?: AbortSignal },
): Promise<T> {
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new PlatformFaultError(`${opts.label} aborted`);
  }
  if (!opts.onStatus && !opts.signal) return work;
  const started = Date.now();
  const heartbeat = opts.onStatus
    ? setInterval(() => {
        const sec = Math.round((Date.now() - started) / 1000);
        opts.onStatus?.(`${opts.label} (waiting ${sec}s)…`);
      }, opts.heartbeatMs ?? 20_000)
    : null;
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => {
        reject(
          opts.signal?.reason instanceof Error
            ? opts.signal.reason
            : new PlatformFaultError(`${opts.label} aborted`),
        );
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      work.then(resolve, reject);
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Bound any async platform wait. Honors AbortSignal. Does not invent brain content —
 * only fails the wait so the cook can self-heal or stop loudly.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  opts: {
    timeoutMs: number;
    label: string;
    signal?: AbortSignal;
    onStatus?: (msg: string) => void;
    heartbeatMs?: number;
  },
): Promise<T> {
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new PlatformFaultError(`${opts.label} aborted`);
  }

  const started = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (opts.onStatus) {
    heartbeat = setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      opts.onStatus?.(`${opts.label} (waiting ${sec}s)…`);
    }, opts.heartbeatMs ?? 20_000);
  }

  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new PlatformFaultError(
            `${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
          ),
        );
      }, opts.timeoutMs);

      onAbort = () => {
        clearTimeout(timer);
        reject(
          opts.signal?.reason instanceof Error
            ? opts.signal.reason
            : new PlatformFaultError(`${opts.label} aborted`),
        );
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
  }
}
