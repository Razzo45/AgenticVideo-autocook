import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { executeArgonMediaTool } from "../../src/autocook/argonMediaTools";
import { buildComposition, parseComposition } from "../../src/pipeline/composition";
import { probeFile } from "../../src/pipeline/stitch";

const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-compose-"));

function ffmpeg(args: string[]): Promise<void> {
  return exec("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { windowsHide: true }).then(() => undefined);
}

describe("composition build", () => {
  it("builds every kind and the mixes from local files", { timeout: 180_000 }, async () => {
    const media = path.join(root, "media");
    const work = path.join(root, "work");
    fs.mkdirSync(media, { recursive: true });
    const logo = path.join(media, "logo.png");
    const webp = path.join(media, "plate.webp");
    const gif = path.join(media, "mark.gif");
    const jpeg = path.join(media, "photo.jpg");
    const red = path.join(media, "red.mp4");
    const blue = path.join(media, "blue.mp4");
    const mono = path.join(media, "mono.wav");
    const stereo = path.join(media, "stereo.wav");
    const bed = path.join(media, "bed.wav");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x336699:s=320x200:d=1", "-frames:v", "1", logo]);
    await ffmpeg(["-i", logo, "-frames:v", "1", webp]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xccaa22:s=40x30:d=0.2", "-frames:v", "1", gif]);
    await ffmpeg(["-i", logo, "-frames:v", "1", jpeg]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xcc3333:s=320x240:d=1", "-pix_fmt", "yuv420p", "-r", "30", "-an", red]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x3333cc:s=160x120:d=1", "-pix_fmt", "yuv420p", "-r", "30", "-an", blue]);
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=1", "-ac", "1", mono]);
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=1", "-ac", "2", stereo]);
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=110:sample_rate=48000:duration=2", "-ac", "2", bed]);

    const toolDir = path.join(root, "tool");
    fs.mkdirSync(toolDir, { recursive: true });
    await executeArgonMediaTool(
      "fit_image",
      { id: "zip-path", source: "brand/logo.png", filename: "slots/zip-path.png", width: 16, height: 16 },
      { stagingDir: toolDir, staged: new Map(), filesByName: new Map([["brand/logo.png", logo]]), namedReferencesOnly: true },
    );
    const fittedRef = await probeFile(path.join(toolDir, "slots", "zip-path.png"));
    assert.equal(fittedRef.width, 16);
    assert.equal(fittedRef.height, 16);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#102033"/></svg>`;
    const soffice = [
      process.env.LIBREOFFICE_BIN,
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ].find((bin) => bin && fs.existsSync(bin));
    const deliverables: unknown[] = [
      {
        id: "deck",
        filename: "Deck.pptx",
        kind: "pptx",
        slides: [
          {
            background: "102033",
            notes: "Say the quiet part.",
            elements: [
              { type: "text", text: "Q&A <draft>", x: 6, y: 8, w: 80, h: 16, size: 28, bold: true, color: "F4F1EA" },
              { type: "shape", x: 0, y: 80, w: 100, h: 20, fill: "F4F1EA" },
              { type: "image", x: 6, y: 28, w: 20, h: 30, source: { kind: "place", file: "brand/logo.png", width: 120, height: 80, fit: "cover" } },
              { type: "image", x: 30, y: 28, w: 20, h: 30, source: { kind: "place", file: "plate.webp" } },
              { type: "image", x: 54, y: 28, w: 20, h: 30, source: { kind: "place", file: "mark.gif" } },
              { type: "image", x: 78, y: 28, w: 16, h: 20, source: { kind: "svg", svg } },
            ],
          },
        ],
      },
      {
        id: "site",
        filename: "Site.html",
        kind: "html",
        entry: "index.html",
        files: [
          { path: "index.html", content: `<!doctype html><img src="{{asset:logo}}"><img src="{{asset:badge}}">` },
          { path: "css/site.css", content: "body{margin:0}" },
        ],
        assets: [
          { id: "logo", filename: "assets/logo.png", source: { kind: "place", file: "brand/logo.png" } },
          { id: "badge", filename: "assets/badge.svg", embed: "data_uri", source: { kind: "svg", svg } },
        ],
      },
      { id: "note", filename: "Note.html", kind: "html", files: [{ path: "index.html", content: "Hello note" }] },
      { id: "mark", filename: "Mark.svg", kind: "svg", svg },
      { id: "fitted", filename: "Fitted.png", kind: "image", source: { kind: "place", file: "brand/logo.png", width: 120, height: 80, fit: "cover" } },
      { id: "thumb", filename: "Thumb.png", kind: "image", source: { kind: "place", file: "brand/logo.png", width: 64, height: 64, fit: "contain" } },
      { id: "drawn", filename: "Drawn.svg", kind: "image", source: { kind: "svg", svg } },
      { id: "photo", filename: "Photo.jpg", kind: "image", source: { kind: "place", file: "photo.jpg" } },
      {
        id: "spot",
        filename: "Spot.mp4",
        kind: "video",
        width: 640,
        height: 360,
        duration_sec: 1.2,
        fit: "contain",
        clips: [{ file: "red.mp4" }, { source: { kind: "place", file: "blue.mp4" } }],
      },
      { id: "voice", filename: "Voice.wav", kind: "audio", places: ["mono.wav", "stereo.wav"] },
      { id: "score", filename: "Score.wav", kind: "audio", source: { kind: "place", file: "mono.wav" }, music: { file: "bed.wav" } },
      {
        id: "handout",
        filename: "Handout.pdf",
        kind: "pdf",
        html: `<!doctype html><img src="{{asset:hero shot}}">`,
        assets: [{ id: "hero shot", filename: "assets/hero.png", source: { kind: "place", file: "brand/logo.png" } }],
      },
      { id: "sitepdf", filename: "Site.pdf", kind: "pdf", from: "Site.html" },
    ];
    if (soffice) deliverables.push({ id: "slides", filename: "Slides.pdf", kind: "pdf", from: "Deck.pptx" });

    const built = await buildComposition({
      composition: parseComposition(JSON.stringify({ deliverables })),
      workDir: work,
      filesByName: new Map([
        ["brand/logo.png", logo],
        ["plate.webp", webp],
        ["mark.gif", gif],
        ["photo.jpg", jpeg],
        ["red.mp4", red],
        ["blue.mp4", blue],
        ["mono.wav", mono],
        ["stereo.wav", stereo],
        ["bed.wav", bed],
      ]),
      ownerId: "composition-test",
    });
    const byName = new Map(built.map((file) => [file.filename.toLowerCase(), file.absPath]));
    const must = (name: string) => {
      const abs = byName.get(name.toLowerCase());
      assert.ok(abs && fs.existsSync(abs), name);
      return abs!;
    };
    const header = (abs: string, bytes: number[]) => {
      const buf = fs.readFileSync(abs).subarray(0, bytes.length);
      return bytes.every((byte, index) => buf[index] === byte);
    };

    const deck = must("Deck.pptx");
    assert.equal(header(deck, [0x50, 0x4b]), true);
    const zip = await JSZip.loadAsync(fs.readFileSync(deck));
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const notes = await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string");
    const names = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/image"));
    assert.match(slide, /Q&amp;A &lt;draft&gt;/);
    assert.equal(slide.includes("Calibri"), false);
    assert.match(slide, /102033/);
    assert.match(notes, /Say the quiet part/);
    assert.equal(names.some((name) => /\.(webp|gif|svg)$/i.test(name)), false);
    assert.equal(names.filter((name) => name.endsWith(".png")).length, 4);

    const site = await JSZip.loadAsync(fs.readFileSync(must("Site.zip")));
    const html = await site.file("index.html")!.async("string");
    assert.match(html, /assets\/logo\.png/);
    assert.equal(html.includes("{{asset:"), false);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.equal(await site.file("css/site.css")!.async("string"), "body{margin:0}");
    assert.match(fs.readFileSync(must("Note.html"), "utf8"), /Hello note/);
    assert.match(fs.readFileSync(must("Mark.svg"), "utf8"), /<svg/);
    assert.match(fs.readFileSync(must("Drawn.svg"), "utf8"), /102033/);
    assert.equal(header(must("Photo.jpg"), [0xff, 0xd8]), true);

    const fitted = await probeFile(must("Fitted.png"));
    const thumb = await probeFile(must("Thumb.png"));
    assert.equal(fitted.width, 120);
    assert.equal(fitted.height, 80);
    assert.equal(thumb.width, 64);
    assert.equal(thumb.height, 64);
    const fits = fs.readdirSync(path.join(work, "compose_media", "slots")).filter((name) => /-fit\.png$/i.test(name));
    assert.equal(fits.length, 2);

    const spot = await probeFile(must("Spot.mp4"));
    assert.equal(spot.width, 640);
    assert.equal(spot.height, 360);
    assert.ok((spot.duration ?? 0) > 1 && (spot.duration ?? 0) < 1.5);
    const voice = await probeFile(must("Voice.wav"));
    const score = await probeFile(must("Score.wav"));
    assert.ok((voice.duration ?? 0) > 1.8 && (voice.duration ?? 0) < 2.3);
    assert.ok((score.duration ?? 0) > 0.8 && (score.duration ?? 0) < 1.4);

    const handoutHtml = fs.readFileSync(path.join(work, "out", "handout-pdf", "index.html"), "utf8");
    assert.match(handoutHtml, /assets\/hero\.png/);
    assert.equal(handoutHtml.includes("{{asset:"), false);
    for (const name of ["Handout.pdf", "Site.pdf", ...(soffice ? ["Slides.pdf"] : [])]) {
      const abs = must(name);
      assert.equal(header(abs, [0x25, 0x50, 0x44, 0x46]), true);
      assert.ok(fs.statSync(abs).size > 1000);
    }

    await assert.rejects(
      () =>
        buildComposition({
          composition: parseComposition(
            JSON.stringify({
              deliverables: [{ id: "bad", filename: "Bad.html", kind: "html", files: [{ path: "../secret.html", content: "no" }] }],
            }),
          ),
          workDir: path.join(root, "unsafe"),
          filesByName: new Map(),
          ownerId: "unsafe",
        }),
      /Unsafe path/,
    );
  });
});
