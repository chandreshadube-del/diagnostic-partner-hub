# Daily AI VTuber Shorts

One 45–60 second English YouTube Short per day about an AI / LLM / developer
tooling project, generated locally and scheduled to publish at 18:00
Asia/Kolkata. No hosted model APIs, no project data leaving the machine.

Read [FEASIBILITY.md](FEASIBILITY.md) first: it records what was verified during
implementation, what was not, and why.

---

## The rule the whole thing is built around

**A day with weak evidence produces nothing.** There is no fallback video, no
degraded render and no catching up on a missed slot. Every stage can refuse, and
a refusal writes the failure and its inputs next to the manifest so you can see
what happened.

## Pipeline

```
discover → research → script → audio → render → validate → canary → schedule → publish
```

| Stage | What happens | What stops it |
|---|---|---|
| **discover** | GitHub REST search, ranked on push recency, release recency, docs and licence | 120-day repo cooldown; no candidate → skip the day |
| **research** | Evidence packet from repo metadata, README, latest release, LICENSE, with retrieval timestamps and body hashes | too few usable sentences → skip |
| **script** | Local model returns scene *data* (never HTML) for five fixed roles: hook / what / detail / limitation / takeaway | strict Pydantic schemas; mechanical critic; repetition and copied-passage checks |
| **audio** | Kokoro TTS, then **faster-whisper transcribes the rendered audio** | WER > 5%, or any technical name / version / number that did not survive synthesis |
| **render** | JSON timeline → Chromium at 1080×1920 → `seekToTime(t)` per frame → FFmpeg | layout overflow, blank frames, page errors |
| **validate** | ffprobe, full decode, audio levels, frame variance, metadata claims | any blocking gate |
| **canary** | one private upload, polled until processed | public scheduling stays locked until this passes |
| **schedule** | private upload with `status.publishAt` | missed window → skip, never a backlog |

Alignment metadata from the TTS engine is deliberately **not** trusted. The only
evidence of what was spoken is an independent transcription of the audio file
that will actually ship.

## Install (Windows)

Requires **Python 3.12** — `kokoro` and `misaki` declare `python <3.13`.

```powershell
powershell -ExecutionPolicy Bypass -File tools\windows\install.ps1
```

That creates `.venv`, installs pinned dependencies, downloads Chromium for
Playwright, points you at the official FFmpeg and Ollama installers, generates
the avatar and runs the doctor. Then pull the models:

```powershell
ollama pull qwen2.5:7b-instruct
```

```powershell
ollama pull llama3.1:8b-instruct-q4_K_M
```

Copy and edit the config:

```powershell
copy config\config.example.toml config\config.toml
```

Then pin the voice model. Uploads stay blocked until this is done, which is the
point at which you read the model's licence:

```powershell
.venv\Scripts\python -m vtuber bootstrap
```

It resolves the current commit of `hexgrad/Kokoro-82M`, prints the licence it
declares and a link to the licence file, and writes the revision into
`config.toml`. It refuses to pin a model whose card declares no licence, or one
outside a short permissive list, unless you pass `--accept-license <id>` to say
you have read it.

## First run

```powershell
.venv\Scripts\python -m vtuber doctor
```

```powershell
.venv\Scripts\python -m vtuber run
```

