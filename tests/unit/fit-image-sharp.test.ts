import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { executeArgonMediaTool, type MediaToolContext } from "../../src/autocook/argonMediaTools";

describe("fit_image sharp path", () => {
  it("resizes a png cover to exact pixels without ffmpeg", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-fit-"));
    const stagingDir = path.join(root, "compose_media");
    fs.mkdirSync(stagingDir, { recursive: true });
    const source = path.join(root, "cover.png");
    await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .png()
      .toFile(source);

    const ctx: MediaToolContext = {
      stagingDir,
      staged: new Map(),
      filesByName: new Map([["cover.png", source]]),
      namedReferencesOnly: true,
    };

    const result = await executeArgonMediaTool(
      "fit_image",
      {
        id: "cover-fit",
        source: "cover.png",
        filename: "assets/cover-fit.png",
        width: 1080,
        height: 1920,
        fit: "cover",
      },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    const out = ctx.staged.get("cover-fit")!.absPath;
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
  });
});
