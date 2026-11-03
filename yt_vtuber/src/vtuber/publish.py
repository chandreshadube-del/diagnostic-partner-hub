"""Idempotent upload: claim, upload, reconcile.

The ledger is written before the network call, so an ambiguous outcome leaves
a claim that the next run must resolve against YouTube rather than uploading a
second copy of the same episode.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from . import youtube
from .config import PipelineConfig
from .ledger import Ledger
from .models import Episode, UploadRecord

log = logging.getLogger(__name__)


class PublishError(RuntimeError):
    pass


class PublishBlocked(PublishError):
    """A precondition says this episode must not be uploaded."""


@dataclass(slots=True)
class PublishOutcome:
    video_id: str | None
    status: str
    detail: str
    reused: bool = False


def _reconcile(svc, ledger: Ledger, episode: Episode, claim: dict) -> PublishOutcome | None:  # noqa: ANN001
    """Resolve a pre-existing claim before considering another upload."""
    if claim["status"] == "confirmed" and claim["video_id"]:
        return PublishOutcome(claim["video_id"], "confirmed", "already confirmed", reused=True)
    if claim["video_id"]:
        status = youtube.get_status(svc, claim["video_id"])
        up = (status.get("status") or {}).get("uploadStatus", "unknown")
        ledger.set_upload(episode.episode_id, video_id=claim["video_id"],
                          status="confirmed" if up in youtube.TERMINAL_OK else "uploaded",
                          note=f"reconciled uploadStatus={up}")
        return PublishOutcome(claim["video_id"], up, "reconciled from ledger", reused=True)
    # Claimed but no id recorded: the previous attempt may still have landed.
    if episode.title:
        found = youtube.find_by_title(svc, episode.title)
        if found:
            vid = found[0]
            ledger.set_upload(episode.episode_id, video_id=vid, status="uploaded",
                              note="recovered by title after ambiguous attempt")
            log.warning("recovered ambiguous upload for %s as %s", episode.episode_id, vid)
            return PublishOutcome(vid, "uploaded", "recovered by title", reused=True)
    return None


def upload_episode(
    episode: Episode,
    cfg: PipelineConfig,
    ledger: Ledger,
    *,
    canary: bool = False,
    publish_at: datetime | None = None,
    svc=None,  # noqa: ANN001
) -> PublishOutcome:
    if episode.render_path is None or not Path(episode.render_path).is_file():
        raise PublishBlocked("no rendered video to upload")
    if episode.validation is None or not episode.validation.passed:
        raise PublishBlocked("episode has not passed validation")
    if not canary and not (cfg.upload.canary_passed or ledger.canary_confirmed()):
        raise PublishBlocked("public scheduling is disabled until a canary upload is confirmed")

    svc = svc or youtube.service()
    identity = youtube.assert_channel(svc, cfg.upload.expected_channel_id)
    log.info("authorised channel: %s (%s)", identity.title, identity.channel_id)

    claim = ledger.claim_upload(
        episode.episode_id,
        is_canary=canary,
        publish_at=publish_at.isoformat() if publish_at else None,
    )
    if claim.get("preexisting"):
        log.warning("episode %s already has an upload claim (%s)", episode.episode_id, claim["status"])
        if claim["attempts"] > cfg.upload.max_upload_attempts:
            raise PublishBlocked(
                f"upload attempted {claim['attempts']} times; refusing to try again"
            )
        outcome = _reconcile(svc, ledger, episode, claim)
        if outcome is not None:
            episode.upload = UploadRecord(
                video_id=outcome.video_id,
                upload_status=outcome.status,
                is_canary=claim["is_canary"],
                channel_id=identity.channel_id,
            )
            return outcome

    req = youtube.UploadRequest(
        video_path=Path(episode.render_path),
        title=episode.title or episode.topic[:95],
        description=episode.description or "",
        category_id=cfg.upload.category_id,
        privacy_status="private",
        publish_at=None if canary else publish_at,
        self_declared_made_for_kids=cfg.upload.self_declared_made_for_kids,
        contains_synthetic_media=True if cfg.upload.declare_synthetic_media else None,
    )
    try:
        response = youtube.insert(svc, req)
    except Exception as exc:
        ledger.set_upload(episode.episode_id, video_id=None, status="claimed",
                          note=f"attempt failed: {exc}"[:400])
        raise

    video_id = response.get("id")
    ledger.set_upload(episode.episode_id, video_id=video_id, status="uploaded", note="inserted")
    episode.upload = UploadRecord(
        video_id=video_id,
        uploaded_at=datetime.now().astimezone(),
        privacy_status=(response.get("status") or {}).get("privacyStatus"),
        publish_at=publish_at,
        upload_status=(response.get("status") or {}).get("uploadStatus"),
        is_canary=canary,
        channel_id=identity.channel_id,
        contains_synthetic_media=True if cfg.upload.declare_synthetic_media else None,
    )
    return PublishOutcome(video_id, "uploaded", "inserted")


def confirm_processing(
    episode: Episode,
    ledger: Ledger,
    *,
    svc=None,  # noqa: ANN001
    timeout_s: float = 1800.0,
) -> tuple[str, dict]:
    svc = svc or youtube.service()
    video_id = episode.upload.video_id if episode.upload else None
    if not video_id:
        raise PublishError("episode has no uploaded video id")
    status, payload = youtube.poll_until_processed(svc, video_id, timeout_s=timeout_s)
    st = payload.get("status") or {}
    if episode.upload:
        episode.upload.upload_status = status
        episode.upload.failure_reason = st.get("failureReason")
        episode.upload.rejection_reason = st.get("rejectionReason")
    ledger.set_upload(
        episode.episode_id,
        video_id=video_id,
        status="confirmed" if status in youtube.TERMINAL_OK else "uploaded",
        note=f"uploadStatus={status} failure={st.get('failureReason')} "
             f"rejection={st.get('rejectionReason')}",
    )
    return status, payload
