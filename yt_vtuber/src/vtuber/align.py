"""Map script words onto the ASR word timeline.

Scene boundaries and captions must follow what was *said*, not an assumed
speaking rate, so the script's word sequence is aligned to the transcript's
with the same edit distance used for WER, and each script word inherits the
timing of the transcript word it matched.
"""
from __future__ import annotations

from .models import WordTimestamp
from .verify_audio import normalize

_SUB, _DEL, _INS, _MATCH = "sub", "del", "ins", "match"


def align(script_text: str, words: list[WordTimestamp]) -> list[int | None]:
    """Return, per normalised script word, the index of the matching ASR word."""
    ref = normalize(script_text)
    hyp_tokens: list[str] = []
    hyp_index: list[int] = []
    for i, w in enumerate(words):
        for tok in normalize(w.word):
            hyp_tokens.append(tok)
            hyp_index.append(i)

    n, m = len(ref), len(hyp_tokens)
    if n == 0:
        return []
    if m == 0:
        return [None] * n

    # Classic Levenshtein DP with an operation backtrace.
    cost = [[0] * (m + 1) for _ in range(n + 1)]
    op = [[_MATCH] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        cost[i][0] = i
        op[i][0] = _DEL
    for j in range(1, m + 1):
        cost[0][j] = j
        op[0][j] = _INS
    for i in range(1, n + 1):
        ri = ref[i - 1]
        row, prev = cost[i], cost[i - 1]
        oprow = op[i]
        for j in range(1, m + 1):
            if ri == hyp_tokens[j - 1]:
                row[j] = prev[j - 1]
                oprow[j] = _MATCH
                continue
            sub, dele, ins = prev[j - 1] + 1, prev[j] + 1, row[j - 1] + 1
            best = min(sub, dele, ins)
            row[j] = best
            oprow[j] = _SUB if best == sub else (_DEL if best == dele else _INS)

    mapping: list[int | None] = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        o = op[i][j]
        if o in (_MATCH, _SUB):
            if o == _MATCH:
                mapping[i - 1] = hyp_index[j - 1]
            i -= 1
            j -= 1
        elif o == _DEL:
            i -= 1
        else:
            j -= 1
    return mapping


def span_for(mapping: list[int | None], start: int, end: int) -> tuple[int | None, int | None]:
    """First and last matched ASR index for script words ``[start:end)``."""
    matched = [m for m in mapping[start:end] if m is not None]
    return (matched[0], matched[-1]) if matched else (None, None)
