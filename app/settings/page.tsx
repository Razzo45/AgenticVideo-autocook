"use client";

import { BRAIN_MODEL, PRODUCT_VIDEO_MODEL } from "@/src/pipeline/constants";
import { useJson } from "@/app/components/hooks";

export default function SettingsPage() {
  const { data, error } = useJson<{
    openrouter: { present: boolean; masked: string };
    gemini: { present: boolean; masked: string };
    resolution: string;
  }>("/api/settings");

  if (error) return <p className="err">{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <div>
      <h2>Settings</h2>
      <p className="sub">
        Product models are fixed in code. Resolution stays {data.resolution}. Change brain/video only by editing{" "}
        <code>BRAIN_MODEL</code> / <code>PRODUCT_VIDEO_MODEL</code> and redeploying.
      </p>
      <div className="card" style={{ marginBottom: 16, maxWidth: 640 }}>
        <h3>API keys</h3>
        <p>
          Gemini (Argon / Omni / TTS / Lyria):{" "}
          {data.gemini?.present ? (
            <span className="ok">{data.gemini.masked}</span>
          ) : (
            <span className="err">missing — set GEMINI_API_KEY in the host env</span>
          )}
        </p>
        <p className="sub" style={{ marginTop: 8 }}>
          OpenRouter is not used on the product cook path
          {data.openrouter.present ? ` (key present: ${data.openrouter.masked})` : ""}.
        </p>
      </div>
      <div className="card" style={{ maxWidth: 640 }}>
        <h3>Baked models</h3>
        <div className="grid grid-2">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Brain</label>
            <p style={{ margin: 0 }}>
              <code>{BRAIN_MODEL}</code>
            </p>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Video</label>
            <p style={{ margin: 0 }}>
              <code>{PRODUCT_VIDEO_MODEL}</code>
            </p>
          </div>
        </div>
        <p className="sub" style={{ marginTop: 12 }}>
          Keyframes use Omni text-to-video on the same Gemini key. No operator overrides.
        </p>
      </div>
    </div>
  );
}
