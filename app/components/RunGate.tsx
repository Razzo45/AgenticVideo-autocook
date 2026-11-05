"use client";

import { useEffect, useState } from "react";
import { mediaSrc, postJson } from "@/app/components/hooks";
import { ChecklistForm, EMPTY_CHECKLIST } from "@/app/components/ChecklistForm";
import { MasterVideo } from "@/app/components/MasterVideo";
import { ZoomableMedia } from "@/app/components/MediaLightbox";
import { checklistComplete, type Checklist } from "@/src/pipeline/schema";

export type GateVariant = {
  id: string;
  shot_index: number;
  kind: string;
  variant_index: number;
  path: string;
  selected: number;
  rejected: number;
  probe_json: string | null;
  model_name?: string | null;
};

export type ShotPlan = {
  index: number;
  duration: number;
  image_prompt: string;
  motion_prompt: string;
  media_desc: string;
  transition?: "cut" | "continue";
};

export type GateDetail = {
  run: {
    id: string;
    status: string;
    gate: string | null;
    aspect_ratio?: string;
    initial_prompt: string;
    current_shot_index: number;
    error: string | null;
    revise_comment: string | null;
    rework_round: number;
    pipeline_mode?: string;
  };
  script: {
    media_desc: string;
    content_safety_notes?: string;
    shots: ShotPlan[];
  } | null;
  variants: GateVariant[];
  stitch: { report?: { pass: boolean; checks: Array<{ id: string; label: string; pass: boolean; detail: string }> } } | null;
  finalPath: string | null;
};

export function ShotScript({
  shot,
  total,
  emphasize = "both",
}: {
  shot: ShotPlan;
  total?: number;
  emphasize?: "image" | "motion" | "both";
}) {
  const of = total != null ? ` of ${total}` : "";
  return (
    <div className="shot-brief">
      <p className="shot-brief-title">
        Shot {shot.index + 1}
        {of} · {shot.duration}s
        {shot.index > 0 && shot.transition ? ` · ${shot.transition}` : ""}
      </p>
      <p>{shot.media_desc}</p>
      {(emphasize === "image" || emphasize === "both") && (
        <>
          <label>Image prompt</label>
          <p>{shot.image_prompt}</p>
        </>
      )}
      {(emphasize === "motion" || emphasize === "both") && (
        <>
          <label>Motion prompt</label>
          <p>{shot.motion_prompt}</p>
        </>
      )}
    </div>
  );
}

function splitCurrentRejected(items: GateVariant[]): { current: GateVariant[]; rejected: GateVariant[] } {
  const current = items.filter((v) => !v.rejected);
  const livePaths = new Set(current.map((v) => v.path));
  const rejected = items.filter((v) => v.rejected && !livePaths.has(v.path));
  return { current, rejected };
}

function VariantCard({
  v,
  kind,
  picked,
  busy,
  selectable,
  takeLabel,
  onPick,
}: {
  v: GateVariant;
  kind: "image" | "video";
  picked: string | null;
  busy: boolean;
  selectable: boolean;
  takeLabel: string;
  onPick: (id: string | null) => void;
}) {
  const parsed = v.probe_json ? JSON.parse(v.probe_json) : {};
  const pass = parsed.report?.pass !== false;
  const hardJoin = v.model_name === "join:prev_clip_tail";
  const isPicked = picked === v.id;
  return (
    <div
      className={`media-card ${isPicked ? "selected" : ""} ${v.rejected && !isPicked ? "rejected" : ""}`}
    >
      <ZoomableMedia src={mediaSrc(v.path)} kind={kind} alt={`${kind} ${v.variant_index}`} />
      <p>
        {selectable ? (
          <button type="button" disabled={!pass || busy} onClick={() => pass && onPick(isPicked ? null : v.id)}>
            Select #{v.variant_index}
          </button>
        ) : (
          <span className="sub" style={{ margin: 0 }}>
            #{v.variant_index}
          </span>
        )}{" "}
        <span className={`badge ${hardJoin ? "pass" : v.rejected ? "fail" : "accent"}`}>
          {hardJoin ? "Hard join" : takeLabel}
        </span>{" "}
        <span className={`badge ${pass ? "pass" : "fail"}`}>{pass ? "3.1 pass" : "3.1 fail"}</span>
      </p>
      {hardJoin && selectable && (
        <p className="sub" style={{ margin: "4px 0 0" }}>
          Exact last frame of the previous clip — pick this for cut permanence.
        </p>
      )}
    </div>
  );
}

