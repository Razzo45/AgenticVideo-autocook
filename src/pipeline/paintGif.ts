/**
 * An SVG named .gif is painted as that animation: one cycle, then it loops.
 * A still renderer draws the first moment only, which is how a looping preview
 * became a single frame.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { rendererEnv } from "./fontFetch";
import { recordPlatformNote } from "./platformNotes";

const execFileAsync = promisify(execFile);

/** One GIF frame is at least this long, and a paint stops at this many frames. */
const MIN_HOLD_SEC = 0.02;
const MAX_GIF_FRAMES = 120;

export type GifPlan = { seconds: number; frames: number; capped: boolean };

/** The animation to paint, or null when the SVG does not animate. */
export function svgAnimationPlan(svg: string): GifPlan | null {
  if (!/<\s*(?:animate|animateTransform|animateMotion|set)\b/i.test(svg)) return null;
  const durs = [...svg.matchAll(/\bdur\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => parseClock(match[1] ?? ""))
    .filter((seconds) => seconds > 0);
  if (!durs.length) return null;
  const seconds = Math.max(...durs);
  let frames = 0;
  if (/calcMode\s*=\s*["']discrete["']/i.test(svg)) {
    for (const match of svg.matchAll(/\bvalues\s*=\s*["']([^"']*)["']/gi)) {
      const count = (match[1] ?? "").split(";").filter((part) => part.trim()).length;
      if (count > frames) frames = count;
    }
  }
  if (frames < 2) frames = Math.max(2, Math.round(seconds * 12.5));
  const maxFrames = Math.max(2, Math.min(MAX_GIF_FRAMES, Math.floor(seconds / MIN_HOLD_SEC)));
  const capped = frames > maxFrames;
  if (capped) frames = maxFrames;
  return { seconds, frames, capped };
}

function parseClock(raw: string): number {
  const text = raw.trim().toLowerCase();
  const ms = text.match(/^([\d.]+)\s*ms$/);
  if (ms) return Number(ms[1]) / 1000;
  const sec = text.match(/^([\d.]+)\s*s$/);
  if (sec) return Number(sec[1]);
  const clock = text.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const plain = Number(text);
  return Number.isFinite(plain) ? plain : 0;
}

/** A browser that can play the SVG, the same ones that print HTML. */
export function findChromium(): string | null {
  const candidates = [
    process.env.CHROMIUM_BIN,
    process.env.CHROME_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  for (const bin of candidates) {
    if ((bin.includes("\\") || bin.includes("/")) && !fs.existsSync(bin)) continue;
    return bin;
  }
  return null;
}

/**
 * Paint one cycle of the SVG into a looping GIF at the given pixel size.
 * Each frame is the document at that moment of its own timeline.
 */
export async function paintAnimatedGif(opts: {
  svg: string;
  dest: string;
  width: number;
  height: number;
  plan: GifPlan;
}): Promise<void> {
  const bin = findChromium();
  if (!bin) throw new Error("No browser to paint the GIF");
  if (opts.plan.capped) {
    recordPlatformNote(
      `The GIF paints ${opts.plan.frames} frames of this animation; it has more steps than a GIF this length can hold.`,
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gif-paint-"));
  const browser = await puppeteer.launch({
    executablePath: bin,
    headless: true,
    env: rendererEnv(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--force-device-scale-factor=1"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
    const html = paintHtml(opts.svg, opts.width, opts.height);
    const slot = opts.plan.seconds / opts.plan.frames;
    for (let i = 0; i < opts.plan.frames; i++) {
      const time = (i + 0.5) * slot;
      // A fresh document each frame: colour is copied off the clock, and that
      // copy must not delete the later steps of the same animation.
      await page.setContent(html, { waitUntil: "load" });
      // A string, not a function: the runner rewrites nested functions into a
      // helper that does not exist inside the page.
      const moved = await page.evaluate(`(function (at) {
        var svg = document.querySelector("svg");
        if (!svg || typeof svg.setCurrentTime !== "function") return false;
        svg.setCurrentTime(at);
        svg.pauseAnimations();
        var names = ["fill", "stroke", "fill-opacity", "stroke-opacity", "opacity"];
        var bake = function (el) {
          var style = getComputedStyle(el);
          for (var i = 0; i < names.length; i++) {
            var value = style.getPropertyValue(names[i]);
            if (value) el.style.setProperty(names[i], value);
          }
          for (var c = 0; c < el.children.length; c++) bake(el.children[c]);
        };
        bake(svg);
        var anims = svg.querySelectorAll("animate, animateTransform, animateMotion, set");
        for (var a = 0; a < anims.length; a++) {
          var attr = (anims[a].getAttribute("attributeName") || "").toLowerCase();
          if (names.indexOf(attr) >= 0) anims[a].parentNode.removeChild(anims[a]);
        }
        return true;
      })(${time})`);
      if (!moved) throw new Error("The SVG clock could not be moved");
      const png = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: opts.width, height: opts.height },
      });
      fs.writeFileSync(path.join(dir, `frame-${String(i).padStart(3, "0")}.png`), png);
    }
    const rate = opts.plan.frames / opts.plan.seconds;
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-framerate",
        String(rate),
        "-i",
        path.join(dir, "frame-%03d.png"),
        "-filter_complex",
        "[0:v]split[s0][s1];[s0]palettegen=stats_mode=full:reserve_transparent=0[p];[s1][p]paletteuse=dither=none",
        "-loop",
        "0",
        opts.dest,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
    if (!fs.existsSync(opts.dest) || fs.statSync(opts.dest).size < 32) throw new Error("The GIF was not written");
  } finally {
    await browser.close().catch(() => undefined);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
}

function paintHtml(svg: string, width: number, height: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;width:${width}px;height:${height}px;overflow:hidden}svg{display:block;width:${width}px;height:${height}px}</style></head><body>${svg}</body></html>`;
}
