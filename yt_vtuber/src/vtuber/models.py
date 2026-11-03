"""Strict schemas for every artefact the pipeline produces.

Every model is `extra="forbid"` on purpose: a generated payload that invents a
field is a defect, not something to tolerate.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    StringConstraints,
    field_validator,
    model_validator,
)

# --------------------------------------------------------------------------- #
# primitives
# --------------------------------------------------------------------------- #

Str = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

#: Tokens that must survive text-to-speech byte-for-byte: identifiers, version
#: strings, numbers with units. Checked for exact agreement against the ASR
#: transcript (see ``verify_audio``).
TECHNICAL_TOKEN_RE = re.compile(
    r"""(?x)
    \b(?:
        v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?   # 1.2.3 / v0.9.4 / 1.0.0-rc.1
      | \d+(?:\.\d+)?\s?(?:k|K|M|B|GB|MB|TB|ms|s|x)\b   # 82M, 500ms, 4x
      | [A-Za-z][A-Za-z0-9_]*(?:[-_/.][A-Za-z0-9_]+)+   # faster-whisper, org/repo
      | [A-Z]{2,}\d*                                     # LLM, GPU, API, H264
    )\b
    """
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class State(StrEnum):
    DISCOVERED = "discovered"
    RESEARCHED = "researched"
    SCRIPTED = "scripted"
    AUDIO_READY = "audio_ready"
    RENDERED = "rendered"
    VALIDATED = "validated"
    CANARY_PASSED = "canary_passed"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"
    FAILED = "failed"


#: The only legal forward transitions. Anything else is a bug and is rejected
#: by ``state.advance`` so a failed episode can never creep towards upload.
TRANSITIONS: dict[State, tuple[State, ...]] = {
    State.DISCOVERED: (State.RESEARCHED,),
    State.RESEARCHED: (State.SCRIPTED,),
    State.SCRIPTED: (State.AUDIO_READY,),
    State.AUDIO_READY: (State.RENDERED,),
    State.RENDERED: (State.VALIDATED,),
    State.VALIDATED: (State.CANARY_PASSED, State.SCHEDULED),
    State.CANARY_PASSED: (State.SCHEDULED,),
    State.SCHEDULED: (State.PUBLISHED,),
    State.PUBLISHED: (),
    State.FAILED: (),
}

TemplateName = Literal["repo_overview", "terminal_demo", "comparison", "architecture"]
TEMPLATE_NAMES: tuple[str, ...] = (
    "repo_overview",
    "terminal_demo",
    "comparison",
    "architecture",
)

AvatarPose = Literal["idle", "talk", "point", "think", "nod"]
AVATAR_POSES: tuple[str, ...] = ("idle", "talk", "point", "think", "nod")

SourceType = Literal["repository", "readme", "release", "license", "docs", "api"]


# --------------------------------------------------------------------------- #
# evidence
# --------------------------------------------------------------------------- #


class SourceRef(Base):
    """One retrieved primary source, with the time it was retrieved."""

    ref_id: Str
    url: HttpUrl
    source_type: SourceType
    retrieved_at: datetime
    title: str | None = None
    #: sha256 of the retrieved body, so a later run can tell the source changed.
    content_sha256: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")] | None = None


class Fact(Base):
    """A claim the script is allowed to make, plus where it came from.

    ``attributed`` marks a claim the project makes about itself (a README
    assertion). Those must be voiced as attribution, never as verified fact.
    """

    fact_id: Str
    claim: Annotated[str, StringConstraints(strip_whitespace=True, min_length=8)]
    source_refs: Annotated[list[str], Field(min_length=1)]
    attributed: bool = False
    #: Verbatim snippet the claim was drawn from, used by the critic and by the
    #: copied-passage check.
    quote: str | None = None

    @field_validator("source_refs")
    @classmethod
    def _unique(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("duplicate source_refs")
        return v


class EvidencePacket(Base):
    topic: Str
    repo_full_name: Annotated[str, StringConstraints(pattern=r"^[\w.-]+/[\w.-]+$")]
    collected_at: datetime
    source_refs: Annotated[list[SourceRef], Field(min_length=2)]
    facts: Annotated[list[Fact], Field(min_length=3)]
    license_spdx: str | None = None
    #: Raw text kept for the copied-passage check; never rendered or spoken.
    corpus: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _facts_resolve(self) -> "EvidencePacket":
        known = {s.ref_id for s in self.source_refs}
        for f in self.facts:
            missing = set(f.source_refs) - known
            if missing:
                raise ValueError(f"fact {f.fact_id} cites unknown refs: {sorted(missing)}")
        return self


# --------------------------------------------------------------------------- #
# scene payloads — one model per template, so an unknown template or a
# malformed payload cannot reach the renderer.
# --------------------------------------------------------------------------- #

Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=96)]


class RepoOverviewPayload(Base):
    kind: Literal["repo_overview"] = "repo_overview"
    repo: Short
    tagline: Annotated[str, StringConstraints(min_length=1, max_length=110)]
    language: Short
    license: Short
    bullets: Annotated[list[Line], Field(min_length=2, max_length=4)]


class TerminalDemoPayload(Base):
    kind: Literal["terminal_demo"] = "terminal_demo"
    title: Short
    #: Shell lines. ``prompt`` lines are typed, ``out`` lines are printed.
    lines: Annotated[
        list[tuple[Literal["prompt", "out", "comment"], Annotated[str, StringConstraints(max_length=72)]]],
        Field(min_length=2, max_length=10),
    ]


class ComparisonPayload(Base):
    kind: Literal["comparison"] = "comparison"
    title: Short
    left_label: Short
    right_label: Short
    rows: Annotated[list[tuple[Line, Line, Line]], Field(min_length=2, max_length=4)]


class ArchitecturePayload(Base):
    kind: Literal["architecture"] = "architecture"
    title: Short
    #: Ordered stages drawn top to bottom; each may carry one short note.
    nodes: Annotated[list[tuple[Short, Annotated[str, StringConstraints(max_length=48)]]], Field(min_length=2, max_length=5)]
    edge_label: Annotated[str, StringConstraints(max_length=32)] | None = None


ScenePayload = Annotated[
    RepoOverviewPayload | TerminalDemoPayload | ComparisonPayload | ArchitecturePayload,
    Field(discriminator="kind"),
]

SceneRole = Literal["hook", "what", "detail", "limitation", "takeaway"]
SCENE_ROLES: tuple[str, ...] = ("hook", "what", "detail", "limitation", "takeaway")


class Scene(Base):
    index: int = Field(ge=0, lt=16)
    role: SceneRole
    template: TemplateName
    avatar_pose: AvatarPose
    narration: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=420)]
    #: Facts this scene's narration rests on. Empty is legal only for the hook
    #: and the takeaway, which carry no standalone factual claim.
    fact_ids: list[str] = Field(default_factory=list)
    payload: ScenePayload

    @model_validator(mode="after")
    def _payload_matches_template(self) -> "Scene":
        if self.payload.kind != self.template:
            raise ValueError(f"payload kind {self.payload.kind!r} != template {self.template!r}")
        if not self.fact_ids and self.role in ("what", "detail", "limitation"):
            raise ValueError(f"scene {self.index} ({self.role}) carries no fact_ids")
        return self


class Script(Base):
    scenes: Annotated[list[Scene], Field(min_length=5, max_length=6)]
    #: Original framing the episode adds on top of the sources — the reason the
    #: episode is not a README read-aloud.
    angle: Annotated[str, StringConstraints(min_length=20, max_length=300)]

    @model_validator(mode="after")
    def _structure(self) -> "Script":
        roles = [s.role for s in self.scenes]
        required = ["hook", "what", "detail", "limitation", "takeaway"]
        if roles[: len(required)] != required:
            raise ValueError(f"scene roles must start {required}, got {roles}")
        if [s.index for s in self.scenes] != list(range(len(self.scenes))):
            raise ValueError("scene indices must be 0..n-1 in order")
        if len({s.template for s in self.scenes}) < 3:
            raise ValueError("episode must use at least 3 distinct templates")
        return self

    @property
    def narration(self) -> str:
        return " ".join(s.narration for s in self.scenes)

    @property
    def word_count(self) -> int:
        return len(self.narration.split())


# --------------------------------------------------------------------------- #
# audio / render
# --------------------------------------------------------------------------- #


class WordTimestamp(Base):
    word: Str
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    probability: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def _ordered(self) -> "WordTimestamp":
        if self.end < self.start:
            raise ValueError("end before start")
        return self


class AudioVerification(Base):
    engine: Str
    asr_engine: Str
    wer: float = Field(ge=0)
    threshold: float = Field(ge=0)
    technical_mismatches: list[str] = Field(default_factory=list)
    attempts: int = Field(ge=1)
    passed: bool


class RenderSettings(Base):
    width: int = 1080
    height: int = 1920
    fps: int = 30
    crf: int = 20
    video_codec: Str = "libx264"
    audio_codec: Str = "aac"
    hwaccel: str | None = None
    chromium_version: str | None = None
    ffmpeg_version: str | None = None


class CheckResult(Base):
    name: Str
    passed: bool
    detail: str = ""
    blocking: bool = True


class ValidationReport(Base):
    checks: list[CheckResult] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks if c.blocking)

    @property
    def failures(self) -> list[CheckResult]:
        return [c for c in self.checks if c.blocking and not c.passed]


class UploadRecord(Base):
    video_id: str | None = None
    uploaded_at: datetime | None = None
    privacy_status: str | None = None
    publish_at: datetime | None = None
    upload_status: str | None = None
    failure_reason: str | None = None
    rejection_reason: str | None = None
    contains_synthetic_media: bool | None = None
    is_canary: bool = False
    channel_id: str | None = None


# --------------------------------------------------------------------------- #
# the episode record
# --------------------------------------------------------------------------- #


class Episode(Base):
    episode_id: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}-[a-z0-9]{8}$")]
    created_at: datetime
    topic: Str
    repo_full_name: str

    state: State = State.DISCOVERED
    failure_reason: str | None = None

    source_refs: list[SourceRef] = Field(default_factory=list)
    facts: list[Fact] = Field(default_factory=list)
    script: Script | None = None

    audio_path: str | None = None
    audio_duration_s: float | None = None
    transcript: str | None = None
    word_timestamps: list[WordTimestamp] = Field(default_factory=list)
    audio_verification: AudioVerification | None = None

    timeline_path: str | None = None
    render_path: str | None = None
    render_settings: RenderSettings | None = None
    render_duration_s: float | None = None

    validation: ValidationReport | None = None
    title: str | None = None
    description: str | None = None
    publish_time: datetime | None = None
    upload: UploadRecord | None = None

    #: Which generator produced the script. A stub generator may never publish.
    generator: str | None = None
    tts_engine: str | None = None

    @model_validator(mode="after")
    def _failed_has_reason(self) -> "Episode":
        if self.state is State.FAILED and not self.failure_reason:
            raise ValueError("failed episode needs failure_reason")
        return self
