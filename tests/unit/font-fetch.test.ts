import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  collectionDir,
  fetchFamily,
  fontconfigFile,
  metadataFiles,
  requestedFamilies,
  resetFontFetchState,
  shorthandFamilies,
  substitutionNote,
} from "../../src/pipeline/fontFetch";

describe("which families a file names", () => {
  it("reads font-family, the font shorthand and SVG attributes, and skips generics", () => {
    const html = `<style>
      h1 { font: italic 700 48px/1.1 'Playfair Display', Georgia, serif; }
      p { font-family: "Space Grotesk", var(--x), system-ui, sans-serif; }
      .x { font-family: Inter !important }
    </style>
    <p style="font-family: 'IBM Plex Sans'">a</p>
    <svg><text font-family="Futura, sans-serif">b</text><text font-family='Lora'>c</text></svg>`;
    assert.deepEqual(requestedFamilies(html).sort(), ["Futura", "Georgia", "IBM Plex Sans", "Inter", "Lora", "Playfair Display", "Space Grotesk"].sort());
  });

  it("leaves out families the file brings itself with @font-face", () => {
    const css = `@font-face { font-family: "Brand Sans"; src: url(assets/brand.ttf); } body { font-family: "Brand Sans", Lato; }`;
    assert.deepEqual(requestedFamilies(css), ["Lato"]);
  });

  it("finds the family list after the size in a font shorthand", () => {
    assert.equal(shorthandFamilies("700 48px/1.1 'Playfair Display', serif"), "'Playfair Display', serif");
    assert.equal(shorthandFamilies("bold 2rem / 1.2 Inter"), "Inter");
    assert.equal(shorthandFamilies("large Lato"), "Lato");
    assert.equal(shorthandFamilies("inherit"), null);
  });

  it("names the collection folder and reads its file list for that exact family", () => {
    assert.equal(collectionDir("IBM Plex Sans"), "ibmplexsans");
    assert.equal(collectionDir("M PLUS 1p"), "mplus1p");
    const meta = `name: "Playfair Display"\nfonts {\n  filename: "PlayfairDisplay[wght].ttf"\n}\nfonts {\n  filename: "PlayfairDisplay-Italic[wght].ttf"\n}\n`;
    assert.deepEqual(metadataFiles(meta, "playfair display"), ["PlayfairDisplay[wght].ttf", "PlayfairDisplay-Italic[wght].ttf"]);
    assert.equal(metadataFiles(meta, "Playfair"), null, "another family in a matching folder is not used");
    assert.equal(metadataFiles(`name: "X"\nfonts {\n  filename: "../evil.ttf"\n}`, "X"), null, "no paths outside the folder");
  });

  it("words the note without claiming which face was drawn", () => {
    assert.equal(substitutionNote({ fetched: ["Lato"], substituted: [] }, "Chromium"), null);
    const note = substitutionNote({ fetched: [], substituted: ["Futura", "Helvetica Neue"] }, "Chromium")!;
    assert.match(note, /Chromium did not have Futura, Helvetica Neue: they are not installed/);
    assert.match(note, /next family the file lists, or the renderer's default/);
  });
});

describe("fetching a family", () => {
  let server: http.Server;
  let hits: string[] = [];
  const font = Buffer.from("not a real font, only bytes to copy");

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === "/ofl/testsans/METADATA.pb") {
        res.end(`name: "Test Sans"\nfonts {\n  filename: "TestSans[wght].ttf"\n}\n`);
      } else if (req.url === "/ofl/testsans/TestSans%5Bwght%5D.ttf") {
        res.end(font);
      } else if (req.url === "/apache/othername/METADATA.pb") {
        res.end(`name: "Something Else"\nfonts {\n  filename: "A.ttf"\n}\n`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    process.env.FONT_SOURCE_BASE = `http://127.0.0.1:${port}`;
    process.env.FONT_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fontfetch-"));
    resetFontFetchState();
  });
  after(() => server.close());

  it("downloads every listed file of an openly licensed family into the cache", async () => {
    assert.equal(await fetchFamily("Test Sans"), true);
    const folder = path.join(path.dirname(fontconfigFile()), "files", "testsans");
    assert.ok(fs.readFileSync(path.join(folder, "TestSans[wght].ttf")).equals(font));
    assert.equal(fs.readFileSync(path.join(folder, ".complete"), "utf8").trim(), "ofl");
    hits = [];
    assert.equal(await fetchFamily("Test Sans"), true);
    assert.deepEqual(hits, [], "cached: no second download");
    assert.ok(fs.readFileSync(fontconfigFile(), "utf8").includes(`<dir>${path.dirname(folder)}</dir>`), "the renderers see the cache folder");
  });

  it("does not use a folder whose family is another, and remembers a family it cannot find", async () => {
    assert.equal(await fetchFamily("Other Name"), false);
    assert.equal(await fetchFamily("Futura"), false);
    hits = [];
    assert.equal(await fetchFamily("Futura"), false);
    assert.deepEqual(hits, [], "not looked up twice");
  });
});
