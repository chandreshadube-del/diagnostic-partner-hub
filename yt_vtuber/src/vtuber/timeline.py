"""Build the JSON timeline that drives the HTML stage."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from .align import align, span_for
from .models import Episode, Script, WordTimestamp
from .verify_audio import normalize

log = logging.getLogger(__name__)

MAX_CAPTION_WORDS = 6
MAX_CAPTION_CHARS = 42
#: Held at the end so the last word is readable and the audio does not clip.
TAIL_PAD_S = 0.45


class TimelineError(RuntimeError):
    pass


@dataclass(slots=True)
class SceneSpan:
    index: int
    start: float
    end: float


def _caption_chunks(words: list[dict]) -> list[dict]:
    lines: list[dict] = []
    cur: list[dict] = []
    chars = 0
    for w in words:
        wlen = len(w["word"]) + 1
        if cur and (len(cur) >= MAX_CAPTION_WORDS or chars + wlen > MAX_CAPTION_CHARS):
            lines.append({"start": cur[0]["start"], "end": cur[-1]["end"], "words": cur})
            cur, chars = [], 0
        cur.append(w)
        chars += wlen
    if cur:
        lines.append({"start": cur[0]["start"], "end": cur[-1]["end"], "words": cur})
    # Stretch each line to meet the next so no frame falls between captions.
    for i in range(len(lines) - 1):
        lines[i]["end"] = lines[i + 1]["start"]
    return lines


def build(
    episode: Episode,
    *,
    avatar_sheet: str,
    avatar_meta: dict,
    audio_duration_s: float,
    source_strip: str = "",
) -> dict:
    script: Script | None = episode.script
    if script is None:
        raise TimelineError("episode has no script")
    if not episode.word_timestamps:
        raise TimelineError("episode has no word timestamps")

    words = episode.word_timestamps
    mapping = align(script.narration, words)

    # cumulative normalised word counts per scene
    bounds: list[tuple[int, int]] = []
    cursor = 0
    for scene in script.scenes:
        n = len(normalize(scene.narration))
        bounds.append((cursor, cursor + n))
        cursor += n
    if cursor != len(mapping):
        raise TimelineError(f"alignment length mismatch: {cursor} vs {len(mapping)}")

    spans: list[SceneSpan] = []
    prev_end = 0.0
    for i, (lo, hi) in enumerate(bounds):
        first, last = span_for(mapping, lo, hi)
        start = words[first].start if first is not None else prev_end
        end = words[last].end if last is not None else start
        start = max(start, prev_end)
        end = max(end, start + 0.4)
        spans.append(SceneSpan(index=i, start=round(start, 3), end=round(end, 3)))
        prev_end = end

    # Close the gaps: each scene runs until the next one starts; the last one
    # runs to the end of the audio plus a short hold.
    duration = round(max(audio_duration_s, spans[-1].end) + TAIL_PAD_S, 3)
    for i in range(len(spans) - 1):
        spans[i].end = spans[i + 1].start
    spans[0].start = 0.0
    spans[-1].end = duration

    scenes_json = []
    for scene, span in zip(script.scenes, spans):
        lo, hi = bounds[scene.index]
        scene_words: list[dict] = []
        for k in range(lo, hi):
            idx = mapping[k]
            if idx is None:
                continue
            w: WordTimestamp = words[idx]
            scene_words.append(
                {"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)}
            )
        if not scene_words:
            raise TimelineError(f"scene {scene.index} has no aligned words")
        captions = _caption_chunks(scene_words)
        captions[-1]["end"] = max(captions[-1]["end"], span.end)
        scenes_json.append(
            {
                "index": scene.index,
                "role": scene.role,
                "template": scene.template,
                "avatar_pose": scene.avatar_pose,
                "start": span.start,
                "end": span.end,
                "payload": scene.payload.model_dump(),
                "captions": captions,
                "fact_ids": scene.fact_ids,
            }
        )

    return {
        "version": 1,
        "episode_id": episode.episode_id,
        "duration": duration,
        "fps": episode.render_settings.fps if episode.render_settings else 30,
        "width": episode.render_settings.width if episode.render_settings else 1080,
        "height": episode.render_settings.height if episode.render_settings else 1920,
        "eyebrow": "AI & DEV TOOLS",
        "daystamp": episode.created_at.date().isoformat(),
        "source_strip": source_strip or " · ".join(str(r.url) for r in episode.source_refs[:2]),
        "avatar": {"sheet": avatar_sheet, "meta": avatar_meta},
        "scenes": scenes_json,
        "words": [
            {"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)}
            for w in words
        ],
    }


def validate_timeline(tl: dict) -> list[str]:
    """Structural checks the renderer relies on."""
    problems: list[str] = []
    scenes = tl.get("scenes") or []
    if not scenes:
        return ["timeline has no scenes"]
    if abs(scenes[0]["start"]) > 1e-6:
        problems.append("first scene does not start at 0")
    for a, b in zip(scenes, scenes[1:]):
        if abs(a["end"] - b["start"]) > 1e-6:
            problems.append(f"gap/overlap between scene {a['index']} and {b['index']}")
    if abs(scenes[-1]["end"] - tl["duration"]) > 1e-6:
        problems.append("last scene does not reach the declared duration")
    for s in scenes:
        if s["end"] <= s["start"]:
            problems.append(f"scene {s['index']} has non-positive duration")
        for c in s["captions"]:
            if c["start"] < s["start"] - 1e-6 or c["start"] > s["end"] + 1e-6:
                problems.append(f"caption outside scene {s['index']} bounds")
            if not c["words"]:
                problems.append(f"empty caption in scene {s['index']}")
    return problems


def write(tl: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(tl, indent=1), encoding="utf-8")
    return path
