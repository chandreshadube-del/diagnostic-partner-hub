"""Episode manifest persistence and the state machine around it.

The manifest is the single source of truth for a run. Every stage writes it
atomically so a crashed or killed run can be resumed without redoing finished
work, and a ``failed`` episode can never be advanced.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from datetime import date, datetime
from pathlib import Path

from .models import TRANSITIONS, Episode, State, utcnow

log = logging.getLogger(__name__)

MANIFEST_NAME = "manifest.json"


class StateError(RuntimeError):
    """An illegal transition was attempted."""


def episode_id_for(repo_full_name: str, day: date | None = None) -> str:
    """Stable per-day, per-repo id. Re-running the same day is idempotent."""
    day = day or utcnow().date()
    digest = hashlib.sha256(f"{day.isoformat()}:{repo_full_name}".encode()).hexdigest()[:8]
    return f"{day.isoformat()}-{digest}"


class EpisodeStore:
    def __init__(self, episodes_dir: Path) -> None:
        self.root = Path(episodes_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def dir_for(self, episode_id: str) -> Path:
        d = self.root / episode_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def path_for(self, episode_id: str) -> Path:
        return self.root / episode_id / MANIFEST_NAME

    def exists(self, episode_id: str) -> bool:
        return self.path_for(episode_id).is_file()

    def load(self, episode_id: str) -> Episode:
        return Episode.model_validate_json(self.path_for(episode_id).read_text(encoding="utf-8"))

    def try_load(self, episode_id: str) -> Episode | None:
        try:
            return self.load(episode_id)
        except FileNotFoundError:
            return None

    def save(self, ep: Episode) -> Path:
        path = self.path_for(ep.episode_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = ep.model_dump_json(indent=2)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return path

    def recent(self, limit: int = 30) -> list[Episode]:
        out: list[Episode] = []
        for d in sorted(self.root.iterdir(), reverse=True):
            if not (d / MANIFEST_NAME).is_file():
                continue
            try:
                out.append(self.load(d.name))
            except Exception as exc:  # a corrupt manifest must not kill a run
                log.warning("skipping unreadable manifest %s: %s", d.name, exc)
            if len(out) >= limit:
                break
        return out

    # -- transitions ------------------------------------------------------- #

    def advance(self, ep: Episode, to: State) -> Episode:
        if ep.state is State.FAILED:
            raise StateError(f"{ep.episode_id} is failed ({ep.failure_reason}); cannot advance")
        if to is ep.state:
            return ep
        if to not in TRANSITIONS[ep.state]:
            raise StateError(f"illegal transition {ep.state} -> {to}")
        ep.state = to
        self.save(ep)
        log.info("%s -> %s", ep.episode_id, to.value)
        return ep

    def fail(self, ep: Episode, reason: str) -> Episode:
        ep.state = State.FAILED
        ep.failure_reason = reason[:2000]
        self.save(ep)
        log.error("%s FAILED: %s", ep.episode_id, reason)
        return ep

    def write_artifact(self, ep: Episode, name: str, data: str | bytes) -> Path:
        path = self.dir_for(ep.episode_id) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, bytes):
            path.write_bytes(data)
        else:
            path.write_text(data, encoding="utf-8")
        return path

    def dump_failure_inputs(self, ep: Episode, label: str, payload: object) -> Path:
        """Keep the exact inputs that produced a failure, for later inspection."""
        name = f"failure-{label}-{utcnow().strftime('%H%M%S')}.json"
        body = json.dumps(payload, indent=2, default=_json_default)
        return self.write_artifact(ep, name, body)


def _json_default(obj: object) -> str:
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    return repr(obj)
