"""FFmpeg: capability probing, hardware-encoder detection, and muxing."""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

log = logging.getLogger(__name__)


class FFmpegError(RuntimeError):
    pass


def _bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise FFmpegError(
            f"{name} not found on PATH. Install FFmpeg (https://ffmpeg.org/download.html) "
            f"or set it up with `winget install Gyan.FFmpeg` on Windows."
        )
    return path


def ffmpeg_version() -> str:
    out = subprocess.run([_bin("ffmpeg"), "-version"], capture_output=True, text=True, check=False)
    return out.stdout.splitlines()[0].strip() if out.stdout else "unknown"


def ffprobe_json(path: Path) -> dict:
    cmd = [
        _bin("ffprobe"), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        raise FFmpegError(f"ffprobe failed on {path}: {out.stderr[:400]}")
    return json.loads(out.stdout)


def available_encoders() -> set[str]:
    out = subprocess.run([_bin("ffmpeg"), "-hide_banner", "-encoders"],
                         capture_output=True, text=True, check=False)
    names: set[str] = set()
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("V"):
            names.add(parts[1])
    return names


def detect_hwaccel(candidates: Iterable[str]) -> str | None:
    """Return the first hardware H.264 encoder that actually encodes here.

    Listing an encoder is not proof it works: the driver may be absent. Each
    candidate therefore has to survive a one-frame trial encode. Any failure
    falls back to libx264, which is the default path.
    """
    listed = available_encoders()
    with tempfile.TemporaryDirectory() as td:
        probe = Path(td) / "probe.mp4"
        for enc in candidates:
            if enc not in listed:
                log.debug("hwaccel %s not listed by ffmpeg", enc)
                continue
            cmd = [
                _bin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1:r=30",
                "-c:v", enc, "-frames:v", "3", str(probe),
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if res.returncode == 0 and probe.exists() and probe.stat().st_size > 0:
                log.info("hardware encoder available: %s", enc)
                return enc
            log.info("hardware encoder %s unusable, falling back: %s", enc, res.stderr.strip()[:160])
            probe.unlink(missing_ok=True)
    return None


@dataclass(slots=True)
class EncodeSettings:
    width: int
    height: int
    fps: int
    crf: int = 20
    video_codec: str = "libx264"
    audio_codec: str = "aac"
    audio_bitrate: str = "192k"
    pix_fmt: str = "yuv420p"
    preset: str = "medium"


def encode(
    frames: Iterator[bytes],
    audio_path: Path,
    out_path: Path,
    settings: EncodeSettings,
    *,
    image_format: str = "png",
) -> Path:
    """Pipe rendered frames + the narration track into one MP4.

    ``-shortest`` is deliberately **not** used: the video track is authoritative
    and the audio must not silently truncate it.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    codec_args = ["-c:v", settings.video_codec]
    if settings.video_codec == "libx264":
        codec_args += ["-preset", settings.preset, "-crf", str(settings.crf), "-profile:v", "high"]
    else:  # hardware encoders do not accept -crf
        codec_args += ["-b:v", "8M", "-maxrate", "12M", "-bufsize", "16M"]

    cmd = [
        _bin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-framerate", str(settings.fps), "-i", "pipe:0",
        "-i", str(audio_path),
        *codec_args,
        "-pix_fmt", settings.pix_fmt,
        "-r", str(settings.fps),
        "-c:a", settings.audio_codec, "-b:a", settings.audio_bitrate, "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        str(out_path),
    ]
    log.info("encoding with %s -> %s", settings.video_codec, out_path.name)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    n = 0
    try:
        for frame in frames:
            proc.stdin.write(frame)
            n += 1
    except BrokenPipeError as exc:
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        raise FFmpegError(f"ffmpeg closed the pipe after {n} frames: {stderr[:500]}") from exc
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
    stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    rc = proc.wait()
    if rc != 0:
        raise FFmpegError(f"ffmpeg exited {rc} after {n} frames: {stderr[:800]}")
    log.info("encoded %d frames -> %s (%.1f MB)", n, out_path.name, out_path.stat().st_size / 1e6)
    return out_path


def decode_fully(path: Path) -> tuple[bool, str]:
    """Decode every packet to prove the file is not truncated or corrupt."""
    cmd = [_bin("ffmpeg"), "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return res.returncode == 0 and not res.stderr.strip(), res.stderr.strip()[:800]
