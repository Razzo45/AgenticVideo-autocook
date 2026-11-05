"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postForm, postJson } from "@/app/components/hooks";
import {
  BRAIN_MODEL,
  CATEGORIES,
  MAX_DURATION_DIRECT_SEC,
  MIN_DURATION_DIRECT_SEC,
  OUTPUT_RESOLUTIONS,
  PRODUCT_VIDEO_MODEL,
  VIDEO_ASPECTS,
  type OutputResolution,
} from "@/src/pipeline/constants";
import { previewSessionId } from "@/src/pipeline/session";

export default function NewDirectRunPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [operatorScript, setOperatorScript] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [aspect, setAspect] = useState("16:9");
  const [outputResolution, setOutputResolution] = useState<OutputResolution>("1080p");
  const [duration, setDuration] = useState(45);
  const [sessionLabel, setSessionLabel] = useState("");
  const [inputFiles, setInputFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = prompt.trim() && (operatorScript.trim() || inputFiles.some((f) => /\.(md|txt|csv)$/i.test(f.name)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        prompt,
        operatorScript: operatorScript.trim() || undefined,
        category,
        aspect,
        duration,
        outputResolution,
        pipelineMode: "direct" as const,
        sessionLabel: sessionLabel || undefined,
      };
      let json;
      if (inputFiles.length) {
        const form = new FormData();
        form.set("pipelineMode", "direct");
        form.set("prompt", prompt);
        if (operatorScript.trim()) form.set("operatorScript", operatorScript);
        form.set("category", category);
        form.set("aspect", aspect);
        form.set("duration", String(duration));
        form.set("outputResolution", outputResolution);
        if (sessionLabel) form.set("sessionLabel", sessionLabel);
        for (const file of inputFiles) form.append("inputs", file);
        json = await postForm("/api/runs", form);
      } else {
        json = await postJson("/api/runs", payload);
      }
      router.push(`/runs/${json.run.id}`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="sub" style={{ marginBottom: 8 }}>
        <Link href="/runs/new">Agentic video</Link> · <strong>Direct video</strong> ·{" "}
        <Link href="/runs/new/auto">Auto run</Link> · <Link href="/runs/new/audio">Audio</Link>
      </p>
      <h2>New direct video run</h2>
      <p className="sub">
        Feed a production brief plus a script or timed beat sheet. The pipeline segments into clips (keyframe → I2V →
        stitch) for {MIN_DURATION_DIRECT_SEC}–{MAX_DURATION_DIRECT_SEC}s. Spoken lines stay verbatim; production /
        timing beats are executed visually, not spoken. Molded to this run&apos;s brief and attachments — Direct runs
        do not count toward the PoC 8-sample tracker.
      </p>
      <form onSubmit={submit} className="card" style={{ maxWidth: 720 }}>
        <div className="field">
          <label>Production brief</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            placeholder="What this job needs: look, cast, camera, graphics, sound, constraints…"
          />
        </div>
        <div className="field">
          <label>Script / beat sheet</label>
          <textarea
            value={operatorScript}
            onChange={(e) => setOperatorScript(e.target.value)}
            rows={12}
            placeholder={
              "Spoken: paste dialogue/VO exactly as written.\n\nAction: paste timed sections or production directions — executed on screen, not read aloud."
            }
          />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Required here or via a .md/.txt attachment. Dialogue is preserved verbatim; production directions are
            classified as on-screen actions. PDFs are stored but not auto-extracted yet.
          </p>
        </div>
        <div className="field">
          <label>Attachments (optional)</label>
          <input
            type="file"
            multiple
            onChange={(e) => setInputFiles(Array.from(e.target.files ?? []))}
          />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Whatever this job needs: stills, plates, PDFs, audio, intro/outro video. Logo filenames stay stitch/prompt-only
            (providers often block trademark image refs). Intro/outro filenames bookend the stitch.
          </p>
          {inputFiles.length > 0 && (
            <p className="sub" style={{ margin: "6px 0 0" }}>
              {inputFiles.length} file(s): {inputFiles.map((f) => f.name).join(", ")}
            </p>
          )}
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Aspect</label>
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {VIDEO_ASPECTS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Output resolution</label>
          <select
            value={outputResolution}
            onChange={(e) => setOutputResolution(e.target.value as OutputResolution)}
          >
            {OUTPUT_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r === "4K" ? "4K (3840×2160 for 16:9)" : "1080p (1920×1080 for 16:9)"}
              </option>
            ))}
          </select>
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Pick 4K when the brief needs UHD masters (e.g. Veo Fast). Requests, stitch, and clip gates follow this
            target.
          </p>
        </div>
        <div className="field">
          <label>Target duration (seconds)</label>
          <input
            type="number"
            min={MIN_DURATION_DIRECT_SEC}
            max={MAX_DURATION_DIRECT_SEC}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Minimum length to reach via stitched clips. Each section gets its own keyframe and I2V clip.
          </p>
        </div>
        <div className="field">
          <label>Session name (optional)</label>
          <input
            value={sessionLabel}
            onChange={(e) => setSessionLabel(e.target.value)}
            placeholder="Leave blank to name from the brief"
          />
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Will be saved as <code>direct-{previewSessionId(category, prompt || "untitled", sessionLabel)}</code>
          </p>
        </div>
        <div className="field">
          <label>Models (baked)</label>
          <p style={{ margin: 0 }}>
            Brain <code>{BRAIN_MODEL}</code> · Video <code>{PRODUCT_VIDEO_MODEL}</code>
          </p>
        </div>
        {err && <p className="err">{err}</p>}
        <button className="primary" disabled={busy || !canSubmit}>
          {busy ? "Starting…" : "Start direct run"}
        </button>
      </form>
    </div>
  );
}
