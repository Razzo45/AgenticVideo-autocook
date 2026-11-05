"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { postForm, postJson } from "@/app/components/hooks";
import {
  AUTO_OPTION_FIELDS,
  DEFAULT_AUTO_OPTIONS,
  type AutoOptions,
} from "@/src/pipeline/autoOptions";
import {
  BRAIN_MODEL,
  CATEGORIES,
  MAX_DURATION_AUTO_SEC,
  MAX_DURATION_AUTO_SHORT_SEC,
  MIN_DURATION_AUTO_SEC,
  OUTPUT_RESOLUTIONS,
  PRODUCT_VIDEO_MODEL,
  TYPICAL_AUTO_CLIP_SEC,
  VIDEO_ASPECTS,
  type OutputResolution,
} from "@/src/pipeline/constants";
import { previewSessionId } from "@/src/pipeline/session";

export default function NewAutoRunPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState(CATEGORIES[1] ?? CATEGORIES[0]);
  const [aspect, setAspect] = useState("16:9");
  const [outputResolution, setOutputResolution] = useState<OutputResolution>("1080p");
  const [duration, setDuration] = useState(270);
  const [sessionLabel, setSessionLabel] = useState("");
  const [inputFiles, setInputFiles] = useState<File[]>([]);
  const [autoOptions, setAutoOptions] = useState<AutoOptions>({ ...DEFAULT_AUTO_OPTIONS });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (autoOptions.deliver4k) setOutputResolution("4K");
    else if (outputResolution === "4K") setOutputResolution("1080p");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to deliver4k toggle
  }, [autoOptions.deliver4k]);

  useEffect(() => {
    if (autoOptions.longCook) {
      setDuration((d) => Math.min(MAX_DURATION_AUTO_SEC, Math.max(d, 180)));
    } else {
      setDuration((d) => Math.min(d, MAX_DURATION_AUTO_SHORT_SEC));
    }
  }, [autoOptions.longCook]);

  function setOpt<K extends keyof AutoOptions>(key: K, value: AutoOptions[K]) {
    setAutoOptions((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const resolution: OutputResolution = autoOptions.deliver4k ? "4K" : outputResolution;
      let json;
      if (inputFiles.length) {
        const form = new FormData();
        form.set("prompt", prompt);
        form.set("category", category);
        form.set("aspect", aspect);
        form.set("outputResolution", resolution);
        form.set("duration", String(duration));
        form.set("pipelineMode", "auto");
        form.set("autoOptions", JSON.stringify(autoOptions));
        if (sessionLabel) form.set("sessionLabel", sessionLabel);
        for (const file of inputFiles) form.append("inputs", file);
        json = await postForm("/api/runs", form);
      } else {
        json = await postJson("/api/runs", {
          prompt,
          category,
          aspect,
          outputResolution: resolution,
          duration,
          pipelineMode: "auto",
          autoOptions,
          sessionLabel: sessionLabel || undefined,
        });
      }
      router.push(`/runs/${json.run.id}`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  const estScenes = Math.max(1, Math.ceil(duration / TYPICAL_AUTO_CLIP_SEC));

  return (
    <div>
      <p className="sub" style={{ marginBottom: 8 }}>
        <strong>Auto</strong> · <Link href="/runs/new/audio">Audio</Link>
      </p>
      <h2>New auto cook</h2>
      <p className="sub">
        Brain is locked to gemini-4-argon. Long form is assembled as short scenes (~{TYPICAL_AUTO_CLIP_SEC}s each) then
        concatenated. Duration {MIN_DURATION_AUTO_SEC}–{MAX_DURATION_AUTO_SEC}s. Worker advances every gate — no HITL
        stalls.
      </p>
      <form onSubmit={submit} className="card" style={{ maxWidth: 720 }}>
        <div className="field">
          <label>What it needs to do</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            placeholder="Brief, tone, cast, and sequence intent…"
          />
        </div>
        <div className="field">
          <label>Operator inputs (optional)</label>
          <input type="file" multiple onChange={(e) => setInputFiles(Array.from(e.target.files ?? []))} />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Refs for look / identity / audio / script. Same attachment rules as Agentic.
          </p>
          {inputFiles.length > 0 && (
            <p className="sub" style={{ margin: "6px 0 0" }}>
              {inputFiles.length} file(s): {inputFiles.map((f) => f.name).join(", ")}
            </p>
          )}
        </div>

        <div className="field">
          <label>Requirement toggles</label>
          <p className="sub" style={{ margin: "0 0 8px" }}>
            Each toggle injects a hard requirement into storyboard / keyframe / clip prompts. Honesty notes stay
            visible — voice and timed graphics are best-effort.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {AUTO_OPTION_FIELDS.map((f) => (
              <label key={f.key} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={Boolean(autoOptions[f.key])}
                  onChange={(e) => setOpt(f.key, e.target.checked)}
                  style={{ marginTop: 4 }}
                />
                <span>
                  <strong>{f.label}</strong>
                  <br />
                  <span className="sub">{f.note}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-2">
          <div className="field">
            <label>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Aspect</label>
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {VIDEO_ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Output resolution</label>
          <select
            value={outputResolution}
            disabled={autoOptions.deliver4k}
            onChange={(e) => setOutputResolution(e.target.value as OutputResolution)}
          >
            {OUTPUT_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r === "4K" ? "4K (3840×2160 for 16:9)" : "1080p (1920×1080 for 16:9)"}
              </option>
            ))}
          </select>
          {autoOptions.deliver4k && (
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Locked to 4K by the delivery toggle.
            </p>
          )}
        </div>
        <div className="field">
          <label>Minimum duration (seconds)</label>
          <input
            type="number"
            min={MIN_DURATION_AUTO_SEC}
            max={autoOptions.longCook ? MAX_DURATION_AUTO_SEC : MAX_DURATION_AUTO_SHORT_SEC}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            {autoOptions.longCook
              ? `Long cook up to ${MAX_DURATION_AUTO_SEC}s (~${estScenes} scenes at ~${TYPICAL_AUTO_CLIP_SEC}s).`
              : `Short cook capped at ${MAX_DURATION_AUTO_SHORT_SEC}s (~${Math.ceil(duration / TYPICAL_AUTO_CLIP_SEC)} scenes).`}
          </p>
        </div>
        <div className="field">
          <label>Session name (optional)</label>
          <input
            value={sessionLabel}
            onChange={(e) => setSessionLabel(e.target.value)}
            placeholder="Leave blank to name from the prompt"
          />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Preview: auto-{previewSessionId(category, prompt, sessionLabel || undefined)}
          </p>
        </div>
        <div className="field">
          <label>Models (baked)</label>
          <p style={{ margin: 0 }}>
            Brain <code>{BRAIN_MODEL}</code> · Video <code>{PRODUCT_VIDEO_MODEL}</code>
          </p>
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Not configurable in the UI — change only in code.
          </p>
        </div>
        {err && <p className="err">{err}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Starting…" : "Start auto run"}
        </button>
      </form>
    </div>
  );
}
