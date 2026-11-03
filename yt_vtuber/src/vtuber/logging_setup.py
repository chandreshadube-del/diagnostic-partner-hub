"""One rotating log per day plus a per-episode log file."""
from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

_FMT = "%(asctime)s %(levelname)-7s %(name)-22s %(message)s"
_configured = False


def setup(logs_dir: Path, level: int = logging.INFO) -> None:
    global _configured
    if _configured:
        return
    logs_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(level)
    stream = logging.StreamHandler()
    stream.setFormatter(logging.Formatter(_FMT))
    rotating = logging.handlers.TimedRotatingFileHandler(
        logs_dir / "pipeline.log", when="midnight", backupCount=30, encoding="utf-8"
    )
    rotating.setFormatter(logging.Formatter(_FMT))
    root.handlers = [stream, rotating]
    _configured = True


def episode_handler(logs_dir: Path, episode_id: str) -> logging.Handler:
    logs_dir.mkdir(parents=True, exist_ok=True)
    h = logging.FileHandler(logs_dir / f"{episode_id}.log", encoding="utf-8")
    h.setFormatter(logging.Formatter(_FMT))
    logging.getLogger().addHandler(h)
    return h
