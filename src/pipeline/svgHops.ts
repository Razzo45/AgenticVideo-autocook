/**
 * One SVG document delivered across streamed hops.
 * Parts are appended in arrival order. A later copy of the same document keeps the longer one.
 * An unfinished document is not returned: the platform does not close the markup.
 */

export type SvgHopPart = {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
};

export type AssembledSvg = { svg: string; id: string; filename: string };

/** The SVG document inside text, when both the open and close tags are present. */
export function svgDocument(value: string): string | null {
  const trimmed = value.trim();
  const start = trimmed.search(/<svg[\s>]/i);
  if (start < 0) return null;
  const end = trimmed.toLowerCase().lastIndexOf("</svg>");
  if (end < start) return null;
  return trimmed.slice(start, end + "</svg>".length);
}

function longest(docs: string[]): string | null {
  if (!docs.length) return null;
  return docs.reduce((best, doc) => (doc.length >= best.length ? doc : best));
}

/** Join hop pieces of one SVG. A piece that starts the document over is a restart, not a suffix. */
export function joinSvgPieces(pieces: string[]): string | null {
  const complete = pieces.map((piece) => svgDocument(piece)).filter((doc): doc is string => Boolean(doc));
  if (complete.length) return longest(complete);
  let acc = "";
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    if (!acc) {
      acc = piece;
      continue;
    }
    if (/^\s*<svg[\s>]/i.test(piece) && /<svg[\s>]/i.test(acc)) {
      acc = piece.trim().length >= acc.trim().length ? piece : acc;
      continue;
    }
    acc += piece;
  }
  return svgDocument(acc);
}

/**
 * The write_svg body from streamed parts, in order.
 * Function-call arguments win. Text is the same document when the hop carried it as text.
 */
export function assembleSvgHops(parts: SvgHopPart[]): AssembledSvg | null {
  const pieces: string[] = [];
  let id = "";
  let filename = "";
  const texts: string[] = [];
  for (const part of parts) {
    if (part.text) texts.push(part.text);
    const call = part.functionCall;
    if (!call || call.name !== "write_svg") continue;
    const args = call.args ?? {};
    if (!id && typeof args.id === "string") id = args.id.trim();
    if (!filename && typeof args.filename === "string") filename = args.filename.trim();
    if (typeof args.svg === "string" && args.svg.trim()) pieces.push(args.svg);
  }
  const svg = joinSvgPieces(pieces) ?? svgDocument(texts.join(""));
  if (!svg) return null;
  return { svg, id, filename };
}
