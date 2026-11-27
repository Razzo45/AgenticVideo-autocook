import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { convertImage, sniffImage } from "../../src/pipeline/mediaFormat";
import { findChromium, svgAnimationPlan } from "../../src/pipeline/paintGif";

const STILL = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00ff00"/></svg>`;
const ANIMATED = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#ff0000"><animate attributeName="fill" dur="0.2s" repeatCount="indefinite" calcMode="discrete" values="#ff0000;#0000ff"/></rect></svg>`;

describe("a GIF painted from an SVG", () => {
  it("plans one frame per discrete step of the animation", () => {
    assert.equal(svgAnimationPlan(STILL), null);
    assert.deepEqual(svgAnimationPlan(ANIMATED), { seconds: 0.2, frames: 2, capped: false });
    const long = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"><animate attributeName="x" dur="3.84s" calcMode="discrete" values="${Array.from({ length: 48 }, () => "0").join(";")}"/></rect></svg>`;
    assert.deepEqual(svgAnimationPlan(long), { seconds: 3.84, frames: 48, capped: false });
  });

  it("paints the animation as a looping GIF, and a still SVG as one frame", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gif-"));
    const stillSrc = path.join(dir, "still.svg");
    const stillGif = path.join(dir, "still.gif");
    fs.writeFileSync(stillSrc, STILL);
    await convertImage(stillSrc, stillGif, "gif");
    const stillBytes = fs.readFileSync(stillGif);
    assert.equal(sniffImage(stillBytes), "gif");
    assert.equal((await sharp(stillBytes, { animated: true }).metadata()).pages, 1);

    if (!findChromium()) return;
    const moving = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#ff0000"><animate attributeName="x" dur="0.2s" repeatCount="indefinite" calcMode="discrete" values="0;20"/><animate attributeName="fill" dur="0.2s" repeatCount="indefinite" calcMode="discrete" values="#ff0000;#0000ff"/></rect></svg>`;
    const src = path.join(dir, "mark.svg");
    const dest = path.join(dir, "mark.gif");
    fs.writeFileSync(src, moving);
    await convertImage(src, dest, "gif");
    const bytes = fs.readFileSync(dest);
    assert.equal(sniffImage(bytes), "gif");
    assert.ok(bytes.includes(Buffer.from("NETSCAPE2.0")));
    const meta = await sharp(bytes, { animated: true }).metadata();
    assert.equal(meta.pages, 2);
    assert.deepEqual([meta.width, meta.pageHeight], [40, 20]);
    const raw = await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer();
    const at = (frame: number, x: number) => raw.subarray((frame * 40 * 20 + x) * 4, (frame * 40 * 20 + x) * 4 + 3);
    const red = (rgb: Buffer) => rgb[0] > 180 && rgb[2] < 80;
    const white = (rgb: Buffer) => rgb[0] > 220 && rgb[1] > 220 && rgb[2] > 220;
    assert.ok(red(at(0, 2)) && white(at(0, 30)), `first step sits on the left, got ${at(0, 2).join(",")} / ${at(0, 30).join(",")}`);
    const blue = (rgb: Buffer) => rgb[2] > 180 && rgb[0] < 80;
    assert.ok(white(at(1, 2)) && blue(at(1, 30)), `second step is the blue block on the right, got ${at(1, 2).join(",")} / ${at(1, 30).join(",")}`);
  });
});
