import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  classifyOperatorVideoRole,
  isLikelyTitleGraphicAsset,
  isLikelyTrademarkAsset,
  operatorModelImageRefs,
} from "../../src/pipeline/inputs";
import { geminiFileName, sha256Bytes, shouldInlineMedia } from "../../src/pipeline/geminiStaging";

describe("gemini staging rules", () => {
  it("inlines a small picture and stages video, audio, a large pdf, and anything over 12 MB", () => {
    assert.equal(shouldInlineMedia("image/png", 1024), true);
    assert.equal(shouldInlineMedia("image/png", 12 * 1024 * 1024), true);
    assert.equal(shouldInlineMedia("image/png", 12 * 1024 * 1024 + 1), false);
    assert.equal(shouldInlineMedia("application/pdf", 2 * 1024 * 1024), true);
    assert.equal(shouldInlineMedia("application/pdf", 2 * 1024 * 1024 + 1), false);
    assert.equal(shouldInlineMedia("video/mp4", 100), false);
    assert.equal(shouldInlineMedia("audio/wav", 100), false);
    assert.equal(shouldInlineMedia("image/png", 100, { stage: true }), false);
  });

  it("hashes bytes and keeps the files api name", () => {
    assert.equal(sha256Bytes(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(geminiFileName("https://generativelanguage.googleapis.com/v1beta/files/abc123"), "files/abc123");
  });
});

describe("input roles", () => {
  it("keeps logos and title cards out of model image refs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-inputs-"));
    const logo = path.join(dir, "Fjellmark_logo.png");
    const plate = path.join(dir, "plate.png");
    fs.writeFileSync(logo, "x");
    fs.writeFileSync(plate, "x");
    assert.equal(isLikelyTrademarkAsset("Fjellmark_logo.png"), true);
    assert.equal(isLikelyTitleGraphicAsset("end_card.png"), true);
    assert.equal(classifyOperatorVideoRole("intro_title_card.mp4"), "intro");
    assert.equal(classifyOperatorVideoRole("outro.mp4"), "outro");
    assert.equal(classifyOperatorVideoRole("broll.mp4"), "reference");
    const raw = JSON.stringify([
      { filename: "Fjellmark_logo.png", path: logo, kind: "image" },
      { filename: "plate.png", path: plate, kind: "image" },
    ]);
    assert.deepEqual(operatorModelImageRefs(raw), [plate]);
  });
});
