"""WAV writing/reading and the subtle, optional enhancement step.

Deliberately stdlib + numpy only: nothing here needs a codec library, and the
test suite must be able to produce and inspect audio without model weights.
"""
from __future__ import annotations

import logging
import wave
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> Path:
    """Write mono 16-bit PCM. ``samples`` is float32/float64 in [-1, 1]."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.asarray(samples, dtype=np.float64).reshape(-1)
    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return path


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        if wf.getsampwidth() != 2:
            raise ValueError(f"{path}: expected 16-bit PCM, got {wf.getsampwidth() * 8}-bit")
        rate = wf.getframerate()
        channels = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def duration_s(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def _highpass(x: np.ndarray, sample_rate: int, cutoff_hz: float = 70.0) -> np.ndarray:
    """One-pole high-pass. Removes rumble without colouring speech."""
    rc = 1.0 / (2 * np.pi * cutoff_hz)
    dt = 1.0 / sample_rate
    a = rc / (rc + dt)
    y = np.empty_like(x)
    prev_x = x[0] if len(x) else 0.0
    prev_y = 0.0
    for i, xi in enumerate(x):
        prev_y = a * (prev_y + xi - prev_x)
        prev_x = xi
        y[i] = prev_y
    return y


def _highpass_fast(x: np.ndarray, sample_rate: int, cutoff_hz: float = 70.0) -> np.ndarray:
    """Vectorised equivalent via FFT; the loop above is kept as the reference."""
    n = len(x)
    if n == 0:
        return x
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    # smooth first-order roll-off rather than a brick wall
    gain = freqs / np.sqrt(freqs**2 + cutoff_hz**2)
    gain[0] = 0.0
    return np.fft.irfft(spec * gain, n=n)


def enhance(
    samples: np.ndarray, sample_rate: int, *, target_peak_dbfs: float = -1.5
) -> np.ndarray:
    """Subtle only: gentle high-pass then peak normalisation.

    No noise bed, no compression, no reverb. Anything stronger is a listening
    decision, not something to apply blind — see ``docs`` in the README.
    """
    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    if x.size == 0:
        return x
    x = _highpass_fast(x, sample_rate)
    peak = float(np.max(np.abs(x)))
    if peak <= 1e-9:
        return x
    target = 10.0 ** (target_peak_dbfs / 20.0)
    return x * (target / peak)


def trailing_silence_s(samples: np.ndarray, sample_rate: int, floor: float = 2e-3) -> float:
    x = np.abs(np.asarray(samples, dtype=np.float64).reshape(-1))
    above = np.flatnonzero(x > floor)
    if above.size == 0:
        return len(x) / sample_rate
    return (len(x) - int(above[-1]) - 1) / sample_rate
