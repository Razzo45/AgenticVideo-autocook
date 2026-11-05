"use client";

import type { Checklist } from "@/src/pipeline/schema";

const ITEMS: Array<{ key: keyof Checklist; label: string }> = [
  { key: "purity", label: "No unrequested hard subtitles, watermarks, UI overlays, unclean edges, or black bars (on-screen branding only if the brief requires it)" },
  { key: "safety", label: "Content safety pass (no gore, violence, pornography, political/religious extremism, privacy violations)" },
  { key: "structure", label: "No extra limbs, distorted faces, merged objects, morphing, liquefaction, jelly, or flicker" },
  { key: "identity", label: "Character/object identity holds across the shot and the join to the previous shot" },
];

export function ChecklistForm({
  value,
  onChange,
}: {
  value: Checklist;
  onChange: (next: Checklist) => void;
}) {
  return (
    <div>
      {ITEMS.map((item) => (
        <label className="check" key={item.key}>
          <input
            type="checkbox"
            checked={value[item.key]}
            onChange={(e) => onChange({ ...value, [item.key]: e.target.checked })}
          />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
}

export const EMPTY_CHECKLIST: Checklist = {
  purity: false,
  safety: false,
  structure: false,
  identity: false,
};
