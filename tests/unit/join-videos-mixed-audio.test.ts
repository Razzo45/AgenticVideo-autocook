import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { executeArgonMediaTool, type MediaToolContext } from "../../src/autocook/argonMediaTools";

const execFileAsync = promisify(execFile);

async function makeClip(outPath: string, withAudio: boolean): Promise<void> {
  const args = withAudio
    ? [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=0.5",
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:d=0.5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        outPath,
      ]
    : [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=0.5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        outPath,
      ];
  await execFileAsync("ffmpeg", args, { windowsHide: true, timeout: 30_000 });
}

describe("join_videos mixed audio", () => {
  it("fails clearly when only some clips have audio", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-join-"));
    const stagingDir = path.join(root, "compose_media");
    fs.mkdirSync(stagingDir, { recursive: true });
    const withAudio = path.join(root, "a.mp4");
    const silent = path.join(root, "b.mp4");
    await makeClip(withAudio, true);
    await makeClip(silent, false);

    const ctx: MediaToolContext = {
      stagingDir,
      staged: new Map([
        [
          "a",
          {
            id: "a",
            format: "mp4",
            filename: "a.mp4",
            absPath: withAudio,
            embed: "path",
            mime: "video/mp4",
          },
        ],
        [
          "b",
          {
            id: "b",
            format: "mp4",
            filename: "b.mp4",
            absPath: silent,
            embed: "path",
            mime: "video/mp4",
          },
        ],
      ]),
      filesByName: new Map([
        ["a.mp4", withAudio],
        ["b.mp4", silent],
      ]),
      namedReferencesOnly: true,
    };

    await assert.rejects(
      () =>
        executeArgonMediaTool(
          "join_videos",
          {
            id: "joined",
            filename: "assets/joined.mp4",
            clips: ["a", "b"],
          },
          ctx,
        ),
      /every clip must have audio, or none/i,
    );
  });
});
