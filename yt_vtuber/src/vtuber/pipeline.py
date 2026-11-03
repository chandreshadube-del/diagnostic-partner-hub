"""The daily orchestrator.

Each stage is guarded by the episode's recorded state, so re-running a day
resumes rather than repeats. Any failed gate ends the run: there is no
degraded fallback video.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import platform
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import critic as critic_mod
from . import encoder, gates, llm, metadata, qc, render, timeline, tts
from .asr import ASREngine, build as build_asr
from .audio_io import duration_s as wav_duration
from .config import PipelineConfig
from .discover import Candidate, discover
from .evidence import ThinEvidence, collect
from .github_api import GitHub, GitHubError
from .ledger import Ledger
from .models import (
    AudioVerification,
    Episode,
    EvidencePacket,
    RenderSettings,
    State,
    utcnow,
)
from .repetition import layout_signature
from .script_gen import ScriptGenerationError, generate
from .state import EpisodeStore, episode_id_for
from .tts import synthesize_to_file
from .verify_audio import check_technical, word_error_rate

log = logging.getLogger(__name__)


class PipelineSkip(RuntimeError):
    """A legitimate reason to produce nothing today."""


class PipelineFailed(RuntimeError):
    pass


@dataclass(slots=True)
class RunContext:
    cfg: PipelineConfig
    store: EpisodeStore
    ledger: Ledger
    packet: EvidencePacket | None = None
    timeline: dict | None = None
    layout_problems: list[str] = field(default_factory=list)
    blank_frames: list[int] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def total_ram_gb() -> float | None:
    try:
        if hasattr(__import__("os"), "sysconf"):
            import os

            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    except (ValueError, OSError, AttributeError):
        pass
    try:  # Windows
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))  # type: ignore[attr-defined]
        return stat.ullTotalPhys / 1024**3
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# stages
# --------------------------------------------------------------------------- #


def stage_discover(ctx: RunContext, *, force_repo: str | None = None) -> tuple[Episode, EvidencePacket]:
    cfg = ctx.cfg
    excluded = ctx.ledger.recently_used(cfg.discovery.cooldown_days)
    with GitHub() as gh:
        if not gh.authenticated:
            log.warning("no GitHub token; unauthenticated rate limits apply")
        if force_repo:
            data = gh.repo(force_repo)
            from .discover import score_candidate, to_candidate

            candidates: list[Candidate] = [score_candidate(to_candidate(data, gh.latest_release(force_repo)))]
        else:
            candidates = discover(gh, cfg.discovery, excluded=excluded)
        if not candidates:
            raise PipelineSkip("no candidate repository passed discovery filters today")

        last_error = ""
        for cand in candidates[:8]:
            try:
                packet = collect(gh, cand)
            except (ThinEvidence, GitHubError) as exc:
                last_error = str(exc)
                log.info("skipping %s: %s", cand.full_name, exc)
                continue
            episode = Episode(
                episode_id=episode_id_for(cand.full_name),
                created_at=utcnow(),
                topic=packet.topic[:200],
                repo_full_name=cand.full_name,
                source_refs=packet.source_refs,
                facts=packet.facts,
                state=State.DISCOVERED,
            )
            ctx.store.save(episode)
            ctx.store.write_artifact(
                episode, "evidence.json", packet.model_dump_json(indent=2)
            )
            ctx.notes.append(f"selected {cand.full_name} (score {cand.score})")
            return episode, packet
    raise PipelineSkip(f"no candidate yielded a usable evidence packet; last error: {last_error}")


def stage_script(ctx: RunContext, episode: Episode, packet: EvidencePacket) -> Episode:
    cfg = ctx.cfg
    ram = total_ram_gb()
    writer = llm.build(cfg.llm, "writer", ram)
    critic_llm = llm.build(cfg.llm, "critic", ram)
    if hasattr(writer, "ensure_model"):
        writer.ensure_model()  # type: ignore[attr-defined]

    try:
        script, notes = generate(writer, packet, cfg.script, max_attempts=cfg.llm.max_attempts)
    except ScriptGenerationError as exc:
        ctx.store.dump_failure_inputs(episode, "script", {"error": str(exc), "repo": episode.repo_full_name})
        raise PipelineFailed(f"script generation failed: {exc}") from exc
    ctx.notes.extend(notes)

    report = critic_mod.run(script, packet, cfg.script, critic_llm)
    episode.script = script
    episode.generator = writer.name
    ctx.store.save(episode)
    ctx.store.write_artifact(
        episode,
        "critic.json",
        json.dumps(
            {
                "blocking": report.blocking,
                "llm_verdict": report.llm_verdict,
                "llm_issues": report.llm_issues,
            },
            indent=2,
        ),
    )
    recent = ctx.ledger.recent_scripts(cfg.script.recent_window)
    checks = gates.check_evidence(packet, ctx.ledger.recently_used(cfg.discovery.cooldown_days))
    checks += gates.check_script(episode, packet, report, cfg, recent)
    failures = [c for c in checks if c.blocking and not c.passed]
    if failures:
        ctx.store.dump_failure_inputs(
            episode, "gates-script", {"failures": [c.model_dump() for c in failures]}
        )
        raise PipelineFailed("; ".join(f"{c.name}: {c.detail}" for c in failures))

    ctx.ledger.record_script(episode.episode_id, script.narration, layout_signature(script))
    ctx.ledger.record_topic(episode.repo_full_name, episode.episode_id)
    ctx.store.advance(episode, State.RESEARCHED)
    ctx.store.advance(episode, State.SCRIPTED)
    return episode


def stage_audio(
    ctx: RunContext,
    episode: Episode,
    *,
    asr_engine: ASREngine | None = None,
) -> Episode:
    cfg = ctx.cfg
    assert episode.script is not None
    engine = tts.build(cfg.tts)
    asr = asr_engine or build_asr(cfg.asr)
    target = ctx.store.dir_for(episode.episode_id) / "narration.wav"

    attempts = 0
    last: AudioVerification | None = None
    while attempts < cfg.asr.max_synthesis_attempts:
        attempts += 1
        synthesize_to_file(engine, episode.script.narration, target, cfg.tts)
        transcript, words = asr.transcribe(target)
        wer, subs, dels, ins, n_ref = word_error_rate(episode.script.narration, transcript)
        tech = check_technical(episode.script.narration, transcript)
        last = AudioVerification(
            engine=engine.name,
            asr_engine=asr.name,
            wer=round(wer, 4),
            threshold=cfg.asr.wer_threshold,
            technical_mismatches=tech.missing,
            attempts=attempts,
            passed=wer <= cfg.asr.wer_threshold and tech.ok,
        )
        log.info(
            "attempt %d: WER %.3f (S%d D%d I%d of %d), technical missing=%s",
            attempts, wer, subs, dels, ins, n_ref, tech.missing,
        )
        episode.transcript = transcript
        episode.word_timestamps = words
        episode.audio_path = str(target)
        episode.audio_duration_s = round(wav_duration(target), 3)
        episode.audio_verification = last
        episode.tts_engine = engine.name
        ctx.store.save(episode)
        if last.passed:
            break

    if last is None or not last.passed:
        ctx.store.dump_failure_inputs(
            episode,
            "audio",
            {
                "intended": episode.script.narration,
                "transcript": episode.transcript,
                "verification": last.model_dump() if last else None,
            },
        )
        raise PipelineFailed(
            f"audio verification failed after {attempts} attempts: "
            f"WER {last.wer if last else '?'} / missing {last.technical_mismatches if last else '?'}"
        )

    checks = gates.check_audio(episode, cfg)
    failures = [c for c in checks if c.blocking and not c.passed]
    if failures:
        raise PipelineFailed("; ".join(f"{c.name}: {c.detail}" for c in failures))
    ctx.store.advance(episode, State.AUDIO_READY)
    return episode


def stage_render(ctx: RunContext, episode: Episode, *, image_format: str = "png") -> Episode:
    cfg = ctx.cfg
    avatar_dir = cfg.assets_dir / "avatar"
    meta_path = avatar_dir / "avatar.json"
    if not meta_path.is_file():
        raise PipelineFailed(f"avatar metadata missing: {meta_path} (run tools/make_avatar.py)")
    avatar_meta = json.loads(meta_path.read_text(encoding="utf-8"))

    settings = RenderSettings(
        width=cfg.render.width,
        height=cfg.render.height,
        fps=cfg.render.fps,
        crf=cfg.render.crf,
        ffmpeg_version=encoder.ffmpeg_version(),
    )
    episode.render_settings = settings

    tl = timeline.build(
        episode,
        avatar_sheet="avatar.png",
        avatar_meta=avatar_meta,
        audio_duration_s=episode.audio_duration_s or 0.0,
    )
    ctx.timeline = tl
    tl_path = ctx.store.dir_for(episode.episode_id) / "timeline.json"
    timeline.write(tl, tl_path)
    episode.timeline_path = str(tl_path)
    ctx.store.save(episode)

    checks = gates.check_timeline(tl)
    failures = [c for c in checks if c.blocking and not c.passed]
    if failures:
        raise PipelineFailed("; ".join(f"{c.name}: {c.detail}" for c in failures))

    hw = None
    if cfg.render.try_hwaccel:
        hw = encoder.detect_hwaccel(cfg.render.hwaccel_candidates)
    settings.hwaccel = hw

    render_dir = ctx.store.dir_for(episode.episode_id) / "render"
    if render_dir.exists():
        shutil.rmtree(render_dir)
    render.stage(cfg.templates_dir, avatar_dir, tl, render_dir)

    result = render.RenderResult(frame_count=0, chromium_version="")
    frames = render.frames(
        render_dir,
        duration_s=tl["duration"],
        fps=cfg.render.fps,
        width=cfg.render.width,
        height=cfg.render.height,
        executable_path=cfg.render.chromium_executable or None,
        image_format=image_format,
        timeout_ms=cfg.render.screenshot_timeout_ms,
        result=result,
    )
    out_path = ctx.store.dir_for(episode.episode_id) / f"{episode.episode_id}.mp4"
    enc = encoder.EncodeSettings(
        width=cfg.render.width,
        height=cfg.render.height,
        fps=cfg.render.fps,
        crf=cfg.render.crf,
        video_codec=hw or "libx264",
    )
    try:
        encoder.encode(frames, Path(episode.audio_path or ""), out_path, enc, image_format=image_format)
    except encoder.FFmpegError:
        if hw:
            log.warning("hardware encoder %s failed mid-encode; retrying on libx264", hw)
            settings.hwaccel = None
            enc.video_codec = "libx264"
            frames = render.frames(
                render_dir,
                duration_s=tl["duration"],
                fps=cfg.render.fps,
                width=cfg.render.width,
                height=cfg.render.height,
                executable_path=cfg.render.chromium_executable or None,
                image_format=image_format,
                timeout_ms=cfg.render.screenshot_timeout_ms,
                result=result,
            )
            encoder.encode(frames, Path(episode.audio_path or ""), out_path, enc,
                           image_format=image_format)
        else:
            raise

    settings.chromium_version = result.chromium_version
    settings.video_codec = enc.video_codec
    episode.render_settings = settings
    episode.render_path = str(out_path)
    episode.render_duration_s = tl["duration"]
    ctx.layout_problems = result.layout_problems
    ctx.blank_frames = result.blank_frames
    ctx.store.save(episode)
    ctx.store.advance(episode, State.RENDERED)
    return episode


def stage_validate(ctx: RunContext, episode: Episode, packet: EvidencePacket) -> Episode:
    cfg = ctx.cfg
    episode.title = metadata.build_title(episode, packet)
    episode.description = metadata.build_description(episode, packet)
    ctx.store.save(episode)

    result = qc.run(Path(episode.render_path or ""))
    report = gates.assemble(
        gates.check_render(episode, result, cfg, ctx.layout_problems, ctx.blank_frames),
        gates.check_metadata(episode),
        gates.check_generator(episode),
        gates.check_tts_engine(episode),
    )
    episode.validation = report
    ctx.store.save(episode)
    ctx.store.write_artifact(
        episode, "qc.json",
        json.dumps({
            "probe": {f.name: ("omitted" if f.name == "raw" else getattr(result.probe, f.name))
                      for f in dataclasses.fields(result.probe)},
            "decodes": result.decodes,
            "decode_error": result.decode_error,
            "black": result.black,
            "mean_dbfs": result.mean_dbfs,
            "peak_dbfs": result.peak_dbfs,
            "frame_stddevs": result.frame_stddevs,
            "layout_problems": ctx.layout_problems,
        }, indent=2, default=str),
    )
    if not report.passed:
        raise PipelineFailed("; ".join(f"{c.name}: {c.detail}" for c in report.failures))
    ctx.store.advance(episode, State.VALIDATED)
    return episode


# --------------------------------------------------------------------------- #
# driver
# --------------------------------------------------------------------------- #


def run(
    cfg: PipelineConfig,
    *,
    force_repo: str | None = None,
    asr_engine: ASREngine | None = None,
    image_format: str = "png",
    stop_after: str | None = None,
) -> tuple[Episode, RunContext]:
    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    ctx = RunContext(cfg=cfg, store=store, ledger=ledger)
    log.info(
        "pipeline start on %s / python %s / ram %.1f GB",
        platform.platform(), platform.python_version(), total_ram_gb() or -1,
    )

    episode, packet = stage_discover(ctx, force_repo=force_repo)
    ctx.packet = packet
    try:
        if stop_after == "discover":
            return episode, ctx
        stage_script(ctx, episode, packet)
        if stop_after == "script":
            return episode, ctx
        stage_audio(ctx, episode, asr_engine=asr_engine)
        if stop_after == "audio":
            return episode, ctx
        stage_render(ctx, episode, image_format=image_format)
        if stop_after == "render":
            return episode, ctx
        stage_validate(ctx, episode, packet)
    except PipelineFailed as exc:
        store.fail(episode, str(exc))
        raise
    except Exception as exc:  # noqa: BLE001 - any crash must mark the episode
        store.fail(episode, f"{type(exc).__name__}: {exc}")
        raise
    return episode, ctx


def summarise(episode: Episode) -> str:
    lines = [
        f"episode   {episode.episode_id}",
        f"state     {episode.state.value}",
        f"topic     {episode.repo_full_name}",
    ]
    if episode.audio_duration_s:
        lines.append(f"audio     {episode.audio_duration_s:.2f}s ({episode.tts_engine})")
    if episode.audio_verification:
        av = episode.audio_verification
        lines.append(f"asr       WER {av.wer:.3f} (<= {av.threshold}) via {av.asr_engine}")
    if episode.render_path:
        lines.append(f"video     {episode.render_path}")
    if episode.validation:
        lines.append(
            f"gates     {sum(1 for c in episode.validation.checks if c.passed)}/"
            f"{len(episode.validation.checks)} passed"
        )
        for c in episode.validation.failures:
            lines.append(f"  FAIL    {c.name}: {c.detail}")
    if episode.failure_reason:
        lines.append(f"failure   {episode.failure_reason}")
    return "\n".join(lines)
