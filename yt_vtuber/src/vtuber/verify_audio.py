"""Compare an ASR transcript against the intended script.

Two independent bars:

1. Normalised word error rate at or below the configured threshold.
2. Exact agreement on technical names, version strings and numbers. A 3%% WER
   is meaningless if the one mangled word was the version number.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from .models import TECHNICAL_TOKEN_RE

log = logging.getLogger(__name__)

_PUNCT = re.compile(r"[^\w\s./+-]")
_WS = re.compile(r"\s+")

_NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12", "twenty": "20", "thirty": "30", "forty": "40",
    "fifty": "50", "hundred": "100", "thousand": "1000", "million": "1000000",
}


def normalize(text: str) -> list[str]:
    """Lowercase, strip punctuation that TTS/ASR legitimately disagree about."""
    t = text.lower().replace("—", " ").replace("–", " ")
    t = _PUNCT.sub(" ", t)
    t = _WS.sub(" ", t).strip()
    out: list[str] = []
    for w in t.split():
        w = w.strip("./-+")
        if not w:
            continue
        out.append(_NUMBER_WORDS.get(w, w))
    return out


def word_error_rate(reference: str, hypothesis: str) -> tuple[float, int, int, int, int]:
    """Levenshtein WER. Returns (wer, substitutions, deletions, insertions, n_ref)."""
    ref, hyp = normalize(reference), normalize(hypothesis)
    n, m = len(ref), len(hyp)
    if n == 0:
        return (0.0 if m == 0 else 1.0), 0, 0, m, 0

    # full DP with backtrace counters folded into the cell
    # cell = (cost, subs, dels, ins)
    prev: list[tuple[int, int, int, int]] = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur: list[tuple[int, int, int, int]] = [(i, 0, i, 0)]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur.append(prev[j - 1])
                continue
            sub = prev[j - 1]
            dele = prev[j]
            ins = cur[j - 1]
            best = min(
                (sub[0] + 1, sub[1] + 1, sub[2], sub[3]),
                (dele[0] + 1, dele[1], dele[2] + 1, dele[3]),
                (ins[0] + 1, ins[1], ins[2], ins[3] + 1),
                key=lambda c: c[0],
            )
            cur.append(best)
        prev = cur
    cost, subs, dels, ins = prev[m]
    return cost / n, subs, dels, ins, n


@dataclass(slots=True)
class TechnicalCheck:
    missing: list[str]
    extra: list[str]

    @property
    def ok(self) -> bool:
        return not self.missing


#: Tokens whose absence from a transcript is an ASR artefact, not a mismatch.
_IGNORE = {"a", "i", "api", "cli", "ai", "ok"}


def technical_tokens(text: str) -> list[str]:
    out: list[str] = []
    for tok in TECHNICAL_TOKEN_RE.findall(text):
        norm = tok.lower().strip("./-+")
        if norm in _IGNORE or not norm:
            continue
        out.append(norm)
    return out


def check_technical(reference: str, hypothesis: str) -> TechnicalCheck:
    """Every technical token in the script must appear in the transcript.

    Comparison is on normalised text, so ``v0.9.4`` matches ``V0.9.4`` but not
    ``v0.9.5``, and ``faster-whisper`` matches a transcript that spells the
    hyphen as a space.
    """
    hyp_words = normalize(hypothesis)
    hyp_joined = " ".join(hyp_words)
    missing: list[str] = []
    for tok in technical_tokens(reference):
        variants = {tok, tok.replace("-", " "), tok.replace("_", " "), tok.replace("/", " ")}
        if tok.startswith("v") and tok[1:2].isdigit():
            variants.add(tok[1:])
            variants.add("version " + tok[1:])
        if any(re.search(rf"(?<!\w){re.escape(v)}(?!\w)", hyp_joined) for v in variants):
            continue
        missing.append(tok)
    extra = [t for t in technical_tokens(hypothesis) if t not in set(technical_tokens(reference))]
    return TechnicalCheck(missing=sorted(set(missing)), extra=sorted(set(extra)))
