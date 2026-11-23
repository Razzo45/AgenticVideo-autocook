import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import sharp from "sharp";
import {
  buildComposition,
  composeInstructions,
  composeTaskInstructions,
  generatorFacts,
  mixFilter,
  parseComposition,
  sliceTurnText,
} from "../../src/pipeline/composition";
import { sanitizeLyriaPrompt } from "../../src/pipeline/geminiAudio";
import { asGeneratorPicture, encodeMediaTo, sniffImage } from "../../src/pipeline/mediaFormat";
import { recordPlatformNote, takePlatformNotes } from "../../src/pipeline/platformNotes";
import { installedFontsLine } from "../../src/pipeline/renderEnv";
import { applyTaskBriefs, briefFollowUp, hasTaskBriefs, sliceKey } from "../../src/pipeline/taskPipeline";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("the instruction does not suggest values", () => {
  const text = composeInstructions([{ deliverable: "pptx", filename: "Deck.pptx" }], ["logo.png"]);

  it("uses placeholders where it used to show example values", () => {
    // The installed-font list is a fact about the worker, not an example; leave it out of this check.
    const examples = text.replace(generatorFacts(), "");
    for (const anchor of ["Poppins", "F4F1EA", "1920", "1080", '"size":28', '"duration_sec":6', '"x":6', '"voice":"Sulafat"']) {
      assert.equal(examples.includes(anchor), false, `no example value ${anchor}`);
    }
    assert.match(text, /"font":"<family name>"/);
    assert.match(text, /"fill":"<hex colour>"/);
    assert.match(text, /<…> marks a value you choose/);
  });

  it("names the defaults that apply when a field is left out", () => {
    assert.match(text, /size 28 when bold, else 16; color 111111; align left/);
    assert.match(text, /default voice Sulafat/);
    assert.match(text, /default instrumental/);
  });

  it("states generator and renderer limits as facts", () => {
    const facts = generatorFacts();
    assert.match(facts, /up to 6000 characters/);
    assert.match(facts, /3–10 seconds, 16:9 or 9:16/);
    assert.match(facts, /HTML prints in Chromium/);
    assert.match(facts, /"in the style of …" phrases are removed/);
    assert.ok(text.includes(facts));
    assert.match(briefFollowUp(), /up to 6000 characters/);
  });

  it("collapses Noto's per-script families in the font list", () => {
    const line = installedFontsLine(["Arial", "Noto Sans", "Noto Sans Arabic", "Noto Serif Thai", "Noto Sans Mono"]);
    assert.equal(line, "Arial, Noto Sans, Noto Sans Mono; plus Noto Sans/Serif for 2 other scripts");
  });
});

describe("the second plan turn", () => {
  const plan = {
    deliverables: [
      { deliverable: "pdf", id: "poster", filename: "Poster.pdf" },
      { deliverable: "pdf", id: "flyer", filename: "Flyer.pdf" },
    ],
  };

  it("attaches the brain's briefs and shared decisions to the plan", () => {
    const reply = JSON.stringify({
      shared: "Ink and chalk, one orange accent. Headline: A new place to look.",
      deliverables: [
        { id: "flyer", filename: "Flyer.pdf", brief: "A5, two sides." },
        { id: "poster", filename: "Poster.pdf", brief: "A2, distance-readable." },
      ],
    });
    const out = applyTaskBriefs(plan, reply);
    assert.equal(out.shared, "Ink and chalk, one orange accent. Headline: A new place to look.");
    assert.deepEqual(out.deliverables.map((d) => d.brief), ["A2, distance-readable.", "A5, two sides."]);
    assert.equal(hasTaskBriefs(out), true);
    assert.equal(hasTaskBriefs(plan), false);
  });

  it("leaves an html file list to the deliverable and keeps the brief for other kinds", () => {
    const text = briefFollowUp();
    assert.match(text, /what this file contains and how it is made/);
    assert.match(text, /For an html deliverable, this brief does not list the files inside it or the code in them/);
    assert.match(text, /Those are written in the deliverable JSON/);
  });

  it("refuses an empty brief turn", () => {
    assert.throws(() => applyTaskBriefs(plan, "{}"), /no shared decisions and no briefs/);
  });

  it("every file's call shares one instruction; the file's own brief is in its turn", () => {
    const planned = [
      { deliverable: "pdf", id: "poster", filename: "Poster.pdf", brief: "A2 poster brief" },
      { deliverable: "pdf", id: "flyer", filename: "Flyer.pdf", brief: "A5 flyer brief" },
    ];
    const shared = composeTaskInstructions(planned, [], "Carbon", "Shared palette");
    assert.match(shared, /Decisions shared by every file of this task \(from your plan\):\nShared palette/);
    assert.equal(shared.includes("A2 poster brief"), false);
    assert.match(sliceTurnText([planned[0]]), /A2 poster brief/);
  });

  it("a changed brief or shared decision does not reuse a saved file", () => {
    const slice = [{ deliverable: "pdf", id: "poster", filename: "Poster.pdf", brief: "one" }];
    const a = sliceKey(slice, "m", "s");
    assert.notEqual(a, sliceKey([{ ...slice[0]!, brief: "two" }], "m", "s"));
    assert.notEqual(a, sliceKey(slice, "m", "other"));
    assert.equal(a, sliceKey(slice, "m", "s"));
  });
});

