"use client";

import { useJson } from "@/app/components/hooks";

type Rec = {
  uniq_id: string;
  category: string;
  media_desc: string;
  duration: number;
  aspect_ratio: string;
  shots?: Array<{ index: number; media_desc: string; still?: string; motion?: string }>;
};

export default function AntiPromptPage() {
  const { data, error } = useJson<{ records: Rec[] }>("/api/anti-prompt", 4000);
  if (error) return <p className="err">{error}</p>;
  if (!data) return <p>Loading…</p>;
  const byField = new Map<string, Rec[]>();
  for (const r of data.records) {
    const key = r.category || "Uncategorized";
    const list = byField.get(key) ?? [];
    list.push(r);
    byField.set(key, list);
  }
  return (
    <div>
      <h2>Uniqueness sidecar</h2>
      <p className="sub">
        Each field is a “do not repeat” catalog. The next storyboard call gets this
        field’s full occupied list (logline + panel sentences, closest to the new
        prompt first). Still/motion stay on disk, not in the prompt.
      </p>
      {data.records.length === 0 && <p>Empty — fills when a sample is exported.</p>}
      {[...byField.entries()].map(([field, recs]) => (
        <section key={field} style={{ marginBottom: 22 }}>
          <h3>
            {field} · {recs.length}
          </h3>
          {recs.map((r) => (
            <div className="card" key={r.uniq_id} style={{ marginBottom: 10 }}>
              <p>{r.media_desc}</p>
              <p className="sub">
                {r.aspect_ratio} · {r.duration}s
              </p>
              {(r.shots ?? []).map((s) => (
                <p className="sub" key={s.index}>
                  {s.index + 1}. {s.media_desc}
                </p>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
