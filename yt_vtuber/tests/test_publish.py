"""Upload idempotency, canary gating, channel pinning and missed windows."""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_youtube import FakeHttpError, FakeYouTube  # noqa: E402

from vtuber import publish, scheduling, youtube  # noqa: E402
from vtuber.ledger import Ledger  # noqa: E402
from vtuber.models import CheckResult, State, ValidationReport  # noqa: E402


@pytest.fixture
def ready_episode(stub_episode, tmp_path):
    video = tmp_path / "ep.mp4"
    video.write_bytes(b"\x00" * 2048)
    stub_episode.render_path = str(video)
    stub_episode.title = "widgetctl: what actually changed"
    stub_episode.description = "body"
    stub_episode.validation = ValidationReport(checks=[CheckResult(name="all", passed=True)])
    stub_episode.state = State.VALIDATED
    return stub_episode


@pytest.fixture
def ledger(tmp_path) -> Ledger:
    return Ledger(tmp_path / "ledger.sqlite3")


@pytest.fixture
def fake(monkeypatch) -> FakeYouTube:
    y = FakeYouTube()
    monkeypatch.setattr(youtube, "_imports",
                        lambda: (None, None, None, None, FakeHttpError, lambda *a, **k: None))
    return y


def test_public_schedule_blocked_before_canary(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    with pytest.raises(publish.PublishBlocked, match="canary"):
        publish.upload_episode(ready_episode, cfg, ledger, canary=False,
                               publish_at=datetime.now(timezone.utc) + timedelta(hours=2),
                               svc=fake)


def test_canary_upload_is_private_without_publish_at(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    outcome = publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    body = fake.insert_bodies[-1]
    assert body["status"]["privacyStatus"] == "private"
    assert "publishAt" not in body["status"]
    assert outcome.video_id == "vid001"


def test_canary_confirmation_unlocks_public_scheduling(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    fake.set_status("vid001", "processed")
    status, _ = publish.confirm_processing(ready_episode, ledger, svc=fake)
    assert status == "processed"
    assert ledger.canary_confirmed()


def test_scheduled_upload_is_private_with_publish_at(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    cfg.upload.canary_passed = True
    target = datetime.now(timezone.utc) + timedelta(hours=3)
    publish.upload_episode(ready_episode, cfg, ledger, canary=False, publish_at=target, svc=fake)
    status = fake.insert_bodies[-1]["status"]
    assert status["privacyStatus"] == "private"
    assert status["publishAt"].endswith("Z")


def test_publish_at_with_public_privacy_is_refused():
    req = youtube.UploadRequest(
        video_path=Path(__file__), title="t", description="d",
        privacy_status="public", publish_at=datetime.now(timezone.utc),
    )
    with pytest.raises(youtube.YouTubeError, match="publishAt"):
        youtube._body(req)


def test_synthetic_flag_only_sent_when_declared(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    assert "containsSyntheticMedia" not in fake.insert_bodies[-1]["status"]

    cfg.upload.declare_synthetic_media = True
    ready_episode.episode_id = "2026-11-03-bbbbbbbb"
    publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    assert fake.insert_bodies[-1]["status"]["containsSyntheticMedia"] is True


def test_unverifiable_synthetic_flag_is_reported_as_unverified(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    cfg.upload.declare_synthetic_media = True
    publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    fake.store["vid001"]["status"].pop("containsSyntheticMedia", None)
    ok, detail = youtube.verify_synthetic_flag(fake, "vid001", True)
    assert not ok
    assert "YouTube Studio" in detail


def test_channel_mismatch_refuses_upload(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_someone_else"
    with pytest.raises(youtube.ChannelMismatch):
        publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    assert fake.inserts == []


def test_multiple_channels_refuses_to_guess(ready_episode, cfg, ledger, fake):
    fake.channel_list = [("UC_a", "A"), ("UC_b", "B")]
    cfg.upload.expected_channel_id = "UC_a"
    with pytest.raises(youtube.ChannelMismatch, match="will not choose"):
        publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)


def test_duplicate_run_does_not_upload_twice(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    assert len(fake.inserts) == 1
    second = publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    assert len(fake.inserts) == 1
    assert second.reused


def test_ambiguous_upload_is_recovered_not_repeated(ready_episode, cfg, ledger, fake):
    """A network error after the bytes landed must not produce a second video."""
    cfg.upload.expected_channel_id = "UC_expected"
    cfg.upload.canary_passed = True
    fake.chunks = 2
    fake.fail_with = FakeHttpError(400)
    with pytest.raises(youtube.YouTubeError):
        publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    claim = ledger.get_upload(ready_episode.episode_id)
    assert claim["status"] == "claimed" and claim["video_id"] is None

    # The video did in fact land; the next run must find it by title.
    fake.store["vid001"] = {"id": "vid001", "status": {"uploadStatus": "uploaded"},
                            "snippet": {"title": ready_episode.title}}
    fake.chunks = 1
    fake.fail_with = None
    outcome = publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)
    assert outcome.reused and outcome.video_id == "vid001"
    assert fake.inserts == []


def test_repeated_failures_stop_retrying(ready_episode, cfg, ledger, fake):
    cfg.upload.expected_channel_id = "UC_expected"
    cfg.upload.max_upload_attempts = 2
    for _ in range(3):
        ledger.claim_upload(ready_episode.episode_id, is_canary=True, publish_at=None)
    with pytest.raises(publish.PublishBlocked, match="refusing"):
        publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)


def test_unvalidated_episode_is_refused(ready_episode, cfg, ledger, fake):
    ready_episode.validation = ValidationReport(
        checks=[CheckResult(name="x", passed=False, detail="boom")]
    )
    with pytest.raises(publish.PublishBlocked, match="validation"):
        publish.upload_episode(ready_episode, cfg, ledger, canary=True, svc=fake)


def test_expired_oauth_surfaces_clearly(monkeypatch):
    from vtuber import secrets_store

    monkeypatch.setattr(secrets_store, "get_secret", lambda key: None)
    monkeypatch.setattr(youtube, "get_secret", lambda key: None)
    monkeypatch.setattr(youtube, "_imports",
                        lambda: (None, _Creds, None, None, FakeHttpError, None))
    with pytest.raises(youtube.YouTubeError, match="vtuber auth"):
        youtube.load_credentials(interactive=False)


class _Creds:
    @staticmethod
    def from_authorized_user_info(info, scopes):  # noqa: ANN001, ANN205
        raise ValueError("expired")


# --------------------------------------------------------------------------- #
# scheduling
# --------------------------------------------------------------------------- #


def test_window_is_today_when_run_early():
    now = datetime(2026, 11, 3, 11, 0, tzinfo=timezone.utc)  # 16:30 IST
    target = scheduling.next_publish_at("18:00", "Asia/Kolkata", now=now)
    assert target == datetime(2026, 11, 3, 12, 30, tzinfo=timezone.utc)


def test_missed_window_skips_rather_than_posting_late():
    now = datetime(2026, 11, 3, 13, 0, tzinfo=timezone.utc)  # 18:30 IST, slot gone
    with pytest.raises(scheduling.MissedWindow, match="skipping today"):
        scheduling.next_publish_at("18:00", "Asia/Kolkata", now=now)


def test_inside_lead_time_also_skips():
    now = datetime(2026, 11, 3, 12, 25, tzinfo=timezone.utc)  # 5 minutes before
    with pytest.raises(scheduling.MissedWindow):
        scheduling.next_publish_at("18:00", "Asia/Kolkata", now=now)


def test_two_missed_days_never_queue_a_backlog(ready_episode, cfg, ledger, fake):
    """Three runs on a passed window produce zero uploads, not three."""
    cfg.upload.expected_channel_id = "UC_expected"
    cfg.upload.canary_passed = True
    now = datetime(2026, 11, 3, 13, 0, tzinfo=timezone.utc)
    for _ in range(3):
        with pytest.raises(scheduling.MissedWindow):
            scheduling.next_publish_at("18:00", "Asia/Kolkata", now=now)
    assert fake.inserts == []
