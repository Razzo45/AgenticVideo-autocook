import fs from "node:fs";
import path from "node:path";
import { getRun } from "../src/db";
import { runDetail } from "../src/pipeline/orchestrator";
import { probeFile } from "../src/pipeline/stitch";

async function dump(id: string) {
  const r = getRun(id)!;
  const d = runDetail(id)!;
  console.log("\n====", id, r.session_id, "====");
  console.log({
    mode: r.pipeline_mode,
    status: r.status,
    aspect: r.aspect_ratio,
    target: r.target_duration,
    video: r.video_model,
    script: r.script_model,
  });
  if (r.pipeline_mode === "audio") {
    const plan = d.audioPlan;
    console.log("audioPlan", {
      media: plan?.media_desc?.slice(0, 160),
      target: plan?.target_duration,
      cues: plan?.cues?.length,
      music: plan?.music?.prompt?.slice(0, 120),
    });
    for (const m of d.audioDeliverables ?? []) {
      const pr = await probeFile(m.path);
      console.log("deliverable", m.label, {
        path: m.path,
        dur: pr.duration,
        hasAudio: pr.hasAudio,
        sampleRate: (pr as { sampleRate?: number }).sampleRate,
      });
    }
    if (d.finalPath) {
      const pr = await probeFile(d.finalPath);
      console.log("final", pr);
    }
    return;
  }
  const s = JSON.parse(r.script_json!);
  console.log("plan", {
    delivery_fps: s.delivery_fps,
    delivery_resolution: s.delivery_resolution,
    callout_color: s.callout_color,
    shots: s.shots.map((x: { index: number; duration: number; callout?: string; logo_bug?: boolean; transition?: string }) => ({
      i: x.index,
      dur: x.duration,
      t: x.transition,
      callout: x.callout,
      logo: x.logo_bug,
    })),
  });
  const promptFiles: string[] = [];
  const walk = (p: string) => {
    for (const n of fs.readdirSync(p)) {
      const a = path.join(p, n);
      if (fs.statSync(a).isDirectory()) walk(a);
      else if (n.endsWith(".omni_prompt.txt")) promptFiles.push(a);
    }
  };
  walk(path.join("runs", id));
  for (const p of promptFiles) {
    const t = fs.readFileSync(p, "utf8");
    console.log("\nomni_prompt head:", path.relative("runs", p));
    console.log(t.slice(0, 280).replace(/\n/g, " | "));
  }
  if (d.finalPath) console.log("\nfinal probe", await probeFile(d.finalPath));
}

async function main() {
  for (const id of process.argv.slice(2)) await dump(id);
}
main();
