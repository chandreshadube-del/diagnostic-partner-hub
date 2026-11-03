"""Quality gates: each blocking condition must actually block."""
from __future__ import annotations

from dataclasses import replace

import pytest

from vtuber import gates
from vtuber.config import ScriptConfig
from vtuber.critic import CriticReport
from vtuber.models import AudioVerification, CheckResult, ValidationReport
from vtuber.qc import QCResult, VideoProbe
from vtuber.repetition import layout_signature


def _probe(**over) -> VideoProbe:
    base = dict(width=1080, height=1920, fps=30.0, duration_s=52.0, video_codec="h264",
                audio_codec="aac", audio_channels=2, audio_sample_rate=48000,
                nb_frames=1560, size_bytes=8_000_000, raw={})
    base.update(over)
    return VideoProbe(**base)


def _qc(probe=None, **over) -> QCResult:
    base = dict(probe=probe or _probe(), decodes=True, decode_error="", black=[],
                mean_dbfs=-18.0, peak_dbfs=-1.5, frame_stddevs=[40.0, 41.0, 38.5])
    base.update(over)
    return QCResult(**base)


def _names(checks):
    return {c.name: c for c in checks}


def test_duplicate_repository_is_rejected(packet):
    checks = _names(gates.check_evidence(packet, {"acme/widgetctl"}))
    assert not checks["evidence.not_duplicate"].passed


def test_fresh_repository_passes(packet):
    checks = _names(gates.check_evidence(packet, {"other/repo"}))
    assert checks["evidence.not_duplicate"].passed
    assert checks["evidence.sufficient"].passed


def test_thin_evidence_is_rejected(packet):
    packet.facts = packet.facts[:3]
    checks = _names(gates.check_evidence(packet, set()))
    assert not checks["evidence.sufficient"].passed


def test_repetitive_script_is_rejected(stub_episode, packet, cfg):
    recent = [("2026-10-30-x", stub_episode.script.narration, "other-layout")]
    checks = _names(gates.check_script(stub_episode, packet, CriticReport(), cfg, recent))
    assert not checks["script.not_repetitive"].passed


def test_reused_layout_is_rejected(stub_episode, packet, cfg):
    recent = [("2026-10-30-x", "completely different words entirely",
               layout_signature(stub_episode.script))]
    checks = _names(gates.check_script(stub_episode, packet, CriticReport(), cfg, recent))
    assert not checks["script.layout_varies"].passed


def test_critic_failure_is_surfaced(stub_episode, packet, cfg):
    rep = CriticReport(unsupported_numbers=["scene 2: 40000"])
    checks = _names(gates.check_script(stub_episode, packet, rep, cfg, []))
    assert not checks["script.critic"].passed


def test_stub_generator_cannot_publish(stub_episode):
    assert not gates.check_generator(stub_episode).passed
    stub_episode.generator = "ollama:qwen2.5:7b-instruct"
    assert gates.check_generator(stub_episode).passed


def test_stub_tts_cannot_publish(stub_episode):
    assert not gates.check_tts_engine(stub_episode).passed
    stub_episode.tts_engine = "kokoro:af_heart@UNPINNED"
    assert not gates.check_tts_engine(stub_episode).passed
    stub_episode.tts_engine = "kokoro:af_heart@abc123"
    assert gates.check_tts_engine(stub_episode).passed


def test_technical_mismatch_blocks(stub_episode, cfg):
    stub_episode.audio_duration_s = 50.0
    stub_episode.audio_verification = AudioVerification(
        engine="kokoro", asr_engine="fw", wer=0.01, threshold=0.05,
        technical_mismatches=["v2.4.1"], attempts=2, passed=False,
    )
    checks = _names(gates.check_audio(stub_episode, cfg))
    assert checks["audio.wer"].passed
    assert not checks["audio.technical_terms"].passed


def test_wrong_dimensions_block(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(stub_episode, _qc(probe=_probe(width=1920, height=1080)),
                                       cfg, [], []))
    assert not checks["render.dimensions"].passed


def test_wrong_fps_blocks(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(stub_episode, _qc(probe=_probe(fps=24.0)), cfg, [], []))
    assert not checks["render.fps"].passed


def test_out_of_range_duration_blocks(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(stub_episode, _qc(probe=_probe(duration_s=92.0)),
                                       cfg, [], []))
    assert not checks["render.duration"].passed


def test_missing_audio_blocks(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(
        stub_episode, _qc(probe=_probe(audio_codec=None), mean_dbfs=None), cfg, [], []))
    assert not checks["render.audio"].passed


def test_silent_audio_blocks(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(stub_episode, _qc(mean_dbfs=-91.0), cfg, [], []))
    assert not checks["render.audio"].passed


