"use client";

import Link from "next/link";
import { Badge, useJson } from "@/app/components/hooks";

type Waiting = {
  id: string;
  session_id: string;
  category: string;
  gate: string | null;
  initial_prompt: string;
  updated_at: string;
};

export default function ReviewPage() {
  const { data, error } = useJson<{ runs: Waiting[] }>("/api/review", 2000);

  if (error) return <p className="err">{error}</p>;
  if (!data) return <p>Loading…</p>;
  const runs = data.runs ?? [];

  return (
    <div>
      <h2>Review</h2>
      <p className="sub">
        Sessions waiting on you, oldest first. Open any of them — the others keep cooking or stay in this list.
      </p>
      {runs.length === 0 ? (
        <p>Nothing waiting. Open a run from the list, or start a new one while others generate.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Gate</th>
              <th>Category</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/runs/${r.id}`}>{r.session_id}</Link>
                  <div className="sub" style={{ marginTop: 4 }}>
                    {(r.initial_prompt ?? "").slice(0, 90)}
                    {(r.initial_prompt ?? "").length > 90 ? "…" : ""}
                  </div>
                </td>
                <td>
                  <Badge status={r.gate ?? "—"} />
                </td>
                <td>{r.category}</td>
                <td>
                  <Link href={`/runs/${r.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
