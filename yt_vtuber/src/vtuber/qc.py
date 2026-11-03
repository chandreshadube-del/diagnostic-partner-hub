"""Quality control on the rendered MP4 itself.

Everything here inspects the finished file rather than trusting the settings
that produced it: the renderer can believe it wrote 30 fps and be wrong.
"""
from __future__ import annotations

import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

from .encoder import FFmpegError, decode_fully, ffprobe_json

log = logging.getLogger(__name__)


@dataclass(slots=True)
class VideoProbe:
    width: int
    height: int
    fps: float
    duration_s: float
    video_codec: str
    audio_codec: str | None
    audio_channels: int | None
    audio_sample_rate: int | None
    nb_frames: int | None
    size_bytes: int
    raw: dict = field(default_factory=dict)


def probe(path: Path) -> VideoProbe:
    data = ffprobe_json(path)
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        raise FFmpegError(f"{path}: no video stream")
    rate = v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1"
    try:
        fps = float(Fraction(rate)) if rate != "0/0" else 0.0
    except ZeroDivisionError:
        fps = 0.0
    fmt = data.get("format", {})
    nb = v.get("nb_frames")
    return VideoProbe(
        width=int(v.get("width") or 0),
        height=int(v.get("height") or 0),
        fps=round(fps, 4),
        duration_s=float(fmt.get("duration") or v.get("duration") or 0.0),
        video_codec=v.get("codec_name", "?"),
        audio_codec=a.get("codec_name") if a else None,
        audio_channels=int(a["channels"]) if a and a.get("channels") else None,
        audio_sample_rate=int(a["sample_rate"]) if a and a.get("sample_rate") else None,
        nb_frames=int(nb) if nb and str(nb).isdigit() else None,
        size_bytes=path.stat().st_size,
        raw=data,
    )


_BLACK_RE = re.compile(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)")


def black_intervals(path: Path, min_duration_s: float = 0.25) -> list[tuple[float, float]]:
    """Intervals the decoder considers black — a blank-frame detector."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FFmpegError("ffmpeg not found on PATH")
    cmd = [
        ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
        "-vf", f"blackdetect=d={min_duration_s}:pix_th=0.10", "-an", "-f", "null", "-",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return [(float(m.group(1)), float(m.group(2))) for m in _BLACK_RE.finditer(res.stderr)]


_MEAN_RE = re.compile(r"mean_volume:\s*(-?[\d.]+) dB")
_MAX_RE = re.compile(r"max_volume:\s*(-?[\d.]+) dB")


def audio_levels(path: Path) -> tuple[float | None, float | None]:
    """(mean_volume_dB, max_volume_dB). ``None`` when there is no audio."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FFmpegError("ffmpeg not found on PATH")
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect",
           "-vn", "-f", "null", "-"]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    mean = _MEAN_RE.search(res.stderr)
    peak = _MAX_RE.search(res.stderr)
    return (float(mean.group(1)) if mean else None, float(peak.group(1)) if peak else None)


def frame_variation(path: Path, samples: int = 12) -> list[float]:
    """Per-sampled-frame pixel standard deviation.

    A frame that is one flat colour has a standard deviation near zero. This
    catches a stage that rendered but painted nothing, which ``blackdetect``
    misses when the background is a light colour.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover
        log.warning("Pillow unavailable; skipping frame variation check")
        return []
    import io
    import tempfile

    p = probe(path)
    if p.duration_s <= 0:
        return []
    ffmpeg = shutil.which("ffmpeg")
    out: list[float] = []
    with tempfile.TemporaryDirectory() as td:
        for i in range(samples):
            t = p.duration_s * (i + 0.5) / samples
            dest = Path(td) / f"f{i}.png"
            cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}",
                   "-i", str(path), "-frames:v", "1", "-vf", "scale=216:384", str(dest)]
            if subprocess.run(cmd, capture_output=True, check=False).returncode != 0:
                continue
            if not dest.exists():
                continue
            with Image.open(dest) as im:
                g = im.convert("L")
                hist = g.histogram()
                n = sum(hist)
                if not n:
                    continue
                mean = sum(i2 * c for i2, c in enumerate(hist)) / n
                var = sum(c * (i2 - mean) ** 2 for i2, c in enumerate(hist)) / n
                out.append(round(var**0.5, 3))
    return out


@dataclass(slots=True)
class QCResult:
    probe: VideoProbe
    decodes: bool
    decode_error: str
    black: list[tuple[float, float]]
    mean_dbfs: float | None
    peak_dbfs: float | None
    frame_stddevs: list[float]


def run(path: Path, *, samples: int = 12) -> QCResult:
    p = probe(path)
    ok, err = decode_fully(path)
    mean, peak = audio_levels(path)
    return QCResult(
        probe=p,
        decodes=ok,
        decode_error=err,
        black=black_intervals(path),
        mean_dbfs=mean,
        peak_dbfs=peak,
        frame_stddevs=frame_variation(path, samples=samples),
    )
