"""Timeline alignment, caption bounds and structural validation."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from vtuber.align import align, span_for
from vtuber.timeline import build, validate_timeline
from vtuber.models import WordTimestamp


def _meta() -> dict:
    root = Path(__file__).resolve().parents[1]
    return json.loads((root / "assets" / "avatar" / "avatar.json").read_text())


def test_alignment_is_exact_when_transcript_matches(stub_episode):
    from vtuber.verify_audio import normalize

    mapping = align(stub_episode.script.narration, stub_episode.word_timestamps)
    assert len(mapping) == len(normalize(stub_episode.script.narration))
    assert all(m is not None for m in mapping)


def test_alignment_survives_a_dropped_word(stub_episode):
    words = [w for i, w in enumerate(stub_episode.word_timestamps) if i != 5]
    mapping = align(stub_episode.script.narration, words)
    matched = [m for m in mapping if m is not None]
    assert len(matched) >= len(mapping) - 3
    assert matched == sorted(matched)


def test_span_for_returns_first_and_last():
    assert span_for([None, 3, 4, None, 9], 0, 5) == (3, 9)
    assert span_for([None, None], 0, 2) == (None, None)


def test_timeline_scenes_tile_the_duration(stub_episode):
    tl = build(stub_episode, avatar_sheet="avatar.png", avatar_meta=_meta(),
               audio_duration_s=stub_episode.audio_duration_s)
    assert validate_timeline(tl) == []
    assert tl["scenes"][0]["start"] == 0.0
    assert tl["scenes"][-1]["end"] == tl["duration"]


def test_every_caption_sits_inside_its_scene(stub_episode):
    tl = build(stub_episode, avatar_sheet="avatar.png", avatar_meta=_meta(),
               audio_duration_s=stub_episode.audio_duration_s)
    for scene in tl["scenes"]:
        for cap in scene["captions"]:
            assert scene["start"] - 1e-6 <= cap["start"] <= scene["end"] + 1e-6
            assert cap["words"]


def test_validate_catches_a_gap(stub_episode):
    tl = build(stub_episode, avatar_sheet="avatar.png", avatar_meta=_meta(),
               audio_duration_s=stub_episode.audio_duration_s)
    tl["scenes"][1]["start"] += 0.5
    assert any("gap/overlap" in p for p in validate_timeline(tl))


def test_missing_word_timestamps_rejected(stub_episode):
    stub_episode.word_timestamps = []
    with pytest.raises(Exception):
        build(stub_episode, avatar_sheet="avatar.png", avatar_meta=_meta(), audio_duration_s=10)
