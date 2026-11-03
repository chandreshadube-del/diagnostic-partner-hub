"""YouTube Data API v3: OAuth, upload, scheduling and processing status.

API facts this module relies on, taken from the published v3 discovery
document (``https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest``):

* ``status.publishAt`` — "can be set only if the privacy status of the video is
  private", so every scheduled upload is inserted as ``private``.
* ``status.containsSyntheticMedia`` — "Indicates if the video contains altered
  or synthetic media". Sent only when ``upload.declare_synthetic_media`` is on,
  and the value is read back after upload because the field is not guaranteed
  to be echoed by ``videos.list``; see ``verify_synthetic_flag``.
* ``status.uploadStatus`` / ``failureReason`` / ``rejectionReason`` — polled to
  decide whether a canary actually processed.

``videos.insert`` accepts ``youtube.upload``; reading back the channel and the
video status needs ``youtube.readonly``. Those two are the whole scope list.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .secrets_store import (
    KEY_OAUTH_TOKEN,
    SecretsError,
    client_secrets_path,
    get_secret,
    set_secret,
)

log = logging.getLogger(__name__)

#: Upload, plus the read access required to confirm the channel identity and to
#: poll processing status. Nothing broader is requested.
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]

TERMINAL_OK = {"processed"}
TERMINAL_BAD = {"failed", "rejected", "deleted"}


class YouTubeError(RuntimeError):
    pass


class ChannelMismatch(YouTubeError):
    """OAuth resolved to a channel other than the one the pipeline is pinned to."""


@dataclass(slots=True)
class ChannelIdentity:
    channel_id: str
    title: str


def _imports():  # noqa: ANN202
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload
    except ImportError as exc:  # pragma: no cover
        raise YouTubeError(
            "Google API client libraries are not installed "
            "(`pip install -r requirements.txt`)"
        ) from exc
    return Request, Credentials, InstalledAppFlow, build, HttpError, MediaFileUpload


def load_credentials(*, interactive: bool = False):  # noqa: ANN201
    Request, Credentials, InstalledAppFlow, _build, _HttpError, _Media = _imports()
    raw = get_secret(KEY_OAUTH_TOKEN)
    creds = None
    if raw:
        try:
            creds = Credentials.from_authorized_user_info(json.loads(raw), SCOPES)
        except Exception as exc:  # noqa: BLE001
            log.warning("stored OAuth token unusable, re-authorising: %s", exc)
            creds = None
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            set_secret(KEY_OAUTH_TOKEN, creds.to_json())
            return creds
        except Exception as exc:  # noqa: BLE001
            log.warning("refresh failed: %s", exc)
    if not interactive:
        raise YouTubeError(
            "no usable OAuth credentials. Run `vtuber auth` once, interactively, on this machine."
        )
    secrets = client_secrets_path()
    if not secrets.is_file():
        raise SecretsError(
            f"OAuth client secrets not found at {secrets}. Create a Desktop-app OAuth client in "
            "Google Cloud Console, enable the YouTube Data API v3, and save the JSON there "
            "(or point VTUBER_CLIENT_SECRETS at it)."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(secrets), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent")
    set_secret(KEY_OAUTH_TOKEN, creds.to_json())
    return creds


def service(creds=None, *, interactive: bool = False):  # noqa: ANN001, ANN201
    _R, _C, _F, build, _E, _M = _imports()
    creds = creds or load_credentials(interactive=interactive)
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def whoami(svc) -> ChannelIdentity:  # noqa: ANN001
    resp = svc.channels().list(part="id,snippet", mine=True).execute()
    items = resp.get("items") or []
    if not items:
        raise YouTubeError("OAuth account has no YouTube channel")
    if len(items) > 1:
        names = [f"{i['id']} ({i['snippet']['title']})" for i in items]
        raise ChannelMismatch(
            f"account owns {len(items)} channels: {names}. Pin one explicitly in config "
            "(upload.expected_channel_id) — the pipeline will not choose for you."
        )
    item = items[0]
    return ChannelIdentity(channel_id=item["id"], title=item["snippet"]["title"])


def assert_channel(svc, expected_channel_id: str) -> ChannelIdentity:  # noqa: ANN001
    ident = whoami(svc)
    if expected_channel_id and ident.channel_id != expected_channel_id:
        raise ChannelMismatch(
            f"OAuth resolved to {ident.channel_id} ({ident.title}), "
            f"but the pipeline is pinned to {expected_channel_id}"
        )
    return ident


@dataclass(slots=True)
class UploadRequest:
    video_path: Path
    title: str
    description: str
    category_id: str = "28"
    tags: list[str] | None = None
    privacy_status: str = "private"
    publish_at: datetime | None = None
    self_declared_made_for_kids: bool = False
    contains_synthetic_media: bool | None = None


def _body(req: UploadRequest) -> dict:
    status: dict = {
        "privacyStatus": req.privacy_status,
        "selfDeclaredMadeForKids": req.self_declared_made_for_kids,
    }
    if req.publish_at is not None:
        if req.privacy_status != "private":
            # The API rejects this combination; fail before spending an upload.
            raise YouTubeError(
                "status.publishAt can be set only when privacyStatus is 'private'"
            )
        status["publishAt"] = req.publish_at.isoformat().replace("+00:00", "Z")
    if req.contains_synthetic_media is not None:
        status["containsSyntheticMedia"] = bool(req.contains_synthetic_media)
    return {
        "snippet": {
            "title": req.title,
            "description": req.description,
            "categoryId": req.category_id,
            "tags": req.tags or [],
        },
        "status": status,
    }


def insert(svc, req: UploadRequest, *, chunk_size: int = 4 * 1024 * 1024) -> dict:  # noqa: ANN001
    _R, _C, _F, _B, HttpError, MediaFileUpload = _imports()
    if not req.video_path.is_file():
        raise YouTubeError(f"video not found: {req.video_path}")
    media = MediaFileUpload(
        str(req.video_path), chunksize=chunk_size, resumable=True, mimetype="video/mp4"
    )
    request = svc.videos().insert(part="snippet,status", body=_body(req), media_body=media)
    response = None
    tries = 0
    while response is None:
        try:
            _status, response = request.next_chunk()
        except HttpError as exc:
            tries += 1
            if exc.resp.status in (500, 502, 503, 504) and tries <= 5:
                wait = min(2**tries, 32)
                log.warning("transient %s from YouTube; retrying in %ss", exc.resp.status, wait)
                time.sleep(wait)
                continue
            raise YouTubeError(f"upload failed: {exc}") from exc
    log.info("uploaded video id=%s", response.get("id"))
    return response


def get_status(svc, video_id: str) -> dict:  # noqa: ANN001
    resp = svc.videos().list(part="status,processingDetails", id=video_id).execute()
    items = resp.get("items") or []
    if not items:
        raise YouTubeError(f"video {video_id} not visible to this account")
    return items[0]


def poll_until_processed(
    svc,  # noqa: ANN001
    video_id: str,
    *,
    timeout_s: float = 1800.0,
    interval_s: float = 20.0,
) -> tuple[str, dict]:
    """Poll ``uploadStatus`` until it settles. Returns (status, last payload)."""
    deadline = time.monotonic() + timeout_s
    last: dict = {}
    while time.monotonic() < deadline:
        last = get_status(svc, video_id)
        status = (last.get("status") or {}).get("uploadStatus", "unknown")
        log.info("video %s uploadStatus=%s", video_id, status)
        if status in TERMINAL_OK or status in TERMINAL_BAD:
            return status, last
        time.sleep(interval_s)
    return "timeout", last


def verify_synthetic_flag(svc, video_id: str, expected: bool | None) -> tuple[bool, str]:  # noqa: ANN001
    """Read ``status.containsSyntheticMedia`` back after upload.

    The field is write-supported but is not reliably echoed by ``videos.list``.
    An absent value is reported as unverified rather than as agreement, so the
    pipeline never claims a disclosure it could not confirm.
    """
    if expected is None:
        return True, "not declared"
    payload = get_status(svc, video_id)
    status = payload.get("status") or {}
    if "containsSyntheticMedia" not in status:
        return False, (
            "API did not return status.containsSyntheticMedia; confirm the disclosure "
            "in YouTube Studio for this video"
        )
    actual = bool(status["containsSyntheticMedia"])
    return actual == expected, f"containsSyntheticMedia={actual}, expected={expected}"


def find_by_title(svc, title: str, *, limit: int = 25) -> list[str]:  # noqa: ANN001
    """Reconcile an ambiguous upload: look for the video on the channel.

    Uses the authenticated account's own uploads playlist rather than public
    search, so a private video is still found.
    """
    chan = svc.channels().list(part="contentDetails", mine=True).execute()
    items = chan.get("items") or []
    if not items:
        return []
    uploads = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
    resp = svc.playlistItems().list(part="snippet", playlistId=uploads, maxResults=limit).execute()
    out = []
    for item in resp.get("items", []):
        if item["snippet"]["title"].strip() == title.strip():
            out.append(item["snippet"]["resourceId"]["videoId"])
    return out
