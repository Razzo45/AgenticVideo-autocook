import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { blankForMissingImage, missingImageFinish } from "../../src/pipeline/composition";
import { takePlatformNotes } from "../../src/pipeline/platformNotes";

describe("a picture the model does not return", () => {
  it("recognises only the no-bytes failure", () => {
    assert.equal(missingImageFinish(new Error("generate_image: model returned no image bytes")), "");
    assert.equal(
      missingImageFinish(new Error("stage failed: generate_image: model returned no image bytes (IMAGE_RECITATION)")),
      "IMAGE_RECITATION",
    );
    assert.equal(missingImageFinish(new Error("generate_image: timed out")), null);
    assert.equal(missingImageFinish("generate_image: model returned no image bytes"), null);
  });

  it("writes a transparent picture of the size the brain asked for and records the blank", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blank-image-"));
    const dest = path.join(dir, "slots", "scheme_a-t1_velvet.png");
    const written = await blankForMissingImage({
      err: new Error("generate_image: model returned no image bytes (IMAGE_RECITATION)"),
      id: "scheme_a-t1_velvet",
      ownerId: "run_blank",
      dest,
      width: 420,
      height: 320,
    });
    assert.equal(written, dest);
    const meta = await sharp(dest).metadata();
    assert.equal(meta.width, 420);
    assert.equal(meta.height, 320);
    const { data } = await sharp(dest).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0);
    assert.deepEqual(takePlatformNotes("run_blank:scheme_a"), [
      "The image model returned no picture (IMAGE_RECITATION) for scheme_a-t1_velvet, so that space was left blank.",
    ]);

    const other = await blankForMissingImage({
      err: new Error("Attached file not found: swatch.png"),
      id: "scheme_a-other",
      ownerId: "run_blank",
      dest: path.join(dir, "other.png"),
    });
    assert.equal(other, null);
    assert.equal(fs.existsSync(path.join(dir, "other.png")), false);
  });
});
