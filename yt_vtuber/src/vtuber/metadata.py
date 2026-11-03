"""Title and description, built only from material already in the episode."""
from __future__ import annotations

import re
from datetime import datetime

from .models import Episode, EvidencePacket

TITLE_MAX = 100
DESC_MAX = 5000

_NUMBER_RE = re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")

_BANNED_TITLE = re.compile(
    r"\b(you won'?t believe|shocking|insane|crazy|#1 best|must watch|secret)\b", re.I
)


class MetadataError(RuntimeError):
    pass


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def build_title(episode: Episode, packet: EvidencePacket) -> str:
    repo = packet.repo_full_name.split("/")[-1]
    hook = episode.script.scenes[0].narration if episode.script else ""
    # The title restates the episode's own angle; it never promises more.
    core = _clean(hook).rstrip(".")
    core = re.sub(r"^(here is|here's|this is)\s+", "", core, flags=re.I)
    title = f"{repo}: {core}"
    if len(title) > TITLE_MAX:
        title = title[: TITLE_MAX - 1].rsplit(" ", 1)[0] + "…"
    if _BANNED_TITLE.search(title):
        raise MetadataError(f"title contains clickbait wording: {title!r}")
    return title


def build_description(episode: Episode, packet: EvidencePacket) -> str:
    if episode.script is None:
        raise MetadataError("episode has no script")
    lines: list[str] = []
    lines.append(_clean(episode.script.angle))
    lines.append("")
    lines.append("What this covers:")
    for scene in episode.script.scenes[1:4]:
        lines.append(f"- {_clean(scene.narration)[:160]}")
    lines.append("")
    lines.append("Sources (retrieved automatically, timestamps in UTC):")
    seen: set[str] = set()
    for ref in episode.source_refs:
        url = str(ref.url)
        if url in seen:
            continue
        seen.add(url)
        stamp = ref.retrieved_at.strftime("%Y-%m-%d %H:%M")
        label = ref.title or ref.source_type
        lines.append(f"- {label}: {url} (retrieved {stamp})")
    lines.append("")
    if packet.license_spdx:
        lines.append(f"{packet.repo_full_name} is licensed {packet.license_spdx}.")
    lines.append(
        "Statements attributed to the project are the project's own claims, not independent "
        "benchmarks. Narration is synthesised; visuals are original generated artwork."
    )
    text = "\n".join(lines)
    if len(text) > DESC_MAX:
        text = text[: DESC_MAX - 1]
    return text


def claims_supported(description: str, episode: Episode) -> list[str]:
    """Every number in the description must appear in the script or the facts."""
    pool = " ".join([episode.script.narration if episode.script else ""] +
                    [f.claim for f in episode.facts] +
                    [f.quote or "" for f in episode.facts])
    pool_numbers = set(_NUMBER_RE.findall(pool))
    # Timestamps the pipeline itself printed are not claims about the subject,
    # so their digit groups count as supported.
    # ISO timestamps have no word boundary between "01" and "T09", so the
    # digit groups are pulled out with a looser pattern.
    pool_numbers |= set(re.findall(r"\d+", _dates(episode)))
    problems = [n for n in _NUMBER_RE.findall(description) if n not in pool_numbers]
    return sorted(set(problems))


def _dates(episode: Episode) -> str:
    out = [episode.created_at.isoformat()]
    out += [r.retrieved_at.isoformat() for r in episode.source_refs]
    if isinstance(episode.publish_time, datetime):
        out.append(episode.publish_time.isoformat())
    return " ".join(out)


def source_urls(episode: Episode) -> list[str]:
    return [str(r.url) for r in episode.source_refs]
