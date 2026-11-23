/**
 * After write_svg / write_html, the conversation keeps this note instead of the
 * markup so later turns do not resend it. The bytes stay on disk. A reply that
 * copies the note back is not a document.
 */
const STAGED_MARKUP_NOTE =
  /^\[staged \d+ chars — already stored by (?:write_svg|write_html); do not repeat\]$/;

export function stagedMarkupNote(tool: "write_svg" | "write_html", chars: number): string {
  return `[staged ${chars} chars — already stored by ${tool}; do not repeat]`;
}

export function isStagedMarkupNote(value: string): boolean {
  return STAGED_MARKUP_NOTE.test(value.trim());
}
