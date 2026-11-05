"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postForm, postJson } from "@/app/components/hooks";
import {
  CATEGORIES,
  MAX_DURATION_AUDIO_SEC,
  MIN_DURATION_AUDIO_SEC,
  type Category,
} from "@/src/pipeline/constants";
import { previewSessionId } from "@/src/pipeline/session";

export default function NewAudioRunPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState<Category>(CATEGORIES[1] ?? CATEGORIES[0]);
  const [duration, setDuration] = useState(45);
  const [sessionLabel, setSessionLabel] = useState("");
  const [inputFiles, setInputFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      let json;
      if (inputFiles.length) {
        const form = new FormData();
        form.set("prompt", prompt);
        form.set("category", category);
        form.set("aspect", "16:9");
        form.set("duration", String(duration));
        form.set("pipelineMode", "audio");
        if (sessionLabel) form.set("sessionLabel", sessionLabel);
        for (const file of inputFiles) form.append("inputs", file);
        json = await postForm("/api/runs", form);
      } else {
        json = await postJson("/api/runs", {
          prompt,
          category,
          aspect: "16:9",
          duration,
          pipelineMode: "audio",
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

  const preview = previewSessionId(category, prompt, sessionLabel || undefined);

  return (
    <div>
      <p className="sub" style={{ marginBottom: 8 }}>
        <Link href="/runs/new/auto">Auto</Link> · <strong>Audio</strong>
      </p>
      <h2>Audio cook</h2>
      <p className="sub">
        Brain locked to <code>gemini-4-argon</code> for extract / EDL. Generation stays Gemini TTS + Lyria (or
        plate-assembly when the brief says so).
      </p>
      <form onSubmit={submit} className="card" style={{ maxWidth: 720, marginTop: 16 }}>
        <div className="field">
          <label>Brief / prompt</label>
          <textarea
            rows={10}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            placeholder="Spoken lines, tone, and music mood. Keep wording close to what should be spoken."
          />
        </div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            Duration ({MIN_DURATION_AUDIO_SEC}–{MAX_DURATION_AUDIO_SEC}s)
          </label>
          <input
            type="number"
            min={MIN_DURATION_AUDIO_SEC}
            max={MAX_DURATION_AUDIO_SEC}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            required
          />
        </div>
        <div className="field">
          <label>Session label (optional)</label>
          <input value={sessionLabel} onChange={(e) => setSessionLabel(e.target.value)} placeholder="short slug" />
        </div>
        <p className="sub">Session preview: audio-{preview}</p>
        <div className="field">
          <label>Brain</label>
          <p style={{ margin: 0 }}>
            <code>gemini-4-argon</code>
          </p>
        </div>
        <div className="field">
          <label>Attachments (brief PDF/DOCX, optional refs)</label>
          <input type="file" multiple onChange={(e) => setInputFiles(Array.from(e.target.files ?? []))} />
        </div>
        {err && <p className="err">{err}</p>}
        <button type="submit" disabled={busy || !prompt.trim()}>
          {busy ? "Starting…" : "Start audio cook"}
        </button>
      </form>
    </div>
  );
}
