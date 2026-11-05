"use client";

import { useMemo, useState } from "react";
import type { CatalogOption } from "@/src/pipeline/catalog";

function optionLabel(o: CatalogOption): string {
  const bits = [o.name];
  if (o.durations?.length) bits.push(`${o.durations.join("/")}s`);
  if (o.eligible1080p === false) bits.push("no 1080p");
  return bits.join(" · ");
}

export function ModelSelect({
  label,
  options,
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "Use default",
  hint,
}: {
  label: string;
  options: CatalogOption[];
  value: string;
  onChange: (id: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  hint?: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return options;
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q),
    );
  }, [options, q]);
  const selected = options.find((o) => o.id === value);
  const shown = selected && !filtered.some((o) => o.id === value) ? [selected, ...filtered] : filtered;

  return (
    <div className="field">
      <label>{label}</label>
      {options.length > 24 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name"
          style={{ marginBottom: 6 }}
        />
      )}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {shown.map((o) => (
          <option key={o.id} value={o.id}>
            {optionLabel(o)}
          </option>
        ))}
        {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
      </select>
      {hint && <p className="sub" style={{ margin: "6px 0 0" }}>{hint}</p>}
    </div>
  );
}
