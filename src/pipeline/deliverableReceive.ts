/**
 * Receiving a deliverable the brain already wrote.
 * A cut-off reply is unfinished. Stitch the suffix. Leave the bytes alone.
 */

/** Gemini sync output cap. The execute call sets this so the document is not left to a smaller default. */
export const DELIVERABLE_MAX_OUTPUT_TOKENS = 65_536;

/** How many times to ask for the missing suffix of one reply. */
export const DELIVERABLE_CONTINUATIONS = 3;

const TAIL_CHARS = 600;

export function isCutOffFinish(reason: string | undefined): boolean {
  return reason === "MAX_TOKENS";
}

/** JSON.parse reached the end of the text inside a value. The reply stopped early. */
export function isCutOffParseError(message: string): boolean {
  return /Unterminated string in JSON/i.test(message) || /Unexpected end of JSON/i.test(message);
}

export function continuationTail(text: string, chars = TAIL_CHARS): string {
  return text.slice(-chars);
}

export function continuationPrompt(tail: string): string {
  return `The previous JSON reply was cut off by the output limit.
Continue character-for-character from the tail below.
Output only the missing suffix. Do not repeat the tail. Do not start a new JSON object. Do not use markdown fences.

TAIL:
${tail}`;
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
 * When the continuation is itself a finished object and the previous text is not, keep the finished object.
 */
export function stitchDeliverableText(prev: string, next: string): string {
  const extra = unwrapFence(next);
  if (!extra.trim()) return prev;
  const joined = joinOverlap(prev, extra);
  if (jsonSliceParsable(joined)) return joined;
  if (jsonSliceParsable(extra) && !jsonSliceParsable(prev)) return extra.trim();
  return joined;
}