def test_malformed_video_blocks(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(
        stub_episode, _qc(decodes=False, decode_error="moov atom not found"), cfg, [], []))
    assert not checks["render.decodes"].passed


def test_blank_frames_block(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(stub_episode, _qc(black=[(1.0, 3.0)]), cfg, [], []))
    assert not checks["render.no_blank_frames"].passed
    checks = _names(gates.check_render(stub_episode, _qc(frame_stddevs=[0.4, 40.0]), cfg, [], []))
    assert not checks["render.no_blank_frames"].passed


def test_layout_overflow_blocks(stub_episode, cfg):
    stub_episode.render_path = __file__
    checks = _names(gates.check_render(stub_episode, _qc(), cfg,
                                       ["t=3.00s: scene card overflows by 42px"], []))
    assert not checks["render.layout_fits"].passed


def test_missing_render_file_blocks(stub_episode, cfg):
    stub_episode.render_path = "/nonexistent/video.mp4"
    checks = _names(gates.check_render(stub_episode, _qc(), cfg, [], []))
    assert not checks["render.file"].passed


def test_description_without_sources_blocks(stub_episode):
    stub_episode.title = "widgetctl: what changed this week"
    stub_episode.description = "no links here"
    checks = _names(gates.check_metadata(stub_episode))
    assert not checks["metadata.source_links"].passed


def test_description_with_invented_number_blocks(stub_episode):
    stub_episode.title = "widgetctl: what changed this week"
    stub_episode.description = (
        "Handles 40000 widgets.\n"
        + "\n".join(str(r.url) for r in stub_episode.source_refs)
    )
    checks = _names(gates.check_metadata(stub_episode))
    assert not checks["metadata.claims"].passed


def test_publish_blocked_without_canary(cfg):
    checks = _names(gates.check_publish_preconditions(cfg, canary_confirmed=False))
    assert not checks["publish.canary"].passed
    assert not checks["publish.channel_pinned"].passed


def test_publish_allowed_after_canary(cfg):
    cfg.upload.expected_channel_id = "UC_test"
    checks = _names(gates.check_publish_preconditions(cfg, canary_confirmed=True))
    assert checks["publish.canary"].passed
    assert checks["publish.channel_pinned"].passed


def test_report_passes_only_when_all_blocking_pass():
    rep = ValidationReport(checks=[
        CheckResult(name="a", passed=True),
        CheckResult(name="b", passed=False, blocking=False),
    ])
    assert rep.passed
    rep.checks.append(CheckResult(name="c", passed=False))
    assert not rep.passed


def test_timestamps_in_description_are_not_treated_as_claims(stub_episode):
    """ISO retrieval stamps have no word boundary between '01' and 'T09'."""
    from vtuber.metadata import build_description, claims_supported

    stub_episode.description = build_description(stub_episode, _packet_of(stub_episode))
    assert claims_supported(stub_episode.description, stub_episode) == []


def _packet_of(episode):  # noqa: ANN001, ANN202
    from vtuber.models import EvidencePacket

    return EvidencePacket(
        topic=episode.topic,
        repo_full_name=episode.repo_full_name,
        collected_at=episode.created_at,
        source_refs=episode.source_refs,
        facts=episode.facts,
        license_spdx="Apache-2.0",
    )


def test_clickbait_title_is_refused(stub_episode, packet):
    from vtuber.metadata import MetadataError, build_title

    data = stub_episode.script.model_dump()
    data["scenes"][0]["narration"] = "You won't believe what widgetctl shipped this week."
    stub_episode.script = type(stub_episode.script).model_validate(data)
    with pytest.raises(MetadataError, match="clickbait"):
        build_title(stub_episode, packet)


def test_bootstrap_refuses_an_undeclared_license():
    from vtuber.bootstrap import BootstrapError, ModelPin, check_license

    pin = ModelPin(repo_id="x/y", revision="abc", license_id=None, license_url="u")
    with pytest.raises(BootstrapError, match="declares no licence"):
        check_license(pin)
    check_license(pin, accept="apache-2.0")  # explicit human decision is honoured


def test_bootstrap_refuses_a_restricted_license():
    from vtuber.bootstrap import BootstrapError, ModelPin, check_license

    pin = ModelPin(repo_id="x/y", revision="abc", license_id="cc-by-nc-4.0", license_url="u")
    with pytest.raises(BootstrapError, match="does not pin"):
        check_license(pin)


def test_bootstrap_accepts_apache():
    from vtuber.bootstrap import ModelPin, check_license

    check_license(ModelPin(repo_id="x/y", revision="abc",
                           license_id="apache-2.0", license_url="u"))
