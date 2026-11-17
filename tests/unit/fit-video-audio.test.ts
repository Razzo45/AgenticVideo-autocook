import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { executeMediaTool, type MediaToolContext } from "../../src/autocook/mediaTools";
import { probeFile } from "../../src/pipeline/stitch";

const execFileAsync = promisify(execFile);

async function makeClipWithAudio(outPath: string): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "sine=f=880:d=0.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      outPath,
    ],
    { windowsHide: true, timeout: 30_000 },
  );
}

describe("fit_video audio intent", () => {
  it("strips audio when mute is set without reinventing from the probe", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-fit-video-"));
    const stagingDir = path.join(root, "compose_media");
    fs.mkdirSync(stagingDir, { recursive: true });
    const source = path.join(root, "plate.mp4");
    await makeClipWithAudio(source);
    assert.equal((await probeFile(source)).hasAudio, true);

    const ctx: MediaToolContext = {
      stagingDir,
      staged: new Map([
        [
          "plate",
          {
            id: "plate",
            format: "mp4",
            filename: "plate.mp4",
            absPath: source,
            embed: "path",
            mime: "video/mp4",
          },
        ],
      ]),
      filesByName: new Map([["plate.mp4", source]]),
      namedReferencesOnly: true,
    };

    const muted = await executeMediaTool(
      "fit_video",
      {
        id: "muted",
        source: "plate",
        filename: "assets/muted.mp4",
        audio: "mute",
      },
      ctx,
    );
    assert.equal(muted.ok, true);
    assert.equal(muted.audio, "mute");
    assert.equal(muted.has_audio, false);

    const kept = await executeMediaTool(
      "fit_video",
      {
        id: "kept",
        source: "plate",
        filename: "assets/kept.mp4",
        audio: "keep",
        width: 320,
        height: 240,
      },
      ctx,
    );
    assert.equal(kept.ok, true);
    assert.equal(kept.audio, "keep");
    assert.equal(kept.has_audio, true);
  });
});
