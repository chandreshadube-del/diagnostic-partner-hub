"""Durable ledgers: which repos were used, and which uploads exist.

The upload ledger is what makes a retry safe. An episode is written to the
ledger *before* the upload call and reconciled after, so an ambiguous response
(timeout, reset connection) leaves a claim behind that the next run must
resolve against YouTube rather than uploading a second copy.
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS topics (
    repo_full_name TEXT PRIMARY KEY,
    last_used_at   TEXT NOT NULL,
    episode_id     TEXT NOT NULL,
    times_used     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS uploads (
    episode_id   TEXT PRIMARY KEY,
    claimed_at   TEXT NOT NULL,
    video_id     TEXT,
    is_canary    INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL,          -- claimed | uploaded | confirmed | abandoned
    publish_at   TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    note         TEXT
);
CREATE TABLE IF NOT EXISTS scripts (
    episode_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    narration  TEXT NOT NULL,
    layout_sig TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Ledger:
    def __init__(self, db_path: Path) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._conn()) as c:
            c.executescript(SCHEMA)
            c.commit()

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=30)
        c.execute("PRAGMA journal_mode=WAL")
        return c

    # -- topics ------------------------------------------------------------ #

    def recently_used(self, cooldown_days: int) -> set[str]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=cooldown_days)).isoformat()
        with closing(self._conn()) as c:
            rows = c.execute(
                "SELECT repo_full_name FROM topics WHERE last_used_at >= ?", (cutoff,)
            ).fetchall()
        return {r[0] for r in rows}

    def record_topic(self, repo_full_name: str, episode_id: str) -> None:
        with closing(self._conn()) as c:
            c.execute(
                """INSERT INTO topics(repo_full_name, last_used_at, episode_id)
                   VALUES(?,?,?)
                   ON CONFLICT(repo_full_name) DO UPDATE SET
                     last_used_at=excluded.last_used_at,
                     episode_id=excluded.episode_id,
                     times_used=topics.times_used+1""",
                (repo_full_name, _now(), episode_id),
            )
            c.commit()

    # -- scripts (repetition check) ---------------------------------------- #

    def record_script(self, episode_id: str, narration: str, layout_sig: str) -> None:
        with closing(self._conn()) as c:
            c.execute(
                """INSERT INTO scripts(episode_id, created_at, narration, layout_sig)
                   VALUES(?,?,?,?)
                   ON CONFLICT(episode_id) DO UPDATE SET
                     narration=excluded.narration, layout_sig=excluded.layout_sig""",
                (episode_id, _now(), narration, layout_sig),
            )
            c.commit()

    def recent_scripts(self, limit: int = 30) -> list[tuple[str, str, str]]:
        with closing(self._conn()) as c:
            return c.execute(
                "SELECT episode_id, narration, layout_sig FROM scripts "
                "ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()

    # -- uploads ----------------------------------------------------------- #

    def claim_upload(self, episode_id: str, *, is_canary: bool, publish_at: str | None) -> dict:
        """Reserve the right to upload. Returns the existing row if there is one."""
        with closing(self._conn()) as c:
            existing = c.execute(
                "SELECT episode_id, claimed_at, video_id, is_canary, status, publish_at, attempts, note"
                " FROM uploads WHERE episode_id=?",
                (episode_id,),
            ).fetchone()
            if existing:
                c.execute(
                    "UPDATE uploads SET attempts=attempts+1 WHERE episode_id=?", (episode_id,)
                )
                c.commit()
                return self._row(existing) | {"preexisting": True}
            c.execute(
                "INSERT INTO uploads(episode_id, claimed_at, is_canary, status, publish_at, attempts)"
                " VALUES(?,?,?,?,?,1)",
                (episode_id, _now(), int(is_canary), "claimed", publish_at),
            )
            c.commit()
            return {
                "episode_id": episode_id,
                "status": "claimed",
                "video_id": None,
                "attempts": 1,
                "preexisting": False,
                "is_canary": is_canary,
                "publish_at": publish_at,
                "note": None,
                "claimed_at": _now(),
            }

    def set_upload(self, episode_id: str, *, video_id: str | None, status: str, note: str = "") -> None:
        with closing(self._conn()) as c:
            c.execute(
                "UPDATE uploads SET video_id=COALESCE(?, video_id), status=?, note=? WHERE episode_id=?",
                (video_id, status, note, episode_id),
            )
            c.commit()

    def get_upload(self, episode_id: str) -> dict | None:
        with closing(self._conn()) as c:
            row = c.execute(
                "SELECT episode_id, claimed_at, video_id, is_canary, status, publish_at, attempts, note"
                " FROM uploads WHERE episode_id=?",
                (episode_id,),
            ).fetchone()
        return self._row(row) if row else None

    def canary_confirmed(self) -> bool:
        with closing(self._conn()) as c:
            row = c.execute(
                "SELECT 1 FROM uploads WHERE is_canary=1 AND status='confirmed' LIMIT 1"
            ).fetchone()
        return row is not None

    def unresolved_claims(self) -> Iterable[dict]:
        with closing(self._conn()) as c:
            rows = c.execute(
                "SELECT episode_id, claimed_at, video_id, is_canary, status, publish_at, attempts, note"
                " FROM uploads WHERE status IN ('claimed','uploaded')"
            ).fetchall()
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(r: tuple) -> dict:
        keys = (
            "episode_id",
            "claimed_at",
            "video_id",
            "is_canary",
            "status",
            "publish_at",
            "attempts",
            "note",
        )
        d = dict(zip(keys, r))
        d["is_canary"] = bool(d["is_canary"])
        return d
