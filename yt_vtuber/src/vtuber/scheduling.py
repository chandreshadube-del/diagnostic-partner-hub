"""Publish-time arithmetic and the missed-window rule.

The pipeline never catches up. If the 18:00 Asia/Kolkata slot has passed by
the time an episode is ready, that day is skipped — publishing two or three
backlogged shorts at once is exactly the pattern that reads as mass-produced.
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

#: YouTube needs the video processed before the scheduled instant; the
#: generation job starts an hour early and this is the floor it must clear.
MIN_LEAD_S = 10 * 60


class MissedWindow(RuntimeError):
    def __init__(self, target: datetime, now: datetime) -> None:
        super().__init__(
            f"publish window {target.isoformat()} is {int((now - target).total_seconds())}s in the "
            f"past (or inside the {MIN_LEAD_S}s lead time); skipping today rather than posting late"
        )
        self.target = target
        self.now = now


def parse_hhmm(value: str) -> time:
    hh, mm = value.split(":")
    return time(int(hh), int(mm))


def next_publish_at(
    local_time: str,
    tz_name: str,
    *,
    now: datetime | None = None,
    allow_tomorrow: bool = False,
) -> datetime:
    """The UTC instant for today's slot, raising ``MissedWindow`` if it passed."""
    tz = ZoneInfo(tz_name)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    local_now = now.astimezone(tz)
    target_local = datetime.combine(local_now.date(), parse_hhmm(local_time), tzinfo=tz)
    target = target_local.astimezone(timezone.utc)
    if (target - now).total_seconds() >= MIN_LEAD_S:
        return target
    if allow_tomorrow:
        target = (target_local + timedelta(days=1)).astimezone(timezone.utc)
        log.info("today's slot has passed; targeting %s", target.isoformat())
        return target
    raise MissedWindow(target, now)


def describe(target: datetime, tz_name: str) -> str:
    tz = ZoneInfo(tz_name)
    return f"{target.astimezone(tz).strftime('%Y-%m-%d %H:%M')} {tz_name} ({target.isoformat()})"
