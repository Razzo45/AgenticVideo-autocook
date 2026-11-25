import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildJoinVideosFilter } from "../../src/autocook/mediaTools";

describe("join_videos filter graph", () => {
  it("interleaves video and audio pads for concat when every clip has audio", () => {
    const graph = buildJoinVideosFilter({
      clipCount: 3,
      width: 1080,
      height: 1920,
      fps: 24,
      withAudio: true,
    });
    assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[v\]\[a\]/);
    assert.doesNotMatch(graph, /\[v0\]\[v1\]\[v2\]\[a0\]\[a1\]\[a2\]/);
  });

  it("uses video-only concat when clips have no audio", () => {
    const graph = buildJoinVideosFilter({
      clipCount: 2,
      width: 1280,
      height: 720,
      fps: 25,
      withAudio: false,
    });
    assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[v\]/);
    assert.doesNotMatch(graph, /\[a0\]/);
  });

  it("fills a silent plate in the same graph when keep meets mixed audio", () => {
    const graph = buildJoinVideosFilter({
      clipCount: 2,
      width: 1280,
      height: 720,
      fps: 24,
      withAudio: true,
      silence: [null, 1.25],
    });
    assert.match(graph, /\[0:a\]aformat=/);
    assert.match(graph, /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=1\.250/);
    assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]/);
  });
});
