import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import sharp from "sharp";
import { buildComposition, parseComposition } from "../../src/pipeline/composition";
import { htmlToDocx } from "../../src/pipeline/docxWrite";
import { withGeminiOwner } from "../../src/pipeline/geminiAdmission";
import { readOffice } from "../../src/pipeline/officeText";
import { takePlatformNotes } from "../../src/pipeline/platformNotes";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("docx writer", () => {
  it("packs headings, lists, a table, a link, and pictures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-write-"));
    await sharp({ create: { width: 800, height: 20, channels: 3, background: "#336699" } }).png().toFile(path.join(dir, "wide.png"));
    fs.writeFileSync(path.join(dir, "mark.png"), PNG);
    const html = `<!doctype html><html><body>
      <h1>Title &amp; Co</h1>
      <p style="text-align:center">Hello <strong>bold</strong> <a href="https://example.com/spec">spec</a></p>
      <p style="page-break-before: always">Next</p>
      <ul><li>One</li><li>Two</li></ul>
      <ol><li>First</li></ol>
      <table><tr><th>Name</th><th>Qty</th></tr><tr><td>Bolt</td><td>4</td></tr></table>
      <img src="mark.png" alt="mark" width="12" height="12">
      <img src="wide.png">
      <img src="data:image/png;base64,${PNG.toString("base64")}" width="8" height="8">
    </body></html>`;
    const bytes = await withGeminiOwner("docx-test", () => htmlToDocx(html, { baseDir: dir }));
    assert.match(takePlatformNotes("docx-test").join("\n"), /wide\.png/);
    const zip = await JSZip.loadAsync(bytes);
    const document = await zip.file("word/document.xml")!.async("string");
    assert.match(document, /Heading1/);
    assert.equal((document.match(/<w:drawing\b/g) ?? []).length, 3);
    assert.match(document, /<w:b[\s/>]/);
    assert.match(document, /pageBreakBefore/);
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
    assert.match(rels, /https:\/\/example\.com\/spec/);
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    assert.match(numbering, /bullet/);
    assert.match(numbering, /decimal/);
    const pieces = await readOffice(bytes, "Note.docx");
    const text = pieces?.find((piece) => piece.kind === "text");
    assert.ok(text && text.kind === "text");
    assert.match(text.text, /Title & Co/);
    assert.match(text.text, /Hello bold spec/);
    assert.match(text.text, /One/);
    assert.match(text.text, /Bolt/);
    assert.ok((pieces?.filter((piece) => piece.kind === "image").length ?? 0) >= 2);
    const parsed = parseComposition(
      JSON.stringify({ deliverables: [{ type: "word", filename: "Note.docx", html: "<p>Hi</p>" }] }),
    );
    assert.equal(parsed.deliverables[0]?.kind, "docx");
  });

  it("builds a docx from its html and from another html file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "docx-build-"));
    const logo = path.join(root, "logo.png");
    fs.writeFileSync(logo, PNG);
    const built = await buildComposition({
      composition: parseComposition(
        JSON.stringify({
          deliverables: [
            {
              id: "page",
              filename: "Page.html",
              kind: "html",
              files: [{ path: "index.html", content: "<h1>From the page</h1><p>Body</p>" }],
            },
            {
              id: "note",
              filename: "Note.docx",
              kind: "docx",
              html: `<p>Placed</p><img src="{{asset:logo}}" alt="logo">`,
              assets: [{ id: "logo", filename: "logo.png", source: { kind: "place", file: "logo.png" } }],
            },
            { id: "copy", filename: "Copy.docx", kind: "docx", from: "Page.html" },
          ],
        }),
      ),
      workDir: root,
      filesByName: new Map([["logo.png", logo]]),
      ownerId: "docx-build",
    });
    const note = built.find((file) => file.filename === "Note.docx");
    const copy = built.find((file) => file.filename === "Copy.docx");
    assert.ok(note && copy);
    const notePieces = await readOffice(fs.readFileSync(note.absPath), note.filename);
    const copyPieces = await readOffice(fs.readFileSync(copy.absPath), copy.filename);
    const noteText = notePieces?.find((piece) => piece.kind === "text");
    const copyText = copyPieces?.find((piece) => piece.kind === "text");
    assert.ok(noteText && noteText.kind === "text" && /Placed/.test(noteText.text));
    assert.ok(copyText && copyText.kind === "text" && /From the page/.test(copyText.text));
    assert.ok(notePieces?.some((piece) => piece.kind === "image"));
  });

  it("refuses a remote picture address", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-remote-"));
    await assert.rejects(() => htmlToDocx(`<p><img src="https://example.com/a.png"></p>`, { baseDir: dir }), /remote address/);
  });
});
