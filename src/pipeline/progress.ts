import type { Gate, RunStatus } from "./constants";

export type LiveKind = "work" | "need_you" | "done" | "fail" | "idle";

export type LiveStatus = {
  kind: LiveKind;
  text: string;
};

type RunLite = {
  status: string;
  gate: string | null;
  error: string | null;
  script_json: string | null;
  current_shot_index: number;
};

function shotCount(scriptJson: string | null): number {
  if (!scriptJson) return 0;
  try {
    const parsed = JSON.parse(scriptJson) as { shots?: unknown[] };
    return Array.isArray(parsed.shots) ? parsed.shots.length : 0;
  } catch {
    return 0;
  }
}

function gateLabel(gate: string | null, shot: number, shots: number): string {
  const n = shots > 0 ? `${shot + 1}/${shots}` : `${shot + 1}`;
  if (gate === "script") return "storyboard";
  if (gate === "keyframe") return `keyframe ${n}`;
  if (gate === "clip") return `clip ${n}`;
  if (gate === "audit") return "stitch review";
  return gate ?? "review";
}

/** Same ticker the run page shows while cooking, plus a Needs-you line when HITL. */
export function liveStatus(run: RunLite): LiveStatus {
  const status = run.status as RunStatus;
  const shots = shotCount(run.script_json);
  const ticker = run.error?.trim() ?? "";
  const sceneN = shots > 0 ? `${run.current_shot_index + 1}/${shots}` : `${run.current_shot_index + 1}`;
  const mode = (run as RunLite & { pipeline_mode?: string }).pipeline_mode;
  const auto = mode === "auto";
  const audio = mode === "audio";
  const doc =
    mode === "html" || mode === "image" || mode === "pptx" || mode === "pdf";

  if (status === "failed") {
    return {
      kind: "fail",
      text: ticker || (auto ? `Failed at scene ${sceneN} — resume keeps earlier scenes` : "Failed"),
    };
  }
  if (status === "exported") {
    return { kind: "done", text: "Exported" };
  }
  if (status === "rejected") {
    return { kind: "idle", text: "Rejected" };
  }
  if (status === "waiting_human") {
    if (auto) {
      return {
        kind: "work",
        text: ticker || `Auto — advancing scene ${sceneN}…`,
      };
    }
    return { kind: "need_you", text: `Needs you — ${gateLabel(run.gate as Gate, run.current_shot_index, shots)}` };
  }
  if (status === "queued") {
    return { kind: "work", text: ticker || "Queued — waiting for a worker slot" };
  }
  if (status === "stitching") {
    return {
      kind: "work",
      text: ticker || (audio ? "Mixing audio master…" : auto ? `Stitching ${shots || "all"} scenes…` : "Stitching clips…"),
    };
  }
  if (status === "generating" || status === "auditing" || status === "rework") {
    if (ticker) return { kind: "work", text: ticker };
    if (doc) {
      return {
        kind: "work",
        text: `Document cook (${mode}) — waiting in FIFO / generating…`,
      };
    }
    if (!run.script_json) {
      const direct = mode === "direct";
      return {
        kind: "work",
        text: audio ? "Planning audio cues…" : direct ? "Segmenting operator script…" : "Writing storyboard…",
      };
    }
    return {
      kind: "work",
      text: audio ? "Synthesizing audio…" : auto ? `Scene ${sceneN}…` : `Working shot ${sceneN}…`,
    };
  }
  return { kind: "idle", text: status };
}
