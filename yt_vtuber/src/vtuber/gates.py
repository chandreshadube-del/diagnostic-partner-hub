"""The quality gates. Every blocking check must pass before an upload.

A failed gate stops the episode where it stands: no fallback render, no
"good enough" upload. The failure and its inputs are written next to the
manifest so the run can be inspected afterwards.
"""
from __future__ import annotations

import logging
from pathlib import Path

from .config import PipelineConfig
from .critic import CriticReport
from .metadata import claims_supported, source_urls
from .models import (
    CheckResult,
    Episode,
    EvidencePacket,
    ValidationReport,
)
from .qc import QCResult
from .repetition import layout_signature, most_similar
from .timeline import validate_timeline

log = logging.getLogger(__name__)


def _ok(name: str, detail: str = "") -> CheckResult:
    return CheckResult(name=name, passed=True, detail=detail)


def _bad(name: str, detail: str, blocking: bool = True) -> CheckResult:
    return CheckResult(name=name, passed=False, detail=detail, blocking=blocking)


# --------------------------------------------------------------------------- #
# stage gates
# --------------------------------------------------------------------------- #


def check_evidence(packet: EvidencePacket, used_recently: set[str]) -> list[CheckResult]:
    out: list[CheckResult] = []
    if packet.repo_full_name in used_recently:
        out.append(_bad("evidence.not_duplicate", f"{packet.repo_full_name} used within cooldown"))
    else:
        out.append(_ok("evidence.not_duplicate", packet.repo_full_name))

    verified = [f for f in packet.facts if not f.attributed]
    if len(packet.facts) < 5 or len(verified) < 2:
        out.append(
            _bad(
                "evidence.sufficient",
                f"{len(packet.facts)} facts ({len(verified)} independently verified); "
                "need >=5 with >=2 verified",
            )
        )
    else:
        out.append(_ok("evidence.sufficient", f"{len(packet.facts)} facts, {len(verified)} verified"))

    primary = {r.source_type for r in packet.source_refs}
    if not {"repository", "readme"} <= primary:
        out.append(_bad("evidence.primary_sources", f"source types present: {sorted(primary)}"))
    else:
        out.append(_ok("evidence.primary_sources", f"{len(packet.source_refs)} refs"))
    return out


def check_script(
    episode: Episode,
    packet: EvidencePacket,
    critic: CriticReport,
    cfg: PipelineConfig,
    recent_scripts: list[tuple[str, str, str]],
) -> list[CheckResult]:
    out: list[CheckResult] = []
    script = episode.script
    if script is None:
        return [_bad("script.present", "no script")]

    out.append(_ok("script.schema", f"{len(script.scenes)} scenes validated"))

    words = script.word_count
    if cfg.script.target_words_min <= words <= cfg.script.target_words_max:
        out.append(_ok("script.length", f"{words} words"))
    else:
        out.append(
            _bad(
                "script.length",
                f"{words} words outside {cfg.script.target_words_min}-{cfg.script.target_words_max}",
            )
        )

    uncited = [s.index for s in script.scenes if s.role in ("what", "detail", "limitation") and not s.fact_ids]
    if uncited:
        out.append(_bad("script.citations", f"scenes without citations: {uncited}"))
    else:
        out.append(_ok("script.citations", "every factual scene cites evidence"))

    if critic.passed:
        out.append(_ok("script.critic", f"llm verdict={critic.llm_verdict}"))
    else:
        out.append(_bad("script.critic", "; ".join(critic.blocking[:6])))

    sim, who, same_layout = most_similar(script, recent_scripts)
    if sim > cfg.script.max_recent_similarity:
        out.append(_bad("script.not_repetitive", f"{sim:.2f} similarity to {who}"))
    else:
        out.append(_ok("script.not_repetitive", f"max similarity {sim:.2f}"))

    if same_layout:
        out.append(
            _bad("script.layout_varies", f"layout {layout_signature(script)} already used recently")
        )
    else:
        out.append(_ok("script.layout_varies", layout_signature(script)))
    return out


def check_generator(episode: Episode) -> CheckResult:
    """A stub-generated or stub-voiced episode may never be uploaded."""
    gen = episode.generator or ""
    if gen.startswith("stub") or not gen:
        return _bad("publish.real_generator", f"generator={gen or 'unset'}")
    return _ok("publish.real_generator", gen)


def check_tts_engine(episode: Episode) -> CheckResult:
    eng = episode.tts_engine or ""
    if eng.startswith("stub") or not eng:
        return _bad("publish.real_tts", f"tts_engine={eng or 'unset'}")
    if eng.startswith("kokoro") and eng.endswith("UNPINNED"):
        return _bad("publish.pinned_model", "Kokoro model revision is not pinned")
    return _ok("publish.real_tts", eng)


def check_audio(episode: Episode, cfg: PipelineConfig) -> list[CheckResult]:
    out: list[CheckResult] = []
    av = episode.audio_verification
    if av is None:
        return [_bad("audio.verified", "no transcript verification")]
    if av.wer <= av.threshold:
        out.append(_ok("audio.wer", f"{av.wer:.3f} <= {av.threshold:.3f}"))
    else:
        out.append(_bad("audio.wer", f"{av.wer:.3f} > {av.threshold:.3f}"))
    if av.technical_mismatches:
        out.append(_bad("audio.technical_terms", f"mismatched: {av.technical_mismatches[:8]}"))
    else:
        out.append(_ok("audio.technical_terms", "all technical tokens and numbers matched"))

    dur = episode.audio_duration_s or 0.0
    if cfg.script.duration_min_s <= dur <= cfg.script.duration_max_s:
        out.append(_ok("audio.duration", f"{dur:.1f}s"))
    else:
        out.append(
            _bad(
                "audio.duration",
                f"{dur:.1f}s outside {cfg.script.duration_min_s}-{cfg.script.duration_max_s}s",
            )
        )
    if episode.word_timestamps:
        out.append(_ok("audio.word_timestamps", f"{len(episode.word_timestamps)} words"))
    else:
        out.append(_bad("audio.word_timestamps", "none"))
    return out


