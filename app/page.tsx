"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, useJson } from "@/app/components/hooks";
import { runLiveLine, runProgressPct, runTitle } from "@/app/lib/runDisplay";

type Preflight = {
  status: string;
  risks: Array<{ severity: string; field: string; message: string; suggestedFix: string }>;
  notes: string[];
  rewrittenBrief?: string;
};

type Run = {
  id: string;
  session_id: string;
  status: string;
  pipeline_mode?: string;
  initial_prompt?: string;
  error: string | null;
  gate: string | null;
  target_duration: number;
  live?: { kind: string; text: string };
  sceneProgress?: { total: number; completed: number; current: number } | null;
};

export default function CookHomePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const runs = useJson<{ runs: Run[] }>("/api/runs", 2500);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Preflight | null>(null);

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const next = Array.from(list);
    setFiles((prev) => {
      const names = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...next.filter((f) => !names.has(`${f.name}:${f.size}`))];
    });
  }

  async function cook(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setBlocked(null);
    try {
      const form = new FormData();
      form.set("prompt", prompt);
      for (const f of files) form.append("inputs", f);
      const res = await fetch("/api/cook", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.blocked) {
        setBlocked(json.preflight as Preflight);
        if (json.preflight?.rewrittenBrief) setPrompt(json.preflight.rewrittenBrief);
        return;
      }
      if (json.fanout && json.taskId) {
        router.push(`/task/${encodeURIComponent(json.taskId)}`);
        return;
      }
      const id = json.run?.id as string;
      if (!id) throw new Error("Cook started but no run id returned");
      router.push(`/runs/${id}`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  const active = (runs.data?.runs ?? []).filter(
    (r) => !["exported", "failed", "rejected"].includes(r.status),
  );

  return (
    <div className="cook-shell">
      <header className="cook-hero">
        <p className="cook-eyebrow">Autocook</p>
        <h2>Paste the task. Click COOK. Walk away.</h2>
        <p className="sub">
          Argon reads the task and starts one cook per deliverable. Each finished file downloads on its own.
        </p>
      </header>

      <div className="ws-tracker" aria-hidden>
        <div className="ws-tracker-step is-active">1 · Ingest</div>
        <div className="ws-tracker-step">2 · Preflight</div>
        <div className="ws-tracker-step">3 · Cook</div>
        <div className="ws-tracker-step">4 · Download</div>
      </div>

      <form onSubmit={cook} className="card cook-ingest">
        <div className="field">
          <label htmlFor="task-body">Task body</label>
          <textarea
            id="task-body"
            rows={12}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            placeholder="Paste the full task brief here. Aspect, duration, and audio vs video are inferred when possible."
          />
        </div>

        <div className="field">
          <label>Inputs</label>
          <div
            className={`ws-uploader${drag ? " is-drag" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="ws-uploader-title">Add your photos, videos, and briefs</p>
            <p className="ws-uploader-hint">
              Drag and drop, or browse. Later these come from the task API — same fields.
            </p>
            <span className="ws-uploader-cta">Add media</span>
          </div>
          {files.length > 0 && (
            <div className="ws-file-chips">
              {files.map((f) => (
                <span key={`${f.name}-${f.size}`} className="ws-file-chip">
                  {f.name}
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFiles((prev) => prev.filter((x) => !(x.name === f.name && x.size === f.size)));
                    }}
                    style={{
                      border: 0,
                      background: "transparent",
                      color: "var(--muted)",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {blocked && (
          <div className="cook-error" role="alert">
            <h3>
              {blocked.risks.filter((r) => r.severity === "hard").length} hard blocker
              {blocked.risks.filter((r) => r.severity === "hard").length === 1 ? "" : "s"}
            </h3>
            <p className="sub" style={{ margin: "0 0 8px" }}>
              Fix these, then COOK again. Soft risks are auto-rewritten — these are not.
            </p>
            <ul>
              {blocked.risks
                .filter((r) => r.severity === "hard")
                .map((r, i) => (
                  <li key={i}>
                    <strong>{r.field}:</strong> {r.message}
                    {r.suggestedFix ? <span className="sub"> — {r.suggestedFix}</span> : null}
                  </li>
                ))}
            </ul>
          </div>
        )}

        {err && <p className="err">{err}</p>}

        <button className="primary cook-btn" type="submit" disabled={busy || !prompt.trim()}>
          {busy ? "Starting…" : "COOK"}
        </button>
      </form>

      {active.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h3
            style={{
              margin: "0 0 12px",
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--muted)",
              fontWeight: 700,
            }}
          >
            In progress
          </h3>
          <div className="grid" style={{ gap: 10 }}>
            {active.slice(0, 8).map((r) => {
              const cooking =
                r.status === "generating" || r.status === "stitching" || r.status === "queued";
              return (
                <Link key={r.id} href={`/runs/${r.id}`} className="card cook-run-row">
                  <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {runTitle(r.session_id, r.initial_prompt)}
                    </strong>
                    <Badge status={r.status} />
                  </div>
                  <p className={`live live-${r.live?.kind ?? "work"}`} style={{ margin: "8px 0 0", maxWidth: "none" }}>
                    {runLiveLine({
                      liveText: r.live?.text,
                      error: r.error,
                      gate: r.gate,
                      status: r.status,
                      sceneProgress: r.sceneProgress,
                    })}
                  </p>
                  {cooking && (
                    <div className="ws-progress" aria-hidden>
                      <span style={{ width: `${runProgressPct({ status: r.status, sceneProgress: r.sceneProgress })}%` }} />
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
