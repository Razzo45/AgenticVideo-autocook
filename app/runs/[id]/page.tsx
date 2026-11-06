"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge, mediaSrc, postJson, useJson } from "@/app/components/hooks";
import { DeleteRunButton } from "@/app/components/DeleteRunButton";
import { MasterVideo } from "@/app/components/MasterVideo";
import { ZoomableMedia } from "@/app/components/MediaLightbox";
import { RunGate, ShotScript } from "@/app/components/RunGate";
import { runLiveLine, runProgressPct, runTitle } from "@/app/lib/runDisplay";

type StageId = "script" | "keyframe" | "clip" | "audit" | "exported";

type Detail = {
  run: {
    id: string;
    status: string;
    category: string;
    aspect_ratio: string;
    target_duration: number;
    output_resolution?: string;
    initial_prompt: string;
    gate: string | null;
    error: string | null;
    script_model: string;
    keyframe_model: string;
    video_model: string;
    rework_round: number;
    session_id: string;
    current_shot_index: number;
    revise_comment: string | null;
    counted: number;
    pipeline_mode?: string;
    auto_options_json?: string | null;
  };
  script: {
    media_desc: string;
    content_safety_notes?: string;
    shots: Array<{
      index: number;
      duration: number;
      image_prompt: string;
      motion_prompt: string;
      media_desc: string;
      transition?: "cut" | "continue";
    }>;
  } | null;
  audioPlan?: {
    media_desc: string;
    target_duration: number;
    music: { prompt: string; instrumental?: boolean };
    cues: Array<{
      index: number;
      kind: "speech";
      start: number;
      end: number;
      text: string;
      style?: string | null;
      voice?: string | null;
    }>;
  } | null;
  variants: Array<{
    id: string;
    shot_index: number;
    kind: string;
    variant_index: number;
    path: string;
    selected: number;
    rejected: number;
    probe_json: string | null;
  }>;
  sceneProgress?: {
    total: number;
    completed: number;
    current: number;
    nextAction: string;
    scenes: Array<{
      index: number;
      duration: number;
      transition: string;
      status: "done" | "current" | "pending";
      hasKeyframe: boolean;
      hasClip: boolean;
    }>;
  } | null;
  stitch: { report?: { pass: boolean; checks: Array<{ id: string; label: string; pass: boolean; detail: string }> } } | null;
  finalPath: string | null;
  audioDeliverables?: Array<{ id: string; label: string; path: string }>;
  deliverables?: Array<{ id: string; label: string; path: string }>;
};

function liveStage(run: Detail["run"], hasCurrentKeyframe: boolean): StageId {
  if (run.status === "exported") return "exported";
  if (run.gate === "script" || run.gate === "keyframe" || run.gate === "clip" || run.gate === "audit") return run.gate;
  if (run.status === "stitching") return "audit";
  if (run.status === "generating") {
    if (!run.script_model) return "script";
    if (!hasCurrentKeyframe) return "keyframe";
    return "clip";
  }
  return "script";
}

function reachable(stage: StageId, data: Detail): boolean {
  if (stage === "script") return Boolean(data.script);
  if (stage === "keyframe") return data.variants.some((v) => v.kind === "keyframe");
  if (stage === "clip") return data.variants.some((v) => v.kind === "clip");
  if (stage === "audit") return Boolean(data.stitch?.report || data.finalPath);
  return data.run.status === "exported";
}

