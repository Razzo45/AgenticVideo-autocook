import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { convertImage } from "../../src/pipeline/mediaFormat";

async function redPng(): Promise<string> {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#ff0000" },
  }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function board(href: string, x: number, width: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00ff00"/><image href="${href}" x="${x}" y="0" width="${width}" height="20" preserveAspectRatio="xMidYMid slice"/></svg>`;
}

async function draw(svg: string, hrefLimit?: number): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svg-draw-"));
  const src = path.join(dir, "board.svg");
  const dest = path.join(dir, "board.png");
  fs.writeFileSync(src, svg);
  await convertImage(src, dest, "png", hrefLimit ? { svgImageHrefLimit: hrefLimit } : {});
  return fs.readFileSync(dest);
}

function pixel(raw: Buffer, x: number): Buffer {
  return raw.subarray(x * 4, x * 4 + 3);
}

describe("a picture inside an SVG", () => {
  it("draws a small picture in place", async () => {
    const png = await draw(board(await redPng(), 0, 20));
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    const red = pixel(raw, 2);
    const green = pixel(raw, 30);
    assert.ok(red[0] > 180 && red[1] < 80, `left is the picture, got ${red.join(",")}`);
    assert.ok(green[1] > 180 && green[0] < 80, `right is the board, got ${green.join(",")}`);
  });

  it("places a picture the SVG renderer would refuse, including the part that starts off the canvas", async () => {
    const png = await draw(board(await redPng(), -20, 40), 30);
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    const red = pixel(raw, 2);
    const green = pixel(raw, 30);
    assert.ok(red[0] > 180 && red[1] < 80, `the visible part of the picture is on the left, got ${red.join(",")}`);
    assert.ok(green[1] > 180 && green[0] < 80, `the board stays on the right, got ${green.join(",")}`);
  });
});
