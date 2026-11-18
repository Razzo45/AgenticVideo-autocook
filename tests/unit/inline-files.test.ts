import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expandInlineFiles, inlineNames, namespaceSvgIds } from "../../src/pipeline/inlineFiles";
import { composeInstructions, parseComposition } from "../../src/pipeline/composition";

function fixture(): { dir: string; files: Map<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-"));
  const logo = path.join(dir, "Tern_Logo.svg");
  fs.writeFileSync(
    logo,
    `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><g id="glyph0-0"><path d="M 1.234375 0 L 9.765625 0"/></g><clipPath id="c"><rect width="5" height="5"/></clipPath></defs><use xlink:href="#glyph0-0" x="1"/><rect clip-path="url(#c)" width="9" height="9"/></svg>`,
  );
  const other = path.join(dir, "Partner.svg");
  fs.writeFileSync(other, `<svg xmlns="http://www.w3.org/2000/svg"><g id="glyph0-0"/><use href="#glyph0-0"/></svg>`);
  const png = path.join(dir, "dot.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const bin = path.join(dir, "clip.mp4");
  fs.writeFileSync(bin, Buffer.from([0, 1, 2]));
  return {
    dir,
    files: new Map([
      ["tern_logo.svg", logo],
      ["partner.svg", other],
      ["dot.png", png],
      ["clip.mp4", bin],
    ]),
  };
}

describe("inline attached files", () => {
  it("pastes the attached SVG byte-exact apart from prefixed ids", () => {
    const { files } = fixture();
    const html = `<div class="logo">{{inline:Tern_Logo.svg}}</div>`;
    const out = expandInlineFiles(html, files);
    assert.ok(!out.includes("<?xml"));
    assert.ok(out.includes('d="M 1.234375 0 L 9.765625 0"'), "path data is untouched");
    assert.ok(out.includes('id="tern-logo-glyph0-0"'));
    assert.ok(out.includes('xlink:href="#tern-logo-glyph0-0"'));
    assert.ok(out.includes("url(#tern-logo-c)"));
    assert.ok(!out.includes("{{inline"));
  });

  it("keeps two marks with the same ids apart", () => {
    const { files } = fixture();
    const out = expandInlineFiles(`{{inline:Tern_Logo.svg}}{{ inline : partner.svg }}{{inline:Tern_Logo.svg}}`, files);
    assert.ok(out.includes('id="partner-glyph0-0"'));
    assert.ok(out.includes('href="#partner-glyph0-0"'));
    assert.equal(out.split('id="tern-logo-glyph0-0"').length - 1, 2);
  });

  it("turns a raster image into a data URI and refuses other binaries", () => {
    const { files } = fixture();
    assert.match(expandInlineFiles(`<img src="{{inline:dot.png}}">`, files), /src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
    assert.throws(() => expandInlineFiles(`{{inline:clip.mp4}}`, files), /Place it as an asset/);
  });

  it("gives an SVG as a data URI where a URL belongs", () => {
    const { files } = fixture();
    const out = expandInlineFiles(
      `<img src="{{inline:Tern_Logo.svg}}"><i style="background:url({{inline:Tern_Logo.svg}})"></i>{{inline:Tern_Logo.svg}}`,
      files,
    );
    assert.equal(out.split("data:image/svg+xml;base64,").length - 1, 2);
    assert.ok(out.includes('id="tern-logo-glyph0-0"'), "the bare token is still markup");
  });

  it("embeds a large photo as it is (run_87814344: a 12.5 MB jpg)", () => {
    const { dir, files } = fixture();
    const photo = path.join(dir, "mysupportlineimag.jpg");
    fs.writeFileSync(photo, Buffer.alloc(12_500_502, 7));
    files.set("mysupportlineimag.jpg", photo);
    const out = expandInlineFiles(`<image href="{{inline:mysupportlineimag.jpg}}"/>`, files);
    assert.ok(out.startsWith('<image href="data:image/jpeg;base64,'));
    assert.ok(out.length > 16_000_000);
  });

  it("a file that cannot be inlined is refused at parse time, with the fix named", () => {
    const { files } = fixture();
    const reply = JSON.stringify({
      deliverables: [{ id: "p", filename: "P.pdf", kind: "pdf", html: `<video src="{{inline:clip.mp4}}"></video>` }],
    });
    assert.throws(() => parseComposition(reply, { filesByName: files }), /P\.pdf: .*Place it as an asset instead/);
  });

  it("names the file that is missing", () => {
    const { files } = fixture();
    assert.throws(() => expandInlineFiles(`{{inline:Nope.svg}}`, files), /Attached file not found: Nope\.svg/);
    assert.deepEqual(inlineNames(`{{inline:a.svg}} {{inline:A.svg}} {{inline: b.css }}`), ["a.svg", "b.css"]);
  });

  it("leaves ids alone when the markup references ids it does not define", () => {
    const out = namespaceSvgIds(`<svg><use href="#elsewhere"/><g id="x"/></svg>`, "p-");
    assert.ok(out.includes('href="#elsewhere"'));
    assert.ok(out.includes('id="p-x"'));
  });

  it("rejects an unknown inline name at parse time so the brain gets one rebuild ping", () => {
    const { files } = fixture();
    const reply = (name: string) =>
      JSON.stringify({
        deliverables: [{ id: "poster", filename: "Poster.pdf", kind: "pdf", html: `<html><body>{{inline:${name}}}</body></html>` }],
      });
    assert.equal(parseComposition(reply("Tern_Logo.svg"), { filesByName: files }).deliverables.length, 1);
    assert.throws(() => parseComposition(reply("Missing.svg"), { filesByName: files }), /does not match an attached filename/);
  });

  it("tells the brain about the token", () => {
    assert.match(composeInstructions([{ deliverable: "pdf", filename: "a.pdf" }], ["logo.svg"]), /\{\{inline:exact-name\.svg\}\}/);
  });
});
