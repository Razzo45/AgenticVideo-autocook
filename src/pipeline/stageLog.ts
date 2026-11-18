/**
 * One worker-log line per finished stage, so a slow cook explains itself:
 *   [stage] run=run_ab12cd34 brain 2/3 (Flyer.pdf) ms=48211 chars=41822 finish=STOP
 */
function fmt(extra: Record<string, unknown> | undefined): string {
  if (!extra) return "";
  const bits: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === "") continue;
    bits.push(`${key}=${String(value).replace(/\s+/g, "_").slice(0, 80)}`);
  }
  return bits.length ? ` ${bits.join(" ")}` : "";
}

export function logStage(runId: string, label: string, ms: number, extra?: Record<string, unknown>): void {
  console.log(`[stage] run=${runId.split(":")[0]} ${label} ms=${Math.round(ms)}${fmt(extra)}`);
}

/** Time one stage. A failed stage is logged with its error and rethrown. */
export async function stage<T>(
  runId: string,
  label: string,
  work: () => Promise<T>,
  extra?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await work();
    logStage(runId, label, Date.now() - started, extra?.(result));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStage(runId, label, Date.now() - started, { failed: message });
    throw err;
  }
}
