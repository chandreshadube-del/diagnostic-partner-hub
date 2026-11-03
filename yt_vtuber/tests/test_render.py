"""Rendering, encoding and QC on the real toolchain (CPU only)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from vtuber import encoder, qc, render
from vtuber.audio_io import write_wav
from vtuber.models import Script
from vtuber.timeline import build

ROOT = Path(__file__).resolve().parents[1]
AVATAR = ROOT / "assets" / "avatar"
TEMPLATES = ROOT / "templates"

requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _chromium_available() -> bool:
    import os

    explicit = os.environ.get("VTUBER_CHROMIUM")
    if explicit:
        return Path(explicit).exists()
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            return Path(pw.chromium.executable_path).exists()
    except Exception:  # noqa: BLE001
        return False


requires_chromium = pytest.mark.skipif(
    not _chromium_available(),
    reason="no Chromium: run `playwright install chromium` or set VTUBER_CHROMIUM",
)


def _meta() -> dict:
    return json.loads((AVATAR / "avatar.json").read_text())


def _timeline(stub_episode) -> dict:
    return build(stub_episode, avatar_sheet="avatar.png", avatar_meta=_meta(),
                 audio_duration_s=stub_episode.audio_duration_s)


def _chromium(cfg) -> str | None:
    return cfg.render.chromium_executable or None


def test_missing_sprite_blocks_rendering(stub_episode, tmp_path):
    empty = tmp_path / "no-avatar"
    empty.mkdir()
    with pytest.raises(render.RenderError, match="avatar sprite sheet missing"):
        render.stage(TEMPLATES, empty, _timeline(stub_episode), tmp_path / "out")


def test_stage_is_self_contained(stub_episode, tmp_path):
    out = render.stage(TEMPLATES, AVATAR, _timeline(stub_episode), tmp_path / "render")
    for name in ("index.html", "app.js", "app.css", "avatar.png", "timeline.json"):
        assert (out / name).is_file(), name
    assert (out / "scenes" / "terminal_demo.js").is_file()
    assert json.loads((out / "timeline.json").read_text())["avatar"]["sheet"] == "avatar.png"


def test_avatar_frames_are_normalised():
    meta = _meta()
    cells = {tuple(v[2:]) for by in meta["frames"].values() for v in by.values()}
    assert len(cells) == 1, cells
    assert set(meta["poses"]) == {"idle", "talk", "point", "think", "nod"}
    assert set(meta["mouths"]) == {"closed", "mid", "open"}


@requires_chromium
def test_cpu_render_produces_frames(stub_episode, cfg, tmp_path):
    tl = _timeline(stub_episode)
    tl["duration"] = 1.0
    tl["scenes"] = tl["scenes"][:1]
    tl["scenes"][0]["start"] = 0.0
    tl["scenes"][0]["end"] = 1.0
    out = render.stage(TEMPLATES, AVATAR, tl, tmp_path / "render")
    result = render.RenderResult(frame_count=0, chromium_version="")
    frames = list(render.frames(out, duration_s=1.0, fps=30, executable_path=_chromium(cfg),
                               result=result, progress_every=0))
    assert len(frames) == 30
    assert all(f.startswith(b"\x89PNG") for f in frames)
    assert result.layout_problems == []
    assert result.blank_frames == []
    assert result.chromium_version


@requires_chromium
def test_render_is_deterministic(stub_episode, cfg, tmp_path):
    """The same t must produce byte-identical pixels across two runs."""
    tl = _timeline(stub_episode)
    tl["duration"] = 0.4
    tl["scenes"] = tl["scenes"][:1]
    tl["scenes"][0]["start"], tl["scenes"][0]["end"] = 0.0, 0.4
    out = render.stage(TEMPLATES, AVATAR, tl, tmp_path / "render")
    runs = [
        list(render.frames(out, duration_s=0.4, fps=10, executable_path=_chromium(cfg),
                           progress_every=0))
        for _ in range(3)
    ]
    assert runs[0] == runs[1] == runs[2]


@requires_chromium
def test_overflowing_text_is_reported(stub_episode, cfg, tmp_path):
    tl = _timeline(stub_episode)
    tl["duration"] = 0.2
    tl["scenes"] = tl["scenes"][:1]
    tl["scenes"][0]["start"], tl["scenes"][0]["end"] = 0.0, 0.2
    tl["scenes"][0]["template"] = "repo_overview"
    tl["scenes"][0]["payload"] = {
        "kind": "repo_overview",
        "repo": "overflowing " * 12,
        "tagline": "a very long tagline " * 20,
        "language": "Python", "license": "Apache-2.0",
        "bullets": ["a very long bullet that will not fit in the card " * 4] * 4,
    }
    out = render.stage(TEMPLATES, AVATAR, tl, tmp_path / "render")
    result = render.RenderResult(frame_count=0, chromium_version="")
    list(render.frames(out, duration_s=0.2, fps=10, executable_path=_chromium(cfg),
                       result=result, sample_layout_every=1, progress_every=0))
    assert result.layout_problems, "overflow should have been reported"


@requires_chromium
def test_unknown_template_fails_the_page(stub_episode, cfg, tmp_path):
    tl = _timeline(stub_episode)
    tl["duration"] = 0.2
    tl["scenes"] = tl["scenes"][:1]
    tl["scenes"][0]["start"], tl["scenes"][0]["end"] = 0.0, 0.2
    tl["scenes"][0]["template"] = "not_a_template"
    out = render.stage(TEMPLATES, AVATAR, tl, tmp_path / "render")
    with pytest.raises(Exception):
        list(render.frames(out, duration_s=0.2, fps=10, executable_path=_chromium(cfg),
                           progress_every=0))


@requires_ffmpeg
def test_hwaccel_detection_falls_back_cleanly():
    assert encoder.detect_hwaccel(["h264_does_not_exist", "h264_nonsense"]) is None


@requires_ffmpeg
@requires_chromium
def test_cpu_encode_and_qc(stub_episode, cfg, tmp_path):
    import numpy as np

    tl = _timeline(stub_episode)
    tl["duration"] = 1.0
    tl["scenes"] = tl["scenes"][:1]
    tl["scenes"][0]["start"], tl["scenes"][0]["end"] = 0.0, 1.0
    out = render.stage(TEMPLATES, AVATAR, tl, tmp_path / "render")

    wav = tmp_path / "a.wav"
    t = np.arange(int(24000 * 1.0)) / 24000
    write_wav(wav, 0.3 * np.sin(2 * np.pi * 220 * t), 24000)

    result = render.RenderResult(frame_count=0, chromium_version="")
    frames = render.frames(out, duration_s=1.0, fps=30, executable_path=_chromium(cfg),
                           result=result, progress_every=0)
    mp4 = tmp_path / "out.mp4"
    encoder.encode(frames, wav, mp4,
                   encoder.EncodeSettings(width=1080, height=1920, fps=30, preset="ultrafast"))

    res = qc.run(mp4, samples=4)
    assert (res.probe.width, res.probe.height) == (1080, 1920)
    assert abs(res.probe.fps - 30) < 0.01
    assert res.probe.video_codec == "h264"
    assert res.probe.audio_codec == "aac"
    assert res.decodes, res.decode_error
    assert res.black == []
    assert res.mean_dbfs is not None and res.mean_dbfs > -50
    assert min(res.frame_stddevs) > 3.0


@requires_ffmpeg
def test_qc_rejects_a_truncated_file(tmp_path):
    import numpy as np

    wav = tmp_path / "a.wav"
    write_wav(wav, np.zeros(2400), 24000)
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"\x00" * 4096)
    with pytest.raises(Exception):
        qc.probe(broken)


@requires_ffmpeg
def test_qc_detects_a_blank_video(tmp_path):
    import subprocess

    black = tmp_path / "black.mp4"
    subprocess.run(
        [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=2:r=30",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", str(black)],
        check=True, capture_output=True,
    )
    res = qc.run(black, samples=3)
    assert res.black, "blackdetect should have found the blank video"
    assert max(res.frame_stddevs) < 3.0
    assert res.mean_dbfs is None or res.mean_dbfs < -50
