import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions, parseComposition } from "../../src/pipeline/composition";

describe("composition parse", () => {
  it("tells Argon about every deliverable kind", () => {
    const text = composeInstructions(
      [{ deliverable: "pptx", filename: "Deck.pptx" }],
      ["brand/logo.png"],
    );
    for (const kind of ["pptx", "pdf", "html", "svg", "image", "video", "audio"]) {
      assert.match(text, new RegExp(kind));
    }
    assert.match(text, /brand\/logo\.png/);
    assert.match(text, /Deck\.pptx/);
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
      [
        JSON.stringify({
          deliverables: [{ kind: "video", filename: "x.mp4", clips: Array.from({ length: 13 }, () => ({ file: "a.mp4" })) }],
        }),
        /at most 12/,
      ],
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
