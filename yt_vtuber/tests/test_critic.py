"""An unsupported claim, a missing citation or a copied passage blocks the run."""
from __future__ import annotations

from vtuber.config import ScriptConfig
from vtuber.critic import longest_copied_run, run as critic_run, verify_claims
from vtuber.models import Script


def _mutate(script: Script, index: int, **over) -> Script:
    data = script.model_dump()
    data["scenes"][index].update(over)
    return Script.model_validate(data)


def test_clean_script_passes(stub_script, packet):
    assert verify_claims(stub_script, packet).passed


def test_invented_version_number_blocks(stub_script, packet):
    bad = _mutate(
        stub_script, 2,
        narration="The maintainers say v9.9.9 landed last week and changed the socket protocol.",
    )
    rep = verify_claims(bad, packet)
    assert not rep.passed
    assert any("v9.9.9" in t for t in rep.unsupported_tokens)


def test_invented_metric_blocks(stub_script, packet):
    bad = _mutate(
        stub_script, 2,
        narration="The README states it handles 40000 widgets per second on a laptop.",
    )
    rep = verify_claims(bad, packet)
    assert not rep.passed
    assert any("40000" in n for n in rep.unsupported_numbers)


def test_unknown_fact_id_blocks(stub_script, packet):
    bad = _mutate(stub_script, 1, fact_ids=["f_does_not_exist"])
    rep = verify_claims(bad, packet)
    assert not rep.passed
    assert rep.missing_citations


def test_attributed_claim_voiced_as_fact_blocks(stub_script, packet):
    bad = _mutate(
        stub_script, 1,
        fact_ids=["f_purpose"],
        narration="widgetctl is the fastest fleet controller available and it never opens a port.",
    )
    rep = verify_claims(bad, packet)
    assert not rep.passed
    assert rep.unattributed_claims


def test_filler_blocks(stub_script, packet):
    bad = _mutate(
        stub_script, 0,
        narration="In this video we dive into widgetctl, don't forget to subscribe.",
    )
    rep = verify_claims(bad, packet)
    assert not rep.passed
    assert rep.filler


def test_copied_passage_detected(stub_script, packet):
    copied = _mutate(
        stub_script, 1,
        fact_ids=["f_readme_0"],
        narration=(
            "The README states widgetctl talks to the fleet daemon over a local unix socket "
            "and never opens a network port."
        ),
    )
    run_len, text = longest_copied_run(copied, packet)
    assert run_len >= 12, (run_len, text)
    rep = critic_run(copied, packet, ScriptConfig(max_copied_run_words=7))
    assert not rep.passed
    assert rep.copied_runs


def test_original_phrasing_is_not_flagged_as_copied(stub_script, packet):
    run_len, _ = longest_copied_run(stub_script, packet)
    assert run_len <= 7, run_len


def test_payload_numbers_also_need_evidence(stub_script, packet):
    data = stub_script.model_dump()
    data["scenes"][3]["payload"]["rows"][0] = ["Throughput", "9999 ops", "n/a"]
    bad = Script.model_validate(data)
    rep = verify_claims(bad, packet)
    assert not rep.passed
    assert any("9999" in n for n in rep.unsupported_numbers)


def test_english_compounds_are_not_treated_as_identifiers():
    """A hand-written list of compounds leaked on the first real run ('on-the-go')."""
    from vtuber.critic import _is_english_compound

    for word in ("on-the-go", "trade-off", "read-only", "out-of-the-box",
                 "end-to-end", "real-time", "drop-in", "third-party"):
        assert _is_english_compound(word), word


def test_real_identifiers_still_need_evidence():
    from vtuber.critic import _is_english_compound

    for token in ("faster-whisper", "owner/repo", "h264_nvenc", "turbo-cache",
                  "qwen2.5", "v1.2.3"):
        assert not _is_english_compound(token), token


