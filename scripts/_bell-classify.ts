import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { execFileSync } from "node:child_process";

async function main() {
  const dl = "C:\\Users\\RazvanHome\\Downloads";
  const files = [
    "dff3911e-959e-48cf-a980-ace37f6c5bf3.wav",
    "de719f86-c058-492a-9268-a7c0644fb1e1.mp3",
    "ccf0ce27-3515-4f7b-bc48-c7525e1a6f74.mp3",
    "3a37c3e1-a42f-4a7e-bc11-ca3ea0dce29c.mp3",
    "a21932ac-bfb5-4f4e-802a-261a3bd15e07.mp3",
    "1227140a-4966-4df2-9475-81c9a905626b.mp3",
    "357b5ad6-9e01-498b-be4a-63fd721eb746.mp3",
    "4c138cff-4a6e-486a-b314-a8ecc390fcd0.mp3",
    "8691aee8-c0db-4168-b0d3-073668c2640e.mp3",
    "a88a1590-6c31-4b40-973d-d3b8b2845dc6.mp3",
    "c999b68b-036a-4725-b71d-91552ae7e91c.mp3",
    "57f4d1c0-c911-4c1c-b312-d597bd1c2480.mp3",
    "66e54072-27f7-455c-bae5-6907c0ff8d01.wav",
    "f2c67c3c-0938-47d3-a0b5-36b75f109afe.mp3",
    "b5b37de5-44fc-4728-84a4-0b1afb84e22f.mp3",
    "270c0263-8cc0-42b6-af20-a894ebd0e55a.wav",
  ];
  function dur(f: string) {
    return Number(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path.join(dl, f)],
        { encoding: "utf8" },
      ).trim(),
    );
  }
  const catalog = files.map((f) => ({ file: f, durationSec: Math.round(dur(f) * 100) / 100 }));
  const brief = fs.readFileSync("tasks/_bell_EDITING_BRIEF_FOR_AUDIO_TECHNICIAN_1.pdf.txt", "utf8").slice(0, 7000);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const prompt = `Map UUID audio files to Bell House tour roles. Return ONE JSON object only.
Roles: narration, music, clock_tick, clock_bell, footsteps, workshop_ambience, door_close_large, tools, wrench, drawer_open, music_box, door_open_small, fireplace, writing.
Known: narration is the mastered VO with two ~15s silent walking gaps (around 85s and 160s). Music is the long historical instrumental bed.
Use duration + materials table. Each role maps to exactly one filename from the catalog.
Also return cue_times_sec approximating: listen_closely, hall_departure_end, workshop_start, tools, modified_tools, unfinished_clock, musical_cylinder, workshop_departure_end, study_fireplace, diary_clara, conclusion_locked, final_word_end.
BRIEF:\n${brief}\nCATALOG:\n${JSON.stringify(catalog)}`;
  const result = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });
  const raw = (result.text ?? "").trim();
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  const json = JSON.parse(raw.slice(s, e + 1));
  fs.mkdirSync("tasks/task-bell-house-tour", { recursive: true });
  fs.writeFileSync("tasks/task-bell-house-tour/_rolemap.json", JSON.stringify({ catalog, map: json }, null, 2));
  console.log(JSON.stringify(json, null, 2));
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
