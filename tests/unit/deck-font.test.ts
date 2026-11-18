import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { buildComposition, parseComposition } from "../../src/pipeline/composition";
import { EOT_MAGIC, embeddingAllowed, toEot } from "../../src/pipeline/eot";

function utf16be(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

/** A tiny sfnt with name and OS/2 tables: enough for family matching and the EOT header. */
function craftFont(family: string, subfamily: string, fsType = 0): Buffer {
  const names: Array<[number, string]> = [
    [1, family],
    [2, subfamily],
    [4, `${family} ${subfamily}`],
    [5, "Version 1.000"],
    [16, family],
    [17, subfamily],
  ];
  const records: Buffer[] = [];
  const strings: Buffer[] = [];
  let cursor = 0;
  for (const [nameID, text] of names) {
    const encoded = utf16be(text);
    const rec = Buffer.alloc(12);
    rec.writeUInt16BE(3, 0);
    rec.writeUInt16BE(1, 2);
    rec.writeUInt16BE(0x409, 4);
    rec.writeUInt16BE(nameID, 6);
    rec.writeUInt16BE(encoded.length, 8);
    rec.writeUInt16BE(cursor, 10);
    records.push(rec);
    strings.push(encoded);
    cursor += encoded.length;
  }
  const nameHeader = Buffer.alloc(6);
  nameHeader.writeUInt16BE(0, 0);
  nameHeader.writeUInt16BE(names.length, 2);
  nameHeader.writeUInt16BE(6 + names.length * 12, 4);
  const nameTable = Buffer.concat([nameHeader, ...records, ...strings]);
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0);
  os2.writeUInt16BE(subfamily === "Bold" ? 700 : 400, 4);
  os2.writeUInt16BE(fsType, 8);
  const sfnt = Buffer.alloc(12);
  sfnt.writeUInt32BE(0x00010000, 0);
  sfnt.writeUInt16BE(2, 4);
  const dir = Buffer.alloc(32);
  dir.write("OS/2", 0, "latin1");
  dir.writeUInt32BE(44, 8);
  dir.writeUInt32BE(os2.length, 12);
  dir.write("name", 16, "latin1");
  dir.writeUInt32BE(44 + os2.length, 24);
  dir.writeUInt32BE(nameTable.length, 28);
  return Buffer.concat([sfnt, dir, os2, nameTable]);
}

function brief() {
  return JSON.stringify({
    deliverables: [
      {
        id: "branded",
        filename: "Branded.pptx",
        kind: "pptx",
        font: "Poppins",
        slides: [
          {
            notes: "Speak in the brand face.",
            elements: [
              { type: "text", text: "Title", bold: true },
              { type: "text", text: "Other", font: "Inter" },
              { type: "shape", x: 10, y: 20, w: 30, h: 15, fill: "112233" },
            ],
          },
        ],
      },
      { id: "plain", filename: "Plain.pptx", kind: "pptx", slides: [{ elements: [{ type: "text", text: "No face" }] }] },
    ],
  });
}

async function build(embed: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-font-"));
  const regularPath = path.join(dir, "Poppins-Regular.ttf");
  const boldPath = path.join(dir, "Poppins-Bold.ttf");
  fs.writeFileSync(regularPath, craftFont("Poppins", "Regular"));
  fs.writeFileSync(boldPath, craftFont("Poppins", "Bold"));
  const prev = process.env.PPTX_EMBED_FONTS;
  if (embed) process.env.PPTX_EMBED_FONTS = "1";
  else delete process.env.PPTX_EMBED_FONTS;
  try {
    const built = await buildComposition({
      composition: parseComposition(brief()),
      workDir: path.join(dir, "work"),
      filesByName: new Map([
        ["poppins-regular.ttf", regularPath],
        ["poppins-bold.ttf", boldPath],
      ]),
      ownerId: "font-test",
    });
    const open = async (name: string) =>
      JSZip.loadAsync(fs.readFileSync(built.find((file) => file.filename === name)!.absPath));
    return { branded: await open("Branded.pptx"), plain: await open("Plain.pptx"), regular: fs.readFileSync(regularPath) };
  } finally {
    if (prev === undefined) delete process.env.PPTX_EMBED_FONTS;
    else process.env.PPTX_EMBED_FONTS = prev;
  }
}

