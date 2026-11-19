/**
 * Things the platform did to a deliverable that the brain did not write: a prompt cut
 * at a generator limit, a fallback after a refusal. Recorded against the admission
 * owner that made the call (run:slot), so the build can attach them to the file.
 */
import { currentGeminiOwnerId } from "./geminiAdmission";

const notes = new Map<string, string[]>();

export function recordPlatformNote(text: string, owner = currentGeminiOwnerId()): void {
  const key = owner ?? "-";
  const list = notes.get(key) ?? [];
  list.push(text);
  notes.set(key, list);
  console.log(`[note] owner=${key} ${text}`);
}

/** Notes recorded by owners that start with prefix. Removed once read. */
export function takePlatformNotes(prefix: string): string[] {
  const out: string[] = [];
  for (const [key, list] of notes) {
    if (key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(`${prefix}-`)) {
      out.push(...list);
      notes.delete(key);
    }
  }
  return out;
}