`run` generates and validates but uploads nothing. The MP4, manifest, timeline,
evidence packet, QC report and critic report all land in
`episodes\<episode-id>\`.

## Authorising YouTube

Create a **Desktop app** OAuth client in Google Cloud Console with the YouTube
Data API v3 enabled, and save the JSON to
`%APPDATA%\vtuber-shorts\client_secrets.json` (or point `VTUBER_CLIENT_SECRETS`
at it). It must live outside this repository.

```powershell
.venv\Scripts\python -m vtuber auth
```

This prints the channel id and title the token actually resolves to. Copy them
into `[upload]` in `config.toml`. The pipeline refuses to upload to any other
channel, and refuses to choose if the account owns more than one.

Two scopes are requested and no more: `youtube.upload` to insert the video, and
`youtube.readonly` to confirm the channel and poll processing status. The
refresh token is stored in the Windows Credential Manager via `keyring` — never
in a file, a log or a manifest.

## The canary

Public scheduling is locked until one private upload has been confirmed as
processed by YouTube:

```powershell
.venv\Scripts\python -m vtuber canary
```

It uploads the latest validated episode as private with **no** `publishAt`, then
polls `status.uploadStatus` until it settles. On `processed`, set
`canary_passed = true` and `enabled = true` under `[upload]`.

## Daily schedule

```powershell
powershell -ExecutionPolicy Bypass -File tools\windows\schedule_enable.ps1
```

Registers `VTuberShortsDaily`: generation starts at **17:00** local time,
targeting an **18:00** publish. `StartWhenAvailable` is off on purpose — if the
PC was asleep, the day is skipped rather than published late.

**To stop everything, immediately:**

```powershell
powershell -ExecutionPolicy Bypass -File tools\windows\schedule_disable.ps1
```

That stops any running instance and unregisters the task. Nothing can generate
or upload until you re-enable it.

## Where things live

```
config/config.toml          your settings (gitignored; no secrets)
assets/avatar/              generated sprite sheet + metadata
templates/                  the stage: index.html, app.js, app.css, scenes/*.js
src/vtuber/                 the pipeline
tools/make_avatar.py        regenerates the avatar from primitives
tools/e2e_prototype.py      end-to-end run with stand-ins, for machines without weights
tools/windows/              installer, daily runner, schedule on/off
episodes/<id>/              manifest.json, evidence.json, critic.json, timeline.json,
                            qc.json, narration.wav, <id>.mp4, render/
logs/pipeline.log           rotated daily, 30 days; plus logs/<episode-id>.log
state/ledger.sqlite3        topic cooldown, script history, upload ledger
```

Secrets are in the Windows Credential Manager. The OAuth client JSON is under
`%APPDATA%`. Neither is in this repository, and `secrets_store.assert_not_in_repo`
exists to keep it that way.

## Commands

| Command | What it does |
|---|---|
| `vtuber doctor` | inspect the machine, list blockers |
| `vtuber bootstrap` | pin the TTS model revision after reading its licence |
| `vtuber avatar` | regenerate the sprite sheet |
| `vtuber run` | generate and validate one episode, no upload |
| `vtuber rerender <id>` | re-render an existing episode |
| `vtuber auth` | OAuth, print the authorised channel |
| `vtuber canary` | private canary upload + processing poll |
| `vtuber schedule` | upload private with `publishAt` at the configured slot |
| `vtuber daily --publish` | what Task Scheduler runs |
| `vtuber status` | recent episodes and ledger state |
| `vtuber reconcile` | resolve ambiguous upload claims against YouTube |

## Retries and duplicate uploads

The upload ledger (`state/ledger.sqlite3`) is written **before** the network
call. If an upload ends ambiguously — a reset connection, a timeout — the claim
is left behind, and the next run reconciles it: it looks the video up by id, or
failing that searches the channel's own uploads playlist by title. Only when
nothing is found is a second upload attempted, and after
`upload.max_upload_attempts` the episode is refused outright.

## Synthetic media disclosure

`status.containsSyntheticMedia` is supported by the API (verified against the v3
discovery document). Whether this content *requires* the disclosure is a policy
question, and the pipeline does not guess: `declare_synthetic_media` defaults to
**false** and is yours to set after reading YouTube's current guidance. When it
is on, the value is read back after upload and reported as *unverified* rather
than as success if the API does not echo it.

## Avatar and assets

`tools/make_avatar.py` draws the character from rectangles — a CRT-screen head,
an antenna, block eyes, a bar mouth, a chevron torso — across 5 poses × 3 mouth
frames. Nothing is traced, sampled or downloaded, so there is no third-party
character art here. The generator verifies that every frame has the same cell
size, sits on the same baseline and uses only the declared palette.

## Tests

```powershell
.venv\Scripts\python -m pytest -q
```

Render and encode tests skip automatically when Chromium or FFmpeg is missing.
`tools/e2e_prototype.py` runs the whole chain with stand-ins for the model, the
voice and the transcriber; episodes it produces are blocked from upload by
design.

## Monetisation

Nothing here guarantees it. YouTube can reject repetitive or mass-produced
content whatever made it. See the closing section of
[FEASIBILITY.md](FEASIBILITY.md).
