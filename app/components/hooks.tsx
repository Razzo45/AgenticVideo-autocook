"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useJson<T>(url: string, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    inFlight.current = true;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch(url, { cache: "no-store", signal: abort.signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      setData(json as T);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void reload();
    if (!intervalMs) return;

    const t = setInterval(() => void reload(), intervalMs);
    const onVis = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      abortRef.current?.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [url, intervalMs, reload]);

  return { data, error, loading, reload };
}

export async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

export async function postForm(url: string, form: FormData) {
  const res = await fetch(url, { method: "POST", body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

export async function deleteJson(url: string) {
  const res = await fetch(url, { method: "DELETE" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json as { ok: boolean; id?: string; diskError?: string };
}

export function mediaSrc(absOrRel: string) {
  const cwd = absOrRel.replaceAll("\\", "/");
  const idx = cwd.toLowerCase().indexOf("/runs/");
  const didx = cwd.toLowerCase().indexOf("/dataset/");
  let rel = cwd;
  if (idx >= 0) rel = cwd.slice(idx + 1);
  else if (didx >= 0) rel = cwd.slice(didx + 1);
  return `/api/media?path=${encodeURIComponent(rel)}`;
}

export function Badge({ status }: { status: string }) {
  let cls = "accent";
  if (status === "exported") cls = "pass";
  else if (status === "rejected" || status === "failed") cls = "fail";
  else if (status === "waiting_human" || status === "rework") cls = "warn";
  return <span className={`badge ${cls}`}>{status}</span>;
}
