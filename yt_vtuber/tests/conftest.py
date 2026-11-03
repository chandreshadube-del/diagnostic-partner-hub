from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vtuber.config import PipelineConfig  # noqa: E402
from vtuber.models import (  # noqa: E402
    EvidencePacket,
    Fact,
    SourceRef,
)


def iso(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


@pytest.fixture
def cfg(tmp_path: Path) -> PipelineConfig:
    c = PipelineConfig(project_root=ROOT)
    c = c.resolved()
    c.episodes_dir = tmp_path / "episodes"
    c.state_dir = tmp_path / "state"
    c.logs_dir = tmp_path / "logs"
    c.llm.backend = "stub"
    c.tts.engine = "stub"
    c.render.try_hwaccel = False
    c.render.chromium_executable = os.environ.get("VTUBER_CHROMIUM", "")
    return c


@pytest.fixture
def packet() -> EvidencePacket:
    t = iso("2026-11-01T09:00:00")
    refs = [
        SourceRef(ref_id="repo", url="https://api.github.com/repos/acme/widgetctl",
                  source_type="repository", retrieved_at=t, title="repo metadata"),
        SourceRef(ref_id="readme", url="https://api.github.com/repos/acme/widgetctl/readme",
                  source_type="readme", retrieved_at=t, title="README"),
        SourceRef(ref_id="release", url="https://github.com/acme/widgetctl/releases/latest",
                  source_type="release", retrieved_at=t, title="v2.4.1"),
        SourceRef(ref_id="license", url="https://github.com/acme/widgetctl/blob/HEAD/LICENSE",
                  source_type="license", retrieved_at=t, title="LICENSE"),
    ]
    facts = [
        Fact(fact_id="f_identity", claim="acme/widgetctl is a Python project on GitHub "
                                         "released under Apache-2.0.", source_refs=["repo"]),
        Fact(fact_id="f_purpose", claim="The project describes itself as: a command line "
                                        "controller for widget fleets", source_refs=["repo"],
             attributed=True, quote="a command line controller for widget fleets"),
        Fact(fact_id="f_activity", claim="The default branch was last pushed on 2026-10-29.",
             source_refs=["repo"]),
        Fact(fact_id="f_license", claim="acme/widgetctl is distributed under the Apache-2.0 licence.",
             source_refs=["license", "repo"]),
        Fact(fact_id="f_release", claim="The latest published release is v2.4.1, published 2026-10-28.",
             source_refs=["release"]),
        Fact(fact_id="f_readme_0", claim="The README states: widgetctl talks to the fleet daemon "
                                         "over a local unix socket and never opens a network port.",
             source_refs=["readme"], attributed=True,
             quote="widgetctl talks to the fleet daemon over a local unix socket and never opens a network port."),
        Fact(fact_id="f_readme_1", claim="The README states: configuration is a single TOML file "
                                         "resolved from the working directory upwards.",
             source_refs=["readme"], attributed=True,
             quote="configuration is a single TOML file resolved from the working directory upwards."),
        Fact(fact_id="f_usage_0", claim="The README documents this shell usage: pip install widgetctl",
             source_refs=["readme"], attributed=True, quote="pip install widgetctl"),
    ]
    return EvidencePacket(
        topic="a command line controller for widget fleets",
        repo_full_name="acme/widgetctl",
        collected_at=t,
        source_refs=refs,
        facts=facts,
        license_spdx="Apache-2.0",
        corpus={
            "readme": "widgetctl talks to the fleet daemon over a local unix socket and never "
                      "opens a network port. configuration is a single TOML file resolved from "
                      "the working directory upwards.",
            "snippets": "pip install widgetctl",
        },
    )


@pytest.fixture
def stub_script(packet):
    """A schema-valid script produced by the deterministic stub writer."""
    from vtuber.config import ScriptConfig
    from vtuber.llm import build
    from vtuber.script_gen import generate
    from vtuber.config import LLMConfig

    writer = build(LLMConfig(backend="stub"), "writer")
    script, _notes = generate(writer, packet, ScriptConfig(target_words_min=60, target_words_max=200))
    return script


@pytest.fixture
def stub_episode(packet, stub_script):
    """A fully populated episode with stub audio + a self-consistent transcript."""
    from vtuber.models import AudioVerification, Episode, State, WordTimestamp

    ep = Episode(
        episode_id="2026-11-03-aaaaaaaa",
        created_at=iso("2026-11-03T08:00:00"),
        topic=packet.topic,
        repo_full_name=packet.repo_full_name,
        source_refs=packet.source_refs,
        facts=packet.facts,
        script=stub_script,
        generator="stub:writer",
        tts_engine="stub:tone",
        state=State.SCRIPTED,
    )
    # A "perfect transcript": one ASR word per normalised script word, so these
    # fixtures exercise alignment rather than ASR error handling.
    from vtuber.verify_audio import normalize

    words = normalize(stub_script.narration)
    t = 0.0
    wts = []
    for w in words:
        dur = 0.08 + 0.035 * len(w)
        wts.append(WordTimestamp(word=w, start=round(t, 3), end=round(t + dur, 3)))
        t += dur + 0.03
    ep.word_timestamps = wts
    ep.transcript = stub_script.narration
    ep.audio_duration_s = round(t, 3)
    ep.audio_verification = AudioVerification(
        engine="stub:tone", asr_engine="fixture", wer=0.0, threshold=0.05,
        technical_mismatches=[], attempts=1, passed=True,
    )
    return ep