describe("deck typefaces", () => {
  it("writes the faces the brain names and the parts PowerPoint requires", async () => {
    const { branded, plain } = await build(false);
    const slide = await branded.file("ppt/slides/slide1.xml")!.async("string");
    assert.match(slide, /typeface="Poppins"/);
    assert.match(slide, /typeface="Inter"/);
    assert.match(slide, /<a:rPr[^>]* b="1"/, "bold is an attribute, not an <a:b/> element");
    assert.equal(slide.includes("<a:b/>"), false);
    const theme = await branded.file("ppt/theme/theme1.xml")!.async("string");
    assert.match(theme, /<a:latin typeface="Poppins"/, "the deck face is the theme face");
    for (const part of [
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/notesMasters/notesMaster1.xml",
      "ppt/presProps.xml",
      "docProps/app.xml",
    ]) {
      assert.ok(branded.file(part), `${part} is present`);
    }
    const presentation = await branded.file("ppt/presentation.xml")!.async("string");
    assert.match(presentation, /<p:sldMasterId id="\d+" r:id="rId\d+"\/>/);
    assert.equal(presentation.includes("embeddedFont"), false, "no embedding unless PPTX_EMBED_FONTS is on");
    assert.equal(Object.values(branded.files).some((entry) => entry.dir), false, "no folder entries");

    const plainSlide = await plain.file("ppt/slides/slide1.xml")!.async("string");
    assert.equal(plainSlide.includes("typeface="), false, "no face named, none written");
    // Positions are the brain's percentages of a 13.333 x 7.5 in slide, exactly.
    const emu = (inches: number) => Math.round(inches * 914400);
    assert.match(slide, new RegExp(`<a:off x="${emu(1.3333)}" y="${emu(1.5)}"/><a:ext cx="${emu(3.9999)}" cy="${emu(1.125)}"/>`));
  });

  it("embeds attached faces as Embedded OpenType when PPTX_EMBED_FONTS=1", async () => {
    const { branded, plain, regular } = await build(true);
    const presentation = await branded.file("ppt/presentation.xml")!.async("string");
    assert.match(presentation, /<p:embeddedFont><p:font typeface="Poppins"\/><p:regular r:id="rId\d+"\/><p:bold r:id="rId\d+"\/><\/p:embeddedFont>/);
    assert.equal(presentation.includes("Inter"), false, "nothing attached for Inter, nothing embedded");
    assert.ok(presentation.indexOf("<p:embeddedFontLst>") > presentation.indexOf("<p:notesSz"), "schema order");
    const types = await branded.file("[Content_Types].xml")!.async("string");
    assert.match(types, /Extension="fntdata"/);
    const rels = await branded.file("ppt/_rels/presentation.xml.rels")!.async("string");
    const targets = [...rels.matchAll(/Target="(fonts\/font\d+\.fntdata)"/g)].map((m) => m[1]!);
    assert.equal(targets.length, 2);
    const eot = await branded.file(`ppt/${targets[0]}`)!.async("nodebuffer");
    assert.equal(eot.readUInt32LE(0), eot.length, "EOTSize");
    assert.equal(eot.readUInt32LE(8), 0x00020001, "version 2.1");
    assert.equal(eot.readUInt16LE(34), EOT_MAGIC, "magic number at its fixed offset");
    const fontSize = eot.readUInt32LE(4);
    const font = eot.subarray(eot.length - fontSize);
    assert.ok(font.equals(regular) || font.readUInt32BE(0) === 0x00010000, "the TrueType bytes follow the header");
    const plainPresentation = await plain.file("ppt/presentation.xml")!.async("string");
    assert.equal(plainPresentation.includes("embeddedFont"), false);
  });

  it("writes the EOT name fields in order and respects a no-embedding licence", () => {
    const font = craftFont("Brand Sans", "Bold");
    const eot = toEot(font);
    let p = 80;
    const read = () => {
      p += 2;
      const size = eot.readUInt16LE(p);
      p += 2;
      const text = eot.toString("utf16le", p, p + size);
      p += size;
      return text;
    };
    assert.deepEqual([read(), read(), read(), read()], ["Brand Sans", "Bold", "Version 1.000", "Brand Sans Bold"]);
    assert.equal(read(), "", "empty root string");
    assert.equal(eot.length - p, font.length);
    assert.equal(eot.readUInt32LE(16 + 10 + 2), 700, "weight from OS/2");
    assert.equal(embeddingAllowed(craftFont("X", "Regular", 0x0002)), false);
    assert.equal(embeddingAllowed(craftFont("X", "Regular", 0x0008)), true);
  });
});
