import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { classifyAttachment } from "../../src/pipeline/attachForArgon";

describe("attachment placement", () => {
  it("remembers a file inside a zip by its archive path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-zip-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const zip = new JSZip();
    zip.file("Direction_A/A-08.jpg", png);
    zip.file("__MACOSX/._junk", "no");
    const zipPath = path.join(dir, "Fjellmark_Image_Library.zip");
    fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    const placed = new Map<string, string>();
    const pieces = await classifyAttachment({
      name: "Fjellmark_Image_Library.zip",
      filePath: zipPath,
      spillDir: path.join(dir, "spill"),
      placed,
    });
    const abs = placed.get("fjellmark_image_library/direction_a/a-08.jpg");
    assert.ok(abs && fs.existsSync(abs));
    assert.equal(placed.get("direction_a/a-08.jpg"), abs);
    assert.equal(placed.has("__macosx/._junk"), false);
    assert.match(pieces.map((piece) => (piece.kind === "note" ? piece.text : piece.kind)).join("\n"), /Direction_A\/A-08\.jpg/);
  });
});
