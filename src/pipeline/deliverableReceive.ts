/**
 * Receiving a deliverable the brain already wrote.
 * A cut-off reply is unfinished. Stitch the suffix. Leave the bytes alone.
 */

/** Gemini sync output cap. The execute call sets this so the document is not left to a smaller default. */
export const DELIVERABLE_MAX_OUTPUT_TOKENS = 65_536;

/** How many times to ask for the missing suffix of one reply. */
export const DELIVERABLE_CONTINUATIONS = 6;

/** Shared opening long enough to tell a restarted document from a real suffix. */
const RESTART_HEAD = 32;

export function isCutOffFinish(reason: string | undefined): boolean {
  return reason === "MAX_TOKENS";
}

/** JSON.parse reached the end of the text inside a value. The reply stopped early. */
export function isCutOffParseError(message: string): boolean {
  return /Unterminated string in JSON/i.test(message) || /Unexpected end of JSON/i.test(message);
}

/** Follow-up when the cut-off reply is already the model's previous turn. */
export function continuationFollowUp(): string {
  return `Your previous message stopped early, inside the JSON.
Continue that same message from its exact last character.
Output only the missing suffix. Do not repeat text you already wrote. Do not start a new JSON object. Do not use markdown fences.`;
}

function sameDocumentRestart(prev: string, extra: string): boolean {
  const head = prev.slice(0, Math.min(RESTART_HEAD, prev.length));
  if (head.length < 24) return false;
  if (extra.startsWith(head)) return true;
  const extraHead = extra.slice(0, Math.min(RESTART_HEAD, extra.length));
  return extraHead.length >= 24 && prev.startsWith(extraHead);
}

function unwrapFence(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "");
  const full = trimmed.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (full) return full[1] ?? "";
  return trimmed.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
}

/** True when the text contains one complete JSON object. */
export function jsonSliceParsable(text: string): boolean {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  try {
    JSON.parse(text.slice(start, end + 1));
    return true;
  } catch {
    return false;
  }
}

function joinOverlap(prev: string, extra: string): string {
  const max = Math.min(prev.length, extra.length, 2000);
  for (let n = max; n >= 16; n--) {
    if (prev.slice(-n) === extra.slice(0, n)) return prev + extra.slice(n);
  }
  return prev + extra;
}

/**
 * Append a continuation onto a cut-off reply.
 * A restart of the same document is kept as the longer draft, not concatenated.
 * When the continuation is itself a finished object and the previous text is not, keep the finished object.
 */
export function stitchDeliverableText(prev: string, next: string): string {
  const extra = unwrapFence(next);
  if (!extra.trim()) return prev;
  const trimmed = extra.trimStart();
  const restart = sameDocumentRestart(prev, extra) ? extra : sameDocumentRestart(prev, trimmed) ? trimmed : "";
  if (restart) return restart.length >= prev.length ? restart : prev;
  const joined = joinOverlap(prev, extra);
  if (jsonSliceParsable(joined)) return joined;
  if (jsonSliceParsable(extra) && !jsonSliceParsable(prev)) return extra.trim();
  return joined;
}
