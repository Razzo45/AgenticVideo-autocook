"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useJson } from "@/app/components/hooks";

type TaskCook = {
  kind: string;
  label: string;
  runId: string;
  status: string;
  error: string | null;
  downloadUrl: string | null;
};

type TaskView = {
  taskId: string;
  total: number;
  ready: number;
  done: boolean;
  cooks: TaskCook[];
};

export default function TaskPage() {
  const params = useParams<{ id: string }>();
  const taskId = decodeURIComponent(params.id);
  const task = useJson<TaskView>(`/api/task/${encodeURIComponent(taskId)}`, 4000);

  return (
    <div className="cook-shell">
      <header className="cook-hero">
        <p className="cook-eyebrow">Task</p>
        <h2>{task.data ? `${task.data.ready} of ${task.data.total} ready` : "Starting cooks"}</h2>
        <p className="sub">Each deliverable is its own cook. Download a file when its status is exported.</p>
      </header>

      {task.error && (
        <div className="cook-error" role="alert">
          {task.error}
        </div>
      )}

      <div className="card" style={{ display: "grid", gap: 12 }}>
        {(task.data?.cooks ?? []).map((cook) => (
          <div
            key={cook.runId}
            style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}
          >
            <div>
              <strong>{cook.label}</strong>
              <div className="sub">
                {cook.kind} · {cook.status}
                {cook.error ? ` — ${cook.error}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <Link href={`/runs/${cook.runId}`}>Open</Link>
              {cook.downloadUrl ? <a href={cook.downloadUrl}>Download</a> : null}
            </div>
          </div>
        ))}
        {!task.loading && !task.data?.cooks.length && !task.error ? <p>No cooks on this task.</p> : null}
      </div>
    </div>
  );
}
