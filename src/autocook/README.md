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

## Product UI / task queue

`POST /api/cook` enqueues one task into `runs/pipeline.db`. The body is the prompt and files. There is no deliverable kind.

Claim logic:

1. `argon_plan` is text. Argon names the files. That job can run while a deliverable task is generating.
2. `argon_execute` is the deliverable queue. One of those runs at a time. Weight is the sum of the plan: image 10, svg 5, html 10, pdf 15, pptx 20, audio 20, video 30.
3. A run that already finished a generation stage is claimed before a new deliverable task. Among new tasks, lower `task_weight` goes first.
4. The worker allows the running deliverable task plus one plan read (`maxParallelRuns: 2`).

Railway: web + `tsx src/worker.ts` on the same volume.

### Concurrency / 429 / idempotency (heavier than GDP text)

Job admission runs one deliverable task at a time. A text plan can be read in the other slot. Gemini calls inside a job still go through **GDP AdaptiveAdmission** (`geminiAdmission.ts`), retuned for media:

- Process ceiling **2** (GDP text often 16–96) · floor **1** · owner ceiling **1**
- Lanes: `argon` / `image` / `omni` / `files`
- On 429: AIMD halve + Retry-After cooldown + paced retry (no fan-out storm)
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