export function RunGate({
  detail,
  onDone,
}: {
  detail: GateDetail;
  onDone: () => Promise<void> | void;
}) {
  const [comment, setComment] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [aesthetic, setAesthetic] = useState(8);
  const [consistency, setConsistency] = useState(90);
  const [checklist, setChecklist] = useState<Checklist>(EMPTY_CHECKLIST);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { run, script, variants, stitch, finalPath } = detail;

  useEffect(() => {
    setComment(run.revise_comment ?? "");
  }, [run.gate, run.revise_comment]);
  const shot = run.current_shot_index;
  const keyframePool = variants.filter((v) => v.kind === "keyframe" && v.shot_index === shot);
  const clipPool = variants.filter((v) => v.kind === "clip" && v.shot_index === shot);
  const keyframes = splitCurrentRejected(keyframePool);
  const clips = splitCurrentRejected(clipPool);
  const prevClip = variants.find((v) => v.kind === "clip" && v.shot_index === shot - 1 && v.selected);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setMsg(null);
    setBusy(true);
    try {
      await postJson(`/api/runs/${run.id}/actions`, { action, ...extra });
      setPicked(null);
      setChecklist(EMPTY_CHECKLIST);
      setComment("");
      await onDone();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (run.status !== "waiting_human") return null;

  if (run.pipeline_mode === "auto") {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Auto run — no action needed</h3>
        <p className="sub">
          Hands-off mode picks cut vs continue keyframes and advances each shot. Status: {run.gate ?? "…"}
          {run.error ? ` · ${run.error}` : ""}
        </p>
        {script?.shots[shot] && (
          <p className="sub">
            Shot {shot + 1}/{script.shots.length}
            {script.shots[shot].transition ? ` · ${script.shots[shot].transition}` : ""}:{" "}
            {script.shots[shot].media_desc || script.shots[shot].image_prompt.slice(0, 160)}
          </p>
        )}
        {keyframes.current.length > 0 && (
          <div className="grid" style={{ marginTop: 12 }}>
            {keyframes.current.map((v) => (
              <VariantCard
                key={v.id}
                v={v}
                kind="image"
                picked={v.selected ? v.id : null}
                busy
                selectable={false}
                takeLabel="Current"
                onPick={() => undefined}
              />
            ))}
          </div>
        )}
        {clips.current.length > 0 && (
          <div className="grid" style={{ marginTop: 12 }}>
            {clips.current.map((v) => (
              <VariantCard
                key={v.id}
                v={v}
                kind="video"
                picked={v.selected ? v.id : null}
                busy
                selectable={false}
                takeLabel="Current"
                onPick={() => undefined}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const directionHint =
    run.gate === "keyframe"
      ? "Anatomy, framing, wardrobe, lighting, proportions — appended to the still prompt."
      : run.gate === "clip"
        ? "Pick a clip to keep or fix, reject clips to retry from this keyframe, or reject the keyframe itself."
        : "What to fix on the next clip generation.";

  return (
    <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
      <h3>Your turn — {run.gate === "script" ? "storyboard" : run.gate}</h3>
      {msg && <p className="err">{msg}</p>}

      {run.gate === "script" && script && (
        <div>
          <p>{script.media_desc}</p>
          {script.content_safety_notes && <p className="sub">Safety notes: {script.content_safety_notes}</p>}
          <p className="sub">
            Requested length is a minimum. This plan is {script.shots.length} clips totaling{" "}
            {script.shots.reduce((s, x) => s + x.duration, 0)}s using the video model&apos;s clip duration.
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Dur</th>
                <th>Join</th>
                <th>Image</th>
                <th>Motion</th>
              </tr>
            </thead>
            <tbody>
              {script.shots.map((s) => (
                <tr key={s.index}>
                  <td>{s.index}</td>
                  <td>{s.duration}s</td>
                  <td>{s.index === 0 ? "—" : s.transition === "continue" ? "continue" : "cut"}</td>
                  <td>{s.image_prompt}</td>
                  <td>{s.motion_prompt}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Revise comment</label>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => act("approve_script")}>
              Approve storyboard
            </button>
            <button disabled={busy || !comment.trim()} onClick={() => act("revise_script", { comment })}>
              Revise
            </button>
          </div>
        </div>
      )}

      {run.gate === "keyframe" && (
        <div>
          {script?.shots[shot] && (
            <ShotScript shot={script.shots[shot]} total={script.shots.length} />
          )}
          {shot > 0 && (
            <div className="grid grid-3" style={{ marginBottom: 12 }}>
              {shot > 1 &&
                variants.find((v) => v.kind === "keyframe" && v.shot_index === 0 && v.selected) && (
                  <div>
                    <h3>First keyframe (identity lock)</h3>
                    <div className="media-card">
                      <ZoomableMedia
                        src={mediaSrc(
                          variants.find((v) => v.kind === "keyframe" && v.shot_index === 0 && v.selected)!.path,
                        )}
                        kind="image"
                        alt="First keyframe"
                      />
                    </div>
                  </div>
                )}
              {variants.find((v) => v.kind === "keyframe" && v.shot_index === shot - 1 && v.selected) && (
                <div>
                  <h3>{shot > 1 ? "Previous keyframe" : "Previous keyframe (identity lock)"}</h3>
                  <div className="media-card">
                    <ZoomableMedia
                      src={mediaSrc(
                        variants.find((v) => v.kind === "keyframe" && v.shot_index === shot - 1 && v.selected)!.path,
                      )}
                      kind="image"
                      alt="Previous keyframe"
                    />
                  </div>
                </div>
              )}
              {prevClip && (
                <div>
                  <h3>Last frame source (previous clip)</h3>
                  <div className="media-card">
                    <ZoomableMedia src={mediaSrc(prevClip.path)} kind="video" alt="Previous shot" />
                  </div>
                </div>
              )}
            </div>
          )}
          <p className="sub">
            {shot > 0
              ? "Select #0 Hard join is the exact last frame of the previous clip — use it for permanence. Other stills are optional tiny progressions. Reject regenerates the batch."
              : "Pick one keyframe that passed §3.1, or reject the whole batch. Selecting a still does not lock it — Reject still regenerates."}{" "}
            Click the photo to zoom. Current take {run.rework_round + 1}.
          </p>
          <div className="media-grid">
            {keyframes.current.map((v) => (
              <VariantCard
                key={v.id}
                v={v}
                kind="image"
                picked={picked}
                busy={busy}
                selectable
                takeLabel="Current"
                onPick={setPicked}
              />
            ))}
          </div>
          {keyframes.rejected.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3>Rejected takes</h3>
              <p className="sub">Earlier batches — selectable if you want to use or compare one.</p>
              <div className="media-grid">
                {keyframes.rejected.map((v) => (
                  <VariantCard
                    key={v.id}
                    v={v}
                    kind="image"
                    picked={picked}
                    busy={busy}
                    selectable
                    takeLabel="Rejected"
                    onPick={setPicked}
                  />
                ))}
              </div>
            </div>
          )}
          {run.revise_comment && (
            <p className="sub">Applied to this batch: {run.revise_comment}</p>
          )}
          <div className="field" style={{ marginTop: 12 }}>
            <label>Direction for next generation</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Same face, body, and wardrobe as the first keyframe. Do not invent new costume or props."
            />
            <p className="sub" style={{ margin: "6px 0 0" }}>
              {directionHint} Selecting a still only enables Use selected. Reject and regenerate does not need a pick
              and still works after you select one.
            </p>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={!picked || busy} onClick={() => act("select_keyframe", { variantId: picked })}>
              Use selected keyframe
            </button>
            <button
              className="danger"
              disabled={busy || !comment.trim()}
              onClick={() => act("reject_keyframes", { comment })}
            >
              Reject and regenerate
            </button>
          </div>
        </div>
      )}

      {run.gate === "clip" && (
        <div>
          {script?.shots[shot] && (
            <ShotScript shot={script.shots[shot]} total={script.shots.length} />
          )}
          {prevClip && (
            <div style={{ marginBottom: 12 }}>
              <h3>Previous shot (join context)</h3>
              <div className="media-card" style={{ maxWidth: 720 }}>
                <ZoomableMedia src={mediaSrc(prevClip.path)} kind="video" alt="Previous shot" />
              </div>
            </div>
          )}
          <p className="sub">
            Watch the join, pick any clip from current or rejected takes, score it, complete the checklist. Click a clip
            to enlarge.
          </p>
          <div className="media-grid">
            {clips.current.map((v) => (
              <VariantCard
                key={v.id}
                v={v}
                kind="video"
                picked={picked}
                busy={busy}
                selectable
                takeLabel="Current"
                onPick={setPicked}
              />
            ))}
          </div>
          {clips.rejected.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3>Rejected takes</h3>
              <p className="sub">Earlier batches — selectable for Approve, Fix, or comparison.</p>
              <div className="media-grid">
                {clips.rejected.map((v) => (
                  <VariantCard
                    key={v.id}
                    v={v}
                    kind="video"
                    picked={picked}
                    busy={busy}
                    selectable
                    takeLabel="Rejected"
                    onPick={setPicked}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <div className="field">
              <label>Aesthetic 0–10</label>
              <input type="number" min={0} max={10} step={0.1} value={aesthetic} onChange={(e) => setAesthetic(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>Consistency 0–100</label>
              <input type="number" min={0} max={100} step={0.1} value={consistency} onChange={(e) => setConsistency(Number(e.target.value))} />
            </div>
          </div>
          <ChecklistForm value={checklist} onChange={setChecklist} />
          {run.revise_comment && (
            <p className="sub">Applied to this batch: {run.revise_comment}</p>
          )}
          <div className="field">
            <label>Direction</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={
                picked
                  ? "Hard requirement, e.g. only one bus door set far in the background"
                  : "Movement is not fluid, no weight behind it, camera too floaty"
              }
            />
            <p className="sub" style={{ margin: "6px 0 0" }}>
              {directionHint} Fix selected take re-runs the same Veo/I2V clip prompt from this keyframe, with your note
              as a HARD REQUIREMENT on top (keeps the picked take). Reject clips regenerates the whole batch the same
              way. Reject keyframe throws this still away and regenerates (later shots include a hard-join still from the
              previous clip).
            </p>
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={!picked || !checklistComplete(checklist) || busy}
              onClick={() =>
                act("select_clip", {
                  variantId: picked,
                  aesthetic,
                  consistency,
                  checklist,
                  useXfade: false,
                })
              }
            >
              Approve clip
            </button>
            <button
              disabled={busy || !picked || !comment.trim()}
              onClick={() => act("edit_clip", { variantId: picked, comment })}
            >
              Fix selected take
            </button>
            <button
              className="danger"
              disabled={busy || !comment.trim()}
              onClick={() => act("reject_clips", { comment })}
            >
              Reject clips
            </button>
            <button
              className="danger"
              disabled={busy || !comment.trim()}
              onClick={() => act("reject_keyframes", { comment })}
            >
              Reject keyframe
            </button>
          </div>
        </div>
      )}

      {run.gate === "audit" && (
        <div>
          {script && script.shots.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <h3>Planned sequence</h3>
              {script.shots.map((s) => (
                <ShotScript key={s.index} shot={s} total={script.shots.length} emphasize="motion" />
              ))}
            </div>
          )}
          {finalPath && <MasterVideo src={mediaSrc(finalPath)} aspect={run.aspect_ratio} />}
          {/* Conformance probe is internal — operators only approve / reject. */}
          {stitch?.report?.pass === false && (
            <p className="err">Delivery checks failed — reject and regenerate, or fix upstream.</p>
          )}
          <ChecklistForm value={checklist} onChange={setChecklist} />
          <div className="field">
            <label>Direction for next generation</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Join pops, last clip has no weight, keep continuity"
            />
            <p className="sub" style={{ margin: "6px 0 0" }}>
              {directionHint}
            </p>
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={!checklistComplete(checklist) || stitch?.report?.pass === false || busy}
              onClick={() => act("approve_final", { checklist, useXfade: false })}
            >
              Export counted sample
            </button>
            <button
              className="danger"
              disabled={busy || !comment.trim()}
              onClick={() => act("fail_final", { comment })}
            >
              Fail and regenerate clips
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
