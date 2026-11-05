"use client";

import { mediaSrc, useJson } from "@/app/components/hooks";

type Rec = {
  uniq_id: string;
  modality: string;
  generation_type: string;
  media_path: string;
  media_desc: string;
  category: string;
  duration: number | null;
  width: number;
  height: number;
};

export default function DatasetPage() {
  const { data, error } = useJson<{
    counted: number;
    rejected: number;
    records: Rec[];
    parseError: string | null;
    files: Array<{ rel: string }>;
  }>("/api/dataset", 4000);

  if (error) return <p className="err">{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <div>
      <h2>Dataset</h2>
      <p className="sub">
        Delivery folder <code>dataset/agentic_poc</code>. Counted {data.counted} · rejected {data.rejected} (not in
        volume). Each export writes <code>meta.jsonl</code> and a pretty session JSON.
      </p>
      {data.parseError && <p className="err">meta.jsonl parse: {data.parseError}</p>}
      {data.files.filter((f) => /^meta\/sess_.*\.json$/.test(f.rel)).length > 0 && (
        <p className="sub">
          Pretty JSON:{" "}
          {data.files
            .filter((f) => /^meta\/sess_.*\.json$/.test(f.rel))
            .map((f, i, arr) => (
              <span key={f.rel}>
                <a href={mediaSrc("dataset/agentic_poc/" + f.rel)} target="_blank">
                  {f.rel}
                </a>
                {i < arr.length - 1 ? " · " : ""}
              </span>
            ))}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>uniq_id</th>
            <th>Type</th>
            <th>Category</th>
            <th>Size</th>
            <th>Dur</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {data.records.map((r) => (
            <tr key={r.uniq_id}>
              <td>{r.uniq_id}</td>
              <td>
                {r.generation_type} / {r.modality}
              </td>
              <td>{r.category}</td>
              <td>
                {r.width}×{r.height}
              </td>
              <td>{r.duration ?? "—"}</td>
              <td>
                <a href={mediaSrc("dataset/agentic_poc/" + r.media_path)} target="_blank">
                  {r.media_path}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
