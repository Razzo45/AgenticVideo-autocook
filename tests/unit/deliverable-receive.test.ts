import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseComposition } from "../../src/pipeline/composition";
import {
  isCutOffParseError,
  jsonSliceParsable,
  stitchDeliverableText,
} from "../../src/pipeline/deliverableReceive";

const deck = JSON.stringify({
  deliverables: [
    {
      kind: "pptx",
      filename: "Deck.pptx",
      slides: [{ notes: "Full speaker notes for the board.", elements: [{ type: "text", text: "Quarterly board update" }] }],
    },
  ],
});

describe("deliverable receive", () => {
  it("treats an unterminated JSON string as a cut-off reply", () => {
    assert.equal(isCutOffParseError("Deliverable JSON did not parse: Unterminated string in JSON at position 47247"), true);
    assert.equal(isCutOffParseError("Deliverable JSON did not parse: Unexpected end of JSON input"), true);
    assert.equal(isCutOffParseError("Deck.pptx: a deck needs slides"), false);
  });

  it("appends the missing suffix of a cut-off deck", () => {
    const cut = deck.slice(0, 80);
    const rest = deck.slice(80);
    const stitched = stitchDeliverableText(cut, rest);
    assert.equal(jsonSliceParsable(stitched), true);
    const composition = parseComposition(stitched);
    assert.equal(composition.deliverables[0]?.slides?.[0]?.elements[0]?.text, "Quarterly board update");
  });

  it("drops a repeated tail when the continuation overlaps", () => {
    const cut = deck.slice(0, 90);
    const overlap = deck.slice(70);
    assert.equal(stitchDeliverableText(cut, overlap), deck);
  });

  it("strips a fence around the suffix", () => {
    const cut = deck.slice(0, 80);
    const fenced = "```json\n" + deck.slice(80) + "\n```";
    assert.equal(stitchDeliverableText(cut, fenced), deck);
  });

  it("keeps a finished object when the continuation restarted the document", () => {
    const cut = deck.slice(0, 40);
    assert.equal(jsonSliceParsable(cut), false);
    assert.equal(stitchDeliverableText(cut, deck), deck);
  });
});
