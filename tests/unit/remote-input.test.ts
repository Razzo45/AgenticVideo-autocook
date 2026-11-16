import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPublicDownloadUrl } from "../../src/pipeline/inputs";

describe("task file addresses", () => {
  it("accepts an https storage URL", () => {
    assert.equal(
      assertPublicDownloadUrl("https://catalog.example.com/inputs/clip.mov?X-Amz-Signature=abc"),
      "https://catalog.example.com/inputs/clip.mov?X-Amz-Signature=abc",
    );
  });

  it("rejects addresses that are not public https", () => {
    assert.throws(() => assertPublicDownloadUrl("http://catalog.example.com/clip.mov"), /https/);
    assert.throws(() => assertPublicDownloadUrl("https://localhost/clip.mov"), /public storage/);
    assert.throws(() => assertPublicDownloadUrl("https://169.254.169.254/latest"), /public storage/);
    assert.throws(() => assertPublicDownloadUrl("https://10.0.0.5/clip.mov"), /public storage/);
    assert.throws(() => assertPublicDownloadUrl("not a url"), /valid URL/);
  });
});
