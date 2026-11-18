/**
 * One Gemini context cache per task: the attached files and the shared instructions,
 * sent once. Every file of the task, every continuation and every rebuild then
 * refers to the cache by name instead of resending the whole package.
 *
 * Best effort. A model without explicit caching, a package under the model's minimum,
 * or any other refusal falls back to sending the files with each call, as before.
 */
import { GoogleGenAI, type Part } from "@google/genai";
import { withGeminiAdmission } from "./geminiAdmission";
import { getRunSignal, withDeadline } from "./runControl";
import { logStage } from "./stageLog";

/** TASK_CACHE=0 turns caching off. */
export function taskCacheEnabled(): boolean {
  const raw = (process.env.TASK_CACHE ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/** How long a task cache lives. Deleted as soon as the task's files are written. */
export const TASK_CACHE_TTL_SEC = Math.max(60, Number(process.env.TASK_CACHE_TTL_SEC) || 45 * 60);
const CACHE_CREATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Explicit caches have a minimum size (tens of thousands of tokens on current models).
 * Rough size of the operator turn, so a small task does not pay for a cache it cannot use.
 */
export function roughPromptTokens(parts: Part[]): number {
  let tokens = 0;
  for (const part of parts) {
    if (part.text) tokens += Math.ceil(part.text.length / 4);
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? "";
      // An image is a few hundred tokens whatever its size. A PDF or text blob is closer to its length.
      tokens += mime.startsWith("image/") ? 1_100 : Math.ceil((part.inlineData.data.length * 0.75) / 4);
    }
    // A staged file (PDF, audio, video) is usually large. Count it as worth caching.
    if (part.fileData?.fileUri) tokens += 40_000;
  }
  return tokens;
}

export const TASK_CACHE_MIN_TOKENS = Number(process.env.TASK_CACHE_MIN_TOKENS) || 40_000;

/** Worth creating: more than one call will use it, and it is big enough to be accepted. */
export function shouldCacheTask(parts: Part[], calls: number): boolean {
  return taskCacheEnabled() && calls >= 2 && roughPromptTokens(parts) >= TASK_CACHE_MIN_TOKENS;
}

function client(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") throw new Error("GEMINI_API_KEY is missing");
  return new GoogleGenAI({ apiKey: key });
}

/** Returns the cache name, or null when the cache could not be made (the caller sends files inline). */
export async function createTaskCache(opts: {
  runId: string;
  model: string;
  system: string;
  userParts: Part[];
  ttlSec?: number;
}): Promise<string | null> {
  const started = Date.now();
  const ttlSec = opts.ttlSec ?? TASK_CACHE_TTL_SEC;
  try {
    const signal = getRunSignal(opts.runId);
    const cache = await withGeminiAdmission(
      "brain",
      () =>
        withDeadline(
          client().caches.create({
            model: opts.model,
            config: {
              contents: [{ role: "user", parts: opts.userParts }],
              systemInstruction: opts.system,
              ttl: `${ttlSec}s`,
              displayName: `autocook ${opts.runId}`.slice(0, 120),
              abortSignal: signal,
            },
          }),
          { timeoutMs: CACHE_CREATE_TIMEOUT_MS, label: "context cache", signal },
        ),
      { maxAttempts: 2 },
    );
    const name = cache.name ?? null;
    logStage(opts.runId, "cache create", Date.now() - started, {
      model: opts.model,
      tokens: cache.usageMetadata?.totalTokenCount,
      ttl: ttlSec,
      ok: Boolean(name),
    });
    return name;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStage(opts.runId, "cache create", Date.now() - started, { model: opts.model, skipped: message });
    return null;
  }
}

export async function deleteTaskCache(runId: string, name: string | null | undefined): Promise<void> {
  if (!name) return;
  try {
    await client().caches.delete({ name });
  } catch (err) {
    // Expires on its own at the TTL.
    console.warn(`[cache] run=${runId} delete ${name} failed`, err instanceof Error ? err.message : err);
  }
}

/** The call failed because the cache is gone or was refused. Retrying with inline files can work. */
export function isCacheError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = err && typeof err === "object" && "status" in err ? Number((err as { status?: number }).status) : NaN;
  return /cached ?content|cachedContents\/|context cache/i.test(message) || (status === 404 && /cache/i.test(message));
}
