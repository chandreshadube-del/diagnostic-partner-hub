"""The per-scene generation loop."""
from __future__ import annotations

from typing import Any

import pytest

from vtuber.config import LLMConfig, ScriptConfig
from vtuber.llm import build
from vtuber.script_gen import ROLE_SPECS, ScriptGenerationError, generate


def _writer():  # noqa: ANN202
    return build(LLMConfig(backend="stub"), "writer")


def test_generates_five_scenes_in_role_order(packet):
    script, notes = generate(_writer(), packet, ScriptConfig())
    assert [s.role for s in script.scenes] == [r.role for r in ROLE_SPECS]
    assert [s.index for s in script.scenes] == [0, 1, 2, 3, 4]
    assert any("accepted" in n for n in notes)


def test_total_length_lands_in_the_budget(packet):
    cfg = ScriptConfig()
    script, _ = generate(_writer(), packet, cfg)
    assert cfg.target_words_min <= script.word_count <= cfg.target_words_max


def test_uses_at_least_three_templates(packet):
    script, _ = generate(_writer(), packet, ScriptConfig())
    assert len({s.template for s in script.scenes}) >= 3


def test_factual_scenes_cite_evidence(packet):
    script, _ = generate(_writer(), packet, ScriptConfig())
    known = {f.fact_id for f in packet.facts}
    for scene in script.scenes:
        if scene.role in ("what", "detail", "limitation"):
            assert scene.fact_ids
            assert set(scene.fact_ids) <= known


class _ShortWriter:
    """Always answers with one clipped sentence — the real 7B failure mode."""

    name = "stub:short"

    def __init__(self, give_up_after: int | None = None) -> None:
        self.calls = 0
        self.give_up_after = give_up_after

    def json_complete(self, system: str, user: str, *, schema_hint: str,
                      schema: dict[str, Any] | None = None) -> dict[str, Any]:
        self.calls += 1
        if "state the angle" in user.lower():
            return {"angle": "An angle long enough to satisfy the validator here."}
        import json as _json

        scene = _json.loads(schema_hint)
        scene["narration"] = "Too short."
        return scene


def test_a_short_scene_is_retried_then_fails_that_scene_only(packet):
    writer = _ShortWriter()
    with pytest.raises(ScriptGenerationError) as exc:
        generate(writer, packet, ScriptConfig(), max_attempts=3)
    # Three attempts at scene 0, and it never proceeds to scene 1.
    assert writer.calls == 3
    assert "scene 0 (hook)" in str(exc.value)
    assert exc.value.last_raw is not None


def test_retry_feedback_includes_what_was_written(packet):
    """The retry must quote the text back; otherwise the model repeats itself."""
    seen: list[str] = []

    class Recorder(_ShortWriter):
        def json_complete(self, system, user, *, schema_hint, schema=None):  # noqa: ANN001
            seen.append(user)
            return super().json_complete(system, user, schema_hint=schema_hint, schema=schema)

    with pytest.raises(ScriptGenerationError):
        generate(Recorder(), packet, ScriptConfig(), max_attempts=2)
    assert '"Too short."' in seen[-1]
    assert "about 18 words" in seen[-1]


def test_scene_prompts_name_the_earlier_scenes(packet):
    """Each scene must know what has been said, or the episode repeats itself."""
    seen: list[str] = []

    class Recorder:
        name = "stub:recorder"

        def __init__(self) -> None:
            self.inner = build(LLMConfig(backend="stub"), "writer")

        def json_complete(self, system, user, *, schema_hint, schema=None):  # noqa: ANN001
            seen.append(user)
            return self.inner.json_complete(system, user, schema_hint=schema_hint, schema=schema)

    generate(Recorder(), packet, ScriptConfig())
    assert "nothing yet" in seen[0]
    assert "scene 0 (hook)" in seen[1]
