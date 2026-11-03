"""Local text-to-speech.

``kokoro`` (Apache-2.0, https://github.com/hexgrad/kokoro) drives the real
voice. A deterministic tone engine stands in for it in tests; episodes
synthesised with it are blocked from upload by ``gates.check_tts_engine``.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Protocol

import numpy as np

from .audio_io import enhance, write_wav
from .config import TTSConfig

log = logging.getLogger(__name__)


class TTSError(RuntimeError):
    pass


class TTSEngine(Protocol):
    name: str
    sample_rate: int

    def synthesize(self, text: str) -> np.ndarray: ...


class KokoroEngine:
    """Kokoro-82M via the ``kokoro`` package, pinned to one model revision."""

    def __init__(self, cfg: TTSConfig) -> None:
        self.cfg = cfg
        self.sample_rate = cfg.sample_rate
        self.name = f"kokoro:{cfg.voice}@{cfg.model_revision or 'UNPINNED'}"
        self._pipeline = None

    def _load(self):  # noqa: ANN202
        if self._pipeline is not None:
            return self._pipeline
        try:
            from kokoro import KPipeline
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise TTSError(
                "kokoro is not installed. It requires Python 3.10-3.12 "
                "(`pip install -r requirements.txt` inside a 3.12 venv)."
            ) from exc
        kwargs: dict = {"lang_code": "a"}  # 'a' = American English
        if self.cfg.model_revision:
            kwargs["repo_id"] = self.cfg.model_repo
        try:
            self._pipeline = KPipeline(**kwargs)
        except Exception as exc:  # pragma: no cover
            raise TTSError(f"could not initialise Kokoro: {exc}") from exc
        return self._pipeline

    def synthesize(self, text: str) -> np.ndarray:
        pipeline = self._load()
        chunks: list[np.ndarray] = []
        try:
            for _, _, audio in pipeline(text, voice=self.cfg.voice, speed=self.cfg.speed):
                arr = np.asarray(audio, dtype=np.float32).reshape(-1)
                if arr.size:
                    chunks.append(arr)
        except Exception as exc:  # pragma: no cover
            raise TTSError(f"Kokoro synthesis failed: {exc}") from exc
        if not chunks:
            raise TTSError("Kokoro returned no audio")
        return np.concatenate(chunks)


class StubToneEngine:
    """Formant-free tone burst per word. Audible as speech-shaped nonsense.

    Its only purpose is to give the renderer and the muxer a real audio file of
    the right length in environments with no model weights. It never ships.
    """

    def __init__(self, cfg: TTSConfig, words_per_minute: float = 155.0) -> None:
        self.cfg = cfg
        self.sample_rate = cfg.sample_rate
        self.name = "stub:tone"
        self.wpm = words_per_minute

    def synthesize(self, text: str) -> np.ndarray:
        words = [w for w in re.split(r"\s+", text.strip()) if w]
        per_word = 60.0 / self.wpm
        out: list[np.ndarray] = []
        rng = np.random.default_rng(1234)
        for i, w in enumerate(words):
            dur = per_word * (0.6 + 0.08 * min(len(w), 10))
            n = max(int(dur * self.sample_rate), 1)
            t = np.arange(n) / self.sample_rate
            f0 = 110.0 + 40.0 * ((i * 7) % 5) / 4.0
            env = np.sin(np.pi * np.linspace(0, 1, n)) ** 0.6
            tone = 0.35 * env * (
                np.sin(2 * np.pi * f0 * t)
                + 0.4 * np.sin(2 * np.pi * 2 * f0 * t)
                + 0.15 * rng.standard_normal(n)
            )
            out.append(tone.astype(np.float32))
            gap = 0.05 if not w.endswith((".", "!", "?")) else 0.22
            out.append(np.zeros(int(gap * self.sample_rate), dtype=np.float32))
        if not out:
            raise TTSError("nothing to synthesise")
        return np.concatenate(out)


def build(cfg: TTSConfig) -> TTSEngine:
    if cfg.engine == "stub":
        return StubToneEngine(cfg)
    return KokoroEngine(cfg)


def synthesize_to_file(engine: TTSEngine, text: str, path: Path, cfg: TTSConfig) -> Path:
    samples = engine.synthesize(text)
    if cfg.enhance:
        samples = enhance(samples, engine.sample_rate, target_peak_dbfs=cfg.target_peak_dbfs)
    write_wav(path, samples, engine.sample_rate)
    log.info("wrote %s (%.2fs, %s)", path.name, len(samples) / engine.sample_rate, engine.name)
    return path
