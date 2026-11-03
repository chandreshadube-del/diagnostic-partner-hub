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


def test_a_scene_failing_the_critic_is_retried_alone(packet):
    """Checking only at the end threw away four good scenes with the fifth."""
    from typing import Any

    from vtuber.config import LLMConfig
    from vtuber.llm import build

    class Unattributed:
        """Cites an attributed fact but states it as plain fact, until told off."""

        name = "stub:unattributed"

        def __init__(self) -> None:
            self.inner = build(LLMConfig(backend="stub"), "writer")
            self.rejections = 0

        def json_complete(self, system, user, *, schema_hint, schema=None):  # noqa: ANN001
            out = self.inner.json_complete(system, user, schema_hint=schema_hint, schema=schema)
            if "REJECTED by the fact checker" in user:
                self.rejections += 1
                return out
            if out.get("role") == "what":
                out["narration"] = (
                    "It talks to the fleet daemon over a local unix socket and never opens "
                    "a network port, which is a real design decision worth knowing about."
                )
            return out

        
    writer = Unattributed()
    script, notes = generate(writer, packet, ScriptConfig())
    assert writer.rejections >= 1, notes
    # The scene was fixed in place; the other four were never regenerated.
    assert len(script.scenes) == 5
    assert any("critic" in n for n in notes)


class _TerseWriter:
    """Writes a fixed fraction of whatever length it is asked for.

    The real 7B model undershoots every target, which is what makes a per-scene
    length rejection so wasteful and a whole-episode sweep necessary.
    """

    name = "stub:terse"

    def __init__(self, ratio: float = 0.6) -> None:
        self.ratio = ratio
        self.inner = None
        self.targets_asked: list[int] = []

    def json_complete(self, system, user, *, schema_hint, schema=None):  # noqa: ANN001
        import re as _re

        from vtuber.config import LLMConfig
        from vtuber.llm import build

        if self.inner is None:
            self.inner = build(LLMConfig(backend="stub"), "writer")
        if "state the angle" in user.lower():
            return {"angle": "An angle long enough to satisfy the validator comfortably."}
        m = _re.search(r"about (\d+) words", user)
        asked = int(m.group(1)) if m else 24
        self.targets_asked.append(asked)

        out = self.inner.json_complete(system, user, schema_hint=schema_hint, schema=schema)
        want = max(8, round(asked * self.ratio))
        tail = ["which", "means", "it", "matters."]
        words = [w for w in out["narration"].split() if w not in tail]
        while len(words) < want - len(tail):
            words.append("more")
        out["narration"] = " ".join(words[: want - len(tail)] + tail)
        assert len(out["narration"].split()) == want
        return out


def test_a_nineteen_word_scene_is_within_tolerance():
    """19 words against a 19.5-word floor once discarded four good scenes."""
    from vtuber.script_gen import LENGTH_TOLERANCE_LOW, ROLE_SPECS

    assert ROLE_SPECS[2].words * LENGTH_TOLERANCE_LOW <= 19


def test_a_terse_writer_triggers_a_length_sweep(packet):
    writer = _TerseWriter(ratio=0.6)
    try:
        generate(writer, packet, ScriptConfig())
    except ScriptGenerationError:
        pass  # may still fall short; the sweep having run is the point
    assert max(writer.targets_asked) > max(r.words for r in ROLE_SPECS), writer.targets_asked


def test_a_cooperative_writer_needs_no_sweep(packet):
    cfg = ScriptConfig()
    writer = _TerseWriter(ratio=1.0)
    script, notes = generate(writer, packet, cfg)
    assert cfg.target_words_min <= script.word_count <= cfg.target_words_max
    assert not any("length sweep" in n for n in notes), notes


def test_a_writer_that_stays_short_fails_on_the_episode_total(packet):
    """Each scene is within its own tolerance; only the sum is wrong."""
    writer = _TerseWriter(ratio=0.55)
    with pytest.raises(ScriptGenerationError, match="spoken words, need"):
        generate(writer, packet, ScriptConfig())


def test_a_scene_far_below_tolerance_still_fails_as_a_scene(packet):
    writer = _TerseWriter(ratio=0.25)
    with pytest.raises(ScriptGenerationError, match="failed after 3 attempts"):
        generate(writer, packet, ScriptConfig())