def check_timeline(timeline: dict) -> list[CheckResult]:
    problems = validate_timeline(timeline)
    if problems:
        return [_bad("timeline.structure", "; ".join(problems[:6]))]
    n_caps = sum(len(s["captions"]) for s in timeline["scenes"])
    return [_ok("timeline.structure", f"{len(timeline['scenes'])} scenes, {n_caps} caption lines")]


def check_render(
    episode: Episode,
    qc: QCResult,
    cfg: PipelineConfig,
    layout_problems: list[str],
    blank_frames: list[int],
) -> list[CheckResult]:
    out: list[CheckResult] = []
    p = qc.probe
    want = (cfg.render.width, cfg.render.height)
    if (p.width, p.height) == want:
        out.append(_ok("render.dimensions", f"{p.width}x{p.height}"))
    else:
        out.append(_bad("render.dimensions", f"{p.width}x{p.height}, expected {want[0]}x{want[1]}"))

    if abs(p.fps - cfg.render.fps) < 0.02:
        out.append(_ok("render.fps", f"{p.fps}"))
    else:
        out.append(_bad("render.fps", f"{p.fps}, expected {cfg.render.fps}"))

    if cfg.script.duration_min_s <= p.duration_s <= cfg.script.duration_max_s:
        out.append(_ok("render.duration", f"{p.duration_s:.2f}s"))
    else:
        out.append(
            _bad(
                "render.duration",
                f"{p.duration_s:.2f}s outside "
                f"{cfg.script.duration_min_s}-{cfg.script.duration_max_s}s",
            )
        )

    if qc.decodes:
        out.append(_ok("render.decodes", "full decode clean"))
    else:
        out.append(_bad("render.decodes", qc.decode_error or "decode errors"))

    if qc.probe.audio_codec and (qc.mean_dbfs is not None and qc.mean_dbfs > -50.0):
        out.append(
            _ok("render.audio", f"{p.audio_codec} {p.audio_channels}ch mean {qc.mean_dbfs:.1f} dBFS")
        )
    else:
        out.append(
            _bad(
                "render.audio",
                f"codec={p.audio_codec} mean={qc.mean_dbfs} — missing or silent audio track",
            )
        )

    if qc.black:
        out.append(_bad("render.no_blank_frames", f"black intervals: {qc.black[:4]}"))
    elif blank_frames:
        out.append(_bad("render.no_blank_frames", f"flat sampled frames: {blank_frames[:8]}"))
    elif qc.frame_stddevs and min(qc.frame_stddevs) < 3.0:
        out.append(_bad("render.no_blank_frames", f"low-variation frame, stddevs={qc.frame_stddevs}"))
    else:
        out.append(_ok("render.no_blank_frames", f"stddevs={qc.frame_stddevs[:5]}"))

    if layout_problems:
        out.append(_bad("render.layout_fits", "; ".join(layout_problems[:5])))
    else:
        out.append(_ok("render.layout_fits", "no overflow or clipping sampled"))

    if episode.render_path and Path(episode.render_path).is_file():
        out.append(_ok("render.file", f"{p.size_bytes / 1e6:.1f} MB"))
    else:
        out.append(_bad("render.file", f"missing {episode.render_path}"))
    return out


def check_metadata(episode: Episode) -> list[CheckResult]:
    out: list[CheckResult] = []
    title = episode.title or ""
    desc = episode.description or ""
    if 10 <= len(title) <= 100:
        out.append(_ok("metadata.title", f"{len(title)} chars"))
    else:
        out.append(_bad("metadata.title", f"{len(title)} chars"))

    urls = source_urls(episode)
    present = [u for u in urls if u in desc]
    if len(present) >= 2:
        out.append(_ok("metadata.source_links", f"{len(present)} source URLs in description"))
    else:
        out.append(_bad("metadata.source_links", f"only {len(present)} source URLs in description"))

    unsupported = claims_supported(desc, episode)
    if unsupported:
        out.append(_bad("metadata.claims", f"numbers not traceable to evidence: {unsupported[:6]}"))
    else:
        out.append(_ok("metadata.claims", "all numeric claims traceable"))
    return out


def check_publish_preconditions(cfg: PipelineConfig, canary_confirmed: bool) -> list[CheckResult]:
    out: list[CheckResult] = []
    if canary_confirmed or cfg.upload.canary_passed:
        out.append(_ok("publish.canary", "private canary processed successfully"))
    else:
        out.append(_bad("publish.canary", "no confirmed canary upload; public scheduling blocked"))
    if cfg.upload.expected_channel_id:
        out.append(_ok("publish.channel_pinned", cfg.upload.expected_channel_id))
    else:
        out.append(_bad("publish.channel_pinned", "upload.expected_channel_id is unset"))
    return out


def assemble(*groups: list[CheckResult] | CheckResult) -> ValidationReport:
    checks: list[CheckResult] = []
    for g in groups:
        if isinstance(g, CheckResult):
            checks.append(g)
        else:
            checks.extend(g)
    report = ValidationReport(checks=checks)
    log.info(
        "gates: %d checks, %d blocking failures",
        len(checks),
        len(report.failures),
    )
    return report
