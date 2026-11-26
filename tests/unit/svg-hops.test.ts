import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleSvgHops, guidedSvgMissText, joinSvgPieces } from "../../src/pipeline/svgHops";
import { stagedMarkupNote } from "../../src/pipeline/stagedMarkup";

const poster = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`;

describe("an SVG gathered across hops", () => {
  it("reads one complete write_svg", () => {
    const got = assembleSvgHops([
      { functionCall: { name: "write_svg", args: { id: "poster", filename: "poster.svg", svg: poster } } },
    ]);
    assert.equal(got?.svg, poster);
    assert.equal(got?.id, "poster");
    assert.equal(got?.filename, "poster.svg");
  });

  it("appends a later piece onto the open document", () => {
    const head = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10"`;
    const tail = ` height="10"/></svg>`;
    assert.equal(joinSvgPieces([head, tail]), poster);
    const got = assembleSvgHops([
      { functionCall: { name: "write_svg", args: { id: "poster", svg: head } } },
      { functionCall: { name: "write_svg", args: { filename: "poster.svg", svg: tail } } },
    ]);
    assert.equal(got?.svg, poster);
    assert.equal(got?.id, "poster");
    assert.equal(got?.filename, "poster.svg");
  });

  it("keeps the longer copy when a hop starts the document over", () => {
    const short = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`;
    const got = assembleSvgHops([
      { functionCall: { name: "write_svg", args: { svg: short } } },
      { functionCall: { name: "write_svg", args: { svg: poster } } },
    ]);
    assert.equal(got?.svg, poster);
  });

  it("reads the document from text hops when the tool argument never arrived", () => {
    const got = assembleSvgHops([{ text: poster.slice(0, 40) }, { text: poster.slice(40) }]);
    assert.equal(got?.svg, poster);
  });

  it("tells the model a copied staging note is not the SVG", () => {
    const note = stagedMarkupNote("write_svg", 32416);
    const text = guidedSvgMissText(
      [{ functionCall: { name: "write_svg", args: { svg: note } } }],
      { id: "small_icon", filename: "OVWA_75_Small_Icon.svg" },
    );
    const shortened = note.replace(" — ", " ");
    assert.match(
      guidedSvgMissText(
        [{ functionCall: { name: "write_svg", args: { svg: shortened } } }],
        { id: "small_icon", filename: "OVWA_75_Small_Icon.svg" },
      ),
      /staging note/,
    );
    assert.match(text, /staging note/);
    assert.match(text, /small_icon/);
    assert.match(text, /OVWA_75_Small_Icon\.svg/);
    assert.equal(assembleSvgHops([{ functionCall: { name: "write_svg", args: { svg: note } } }]), null);
  });

  it("tells the model when the hop is not a document", () => {
    const text = guidedSvgMissText(
      [{ text: "noted" }],
      { id: "small_icon", filename: "OVWA_75_Small_Icon.svg" },
    );
    assert.match(text, /not a complete SVG document \(5 characters\)/);
    assert.match(guidedSvgMissText([], { id: "small_icon", filename: "OVWA_75_Small_Icon.svg" }), /^Empty reply\./);
  });

  it("does not invent a close tag for an unfinished document", () => {
    assert.equal(assembleSvgHops([{ functionCall: { name: "write_svg", args: { svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect` } } }]), null);
  });
});
