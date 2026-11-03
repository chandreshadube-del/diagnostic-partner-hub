# Feasibility report

Written during implementation, 2026-11-03. Everything below is either measured
in this session or quoted from a primary source that was reachable from it.
Anything that could not be checked is marked **[UNVERIFIED]** rather than
assumed.

## Where this was built, and what that means

The master prompt targets a Windows machine at
`C:\Users\chand\OneDrive\Documents\Automate YT`. This implementation was written
in a Linux cloud container, because that is the only machine this session can
reach — Remote Control lists no shared folders for this account, so the Windows
box, the PDF (`Building Automated AI VTuber Videos.pdf`), the
`research/gemini-argon-ai-vtuber-pipeline.md` note and the Gemini conversation
were all unreachable. **None of the three source documents were read.** Nothing
in this repository is derived from them; every external claim here comes from a
primary source fetched during implementation.

Practically: the code is cross-platform and the Windows-specific parts
(Credential Manager, Task Scheduler, the installer) are written but have **not**
been executed on Windows.

### Measured here (Linux container)

| | |
|---|---|
| OS | Linux 6.18.44, x86-64 |
| CPU | 4 logical cores |
| RAM | 15 GB |
| Python | 3.13.18 |
| FFmpeg / ffprobe | 6.1.1 (Ubuntu build), present |
| Chromium | Chrome for Testing 153.0.8010.12 |
| Playwright | 1.64.1 (Python), driven with an explicit `executable_path` |
| GPU | none exposed; everything below is CPU-only |

### Not measurable from here

The Windows machine's CPU, RAM and GPU are unknown. `vtuber doctor` prints all
of them on the target machine and refuses to proceed if a blocking requirement
is missing; run it first.

## Runtime choices, and why

### Python 3.12, not 3.13

`kokoro==0.9.4` and `misaki==0.9.4` both declare `Requires-Python: >=3.10,<3.13`
(read from the PyPI JSON API during implementation). A 3.13 virtualenv cannot
install them. `tools\windows\install.ps1` looks for a 3.12 interpreter and stops
with that explanation if it does not find one.

### Local models

| Component | Choice | Licence | Verified how |
|---|---|---|---|
| Writer / critic LLM | Ollama on `127.0.0.1:11434`, `qwen2.5:7b-instruct` + `llama3.1:8b-instruct-q4_K_M`, downgraded to 3B tags below 12 GB RAM | per-model, on Ollama | **[UNVERIFIED]** — the tags must be confirmed with `ollama pull` on the target machine; `OllamaLLM.ensure_model` fails loudly if a tag is absent |
| TTS | Kokoro-82M via `kokoro==0.9.4` | package: Apache-2.0 | PyPI metadata + the project's own `LICENSE` |
| G2P | `misaki[en]==0.9.4`, which pulls `espeakng-loader` | Apache-2.0 | PyPI metadata |
| ASR | `faster-whisper==1.2.1`, `small.en`, `int8`, CPU | MIT | PyPI metadata + `SYSTRAN/faster-whisper` `LICENSE` |
| Audio IO | stdlib `wave` + `numpy`; `soundfile` optional | BSD-3 | PyPI metadata |

`espeakng-loader` bundles the espeak-ng data, so no separate system install of
espeak-ng is needed on Windows.

**[UNVERIFIED] Kokoro-82M model-weights licence.** `huggingface.co` does not
resolve from this container, so the weight licence on `hexgrad/Kokoro-82M` could
not be read. The package code is Apache-2.0; that is not the same statement.
`tts.model_revision` is empty by default and `gates.check_tts_engine` blocks any
upload while it stays empty, so the first real run forces you to pin a revision
and read the licence at that moment.

No hosted model API is used anywhere, and no project data leaves the machine.

### Rendering

CPU-only by design: Chromium screenshots piped straight into
`ffmpeg -f image2pipe`, encoded with `libx264` + `aac`. Hardware encoders
(`h264_nvenc`, `h264_qsv`, `h264_amf`) are *probed* — listed by ffmpeg **and**
proven with a three-frame trial encode — and any failure, including a failure
part-way through the real encode, falls back to `libx264`. Tested here:
`detect_hwaccel` with unavailable encoders returns `None` cleanly.

## What was actually run and verified in this session

* **90 automated tests pass**, including real Chromium renders, a real FFmpeg
  encode and real ffprobe/blackdetect QC. `pytest -q` from the project root.
  Render and encode tests skip cleanly when Chromium or FFmpeg is absent.
