"""WER and technical-token agreement."""
from __future__ import annotations

from vtuber.verify_audio import check_technical, normalize, word_error_rate


def test_identical_text_is_zero_wer():
    text = "widgetctl v2.4.1 talks over a unix socket"
    wer, *_ = word_error_rate(text, text)
    assert wer == 0.0


def test_punctuation_and_case_are_forgiven():
    wer, *_ = word_error_rate("Widgetctl, v2.4.1 — ready.", "widgetctl v2.4.1 ready")
    assert wer == 0.0


def test_one_wrong_word_in_twenty_is_five_percent():
    ref = " ".join(f"word{i}" for i in range(20))
    hyp = ref.replace("word7", "ward7")
    wer, subs, dels, ins, n = word_error_rate(ref, hyp)
    assert (subs, dels, ins, n) == (1, 0, 0, 20)
    assert abs(wer - 0.05) < 1e-9


def test_version_mismatch_is_caught_even_at_low_wer():
    ref = " ".join(["filler"] * 40) + " release v2.4.1 shipped"
    hyp = " ".join(["filler"] * 40) + " release v2.4.2 shipped"
    wer, *_ = word_error_rate(ref, hyp)
    assert wer < 0.05          # WER alone would wave this through
    check = check_technical(ref, hyp)
    assert not check.ok
    assert "v2.4.1" in check.missing


def test_project_name_mangled_is_caught():
    check = check_technical("install faster-whisper today", "install faster whisperer today")
    assert not check.ok


def test_hyphen_spoken_as_space_is_accepted():
    check = check_technical("install faster-whisper today", "install faster whisper today")
    assert check.ok


def test_spelled_out_numbers_normalise():
    assert normalize("two cores") == ["2", "cores"]
