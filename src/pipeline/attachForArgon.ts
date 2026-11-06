/**
 * Decide how an attached file reaches Argon.
 * Images, video, audio, PDF, text, and SVG go through as the file.
 * Word, PowerPoint, and Excel go through as their text and pictures.
 * A zip is opened once and each file inside is handled the same way.
 * A format Argon cannot read is named, and its bytes are not sent.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { readOffice } from "./officeText";

export type ArgonAttachment =
  | { kind: "note"; text: string }
  | { kind: "inline"; label: string; mime: string; data: Buffer }
  | { kind: "file"; label: string; mime: string; path: string; forceStage?: boolean };

const TEXT_MAX_CHARS = 80_000;
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 300 * 1024 * 1024;
const INLINE_IMAGE_MAX = 12 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
};
const MEDIA_MIME: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};
const TEXT_EXT = new Set(["txt", "md", "csv", "json", "html", "htm", "css", "js", "mjs", "cjs", "srt"]);
const OFFICE_EXT = new Set(["docx", "pptx", "xlsx"]);
const LEGACY_OFFICE: Record<string, string> = {
  doc: "Word",
  ppt: "PowerPoint",
  xls: "Excel",
};
const FONT_EXT = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

function extOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

function sniff(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function clip(text: string): string {
  if (text.length <= TEXT_MAX_CHARS) return text;
  return `${text.slice(0, TEXT_MAX_CHARS)}\n[The rest of this file was cut for length.]`;
}

function note(label: string, text: string): ArgonAttachment {
  return { kind: "note", text: `${label}\n${text}` };
}

function headerOf(filePath: string): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function spill(dir: string, name: string, bytes: Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[^\w.\-()+ ]+/g, "_").slice(-80) || "file.bin";
  const dest = path.join(dir, `${Date.now().toString(36)}-${safe}`);
  fs.writeFileSync(dest, bytes);
  return dest;
}

export async function classifyAttachment(input: {
  name: string;
  filePath: string;
  spillDir: string;
  depth?: number;
  label?: string;
}): Promise<ArgonAttachment[]> {
  const label = input.label ?? `Attached file: ${input.name}`;
  const depth = input.depth ?? 0;
  if (!fs.existsSync(input.filePath)) return [note(label, "The file is missing.")];
  const size = fs.statSync(input.filePath).size;
  if (size === 0) return [note(label, "The file is empty.")];

  const sniffed = sniff(headerOf(input.filePath));
  const ext = extOf(input.name);

  if (sniffed === "application/pdf" || (!sniffed && ext === "pdf")) {
    return [{ kind: "file", label, mime: "application/pdf", path: input.filePath }];
  }
  if (sniffed?.startsWith("image/") || (!sniffed && IMAGE_MIME[ext])) {
    const mime = sniffed?.startsWith("image/") ? sniffed : IMAGE_MIME[ext]!;
    if (size > INLINE_IMAGE_MAX) return [{ kind: "file", label, mime, path: input.filePath }];
    return [{ kind: "inline", label, mime, data: fs.readFileSync(input.filePath) }];
  }
  if (ext === "svg") {
    const text = fs.readFileSync(input.filePath, "utf8");
    if (text.length <= TEXT_MAX_CHARS) return [note(label, `SVG markup:\n${text}`)];
    return [{ kind: "file", label: `${label}\nSVG attached in full.`, mime: "image/svg+xml", path: input.filePath }];
  }
  if (TEXT_EXT.has(ext)) {
    const text = fs.readFileSync(input.filePath, "utf8");
    if (text.length <= TEXT_MAX_CHARS) return [note(label, text)];
    return [{ kind: "file", label: `${label}\nText attached in full (${text.length} characters).`, mime: "text/plain", path: input.filePath }];
  }
  if (OFFICE_EXT.has(ext)) return officePieces(input.name, fs.readFileSync(input.filePath), label);
  if (LEGACY_OFFICE[ext]) {
    return [note(label, `This is a legacy ${LEGACY_OFFICE[ext]} file. Its contents are not extracted. The file is stored with the task.`)];
  }
  if (ext === "zip") return zipPieces(input.name, input.filePath, input.spillDir, label, depth);
  if (MEDIA_MIME[ext]) {
    if (size > MEDIA_MAX_BYTES) {
      return [note(label, `It is ${size} bytes, stored with the task, and too large to play inside this reading.`)];
    }
    return [{ kind: "file", label, mime: MEDIA_MIME[ext]!, path: input.filePath, forceStage: true }];
  }
  if (FONT_EXT.has(ext)) {
    return [note(label, "Font file. It is stored with the task and is not a document to read.")];
  }
  return [note(label, `This format is not read. The file is stored with the task.`)];
}

async function officePieces(name: string, buf: Buffer, label: string): Promise<ArgonAttachment[]> {
  const pieces = await readOffice(buf, name);
  if (!pieces) return [note(label, "The office file could not be opened. The file is stored with the task.")];
  const out: ArgonAttachment[] = [];
  for (const piece of pieces) {
    if (piece.kind === "text") out.push(note(label, clip(piece.text)));
    else out.push({ kind: "inline", label: `Image inside ${name}: ${piece.filename}`, mime: piece.mime, data: piece.data });
  }
  return out.length ? out : [note(label, "The office file had no readable text or pictures.")];
}

async function zipPieces(name: string, filePath: string, spillDir: string, label: string, depth: number): Promise<ArgonAttachment[]> {
  if (depth > 0) return [note(label, "Nested archives are not opened. The archive is stored with the task.")];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  } catch {
    return [note(label, "The archive could not be opened.")];
  }
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(entry.name) && !entry.name.split("/").pop()?.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const listing = entries.map((entry) => entry.name).join(", ") || "(empty)";
  const out: ArgonAttachment[] = [note(label, `Archive with ${entries.length} file(s): ${listing}`)];
  let budget = ARCHIVE_MAX_BYTES;
  for (const entry of entries) {
    const bytes = Buffer.from(await entry.async("uint8array"));
    const innerLabel = `Inside ${name}: ${entry.name}`;
    if (bytes.length > budget) {
      out.push(note(innerLabel, "Not attached. The archive is too large to open further."));
      continue;
    }
    budget -= bytes.length;
    const innerPath = spill(spillDir, entry.name, bytes);
    out.push(...(await classifyAttachment({ name: entry.name, filePath: innerPath, spillDir, depth: depth + 1, label: innerLabel })));
  }
  return out;
}
