/**
 * Inspect whether a finished run obeyed Argon-owns-plan / Omni-gen / plan-only post.
 * Usage: npx tsx scripts/inspect-ownership.ts <runId>
 */
import fs from "node:fs";
import path from "node:path";
import { getRun } from "../src/db";
import { runDetail } from "../src/pipeline/orchestrator";
import { probeFile } from "../src/pipeline/stitch";

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: inspect-ownership.ts <runId>");
  const detail = runDetail(id);
  const run = getRun(id);
  if (!detail || !run) throw new Error(`missing ${id}`);

  const script = detail.script as {
    media_desc?: string;
    delivery_fps?: number | null;
    delivery_resolution?: string | null;
    callout_color?: string | null;
    shots?: Array<{
      index: number;
      duration: number;
      transition?: string;
      callout?: string | null;
      logo_bug?: boolean | null;
      music?: boolean | null;
      motion_prompt?: string;
    }>;
  } | null;

  const findings: Array<{ ok: boolean; msg: string }> = [];
  const mode = run.pipeline_mode ?? "auto";
  findings.push({ ok: true, msg: `mode=${mode} status=${run.status} session=${run.session_id}` });

  if (mode === "audio") {
    findings.push({
      ok: Boolean(detail.audioPlan || script),
      msg: detail.audioPlan
        ? `audio plan: ${detail.audioPlan.cues?.length ?? 0} speech cues, target=${detail.audioPlan.target_duration}s`
        : "audio plan missing",
    });
    const masters = detail.audioDeliverables?.length
      ? detail.audioDeliverables
      : detail.finalPath
        ? [{ id: "final", label: "Master", path: detail.finalPath }]
        : [];
    for (const m of masters) {
      if (!fs.existsSync(m.path)) {
        findings.push({ ok: false, msg: `missing master ${m.path}` });
        continue;
      }
      const pr = await probeFile(m.path);
      findings.push({
        ok: (pr.duration ?? 0) > 0,
        msg: `master ${m.label}: dur=${pr.duration?.toFixed(2)}s hasAudio=${pr.hasAudio}`,
      });
    }
  } else {
    const shots = script?.shots ?? [];
    findings.push({
      ok: shots.length > 0,
      msg: `Argon scenes=${shots.length} durations=[${shots.map((s) => s.duration).join(",")}] delivery_fps=${script?.delivery_fps ?? "∅"} res=${script?.delivery_resolution ?? "∅"}`,
    });
    const callouts = shots.filter((s) => s.callout?.trim());
    const logos = shots.filter((s) => s.logo_bug === true);
    findings.push({
      ok: true,
      msg: `plan overlays: callouts=${callouts.length} logo_bug=${logos.length} color=${script?.callout_color ?? "∅"}`,
    });

    const omniPrompts: string[] = [];
    const walk = (p: string) => {
      if (!fs.existsSync(p)) return;
      for (const name of fs.readdirSync(p)) {
        const abs = path.join(p, name);
        if (fs.statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith(".omni_prompt.txt")) omniPrompts.push(abs);
      }
    };
    walk(path.join("runs", id));

    for (const p of omniPrompts) {
      const text = fs.readFileSync(p, "utf8");
      const wrapped = /^Use the first uploaded video as the base footage/m.test(text);
      const hasTargetLen = /^Target length ~/m.test(text);
      findings.push({
        ok: !wrapped && !hasTargetLen,
        msg: wrapped || hasTargetLen
          ? `PLATFORM WRAPPER still in ${path.basename(path.dirname(p))}/${path.basename(p)}`
          : `Omni prompt clean (Argon-owned) ${path.basename(path.dirname(p))}/${path.basename(p)} (${text.length} chars)`,
      });
    }

    if (detail.finalPath && fs.existsSync(detail.finalPath)) {
      const pr = await probeFile(detail.finalPath);
      const wantFps = script?.delivery_fps;
      const fpsOk = wantFps == null || Math.abs((pr.fps ?? 0) - wantFps) < 0.5 || (wantFps === 30 && pr.fps === 30);
      findings.push({
        ok: Boolean(pr.width && pr.height),
        msg: `final ${pr.width}x${pr.height} ${pr.fps}fps ${pr.duration?.toFixed(2)}s ${pr.codec} (plan fps=${wantFps ?? "∅"})`,
      });
      findings.push({
        ok: fpsOk,
        msg: fpsOk ? "final fps matches Argon delivery_fps (or unset)" : `fps mismatch plan=${wantFps} got=${pr.fps}`,
      });
    } else {
      findings.push({ ok: run.status !== "exported", msg: `final missing (status=${run.status})` });
    }

    const calloutDir = path.join("runs", id, "callouts");
    if (callouts.length) {
      const files = fs.existsSync(calloutDir) ? fs.readdirSync(calloutDir) : [];
      findings.push({
        ok: files.length > 0,
        msg: files.length
          ? `post applied Argon callouts (${files.join(", ")})`
          : "Argon asked callouts but callouts/ empty — overlay may not have run",
      });
    }
  }

  console.log(`\n=== ownership inspect ${id} ===`);
  for (const f of findings) console.log(`${f.ok ? "OK " : "BAD"} ${f.msg}`);
  const bad = findings.filter((f) => !f.ok).length;
  console.log(bad ? `\nRESULT: ${bad} issue(s)` : "\nRESULT: pass");
  if (bad) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