describe("output as the brain wrote it", () => {
  it("a deck keeps any font size and positions past the edge", async () => {
    const dir = tmp("deck-");
    const built = await buildComposition({
      composition: parseComposition(
        JSON.stringify({
          deliverables: [
            {
              id: "d",
              filename: "D.pptx",
              kind: "pptx",
              slides: [{ elements: [{ type: "text", text: "Big", size: 140, x: -5, y: 105, w: 50, h: 10 }] }],
            },
          ],
        }),
      ),
      workDir: dir,
      filesByName: new Map(),
      ownerId: "unbiased",
    });
    const slide = await (await JSZip.loadAsync(fs.readFileSync(built[0]!.absPath))).file("ppt/slides/slide1.xml")!.async("string");
    assert.match(slide, /sz="14000"/);
    assert.match(slide, new RegExp(`<a:off x="${Math.round(-0.05 * 13.333 * 914400)}" y="${Math.round(1.05 * 7.5 * 914400)}"/>`));
  });

  it("the music sanitizer removes a named style without putting a genre in its place", () => {
    const out = sanitizeLyriaPrompt("Slow piano in the style of Devendra Banhart. Warm tape hiss.");
    assert.equal(out.includes("psych-folk"), false);
    assert.equal(out.includes("Banhart"), false);
    assert.match(out, /Slow piano/);
    assert.match(out, /Warm tape hiss\./);
  });

  it("mix: no level means the old average; levels and length are the brain's", () => {
    assert.match(mixFilter({}), /\[a0\]\[a1\]amix=inputs=2:duration=first:dropout_transition=0$/);
    const levelled = mixFilter({ speech_level_db: 0, music: { level_db: -18, until: "longest" } });
    assert.match(levelled, /volume=-18\.00dB/);
    assert.match(levelled, /duration=longest/);
    assert.match(levelled, /normalize=0/);
    assert.match(mixFilter({ music: { until: "music" } }), /\[a1\]\[a0\]amix=inputs=2:duration=first/);
  });

  it("an audio file named .mp3 is MP3", async () => {
    const dir = tmp("enc-");
    const wav = path.join(dir, "a.wav");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
    const mp3 = path.join(dir, "Podcast.mp3");
    const run = async (args: string[]) => {
      execFileSync("ffmpeg", args);
    };
    assert.equal(await encodeMediaTo("audio", wav, mp3, run), "encoded");
    const head = fs.readFileSync(mp3).subarray(0, 3);
    assert.ok(head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0), "MP3 bytes");
    assert.equal(await encodeMediaTo("audio", wav, path.join(dir, "Same.wav"), run), "copied");
    assert.equal(await encodeMediaTo("audio", wav, path.join(dir, "Odd.xyz"), run), "unsupported");
  });

  it("reference pictures reach the generator labelled by their real format", async () => {
    const dir = tmp("refs-");
    const svg = path.join(dir, "logo.svg");
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>`);
    const webp = path.join(dir, "photo.webp");
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123456" } }).webp().toFile(webp);
    const fromSvg = await asGeneratorPicture(svg, dir);
    assert.equal(fromSvg?.mime, "image/png");
    assert.equal(sniffImage(fs.readFileSync(fromSvg!.path)), "png");
    assert.deepEqual(await asGeneratorPicture(webp, dir), { path: webp, mime: "image/webp" });
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    assert.equal(await asGeneratorPicture(path.join(dir, "notes.txt"), dir), null);
  });

  it("two reference conversions of the same file both finish", async () => {
    const dir = tmp("refs-race-");
    const svg = path.join(dir, "198c833f-a221-4096-bb4b-442da4ce4f9d_Draft-universe_primary_logo.svg");
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#111"/></svg>`);
    const [a, b] = await Promise.all([asGeneratorPicture(svg, dir), asGeneratorPicture(svg, dir)]);
    assert.equal(a?.path, b?.path);
    assert.equal(sniffImage(fs.readFileSync(a!.path)), "png");
    assert.equal(fs.readdirSync(path.join(dir, ".refs")).some((name) => name.endsWith(".part")), false);
  });

  it("platform notes are collected per deliverable", () => {
    recordPlatformNote("cut", "run_n:poster-clip1");
    recordPlatformNote("other", "run_n:flyer-clip1");
    assert.deepEqual(takePlatformNotes("run_n:poster"), ["cut"]);
    assert.deepEqual(takePlatformNotes("run_n:poster"), []);
    assert.deepEqual(takePlatformNotes("run_n:flyer"), ["other"]);
  });
});
