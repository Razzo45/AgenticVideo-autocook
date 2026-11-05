"use client";

import Link from "next/link";
import { Badge, useJson } from "@/app/components/hooks";
import { DeleteRunButton } from "@/app/components/DeleteRunButton";
import { runLiveLine, runProgressPct, runTitle } from "@/app/lib/runDisplay";

type Run = {
  id: string;
  session_id: string;
  status: string;
  target_duration: number;
  gate: string | null;
  initial_prompt: string;
  error?: string | null;
  live?: { kind: string; text: string };
  sceneProgress?: { total: number; completed: number; current: number } | null;
};

export default function RunsListPage() {
  const { data, error } = useJson<{ runs: Run[] }>("/api/runs", 2000);
  if (error) return <p className="err">{error}</p>;
  if (!data) return <p>Loading…</p>;
  const runs = data.runs ?? [];

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <p className="cook-eyebrow" style={{ marginBottom: 4 }}>
            Library
          </p>
          <h2 style={{ margin: 0 }}>Runs</h2>
        </div>
        <Link href="/" className="btn primary">
          New cook
        </Link>
      </div>

      {runs.length === 0 ? (
        <p className="sub">No runs yet. Start one from Cook.</p>
      ) : (
        <div className="run-list">
          {runs.map((r) => {
            const title = runTitle(r.session_id, r.initial_prompt);
            const live = runLiveLine({
              liveText: r.live?.text,
              error: r.error,
              gate: r.gate,
              status: r.status,
              sceneProgress: r.sceneProgress,
            });
            const pct = runProgressPct({ status: r.status, sceneProgress: r.sceneProgress });
            const cooking =
              r.status === "generating" || r.status === "stitching" || r.status === "queued";
            return (
              <div key={r.id} className="run-list-row">
                <Link href={`/runs/${r.id}`} className="run-list-main">
                  <div className="run-list-top">
                    <strong className="run-list-title">{title}</strong>
                    <Badge status={r.status} />
                  </div>
                  <p className={`live live-${r.live?.kind ?? "idle"} run-list-live`}>{live}</p>
                  {cooking && (
                    <div className="ws-progress" aria-hidden>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </Link>
                <DeleteRunButton id={r.id} compact onDeleted={() => window.location.reload()} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
