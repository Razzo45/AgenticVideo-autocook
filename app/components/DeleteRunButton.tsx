"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteJson } from "@/app/components/hooks";

export function DeleteRunButton({
  id,
  counted,
  compact,
  onDeleted,
}: {
  id: string;
  counted?: number | boolean;
  compact?: boolean;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const wasCounted = Boolean(counted);

  async function onClick() {
    const extra = wasCounted
      ? " This run was counted. Its dataset files, pretty JSON, and meta.jsonl / anti-prompt rows will be removed too."
      : "";
    if (!window.confirm(`Delete ${id}? The run folder and database rows are removed.${extra}`)) return;
    setBusy(true);
    try {
      const result = await deleteJson(`/api/runs/${id}`);
      if (result.diskError) {
        window.alert(`Run removed from the list, but some files are still locked: ${result.diskError}`);
      }
      if (onDeleted) onDeleted();
      else router.push("/");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={compact ? "btn" : "danger"}
      disabled={busy}
      onClick={onClick}
      style={compact ? { color: "var(--fail)", borderColor: "transparent", background: "transparent" } : undefined}
    >
      {busy ? "…" : compact ? "Delete" : "Delete run"}
    </button>
  );
}