def test_verify_scene_checks_one_scene(stub_script, packet):
    from vtuber.critic import verify_scene

    assert verify_scene(stub_script.scenes[0], packet).passed


def test_verify_scene_catches_an_invented_name(stub_script, packet):
    from vtuber.critic import verify_scene
    from vtuber.models import Script

    data = stub_script.model_dump()
    data["scenes"][1]["narration"] = (
        "The maintainers say turbo-cache is bundled with it from version two."
    )
    scene = Script.model_validate(data).scenes[1]
    rep = verify_scene(scene, packet)
    assert not rep.passed
    assert any("turbo-cache" in t for t in rep.unsupported_tokens)


def test_critic_note_names_the_attribution_fix(stub_script, packet):
    from vtuber.critic import CriticReport
    from vtuber.script_gen import _critic_note

    rep = CriticReport(unattributed_claims=["scene 2 rests on an attributed claim"])
    note = _critic_note(rep, "It never opens a network port.")
    assert "the maintainers say" in note
    assert '"It never opens a network port."' in note


def _script_with(stub_script, **per_index):  # noqa: ANN001
    from vtuber.models import Script

    data = stub_script.model_dump()
    for i, narration in per_index.items():
        data["scenes"][int(i)]["narration"] = narration
    return Script.model_validate(data)


def test_same_opening_in_three_scenes_blocks(stub_script):
    """A real run opened all five scenes with "The maintainers say"."""
    from vtuber.critic import check_self_repetition

    script = _script_with(
        stub_script,
        **{str(i): f"The maintainers say this is point number {i} which means it matters."
           for i in range(5)},
    )
    rep = check_self_repetition(script)
    assert not rep.passed
    assert rep.repeated_openings


def test_two_scenes_may_share_an_opening(stub_script):
    from vtuber.critic import check_self_repetition

    script = _script_with(
        stub_script,
        **{"0": "The maintainers say it runs locally, which means no network hop.",
           "1": "The maintainers say the config is one file, so onboarding is quick."},
    )
    assert not check_self_repetition(script).repeated_openings


def test_a_command_repeated_across_scenes_blocks(stub_script):
    """The takeaway repeated the detail's shell command verbatim on a real run."""
    from vtuber.critic import check_self_repetition

    script = _script_with(
        stub_script,
        **{"2": "Run npx hyperframes init my-video to scaffold it, which means no config.",
           "4": "Just run npx hyperframes init my-video and judge it yourself."},
    )
    rep = check_self_repetition(script)
    assert not rep.passed
    assert rep.repeated_phrases


def test_a_vacuous_limitation_blocks(stub_script):
    from vtuber.critic import check_self_repetition

    script = _script_with(
        stub_script,
        **{"3": "The catch is it has not been benchmarked for speed or performance yet."},
    )
    rep = check_self_repetition(script)
    assert rep.vacuous_limitation


def test_a_specific_limitation_passes(stub_script):
    from vtuber.critic import check_self_repetition

    script = _script_with(
        stub_script,
        **{"3": "The trade-off is the unix socket design, which means no remote control "
                "without a tunnel of your own."},
    )
    assert not check_self_repetition(script).vacuous_limitation


def test_a_script_with_no_reasoning_blocks(stub_script):
    """Five paraphrased README sentences satisfied every other check."""
    from vtuber.critic import check_self_repetition

    script = _script_with(
        stub_script,
        **{str(i): f"The README states fact number {i} about the project plainly."
           for i in range(5)},
    )
    rep = check_self_repetition(script)
    assert rep.no_analysis


def test_smart_quotes_are_folded_before_tts(stub_script):
    """A curly apostrophe reaches the voice, the captions and the WER check."""
    from vtuber.models import Scene

    data = stub_script.scenes[0].model_dump()
    data["narration"] = "It’s a tool — and it… works, which means less setup."
    scene = Scene.model_validate(data)
    assert "’" not in scene.narration
    assert "—" not in scene.narration
    assert "It's a tool - and it... works" in scene.narration
