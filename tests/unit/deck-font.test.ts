import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { buildComposition, parseComposition } from "../../src/pipeline/composition";

function utf16be(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

function craftFont(family: string, subfamily: string): Buffer {
  const names: Array<[number, string]> = [
    [1, family],
    [2, subfamily],
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
  const sfnt = Buffer.alloc(12);
  sfnt.writeUInt32BE(0x00010000, 0);
  sfnt.writeUInt16BE(1, 4);
  const table = Buffer.alloc(16);
  table.write("name", 0, "latin1");
  table.writeUInt32BE(28, 8);
  table.writeUInt32BE(nameTable.length, 12);
  return Buffer.concat([sfnt, table, nameTable]);
}

function guidBytes(guid: string): Buffer {
  const raw = Buffer.from(guid.replace(/-/g, ""), "hex");
  const out = Buffer.alloc(16);
  out[0] = raw[3]!;
  out[1] = raw[2]!;
  out[2] = raw[1]!;
  out[3] = raw[0]!;
  out[4] = raw[5]!;
  out[5] = raw[4]!;
  out[6] = raw[7]!;
  out[7] = raw[6]!;
  raw.copy(out, 8, 8, 16);
  return out;
}

describe("deck typefaces", () => {
  it("embeds the attached family Argon names and does not invent one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-font-"));
    const regular = craftFont("Poppins", "Regular");
    const bold = craftFont("Poppins", "Bold");
    const regularPath = path.join(dir, "Poppins-Regular.ttf");
    const boldPath = path.join(dir, "Poppins-Bold.ttf");
    fs.writeFileSync(regularPath, regular);
    fs.writeFileSync(boldPath, bold);

    const built = await buildComposition({
      composition: parseComposition(
        JSON.stringify({
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
                  ],
                },
              ],
            },
            {
              id: "plain",
              filename: "Plain.pptx",
              kind: "pptx",
              slides: [{ elements: [{ type: "text", text: "No face" }] }],
            },
          ],
        }),
      ),
      workDir: path.join(dir, "work"),
      filesByName: new Map([
        ["poppins-regular.ttf", regularPath],
        ["poppins-bold.ttf", boldPath],
      ]),
      ownerId: "font-test",
    });
    const branded = await JSZip.loadAsync(fs.readFileSync(built.find((file) => file.filename === "Branded.pptx")!.absPath));
    const slide = await branded.file("ppt/slides/slide1.xml")!.async("string");
    const notes = await branded.file("ppt/notesSlides/notesSlide1.xml")!.async("string");
    const presentation = await branded.file("ppt/presentation.xml")!.async("string");
    assert.equal(slide.includes("Calibri"), false);
    assert.match(slide, /typeface="Poppins"/);
    assert.match(slide, /typeface="Inter"/);
    assert.match(notes, /typeface="Poppins"/);
    assert.match(presentation, /<p:embeddedFont><p:font typeface="Poppins"\/>/);
    assert.match(presentation, /<p:regular /);
    assert.match(presentation, /<p:bold /);
    assert.equal(presentation.includes("Inter"), false);

    const rels = await branded.file("ppt/_rels/presentation.xml.rels")!.async("string");
    const targets = [...rels.matchAll(/Target="fonts\/([0-9a-f-]{36})\.fntdata"/g)].map((match) => match[1]!);
    assert.equal(targets.length, 2);
    const restored = targets.map((guid) => {
      const data = branded.file(`ppt/fonts/${guid}.fntdata`)!;
      return data.async("nodebuffer").then((bytes) => {
        const key = guidBytes(guid);
        const head = Buffer.from(bytes.subarray(0, 4));
        for (let i = 0; i < head.length; i++) head[i] = head[i]! ^ key[i % 16]!;
        return head.toString("hex");
      });
    });
    assert.deepEqual(await Promise.all(restored), ["00010000", "00010000"]);

    const plain = await JSZip.loadAsync(fs.readFileSync(built.find((file) => file.filename === "Plain.pptx")!.absPath));
    const plainSlide = await plain.file("ppt/slides/slide1.xml")!.async("string");
    const plainPresentation = await plain.file("ppt/presentation.xml")!.async("string");
    assert.equal(plainSlide.includes("Calibri"), false);
    assert.equal(plainSlide.includes("typeface="), false);
    assert.equal(plainPresentation.includes("embeddedFont"), false);
  });
});
