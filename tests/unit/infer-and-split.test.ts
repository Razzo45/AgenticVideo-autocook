import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferCookKind } from "../../src/autocook/inferCookKind";
import { fallbackCookSplit, normalizeCookSplit } from "../../src/autocook/splitCooks";

describe("cook kind inference", () => {
  it("names a deck, a page, a still, audio, and video", () => {
    assert.equal(inferCookKind("Make a slide deck"), "pptx");
    assert.equal(inferCookKind("Export a pdf master"), "pdf");
    assert.equal(inferCookKind("Build a landing page"), "html");
    assert.equal(inferCookKind("Generate an image of a red square"), "image");
    assert.equal(inferCookKind("A podcast about the launch"), "audio");
    assert.equal(inferCookKind("A 15 second reel"), "video");
  });

  it("uses attachment names when the sentence does not", () => {
    assert.equal(inferCookKind("Use the attached file", ["board.pptx"]), "pptx");
    assert.equal(inferCookKind("Use the attached file", ["page.html"]), "html");
    assert.equal(inferCookKind("Use the attached file", ["bed.wav"]), "audio");
  });

  it("does not call an attached pdf the deliverable", () => {
    assert.equal(inferCookKind("Read the attached pdf and make a video", ["brief.pdf"]), "video");
  });
});

describe("cook split normalization", () => {
  it("expands a count into one entry per file and stops at six", () => {
    const cooks = normalizeCookSplit(
      {
        cooks: [
          { kind: "image", count: 3, label: "Thumb", brief: "A thumbnail" },
          { kind: "video", count: 9, label: "Spot", brief: "" },
        ],
      },
      "Fallback brief",
    );
    assert.deepEqual(
      cooks.map((cook) => cook.label),
      ["Thumb 1", "Thumb 2", "Thumb 3", "Spot 1", "Spot 2", "Spot 3"],
    );
    assert.equal(cooks[3]?.brief, "Fallback brief");
  });

  it("drops an unknown kind and falls back to one cook", () => {
    assert.deepEqual(normalizeCookSplit({ cooks: [{ kind: "docx", count: 1 }] }, "Write a page"), []);
    assert.deepEqual(fallbackCookSplit("Write a landing page"), [
      { kind: "html", label: "html", brief: "Write a landing page" },
    ]);
  });
});
