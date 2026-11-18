import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { buildComposition, parseComposition, withoutFolderEntries } from "../../src/pipeline/composition";
import { sniffImage, svgIntrinsicSize } from "../../src/pipeline/mediaFormat";
import JSZip from "jszip";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#0000ff"/></svg>`;

async function build(deliverables: unknown[], files = new Map<string, string>()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  const built = await buildComposition({
    composition: parseComposition(JSON.stringify({ deliverables }), { filesByName: files }),
    workDir: dir,
    filesByName: files,
    ownerId: "img-test",
  });
  return built.map((file) => ({ ...file, bytes: fs.readFileSync(file.absPath) }));
}

describe("picture deliverables are the format their name says", () => {
  it("kind image with an SVG source, named Banner.png, is a PNG at the SVG's own size", async () => {
    const [banner] = await build([{ id: "b", filename: "Banner.png", kind: "image", source: { kind: "svg", svg: SVG } }]);
    assert.equal(banner!.filename, "Banner.png");
    assert.equal(sniffImage(banner!.bytes), "png");
    const meta = await sharp(banner!.bytes).metadata();
    assert.deepEqual([meta.width, meta.height], [300, 100], "no size invented by the platform");
  });

  it("a contradiction is written as given: kind svg named .png stays SVG text", async () => {
    const built = await build([
      { id: "m", filename: "Mark.png", kind: "svg", svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>` },
      { id: "v", filename: "Mark.svg", kind: "svg", svg: SVG },
    ]);
    assert.equal(built[0]!.filename, "Mark.png");
    assert.equal(sniffImage(built[0]!.bytes), "svg");
    assert.equal(sniffImage(built[1]!.bytes), "svg");
  });

  it("honours an exact size on the deliverable", async () => {
    const [b] = await build([{ id: "b", filename: "Thumb.jpg", kind: "image", width: 640, height: 360, source: { kind: "svg", svg: SVG } }]);
    assert.equal(sniffImage(b!.bytes), "jpeg");
    const meta = await sharp(b!.bytes).metadata();
    assert.deepEqual([meta.width, meta.height], [640, 360]);
  });

  it("a placed JPEG named .png is written as PNG; a photo named .svg is written as given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-src-"));
    const jpg = path.join(dir, "photo.jpg");
    await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ff0000" } }).jpeg().toFile(jpg);
    const files = new Map([["photo.jpg", jpg]]);
    const built = await build(
      [
        { id: "p", filename: "Photo.png", kind: "image", source: { kind: "place", file: "photo.jpg" } },
        { id: "q", filename: "Logo.svg", kind: "image", source: { kind: "place", file: "photo.jpg" } },
      ],
      files,
    );
    assert.equal(built[0]!.filename, "Photo.png");
    assert.equal(sniffImage(built[0]!.bytes), "png");
    assert.deepEqual([(await sharp(built[0]!.bytes).metadata()).width, (await sharp(built[0]!.bytes).metadata()).height], [40, 20]);
    assert.equal(built[1]!.filename, "Logo.svg", "the brain's name is kept");
    assert.equal(sniffImage(built[1]!.bytes), "jpeg", "the platform does not invent an SVG");
  });

  it("a deck picture fills the box the brain gave, even if that distorts it", async () => {
    const [deck] = await build([
      {
        id: "d",
        filename: "Deck.pptx",
        kind: "pptx",
        slides: [{ elements: [{ type: "image", x: 64, y: 22, w: 30, h: 45, source: { kind: "svg", svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300"/></svg>` } }] }],
      },
    ]);
    const zip = await JSZip.loadAsync(deck!.bytes);
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const emu = (inches: number) => Math.round(inches * 914400);
    assert.match(slide, new RegExp(`<a:ext cx="${emu(13.333 * 0.3)}" cy="${emu(7.5 * 0.45)}"/>`));
    const media = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/"));
    assert.equal(sniffImage(await zip.file(media[0]!)!.async("nodebuffer")), "png", "an SVG picture is packed as PNG");
  });

  it("sniffs formats and SVG sizes", () => {
    assert.equal(sniffImage(Buffer.from(`<?xml version="1.0"?>\n<!-- x -->\n${SVG}`)), "svg");
    assert.equal(sniffImage(Buffer.from("hello")), null);
    assert.deepEqual(svgIntrinsicSize(SVG), { width: 300, height: 100 });
    assert.deepEqual(svgIntrinsicSize(`<svg viewBox="0 0 40 20"/>`), { width: 40, height: 20 });
  });

  it("zips carry no folder entries", async () => {
    const zip = new JSZip();
    zip.folder("ppt")!.file("a.xml", "<a/>");
    const cleaned = await JSZip.loadAsync(await withoutFolderEntries(await zip.generateAsync({ type: "nodebuffer" })));
    assert.deepEqual(Object.keys(cleaned.files), ["ppt/a.xml"]);
  });
});
