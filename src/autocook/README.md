# Autocook platform API

Importable control plane for the wider team. **Next.js / HITL is optional** — callers can drive cooks from a worker, CLI, or service.

## Contract

1. **Argon** owns the task plan (structure, prompts, file contents, export flags).
2. **Generators** (Omni / TTS / Lyria / Gemini image) only execute what Argon asked.
3. **Platform** only posts/assembles/exports steps marked on the plan — no creative wrappers.

## Brain

- Planning uses **`gemini-4-argon`** via `GEMINI_API_KEY` only.
- Video generation: Omni (`PRODUCT_VIDEO_MODEL`).
- Image PNG: `PRODUCT_IMAGE_MODEL` or `gemini-2.5-flash-image`.
- SVG / HTML / PPTX IR: Argon emits bytes/markup; platform writes or packs OOXML.
- Document cooks give Argon **media tools** (`generate_image`, `generate_video`, `write_svg`) so it can inline stills/clips the same way gemini.google.com does — platform executes tools with Argon prompts only, then rewrites `{{asset:id}}` to path or data URI.

## API

```ts
import { planCook, generateSegment, assemble, runAutocook, inferCookKind } from "../autocook";

const kind = inferCookKind(brief, attachmentNames);
const result = await runAutocook({
  prompt: brief,
  mode: kind, // video | audio | html | image | pptx | pdf
  durationSec: 30,
  workDir: "/tmp/cook-1",
});
```

## Modes

| Mode | Plan | Generate | Assemble / post |
|------|------|----------|-----------------|
| `video` | Argon `ScriptPlan` | Omni per shot | concat → master MP4 |
| `audio` | Argon `AudioPlan` | TTS + Lyria via `createRun` | mix / dual WAV |
| `html` | Argon files[] + media tools | write + embed assets | zip / screenshot / PDF |
| `image` | Argon assets[] | PNG via Gemini image; SVG write | — |
| `pptx` | Argon slide IR | OOXML + image slots | optional PDF via LibreOffice |
| `pdf` | Argon chooses html\|pptx source | build source then export | LibreOffice / Chromium print |

## Env

- `GEMINI_API_KEY` — required
- `PRODUCT_IMAGE_MODEL` — optional image model override
- `LIBREOFFICE_BIN` / Chrome / Edge — for PDF export

## Product UI / GDP job queue

`POST /api/cook` enqueues into `runs/pipeline.db`. Claim logic is a port of GDP `src/lib/jobs/queue.ts` + `src/domain/jobs.ts`:

1. **Lanes** (lower first, then `created_at`): fast → default → generate → helper → archive  
2. **Light jobs** always eligible  
3. **Heavy / archive** only if running heavy &lt; `HEAVY_RUNNING_MAX` (2)  
4. **Helper lane** (audio) only if running helpers &lt; `HELPER_RUNNING_MAX` (1)  
5. Worker concurrency `maxParallelRuns: 2` (same as GDP default)

| Lane | Cook kinds | Heavy? |
|-----:|------------|--------|
| 0 fast | image | no |
| 1 default | html, pdf, video stages | video yes |
| 2 generate | pptx | no |
| 3 helper | audio | yes |
| 4 archive | reserved | — |

Railway: web + `tsx src/worker.ts` on the same volume.

### Concurrency / 429 / idempotency (heavier than GDP text)

Job lanes only schedule cooks. Gemini calls also go through **GDP AdaptiveAdmission** (`geminiAdmission.ts`), retuned for media:

- Process ceiling **2** (GDP text often 16–96) · floor **1** · owner ceiling **1**
- Lanes: `argon` / `image` / `omni` / `files`
- On 429: AIMD halve + Retry-After cooldown + paced retry (no fan-out storm)
- Heavy cook cap **1** (Omni/audio) so a 2nd worker slot stays free for light docs
- `requestId` on `POST /api/cook` is idempotent (same key → same run, no double enqueue)

## Railway / staging / hygiene

See `deploy/RAILWAY.md`.

- Split images: `Dockerfile.web` + `Dockerfile.worker`
- Postgres `DATABASE_URL` + `sql/001_railway_gemini.sql` (leases + `gemini_files`)
- Bucket via `S3_*` (optional local `RUNS_DIR` mirror)
- GDP file staging: plates hashed once, Omni reuses Files API URI
- **5h** idle after finish → purge staging (plates/shots); keep `final*`
- **24h** since last interaction → delete entire run including download
- GET run detail bumps interaction time
