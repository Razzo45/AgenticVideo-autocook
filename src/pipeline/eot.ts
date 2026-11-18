/**
 * Embedded OpenType 2.1, uncompressed: the font format PowerPoint embeds as .fntdata.
 *
 * Word embeds obfuscated TrueType (.odttf). PowerPoint does not: it reads EOT. The
 * deck writer used the Word form, which PowerPoint cannot read.
 * Layout: W3C Embedded OpenType submission, version 0x00020001.
 */

type Tables = Map<string, { offset: number; length: number }>;

function tables(font: Buffer): Tables {
  const out: Tables = new Map();
  if (font.length < 12) return out;
  const count = font.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > font.length) break;
    out.set(font.toString("latin1", rec, rec + 4), { offset: font.readUInt32BE(rec + 8), length: font.readUInt32BE(rec + 12) });
  }
  return out;
}

function nameString(font: Buffer, t: Tables, id: number): string {
  const name = t.get("name");
  if (!name || name.offset + 6 > font.length) return "";
  const base = name.offset;
  const count = font.readUInt16BE(base + 2);
  const strings = base + font.readUInt16BE(base + 4);
  let best = "";
  let bestScore = -1;
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    if (rec + 12 > font.length) break;
    const platform = font.readUInt16BE(rec);
    if (font.readUInt16BE(rec + 6) !== id) continue;
    const length = font.readUInt16BE(rec + 8);
    const start = strings + font.readUInt16BE(rec + 10);
    if (start + length > font.length) continue;
    let text = "";
    if (platform === 3 || platform === 0) {
      for (let k = start; k + 1 < start + length; k += 2) text += String.fromCharCode(font.readUInt16BE(k));
    } else if (platform === 1) text = font.toString("latin1", start, start + length);
    const score = platform === 3 ? 2 : 1;
    if (text && score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best.replace(/\0/g, "");
}

function utf16le(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16LE(text.charCodeAt(i), i * 2);
  return out;
}

export const EOT_MAGIC = 0x504c;

/** The font's own licence flag (OS/2 fsType). 0x0002 means it may not be embedded. */
export function embeddingAllowed(font: Buffer): boolean {
  const os2 = tables(font).get("OS/2");
  if (!os2 || os2.offset + 10 > font.length) return true;
  return (font.readUInt16BE(os2.offset + 8) & 0x000f) !== 0x0002;
}

/** Wrap a TrueType/OpenType font as EOT. Missing tables fall back to neutral values. */
export function toEot(font: Buffer): Buffer {
  const t = tables(font);
  const os2 = t.get("OS/2");
  const head = t.get("head");
  const u16 = (o: number) => (o + 2 <= font.length ? font.readUInt16BE(o) : 0);
  const u32 = (o: number) => (o + 4 <= font.length ? font.readUInt32BE(o) : 0);

  const panose = Buffer.alloc(10);
  let weight = 400;
  let fsType = 0;
  let italic = 0;
  const unicode = [0, 0, 0, 0];
  const codepage = [0, 0];
  if (os2 && os2.offset + 78 <= font.length) {
    const o = os2.offset;
    weight = u16(o + 4) || 400;
    fsType = u16(o + 8);
    font.copy(panose, 0, o + 32, o + 42);
    for (let i = 0; i < 4; i++) unicode[i] = u32(o + 42 + i * 4);
    italic = u16(o + 62) & 1;
    if (u16(o) >= 1 && os2.length >= 86) {
      codepage[0] = u32(o + 78);
      codepage[1] = u32(o + 82);
    }
  }
  const checkSumAdjustment = head ? u32(head.offset + 8) : 0;

  const strings = [nameString(font, t, 1), nameString(font, t, 2), nameString(font, t, 5), nameString(font, t, 4)].map(utf16le);
  const root = Buffer.alloc(0);

  const fixed = Buffer.alloc(80);
  let p = 8; // EOTSize and FontDataSize are filled at the end
  fixed.writeUInt32LE(0x00020001, p); p += 4; // Version
  fixed.writeUInt32LE(0, p); p += 4; // Flags: no compression, no XOR
  panose.copy(fixed, p); p += 10;
  fixed.writeUInt8(1, p); p += 1; // Charset: DEFAULT_CHARSET
  fixed.writeUInt8(italic, p); p += 1;
  fixed.writeUInt32LE(weight, p); p += 4;
  fixed.writeUInt16LE(fsType, p); p += 2;
  fixed.writeUInt16LE(EOT_MAGIC, p); p += 2;
  for (const v of unicode) { fixed.writeUInt32LE(v >>> 0, p); p += 4; }
  for (const v of codepage) { fixed.writeUInt32LE(v >>> 0, p); p += 4; }
  fixed.writeUInt32LE(checkSumAdjustment >>> 0, p); p += 4;
  p += 16; // Reserved1-4
  if (p !== fixed.length) throw new Error(`EOT header is ${p} bytes, expected ${fixed.length}`);

  const parts: Buffer[] = [fixed];
  const sized = (bytes: Buffer) => {
    const lead = Buffer.alloc(4); // Padding (USHORT 0) then Size (USHORT)
    lead.writeUInt16LE(bytes.length, 2);
    parts.push(lead, bytes);
  };
  for (const s of strings) sized(s); // family, style, version, full name
  sized(root); // Padding5 + RootStringSize + RootString (2.1)
  parts.push(font);
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length, 0);
  out.writeUInt32LE(font.length, 4);
  return out;
}
