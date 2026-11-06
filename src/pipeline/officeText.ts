/**
 * Pull the readable contents out of a Word, PowerPoint, or Excel file.
 * Argon does not accept those packages as documents. The text and embedded
 * pictures are what it can actually read.
 */
import JSZip from "jszip";

export type OfficePiece =
  | { kind: "text"; text: string }
  | { kind: "image"; filename: string; mime: string; data: Buffer };

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function texts(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out.push(decodeXml(match[1] ?? ""));
  return out;
}

function docxText(xml: string): string {
  const lines: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    const line = texts(para, "w:t").join("");
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n");
}

function pptxText(xml: string): string {
  return texts(xml, "a:t").filter((line) => line.trim()).join("\n");
}

function sharedStrings(xml: string): string[] {
  return xml.split(/<si\b/).slice(1).map((block) => texts(block, "t").join(""));
}

function xlsxSheet(xml: string, strings: string[]): string {
  const lines: string[] = [];
  for (const row of xml.split(/<row\b/).slice(1)) {
    const cells: string[] = [];
    for (const cell of row.split(/<c\b/).slice(1)) {
      const kind = /t="([^"]+)"/.exec(cell)?.[1] ?? "";
      const value = texts(cell, "v")[0] ?? texts(cell, "t").join("");
      if (kind === "s") cells.push(strings[Number(value)] ?? "");
      else cells.push(value);
    }
    if (cells.some((cell) => cell.trim())) lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

function slideOrder(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

export async function readOffice(buf: Buffer, filename: string): Promise<OfficePiece[] | null> {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));
  if (ext !== ".docx" && ext !== ".pptx" && ext !== ".xlsx") return null;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return null;
  }

  const pieces: OfficePiece[] = [];
  if (ext === ".docx") {
    const names = Object.keys(zip.files)
      .filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name))
      .sort((a, b) => (a.includes("document") ? -1 : b.includes("document") ? 1 : a.localeCompare(b)));
    const blocks: string[] = [];
    for (const name of names) {
      const xml = await zip.files[name]!.async("string");
      const text = docxText(xml);
      if (text.trim()) blocks.push(text);
    }
    if (blocks.length) pieces.push({ kind: "text", text: blocks.join("\n\n") });
  } else if (ext === ".pptx") {
    const names = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideOrder(a) - slideOrder(b));
    const blocks: string[] = [];
    for (const name of names) {
      const text = pptxText(await zip.files[name]!.async("string"));
      if (text.trim()) blocks.push(`--- Slide ${slideOrder(name)} ---\n${text}`);
    }
    if (blocks.length) pieces.push({ kind: "text", text: blocks.join("\n\n") });
  } else {
    const shared = zip.files["xl/sharedStrings.xml"]
      ? sharedStrings(await zip.files["xl/sharedStrings.xml"]!.async("string"))
      : [];
    const names = Object.keys(zip.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort((a, b) => slideOrder(a) - slideOrder(b));
    const blocks: string[] = [];
    for (const name of names) {
      const text = xlsxSheet(await zip.files[name]!.async("string"), shared);
      if (text.trim()) blocks.push(`--- Sheet ${slideOrder(name)} ---\n${text}`);
    }
    if (blocks.length) pieces.push({ kind: "text", text: blocks.join("\n\n") });
  }

  const mediaRoot = ext === ".docx" ? "word/media/" : ext === ".pptx" ? "ppt/media/" : "xl/media/";
  const images = Object.keys(zip.files)
    .filter((name) => name.startsWith(mediaRoot) && !zip.files[name]!.dir)
    .sort();
  for (const name of images) {
    const mime = IMAGE_MIME[name.slice(name.lastIndexOf(".")).toLowerCase()];
    if (!mime) continue;
    pieces.push({
      kind: "image",
      filename: name.slice(mediaRoot.length),
      mime,
      data: Buffer.from(await zip.files[name]!.async("uint8array")),
    });
  }
  return pieces.length ? pieces : null;
}