* **A complete 1080x1920 / 30 fps / 50.5 s MP4 was produced end to end**
  (`tools/e2e_prototype.py`, 311 s total): 1,515 frames rendered in ~290 s on
  4 CPU cores (~195 ms/frame), encoded h264 + aac (2.5 MB, 48 kHz stereo).
  **11 of 13 gates passed**; the only two failures were the intended publish
  blocks. ffprobe confirmed 1080x1920, 30.0 fps, 50.5 s, 1,515 frames; the
  file decoded clean end to end; `blackdetect` found nothing; audio measured
  -14.9 dBFS mean / -4.5 dBFS peak; the twelve sampled frames had pixel
  standard deviations of 25-29 (a blank frame reads below 3); and the layout
  sampler reported no overflow or clipping at any sampled time.
* **The two publish gates blocked it**, as designed: `publish.real_generator`
  (stub writer) and `publish.real_tts` (stub voice). Nothing could have been
  uploaded from this run.
* **Hardware-encoder fallback exercised for real**: `h264_nvenc` and `h264_qsv`
  were listed by this FFmpeg build but failed the trial encode, and the run
  fell back to `libx264` without intervention.
* **Avatar**: generated from primitives, 5 poses × 3 mouth frames, and checked
  for uniform cell size, a common baseline and a fixed palette.
* **Render determinism**: the same timeline rendered three times produced
  byte-identical frames. (An earlier version differed on frame 0 roughly one
  run in three — a first-composite race, now fixed with a discarded warm-up
  screenshot.)
* **Overflow detection**: an oversized payload is reported by
  `window.__layoutReport()` and blocks the episode.
* **Blank-frame detection**: a synthetic all-black MP4 is caught by both
  `blackdetect` and the frame-variance check.
* **GitHub discovery**: the live search API returned and ranked 41 candidates.
* **Thin-evidence skip**: run against a real repository with a 118-byte README,
  the pipeline skipped the day instead of generating anything.

## What is blocked, and why

| Stage | Status | Reason |
|---|---|---|
| Kokoro TTS | **not run** | needs Python ≤3.12 (container has 3.13) and `huggingface.co`, which is unreachable here |
| faster-whisper ASR | **not run** | model weights come from `huggingface.co` |
| Ollama writer/critic | **not run** | Ollama is not installed in this container |
| YouTube OAuth, canary upload, scheduling | **not run** | needs the user's Google account on their own machine |
| Windows Task Scheduler job | **not run** | no Windows machine reachable |

Because TTS and ASR could not run, the end-to-end prototype substitutes a tone
generator for the voice and a synthetic stand-in for the transcription. That
proves the *wiring* — timeline, captions, render, encode, QC, gates — and
proves nothing about pronunciation. The pipeline knows this: an episode built
with either stand-in is refused by `gates.check_generator` and
`gates.check_tts_engine` before it can reach an upload.

## YouTube API facts this depends on

Taken from the published discovery document
`https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest`, revision
**20261102**, fetched during implementation. (`developers.google.com` does not
resolve from this container, so the prose documentation and the Help Centre
policy pages could **not** be read — see the caveat below.)

* `status.publishAt` — *"The date and time when the video is scheduled to
  publish. It can be set only if the privacy status of the video is private."*
  Every scheduled upload is therefore inserted as `private` with `publishAt`
  set; `youtube._body` raises rather than send any other combination.
* `status.containsSyntheticMedia` — *"Indicates if the video contains altered or
  synthetic media."* Sent only when `upload.declare_synthetic_media` is true.
  Unlike `privacyStatus`, this property carries no `@mutable` annotation in the
  discovery document, and the value is **read back** after upload;
  `verify_synthetic_flag` reports "unverified" rather than success when the API
  does not echo it.
* `videos.insert` scopes include `.../auth/youtube.upload`; `videos.list` and
  `channels.list` need `.../auth/youtube.readonly`. Those two are the entire
  scope request — nothing broader.
* `status.uploadStatus`, `status.failureReason`, `status.rejectionReason` are
  what the canary poll reads.

**[UNVERIFIED] — current YouTube policy.** Whether this content *requires* an
altered-or-synthetic-media disclosure is a policy question, and
`developers.google.com` and `support.google.com` are both unreachable from this
session. The flag therefore defaults to **off** and is a deliberate decision you
make after reading YouTube's current guidance, not something the pipeline infers
from the presence of an animated avatar. Allow those two hosts in the session's
network settings, or check them on the Windows machine, before deciding.

## Monetisation

This pipeline does not guarantee YouTube monetisation and nothing here should be
read as implying it. YouTube's rules require original work with material added
value, and a channel of templated daily explainers can be rejected as repetitive
or mass-produced regardless of how it was made. The repetition gates
(`script.not_repetitive`, `script.layout_varies`), the 120-day topic cooldown,
the "add original analysis" requirement in the writer prompt and the
copied-passage check exist to reduce that risk. They do not remove it. Verify
the current Partner Programme and "inauthentic content" rules yourself.
