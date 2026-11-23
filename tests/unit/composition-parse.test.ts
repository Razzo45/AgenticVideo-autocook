import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { executeMediaTool } from "../../src/autocook/mediaTools";
import { pdfSiblingFilenames, plannedExecuteSlices, plannedHtmlTargets, plannedSvgTargets } from "../../src/pipeline/taskPipeline";
import { composeInstructions, parseComposition } from "../../src/pipeline/composition";
import { stagedMarkupNote } from "../../src/pipeline/stagedMarkup";

describe("composition parse", () => {
  it("tells the brain about every deliverable kind", () => {
    const text = composeInstructions(
      [{ deliverable: "pptx", filename: "Deck.pptx" }],
      ["brand/logo.png"],
    );
    for (const kind of ["pptx", "pdf", "html", "svg", "image", "video", "audio"]) {
      assert.match(text, new RegExp(kind));
    }
    assert.match(text, /brand\/logo\.png/);
    assert.match(text, /Deck\.pptx/);
    assert.match(text, /write_svg/);
    assert.match(text, /one write_svg per turn/);
    assert.match(text, /This turn is only the planned file above/);
    assert.match(text, /another planned file/);
    assert.match(text, /"audio":"keep"/);
    assert.match(text, /"audio":"mute"/);
  });

  it("accepts video audio keep or mute from the brain", () => {
    const keep = parseComposition(
      JSON.stringify({
        deliverables: [{ kind: "video", filename: "A.mp4", clips: [{ file: "a.mp4" }], audio: "keep" }],
      }),
    );
    const mute = parseComposition(
      JSON.stringify({
        deliverables: [{ kind: "video", filename: "B.mp4", clips: [{ file: "b.mp4" }], audio: "mute" }],
      }),
    );
    assert.equal(keep.deliverables[0]?.audio, "keep");
    assert.equal(mute.deliverables[0]?.audio, "mute");
  });

  it("lists planned SVG targets for guided write_svg", () => {
    const targets = plannedSvgTargets([
      { deliverable: "svg", id: "a", filename: "A.svg", note: "primary" },
      { deliverable: "pdf", id: "skip", filename: "x.pdf" },
      { deliverable: "svg", filename: "B.svg" },
    ]);
    assert.deepEqual(
      targets.map((t) => ({ id: t.id, filename: t.filename })),
      [
        { id: "a", filename: "A.svg" },
        { id: "B", filename: "B.svg" },
      ],
    );
  });

  it("names the deck on a pdf turn so from can point at it", () => {
    const text = composeInstructions(
      [{ deliverable: "pdf", filename: "Board.pdf" }],
      ["logo.png"],
      "Argon",
      ["Deck.pptx"],
    );
    assert.match(text, /Deck\.pptx/);
    assert.match(text, /Do not rewrite those files/);
    assert.match(text, /another planned file/);
    assert.doesNotMatch(text, /this same reply/);
  });

  it("lists sibling filenames only for a pdf slice", () => {
    const planned = [
      { deliverable: "pptx", filename: "Deck.pptx" },
      { deliverable: "pdf", filename: "Board.pdf" },
    ];
    assert.deepEqual(pdfSiblingFilenames(planned, [planned[1]!]), ["Deck.pptx"]);
    assert.deepEqual(pdfSiblingFilenames(planned, [planned[0]!]), []);
  });

  it("slices execute so html and video are separate JSON calls", () => {
    const slices = plannedExecuteSlices([
      { deliverable: "html", filename: "hero.html" },
      { deliverable: "video", filename: "hero.mp4" },
    ]);
    assert.deepEqual(
      slices.map((slice) => slice.map((item) => item.deliverable)),
      [["html"], ["video"]],
    );
  });

  it("batches two or more SVGs into one execute slice", () => {
    const slices = plannedExecuteSlices([
      { deliverable: "svg", filename: "A.svg" },
      { deliverable: "html", filename: "page.html" },
      { deliverable: "svg", filename: "B.svg" },
    ]);
    assert.deepEqual(
      slices.map((slice) => slice.map((item) => item.filename)),
      [["A.svg", "B.svg"], ["page.html"]],
    );
  });

  it("lists planned HTML targets for guided write_html", () => {
    const targets = plannedHtmlTargets([
      { deliverable: "html", id: "home", filename: "index.html" },
      { deliverable: "webpage", filename: "About.html" },
      { deliverable: "pptx", filename: "Deck.pptx" },
    ]);
    assert.deepEqual(
      targets.map((t) => ({ id: t.id, filename: t.filename })),
      [
        { id: "home", filename: "index.html" },
        { id: "About", filename: "About.html" },
      ],
    );
  });

  it("fills empty svg bodies from staged write_svg files", () => {
    const staged = new Map([["mark", '<svg xmlns="http://www.w3.org/2000/svg"/>']]);
    const composition = parseComposition(
      JSON.stringify({ deliverables: [{ kind: "svg", id: "mark", filename: "Mark.svg" }] }),
      { stagedSvg: staged },
    );
    assert.match(composition.deliverables[0]?.svg ?? "", /<svg/);
  });

  it("replaces a copied staging note with the stored svg", () => {
    const note = "[staged 25937 chars — already stored by write_svg; do not repeat]";
    const stored = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const composition = parseComposition(
      JSON.stringify({
        deliverables: [{ kind: "svg", id: "flyer", filename: "flyer.svg", svg: note }],
      }),
      { stagedSvg: new Map([["flyer", stored]]) },
    );
    assert.equal(composition.deliverables[0]?.svg, stored);
  });

  it("rejects a reply whose svg is only the staging note", () => {
    const note = "[staged 25937 chars — already stored by write_svg; do not repeat]";
    assert.throws(
      () =>
        parseComposition(
          JSON.stringify({
            deliverables: [{ kind: "svg", id: "flyer", filename: "flyer.svg", svg: note }],
          }),
        ),
      /SVG needs the document/,
    );
  });

  it("does not overwrite a stored svg with the staging note", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staged-markup-"));
    const ctx = { stagingDir: dir, staged: new Map() };
    const real = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    await executeMediaTool("write_svg", { id: "flyer", filename: "flyer.svg", svg: real }, ctx);
    const abs = ctx.staged.get("flyer")?.absPath;
    assert.ok(abs);
    await assert.rejects(
      () =>
        executeMediaTool(
          "write_svg",
          { id: "flyer", filename: "flyer.svg", svg: stagedMarkupNote("write_svg", real.length) },
          ctx,
        ),
      /staging note/,
    );
    assert.equal(fs.readFileSync(abs, "utf8"), real);
  });

  it("fills empty html files from staged write_html documents", () => {
    const staged = new Map([
      ["page", { content: "<!doctype html><html><body>Hi</body></html>", path: "index.html" }],
    ]);
    const composition = parseComposition(
      JSON.stringify({ deliverables: [{ kind: "html", id: "page", filename: "Site.html" }] }),
      { stagedHtml: staged },
    );
    assert.equal(composition.deliverables[0]?.entry, "index.html");
    assert.equal(composition.deliverables[0]?.files?.[0]?.content.includes("Hi"), true);
  });

  it("reads a fenced reply and aliases", () => {
    const composition = parseComposition(
      "```json\n" +
        JSON.stringify({
          deliverables: [
            { type: "powerpoint", filename: "Deck.pptx", slides: [{ elements: [{ type: "text", text: "Hi" }, { type: "image", image_file: "logo.png" }] }] },
            { type: "webpage", filename: "Site.html", files: [{ path: "index.html", content: "<p></p>" }] },
            { type: "mp4", filename: "Spot.mp4", clips: [{ file: "red.mp4" }] },
            { type: "wav", filename: "Voice.wav", places: ["mono.wav"] },
            { kind: "png", filename: "Still.png", source: { kind: "place", file: "logo.png" } },
            { kind: "svg", filename: "Mark.svg", svg: "<svg/>" },
          ],
        }) +
        "\n```",
    );
    assert.deepEqual(
      composition.deliverables.map((item) => item.kind),
      ["pptx", "html", "video", "audio", "image", "svg"],
    );
    assert.equal(composition.deliverables[0]?.slides?.[0]?.elements[1]?.source?.file, "logo.png");
  });

  it("accepts a video made of more than 12 clips", () => {
    const composition = parseComposition(
      JSON.stringify({
        deliverables: [
          {
            kind: "video",
            filename: "Film.mp4",
            clips: Array.from({ length: 35 }, (_, index) => ({ prompt: `plate ${index + 1}`, duration_sec: 10 })),
          },
        ],
      }),
    );
    assert.equal(composition.deliverables[0]?.clips?.length, 35);
  });

  it("rejects a reply that cannot be built", () => {
    const cases: Array<[string, RegExp]> = [
      [JSON.stringify({ deliverables: [{ kind: "docx", filename: "a.docx" }] }), /Unknown deliverable kind/],
      [
        JSON.stringify({
          deliverables: [
            { kind: "svg", filename: "Same.svg", svg: "<svg/>" },
            { kind: "svg", filename: "same.svg", svg: "<svg/>" },
          ],
        }),
        /Two deliverables/,
      ],
      [JSON.stringify({ deliverables: [{ kind: "pptx", filename: "x.pptx" }] }), /needs slides/],
      [JSON.stringify({ deliverables: [{ kind: "pdf", filename: "x.pdf" }] }), /PDF needs html/],
      [JSON.stringify({ deliverables: [{ kind: "html", filename: "x.html" }] }), /HTML needs files/],
      [JSON.stringify({ deliverables: [{ kind: "svg", filename: "x.svg" }] }), /SVG needs/],
      [JSON.stringify({ deliverables: [{ kind: "image", filename: "x.png" }] }), /image needs a source/],
      [JSON.stringify({ deliverables: [{ kind: "video", filename: "x.mp4" }] }), /video needs clips/],
      [JSON.stringify({ deliverables: [{ kind: "audio", filename: "x.wav" }] }), /audio needs/],
      ["not json", /did not parse/],
    ];
    for (const [text, pattern] of cases) {
      assert.throws(() => parseComposition(text), pattern);
    }
  });

  it("keeps an asset id exactly, including spaces", () => {
    const composition = parseComposition(
      JSON.stringify({
        deliverables: [
          {
            kind: "html",
            filename: "Page.html",
            files: [{ path: "index.html", content: "{{asset:hero shot}}" }],
            assets: [{ id: "hero shot", source: { kind: "place", file: "logo.png" } }],
          },
        ],
      }),
    );
    assert.equal(composition.deliverables[0]?.assets?.[0]?.id, "hero shot");
  });
});