async function StageBrowse({
  stage,
  data,
  shot,
  onShot,
}: {
  stage: StageId;
  data: Detail;
  shot: number;
  onShot: (n: number) => void;
}) {
  const { script, variants, stitch, finalPath } = data;
  const shotCount = script?.shots.length ?? 0;
  const shots = Array.from({ length: Math.max(shotCount, 1) }, (_, i) => i);
  const kind = stage === "keyframe" ? "keyframe" : "clip";
  const pool = variants.filter((v) => v.kind === kind && v.shot_index === shot);

  if (stage === "script" && script) {
    return (
      <div>
        <p>{script.media_desc}</p>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Dur</th>
              <th>Image</th>
              <th>Motion</th>
            </tr>
          </thead>
          <tbody>
            {script.shots.map((s) => (
              <tr key={s.index}>
                <td>{s.index + 1}</td>
                <td>{s.duration}s</td>
                <td>{s.image_prompt}</td>
                <td>{s.motion_prompt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (stage === "keyframe" || stage === "clip") {
    return (
      <div>
        <div className="row" style={{ marginBottom: 12 }}>
          {shots.map((i) => (
            <button key={i} type="button" className={i === shot ? "primary" : "btn"} onClick={() => onShot(i)}>
              Scene {i + 1}
            </button>
          ))}
        </div>
        <div className="media-grid">
          {pool.map((v) => (
            <div key={v.id} className={`media-card${v.selected ? " selected" : ""}`}>
              <ZoomableMedia
                src={mediaSrc(v.path)}
                kind={stage === "keyframe" ? "image" : "video"}
                alt={`${stage} ${shot}`}
              />
            </div>
          ))}
        </div>
        {!pool.length && <p className="sub">Nothing for this scene yet.</p>}
      </div>
    );
  }

  if (stage === "audit" || stage === "exported") {
    return (
      <div>
        {finalPath ? (
          <MasterVideo src={mediaSrc(finalPath)} aspect={data.run.aspect_ratio} />
        ) : (
          <p className="sub">Master not ready.</p>
        )}
      </div>
    );
  }

  return <p className="sub">Not ready.</p>;
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useJson<Detail>(`/api/runs/${id}`, 2000);
  const [browse, setBrowse] = useState<StageId | null>(null);
  const [browseShot, setBrowseShot] = useState(0);

  async function retry() {
    await postJson(`/api/runs/${id}/actions`, { action: "retry" });
    await reload();
  }

  const hasCurrentKeyframe = Boolean(
    data?.variants.some((v) => v.kind === "keyframe" && v.shot_index === data.run.current_shot_index && v.selected),
  );
  const active = data ? liveStage(data.run, hasCurrentKeyframe) : "script";
  const shotCount = data?.script?.shots.length ?? 0;

  const detailTabs = useMemo(() => {
    if (!data) return [];
    return [
      { id: "script" as const, label: "Storyboard", open: reachable("script", data) },
      { id: "keyframe" as const, label: "Keyframes", open: reachable("keyframe", data) },
      { id: "clip" as const, label: "Clips", open: reachable("clip", data) },
      { id: "audit" as const, label: "Stitch", open: reachable("audit", data) },
    ];
  }, [data, shotCount]);

  if (error) return <p className="err">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const { run, script, audioPlan, variants, stitch, finalPath, audioDeliverables, deliverables, sceneProgress } = data;
  const mode = run.pipeline_mode || "auto";
  const isTask = mode === "task";
  const isAudio = mode === "audio";
  const isDoc = mode === "html" || mode === "image" || mode === "pptx" || mode === "pdf";
  const isImageDoc = mode === "image";
  const isVideo = !isAudio && !isDoc && !isTask;
  const audioMasters =
    audioDeliverables && audioDeliverables.length > 0
      ? audioDeliverables
      : finalPath
        ? [{ id: "final", label: "Master", path: finalPath }]
        : [];
  const cooking = run.status === "generating" || run.status === "stitching" || run.status === "queued";
  const title = runTitle(run.session_id, run.initial_prompt);
  const live = runLiveLine({
    liveText: null,
    error: run.error,
    gate: run.gate,
    status: run.status,
    sceneProgress,
  });
  const pct = runProgressPct({ status: run.status, sceneProgress });
  const resumeLabel =
    sceneProgress && sceneProgress.completed < sceneProgress.total
      ? `Resume scene ${sceneProgress.current + 1}/${sceneProgress.total}`
      : sceneProgress?.nextAction === "stitch"
        ? "Resume — stitch"
        : "Resume";
  const taskFiles = deliverables ?? [];
  const downloadPath = isTask ? taskFiles[0]?.path : isAudio ? audioMasters[0]?.path : finalPath;
  const masterReady =
    Boolean(downloadPath) && (run.status === "exported" || run.gate === "audit");
  const downloadName = downloadPath
    ? downloadPath.replace(/\\/g, "/").split("/").pop() || "download"
    : "download";

  return (
    <div>
      <p className="cook-eyebrow" style={{ marginBottom: 8 }}>
        <Link href="/runs">← Runs</Link>
      </p>

      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: "0 0 6px", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</h2>
          <p className="sub" style={{ margin: 0 }}>
            {run.target_duration}s
            {!isAudio && <> · {run.aspect_ratio}</>}
            {sceneProgress && sceneProgress.total > 0 && (
              <>
                {" "}
                · {sceneProgress.completed}/{sceneProgress.total} scenes
              </>
            )}
          </p>
        </div>
        <Badge status={run.status} />
      </div>

      <div className="run-status" style={{ marginTop: 16 }}>
        <p className={`live live-${cooking ? "work" : run.status === "failed" ? "fail" : run.status === "exported" ? "done" : "idle"} run-status-live`}>
          {live}
        </p>
        {cooking && (
          <div className="ws-progress" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        {sceneProgress && sceneProgress.total > 0 && cooking && (
          <div className="row" style={{ marginTop: 12, gap: 4, flexWrap: "wrap" }}>
            {sceneProgress.scenes.map((s) => (
              <span
                key={s.index}
                title={`Scene ${s.index + 1}`}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 99,
                  background:
                    s.status === "done" ? "var(--pass)" : s.status === "current" ? "var(--accent)" : "var(--line-strong)",
                }}
              />
            ))}
          </div>
        )}
        {script?.shots[run.current_shot_index] && cooking && (
          <p className="run-status-meta">
            {script.shots[run.current_shot_index].media_desc?.slice(0, 140) ||
              script.shots[run.current_shot_index].motion_prompt?.slice(0, 140)}
          </p>
        )}
      </div>

      {masterReady && downloadPath && (
        <>
          {isVideo && finalPath && <MasterVideo src={mediaSrc(finalPath)} aspect={run.aspect_ratio} />}
          {isImageDoc && finalPath && (
            <div className="card" style={{ marginBottom: 16, padding: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaSrc(finalPath)}
                alt="Generated still"
                style={{ display: "block", maxWidth: "100%", height: "auto", margin: "0 auto" }}
              />
            </div>
          )}
          {isDoc && !isImageDoc && finalPath && (
            <div className="card" style={{ marginBottom: 16 }}>
              <p className="sub" style={{ margin: 0 }}>
                Document ready ({downloadName}). Preview in the browser isn’t available for this
                format — use Download.
              </p>
            </div>
          )}
          {isTask && taskFiles.length > 0 && (
            <div className="card" style={{ marginBottom: 16, display: "grid", gap: 12 }}>
              {taskFiles.map((file) => (
                <div key={file.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <span>{file.label}</span>
                  <a href={`${mediaSrc(file.path)}&download=1`}>Download</a>
                </div>
              ))}
            </div>
          )}
          {isAudio && audioMasters.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              {audioMasters.map((m) => (
                <div key={m.id} style={{ marginBottom: 12 }}>
                  <p className="sub" style={{ marginBottom: 6 }}>
                    {m.label}
                  </p>
                  <audio controls src={mediaSrc(m.path)} style={{ width: "100%" }} />
                </div>
              ))}
            </div>
          )}
          <div className="cook-download">
            <div>
              <strong>Ready</strong>
              <p className="sub" style={{ margin: "4px 0 0" }}>
                Save the finished master to your machine.
              </p>
            </div>
            {!isTask && (
            <a
              className="btn primary"
              href={`${mediaSrc(downloadPath)}&download=1`}
              download={downloadName}
            >
              Download
            </a>
            )}
          </div>
        </>
      )}

      {run.status === "failed" && (
        <div className="card" style={{ marginBottom: 16 }}>
          {run.error && <p className="err">{run.error}</p>}
          <button className="primary" onClick={retry}>
            {resumeLabel}
          </button>
        </div>
      )}

      <RunGate detail={data} onDone={reload} />

      {run.status === "waiting_human" &&
        run.gate === "clip" &&
        run.error &&
        /Saved \d+\/\d+ clip take/i.test(run.error) && (
          <div className="card" style={{ marginBottom: 16 }}>
            <p className="err">{run.error}</p>
            <button className="primary" onClick={retry}>
              Generate more takes
            </button>
          </div>
        )}

      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <Link href="/" className="btn">
          New cook
        </Link>
        <DeleteRunButton id={run.id} counted={run.counted} compact />
      </div>

      <details className="run-details">
        <summary>Details</summary>
        <p className="sub" style={{ marginTop: 0 }}>
          {run.session_id} · {run.id}
        </p>
        <p className="sub">
          Brain <code>{run.script_model}</code> · Video <code>{run.video_model}</code>
        </p>
        <p style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.45 }}>{run.initial_prompt}</p>

        <div className="row" style={{ margin: "12px 0", flexWrap: "wrap" }}>
          {detailTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={browse === t.id ? "primary" : "btn"}
              disabled={!t.open}
              onClick={() => {
                setBrowseShot(run.current_shot_index);
                setBrowse(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
          {browse && (
            <button type="button" className="btn" onClick={() => setBrowse(null)}>
              Close
            </button>
          )}
        </div>

        {browse ? (
          <StageBrowse stage={browse} data={data} shot={browseShot} onShot={setBrowseShot} />
        ) : (
          <>
            {cooking && script?.shots[run.current_shot_index] && (
              <ShotScript shot={script.shots[run.current_shot_index]} total={script.shots.length} />
            )}
            {variants.filter((v) => v.selected).length > 0 && (
              <div className="media-grid" style={{ marginTop: 12 }}>
                {variants
                  .filter((v) => v.selected)
                  .map((v) => (
                    <div key={v.id} className="media-card selected">
                      <ZoomableMedia
                        src={mediaSrc(v.path)}
                        kind={v.kind === "keyframe" ? "image" : "video"}
                        alt={`shot ${v.shot_index}`}
                      />
                      <p className="sub" style={{ margin: "6px 0 0" }}>
                        Scene {v.shot_index + 1} · {v.kind}
                      </p>
                    </div>
                  ))}
              </div>
            )}
            {isAudio && audioPlan && (
              <div style={{ marginTop: 12 }}>
                <p>{audioPlan.media_desc}</p>
                <p className="sub">Music: {audioPlan.music.prompt}</p>
              </div>
            )}
          </>
        )}
      </details>

      {/* keep active stage reachable for gate UI */}
      <span className="sub" style={{ display: "none" }}>
        {active}
      </span>
    </div>
  );
}
