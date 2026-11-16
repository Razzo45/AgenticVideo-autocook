/** Operator view of the cook queue. No prompts, no file addresses. */

export type QueueTask = {
  runId: string;
  sessionId: string;
  pipelineMode: string;
  runStatus: string;
  jobType: string | null;
  jobStatus: string | null;
  taskWeight: number | null;
  updatedAt: string;
  line: string;
};

export type QueueSnapshot = {
  at: string;
  jobs: Record<string, number>;
  runs: Record<string, number>;
  tasks: QueueTask[];
};

export function clipStatusLine(value: string | null | undefined, max = 180): string {
  const text = String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function counts(label: string, keys: string[], bag: Record<string, number>): string {
  const known = keys.map((key) => `${key}=${bag[key] ?? 0}`);
  const extra = Object.keys(bag)
    .filter((key) => !keys.includes(key))
    .sort()
    .map((key) => `${key}=${bag[key]}`);
  return `${label} ${[...known, ...extra].join(" ")}`;
}

export function idleLabel(updatedAt: string, now = Date.now()): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return "?";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/** One line per active task, stable enough to grep. */
export function formatQueueLines(snapshot: QueueSnapshot, now = Date.now()): string[] {
  const lines = [
    counts("queue jobs", ["pending", "running", "done", "error"], snapshot.jobs),
    counts("queue runs", ["queued", "generating", "exported", "failed"], snapshot.runs),
  ];
  if (!snapshot.tasks.length) {
    lines.push("queue active none");
    return lines;
  }
  for (const task of snapshot.tasks) {
    const job = task.jobType ? `${task.jobType} ${task.jobStatus}` : "no-job";
    const weight = task.taskWeight == null ? "" : ` weight=${task.taskWeight}`;
    const line = clipStatusLine(task.line);
    lines.push(
      [
        task.runId,
        job + weight,
        `idle=${idleLabel(task.updatedAt, now)}`,
        `run=${task.runStatus}`,
        task.pipelineMode,
        line,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return lines;
}
