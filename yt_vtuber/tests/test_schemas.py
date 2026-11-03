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

    note = _retry_note("scenes.3.payload.repo_overview.bullets: List should have at least 2 items")
    assert "2 to 4 strings" in note
    assert "REJECTED" in note


def test_retry_note_handles_several_violations():
    from vtuber.script_gen import _retry_note

    note = _retry_note("scenes.0.payload.comparison.rows: too short; scenes.2.fact_ids: missing")
    assert "2 to 4 [label, left, right] triples" in note
    assert "at least one fact_id" in note


def test_schema_hint_is_itself_valid():
    """The example shown to the model must satisfy the schema it illustrates."""
    import json

    from vtuber.script_gen import SCHEMA_HINT
    from vtuber.models import Script

    Script.model_validate(json.loads(SCHEMA_HINT.replace("...", "placeholder text here")))


def test_generation_error_carries_the_rejected_payload():
    from vtuber.script_gen import ScriptGenerationError

    exc = ScriptGenerationError("nope", last_raw={"scenes": []})
    assert exc.last_raw == {"scenes": []}
