/** Friendly title operators actually recognize (not raw session ids). */
export function runTitle(sessionId: string, prompt?: string | null): string {
  let s = (sessionId || "").trim();
  s = s.replace(/^(auto|direct|audio)-/i, "");
  s = s.replace(/^sess_[a-z0-9]+_/i, "");
  s = s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length >= 3 && !/^run /i.test(s)) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const p = (prompt || "").trim().replace(/\s+/g, " ");
  if (p) return p.length > 56 ? `${p.slice(0, 56)}…` : p;
  return sessionId || "Untitled run";
}

export function runProgressPct(input: {
  status: string;
  sceneProgress?: { total: number; completed: number } | null;
}): number {
  const { status, sceneProgress } = input;
  if (status === "exported") return 100;
  if (status === "failed") return sceneProgress?.total
    ? Math.round((sceneProgress.completed / sceneProgress.total) * 100)
    : 0;
  if (status === "stitching") return 92;
  if (status === "queued") return 6;
  if (sceneProgress && sceneProgress.total > 0) {
    const { completed, total } = sceneProgress;
    const base = (completed / total) * 82;
    const working = completed < total ? 8 : 0;
    return Math.min(90, Math.round(base + working));
  }
  if (status === "generating" || status === "waiting_human") return 28;
  return 12;
}

/** One-line status operators care about. */
export function runLiveLine(input: {
  liveText?: string | null;
  error?: string | null;
  gate?: string | null;
  status: string;
  sceneProgress?: { total: number; completed: number; current: number } | null;
}): string {
  const live = (input.liveText || input.error || "").trim();
  if (live) return live;
  if (input.status === "exported") return "Ready to download";
  if (input.status === "failed") return "Stopped — resume when ready";
  if (input.status === "stitching") return "Assembling master…";
  if (input.status === "queued") return "Queued…";
  if (input.sceneProgress && input.sceneProgress.total > 0) {
    return `Scene ${input.sceneProgress.current + 1} of ${input.sceneProgress.total}`;
  }
  if (input.gate) return `Waiting on ${input.gate}`;
  return "Cooking…";
}
