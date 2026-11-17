import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { executeArgonMediaTool, type MediaToolContext } from "../../src/autocook/argonMediaTools";

async function makeStill(root: string, name: string, width: number, height: number): Promise<string> {
  const source = path.join(root, name);
  await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 80, b: 160 } },
  })
    .png()
    .toFile(source);
  return source;
}

function mediaCtx(root: string, files: Map<string, string>): MediaToolContext {
  const stagingDir = path.join(root, "compose_media");
  fs.mkdirSync(stagingDir, { recursive: true });
  return {
    stagingDir,
    staged: new Map(),
    filesByName: files,
    namedReferencesOnly: true,
  };
}

describe("fit_image sharp path", () => {
  it("resizes cover to exact pixels without ffmpeg", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-fit-"));
    const source = await makeStill(root, "cover.png", 640, 360);
    const ctx = mediaCtx(root, new Map([["cover.png", source]]));

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
    const meta = await sharp(ctx.staged.get("cover-fit")!.absPath).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
  });

  it("pads contain with the requested color", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-fit-"));
    const source = await makeStill(root, "logo.png", 200, 100);
    const ctx = mediaCtx(root, new Map([["logo.png", source]]));

    await executeArgonMediaTool(
      "fit_image",
      {
        id: "logo-fit",
        source: "logo.png",
        filename: "assets/logo-fit.png",
        width: 400,
        height: 400,
        fit: "contain",
        pad_color: "112233",
      },
      ctx,
    );

    const { data, info } = await sharp(ctx.staged.get("logo-fit")!.absPath)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 400);
    assert.equal(info.height, 400);
    // Corner pixel should be the pad color (BGR order depends on channels — sharp raw is RGB).
    const i = 0;
    assert.equal(data[i], 0x11);
    assert.equal(data[i + 1], 0x22);
    assert.equal(data[i + 2], 0x33);
  });

  it("stretches to exact width and height", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-fit-"));
    const source = await makeStill(root, "wide.png", 400, 100);
    const ctx = mediaCtx(root, new Map([["wide.png", source]]));

    const result = await executeArgonMediaTool(
      "fit_image",
      {
        id: "wide-fit",
        source: "wide.png",
        filename: "assets/wide-fit.png",
        width: 300,
        height: 300,
        fit: "stretch",
      },
      ctx,
    );

    assert.equal(result.width, 300);
    assert.equal(result.height, 300);
  });

  it("rejects empty sources quickly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-fit-"));
    const empty = path.join(root, "empty.png");
    fs.writeFileSync(empty, Buffer.alloc(8));
    const ctx = mediaCtx(root, new Map([["empty.png", empty]]));

    await assert.rejects(
      () =>
        executeArgonMediaTool(
          "fit_image",
          {
            id: "empty-fit",
            source: "empty.png",
            filename: "assets/empty-fit.png",
            width: 100,
            height: 100,
          },
          ctx,
        ),
      /empty/i,
    );
  });
});
