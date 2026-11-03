"""Configuration. Secrets never live here — see ``secrets_store``."""
from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DiscoveryConfig(Base):
    #: GitHub search queries, tried in order until enough candidates are found.
    queries: list[str] = Field(
        default_factory=lambda: [
            "topic:llm pushed:>={since} stars:>800",
            "topic:ai-agents pushed:>={since} stars:>500",
            "topic:developer-tools topic:cli pushed:>={since} stars:>1500",
            "topic:rag pushed:>={since} stars:>400",
        ]
    )
    #: Days of push recency a candidate must satisfy.
    activity_window_days: int = 21
    #: A repository used within this many days is skipped.
    cooldown_days: int = 120
    min_stars: int = 300
    max_candidates: int = 40
    #: How many top-ranked candidates get a `releases/latest` request. Each one
    #: costs a request, and an unauthenticated client only has 60 per hour.
    release_probe_top_n: int = 10
    #: Refuse to start a run with less core quota than this left.
    min_core_quota: int = 25
    #: Licences we are willing to quote from. ``None`` entry allows unlicensed
    #: repos to be discussed but never quoted.
    require_license: bool = True


class ScriptConfig(Base):
    target_words_min: int = 100
    target_words_max: int = 135
    duration_min_s: float = 45.0
    duration_max_s: float = 60.0
    #: Longest verbatim run (in words) allowed to match a source document.
    max_copied_run_words: int = 7
    #: Jaccard similarity above which a script counts as a repeat of a recent one.
    max_recent_similarity: float = 0.55
    recent_window: int = 30


class LLMConfig(Base):
    backend: Literal["ollama", "stub"] = "ollama"
    base_url: str = "http://127.0.0.1:11434"
    #: Writer and critic deliberately differ so the critic is not marking its
    #: own homework with identical weights.
    writer_model: str = "qwen2.5:7b-instruct"
    critic_model: str = "llama3.1:8b-instruct-q4_K_M"
    #: Smaller tags used automatically when total RAM is below ``low_ram_gb``.
    writer_model_low_ram: str = "qwen2.5:3b-instruct"
    critic_model_low_ram: str = "qwen2.5:3b-instruct"
    low_ram_gb: int = 12
    num_ctx: int = 8192
    temperature: float = 0.4
    timeout_s: float = 600.0
    max_attempts: int = 3


class TTSConfig(Base):
    engine: Literal["kokoro", "stub"] = "kokoro"
    #: hexgrad/Kokoro-82M. Pin a revision so output cannot drift silently.
    model_repo: str = "hexgrad/Kokoro-82M"
    model_revision: str = ""  # set by `vtuber bootstrap`; empty blocks publish
    voice: str = "af_heart"
    speed: float = 1.0
    sample_rate: int = 24000
    #: Subtle only. Peak normalisation plus a gentle high-pass; no noise bed.
    enhance: bool = True
    target_peak_dbfs: float = -1.5


class ASRConfig(Base):
    model: str = "small.en"
    compute_type: str = "int8"
    device: str = "cpu"
    beam_size: int = 5
    wer_threshold: float = 0.05
    max_synthesis_attempts: int = 2


class RenderConfig(Base):
    width: int = 1080
    height: int = 1920
    fps: int = 30
    crf: int = 20
    #: Explicit Chromium binary. Empty means "use Playwright's own download".
    chromium_executable: str = ""
    #: Optional hardware encoder to probe; falls back to libx264 on any failure.
    try_hwaccel: bool = True
    hwaccel_candidates: list[str] = Field(
        default_factory=lambda: ["h264_nvenc", "h264_qsv", "h264_amf"]
    )
    screenshot_timeout_ms: int = 15000
    #: Rendered frames are piped to ffmpeg; nothing is written frame-by-frame.
    pipe_frames: bool = True


class UploadConfig(Base):
    enabled: bool = False
    #: Local time of day the episode should go public, in ``timezone``.
    publish_local_time: str = "18:00"
    timezone: str = "Asia/Kolkata"
    #: The channel OAuth is expected to resolve to. Set during `vtuber auth`.
    expected_channel_id: str = ""
    expected_channel_title: str = ""
    category_id: str = "28"  # Science & Technology
    #: Only set when current YouTube guidance requires it for this content.
    declare_synthetic_media: bool = False
    self_declared_made_for_kids: bool = False
    #: Canary must have reached `processed` before public scheduling is allowed.
    canary_passed: bool = False
    max_upload_attempts: int = 3


class PipelineConfig(Base):
    project_root: Path = Path(".")
    episodes_dir: Path = Path("episodes")
    logs_dir: Path = Path("logs")
    state_dir: Path = Path("state")
    assets_dir: Path = Path("assets")
    templates_dir: Path = Path("templates")

    discovery: DiscoveryConfig = Field(default_factory=DiscoveryConfig)
    script: ScriptConfig = Field(default_factory=ScriptConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)
    asr: ASRConfig = Field(default_factory=ASRConfig)
    render: RenderConfig = Field(default_factory=RenderConfig)
    upload: UploadConfig = Field(default_factory=UploadConfig)

    def resolved(self) -> "PipelineConfig":
        root = self.project_root.resolve()
        data = self.model_dump()
        data["project_root"] = root
        for key in ("episodes_dir", "logs_dir", "state_dir", "assets_dir", "templates_dir"):
            p = Path(data[key])
            data[key] = p if p.is_absolute() else root / p
        return PipelineConfig(**data)


def _package_root() -> Path:
    # src/vtuber/config.py -> yt_vtuber/
    return Path(__file__).resolve().parents[2]


def load_config(path: str | Path | None = None) -> PipelineConfig:
    """Load config.toml, falling back to defaults rooted at the project dir.

    ``VTUBER_CONFIG`` overrides the path; ``VTUBER_LLM`` / ``VTUBER_TTS``
    override those backends (used by the test suite, never by the scheduler).
    """
    root = _package_root()
    candidate = Path(path) if path else Path(os.environ.get("VTUBER_CONFIG", root / "config" / "config.toml"))
    data: dict = {}
    if candidate.is_file():
        data = tomllib.loads(candidate.read_text(encoding="utf-8"))
    data.setdefault("project_root", str(root))
    cfg = PipelineConfig(**data)
    if backend := os.environ.get("VTUBER_LLM"):
        cfg.llm.backend = backend  # type: ignore[assignment]
    if engine := os.environ.get("VTUBER_TTS"):
        cfg.tts.engine = engine  # type: ignore[assignment]
    if chromium := os.environ.get("VTUBER_CHROMIUM"):
        cfg.render.chromium_executable = chromium
    return cfg.resolved()
