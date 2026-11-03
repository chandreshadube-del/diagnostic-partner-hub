"""Local speech recognition, used as the proof of what was actually spoken.

Alignment metadata emitted by a TTS engine is not evidence: it describes what
the engine intended. Only an independent transcription of the rendered audio
can establish that.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Protocol

from .config import ASRConfig
from .models import WordTimestamp

log = logging.getLogger(__name__)


class ASRError(RuntimeError):
    pass


class ASREngine(Protocol):
    name: str

    def transcribe(self, audio_path: Path) -> tuple[str, list[WordTimestamp]]: ...


class FasterWhisperASR:
    """faster-whisper (MIT, SYSTRAN) with word-level timestamps, CPU by default."""

    def __init__(self, cfg: ASRConfig) -> None:
        self.cfg = cfg
        self.name = f"faster-whisper:{cfg.model}/{cfg.device}/{cfg.compute_type}"
        self._model = None

    def _load(self):  # noqa: ANN202
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover
            raise ASRError("faster-whisper is not installed") from exc
        try:
            self._model = WhisperModel(
                self.cfg.model, device=self.cfg.device, compute_type=self.cfg.compute_type
            )
        except Exception as exc:  # pragma: no cover
            raise ASRError(f"could not load faster-whisper model: {exc}") from exc
        return self._model

    def transcribe(self, audio_path: Path) -> tuple[str, list[WordTimestamp]]:
        model = self._load()
        try:
            segments, _info = model.transcribe(
                str(audio_path),
                language="en",
                beam_size=self.cfg.beam_size,
                word_timestamps=True,
                vad_filter=False,
            )
        except Exception as exc:  # pragma: no cover
            raise ASRError(f"transcription failed: {exc}") from exc
        words: list[WordTimestamp] = []
        parts: list[str] = []
        for seg in segments:
            parts.append(seg.text)
            for w in getattr(seg, "words", None) or []:
                text = (w.word or "").strip()
                if not text:
                    continue
                words.append(
                    WordTimestamp(
                        word=text,
                        start=max(float(w.start or 0.0), 0.0),
                        end=max(float(w.end or 0.0), 0.0),
                        probability=float(w.probability) if w.probability is not None else None,
                    )
                )
        transcript = " ".join(p.strip() for p in parts).strip()
        if not words:
            raise ASRError("ASR produced no word timestamps")
        return transcript, words


class FixtureASR:
    """Replays a stored transcription. Test-only; never reaches upload."""

    def __init__(self, fixture_path: Path) -> None:
        self.path = Path(fixture_path)
        self.name = f"fixture:{self.path.name}"

    def transcribe(self, audio_path: Path) -> tuple[str, list[WordTimestamp]]:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        words = [WordTimestamp.model_validate(w) for w in data["word_timestamps"]]
        return data["transcript"], words


class SyntheticASR:
    """Returns the intended text with timings spread over the real audio length.

    This is a WIRING stand-in, not a transcription: it cannot detect a
    mispronunciation, so an episode produced with it is barred from upload by
    ``gates.check_tts_engine`` (it is only ever paired with the stub voice).
    It exists so the timeline, renderer, encoder and QC gates can be exercised
    on machines without model weights.
    """

    def __init__(self, intended_text: str) -> None:
        self.text = intended_text
        self.name = "synthetic:wiring-only"

    def transcribe(self, audio_path: Path) -> tuple[str, list[WordTimestamp]]:
        from .audio_io import duration_s

        total = duration_s(audio_path)
        words = self.text.split()
        if not words:
            raise ASRError("nothing to transcribe")
        weights = [len(w) + 2 for w in words]
        scale = total / sum(weights)
        out: list[WordTimestamp] = []
        t = 0.0
        for w, weight in zip(words, weights):
            span = weight * scale
            out.append(WordTimestamp(word=w, start=round(t, 3), end=round(t + span * 0.85, 3)))
            t += span
        return self.text, out


def build(cfg: ASRConfig, fixture: Path | None = None) -> ASREngine:
    if fixture is not None:
        return FixtureASR(fixture)
    return FasterWhisperASR(cfg)
