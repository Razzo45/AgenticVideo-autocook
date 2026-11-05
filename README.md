# Agentic Video Pipeline

Local operator for turning a prompt into a 30–120s video through script → keyframes → sequential clips → FFmpeg stitch, with full-chain `meta.jsonl` and an anti-prompt catalog.

First production target: **8 counted samples** (2 per PoC category). Only files that pass §3.1 automated gates and the mandatory human checklist are exported.

## Requirements

- Node 22+ (this repo uses `node:sqlite`)
- FFmpeg and ffprobe on `PATH`
- OpenRouter API key (Veo / Seedance / most models)
- Optional: `GEMINI_API_KEY` for **Gemini Omni 1.1 Flash** (direct Google Interactions API)

## Setup

```bash
copy .env.example .env
# put OPENROUTER_API_KEY in .env
# put GEMINI_API_KEY in .env to enable Gemini Omni in the video model picker
npm install
npm run dev
```

UI: http://localhost:3000  
Worker: same `npm run dev` process (separate Node watcher)

Model slugs live in `config/models.json` and can be changed in **Settings** without code changes. Pick **Gemini Omni 1.1 Flash (direct)** per run when you want video-grounded generation (operator footage trimmed to ≤10s per scene). Uploaded-video edit may be region-blocked in EEA/UK/CH.

## Flow

1. **New run** — prompt, category, duration (30–120s), aspect, optional model overrides
2. Worker generates a shot list; **Review** approves or revises
3. 5 keyframe variants → pick one (720p / failed probes cannot be selected)
4. 5 clip variants per shot → pick one, scores + checklist. Next shot is I2V from the last frame
5. Stitch at native 1080p (never upscale 720p). Optional xfade on a flagged join
6. Final audit → export into `dataset/agentic_poc/` and append `meta/anti_prompt.jsonl`

Rejected variants stay under `runs/{id}/`. Delivery contains winners only.

## Resolution

- Floor: 1080p long side. **720p is always fail.**
- Do not request OpenRouter 4K (vendor upscale, not native). Delivery is native 1080p.
