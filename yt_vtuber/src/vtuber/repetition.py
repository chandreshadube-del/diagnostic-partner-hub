"""Repetition checks against recent episodes.

YouTube's rules on repetitious content are the reason this exists: a pipeline
that emits the same sentences over a different repo name is exactly what gets
a channel rejected, regardless of whether a human or a model wrote it.
"""
from __future__ import annotations

import hashlib
import re

from .models import Script

_WORD = re.compile(r"[a-z][a-z0-9'-]+")
_STOP = {
    "the", "and", "for", "that", "this", "with", "you", "your", "its", "it", "are", "is",
    "was", "but", "not", "they", "them", "has", "have", "from", "what", "when", "how",
    "one", "two", "can", "will", "all", "any", "out", "get", "got", "into", "than",
    "then", "there", "their", "run", "use", "uses", "about", "which", "who", "whom",
}


def content_words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 2}


def jaccard(a: str, b: str) -> float:
    sa, sb = content_words(a), content_words(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def layout_signature(script: Script) -> str:
    """Identifies the visual shape of an episode: templates x poses x payload arity."""
    parts = []
    for s in script.scenes:
        data = s.payload.model_dump()
        arity = sum(len(v) if isinstance(v, (list, tuple)) else 1 for v in data.values())
        parts.append(f"{s.template}:{s.avatar_pose}:{arity}")
    joined = "|".join(parts)
    return f"{joined}#{hashlib.sha1(joined.encode()).hexdigest()[:8]}"


def most_similar(
    script: Script, recent: list[tuple[str, str, str]]
) -> tuple[float, str | None, bool]:
    """Return (max_similarity, episode_id, layout_is_identical)."""
    sig = layout_signature(script)
    best, who = 0.0, None
    identical_layout = False
    for episode_id, narration, layout_sig in recent:
        score = jaccard(script.narration, narration)
        if score > best:
            best, who = score, episode_id
        if layout_sig == sig:
            identical_layout = True
    return best, who, identical_layout
