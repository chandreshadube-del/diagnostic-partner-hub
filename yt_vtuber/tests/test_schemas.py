"""Malformed generated payloads must never reach the renderer."""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from vtuber.models import Episode, Scene, Script, State, TRANSITIONS


def _scene(**over) -> dict:
    base = {
        "index": 0, "role": "hook", "template": "repo_overview", "avatar_pose": "point",
        "narration": "Here is the thing worth knowing about widgetctl this week.",
        "fact_ids": [],
        "payload": {"kind": "repo_overview", "repo": "widgetctl", "tagline": "fleet controller",
                    "language": "Python", "license": "Apache-2.0", "bullets": ["a", "b"]},
    }
    base.update(over)
    return base


def test_unknown_template_rejected():
    with pytest.raises(ValidationError):
        Scene.model_validate(_scene(template="motion_graphics"))


def test_payload_template_mismatch_rejected():
    bad = _scene(template="terminal_demo")
    with pytest.raises(ValidationError) as exc:
        Scene.model_validate(bad)
    assert "payload kind" in str(exc.value)


def test_missing_scene_field_rejected():
    bad = _scene()
    del bad["narration"]
    with pytest.raises(ValidationError):
        Scene.model_validate(bad)


def test_extra_field_rejected():
    with pytest.raises(ValidationError):
        Scene.model_validate(_scene(html="<div>nope</div>"))


def test_invalid_json_rejected():
    with pytest.raises(json.JSONDecodeError):
        Script.model_validate(json.loads("{not json"))


def test_factual_scene_without_citation_rejected():
    with pytest.raises(ValidationError) as exc:
        Scene.model_validate(_scene(index=1, role="detail", fact_ids=[]))
    assert "carries no fact_ids" in str(exc.value)


def test_script_requires_five_roles_in_order(stub_script):
    data = stub_script.model_dump()
    data["scenes"][1]["role"] = "takeaway"
    with pytest.raises(ValidationError):
        Script.model_validate(data)


def test_script_requires_template_variety(stub_script):
    data = stub_script.model_dump()
    for s in data["scenes"]:
        s["template"] = "repo_overview"
        s["payload"] = {"kind": "repo_overview", "repo": "w", "tagline": "t",
                        "language": "Python", "license": "Apache-2.0", "bullets": ["a", "b"]}
    with pytest.raises(ValidationError) as exc:
        Script.model_validate(data)
    assert "3 distinct templates" in str(exc.value)


def test_failed_state_is_terminal():
    assert TRANSITIONS[State.FAILED] == ()
    assert TRANSITIONS[State.PUBLISHED] == ()


def test_failed_episode_needs_reason():
    with pytest.raises(ValidationError):
        Episode(
            episode_id="2026-11-03-abcdef12",
            created_at="2026-11-03T00:00:00Z",
            topic="t", repo_full_name="a/b", state="failed",
        )


def test_retry_note_restates_the_broken_rule():
    """Three identical failures in a row meant the model was never told the rule."""
    from vtuber.script_gen import _retry_note

    note = _retry_note("payload.repo_overview.bullets: List should have at least 2 items")
    assert "2 to 4 strings" in note
    assert "REJECTED" in note


def test_retry_note_covers_the_discriminator():
    from vtuber.script_gen import _retry_note

    assert "payload.kind must equal" in _retry_note("payload: discriminator 'kind'")


def test_length_note_quotes_the_text_and_names_a_target():
    """"Rewrite to fit" is not actionable for a 7B model; a count and the text are."""
    from vtuber.script_gen import _length_note

    note = _length_note("Too short.", 28)
    assert "2 words" in note
    assert "too longer" in note or "too short" in note.lower()
    assert "about 28 words" in note
    assert '"Too short."' in note


def test_length_note_asks_to_shorten_when_over():
    from vtuber.script_gen import _length_note

    note = _length_note(" ".join(["word"] * 60), 20)
    assert "too shorter" in note or "shorter" in note


def test_per_scene_word_targets_sum_into_the_budget():
    """The per-scene plan must add up to the configured episode budget."""
    from vtuber.config import ScriptConfig
    from vtuber.script_gen import ROLE_SPECS

    cfg = ScriptConfig()
    assert [r.role for r in ROLE_SPECS] == ["hook", "what", "detail", "limitation", "takeaway"]
    total = sum(r.words for r in ROLE_SPECS)
    assert cfg.target_words_min <= total <= cfg.target_words_max, total


def test_every_scene_hint_is_a_valid_scene():
    """The example shown to the model must satisfy the schema it illustrates."""
    import json

    from vtuber.script_gen import ROLE_SPECS, _scene_hint

    for spec in ROLE_SPECS:
        Scene.model_validate(json.loads(_scene_hint(spec)))


def test_generation_error_carries_the_rejected_payload():
    from vtuber.script_gen import ScriptGenerationError

    exc = ScriptGenerationError("nope", last_raw={"scenes": []})
    assert exc.last_raw == {"scenes": []}


def test_discriminator_is_required_in_the_json_schema():
    """With a default, a schema-constrained model omits `kind` and the union breaks."""
    schema = Script.model_json_schema()
    for name in ("RepoOverviewPayload", "TerminalDemoPayload",
                 "ComparisonPayload", "ArchitecturePayload"):
        assert "kind" in schema["$defs"][name]["required"], name


def test_missing_payload_kind_is_taken_from_the_template():
    payload = {"repo": "w", "tagline": "t", "language": "Python",
               "license": "MIT", "bullets": ["a", "b"]}
    scene = Scene.model_validate(_scene(payload=payload))
    assert scene.payload.kind == "repo_overview"


def test_inferred_kind_does_not_hide_a_shape_mismatch():
    """Filling kind from template must not let the wrong payload through."""
    bad = _scene(template="comparison", payload={"repo": "w", "tagline": "t",
                                                 "language": "Python", "license": "MIT",
                                                 "bullets": ["a", "b"]})
    with pytest.raises(ValidationError) as exc:
        Scene.model_validate(bad)
    assert "discriminator" not in str(exc.value).lower()


def test_an_explicit_wrong_kind_is_still_rejected():
    bad = _scene(template="comparison")
    with pytest.raises(ValidationError):
        Scene.model_validate(bad)
