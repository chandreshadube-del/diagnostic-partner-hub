"""Candidate discovery and ranking from the official GitHub API."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .config import DiscoveryConfig
from .github_api import GitHub, GitHubError, RateLimited

log = logging.getLogger(__name__)


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


@dataclass(slots=True)
class Candidate:
    full_name: str
    description: str
    stars: int
    language: str | None
    license_spdx: str | None
    topics: list[str]
    pushed_at: datetime | None
    homepage: str | None
    has_release: bool
    release_tag: str | None
    release_published_at: datetime | None
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    raw: dict = field(default_factory=dict)


def _recency_points(when: datetime | None, half_life_days: float) -> float:
    if when is None:
        return 0.0
    age = (datetime.now(timezone.utc) - when).total_seconds() / 86400.0
    return 0.5 ** (max(age, 0.0) / half_life_days)


def score_candidate(c: Candidate) -> Candidate:
    """Recompute ``score`` and ``reasons`` in place; safe to call twice."""
    """Rank on activity, release recency and documentation — not popularity alone.

    Stars contribute only a damped signal so the same handful of mega-repos do
    not win every day.
    """
    push = _recency_points(c.pushed_at, half_life_days=10)
    release = _recency_points(c.release_published_at, half_life_days=45)
    docs = 0.0
    reasons: list[str] = []
    if c.homepage:
        docs += 0.5
        reasons.append("has official homepage/docs")
    if c.license_spdx:
        docs += 0.5
        reasons.append(f"licensed {c.license_spdx}")
    stars = min(c.stars, 50_000) ** 0.25 / 15.0
    topical = 0.3 if any(t in {"llm", "ai", "agents", "ai-agents", "rag", "developer-tools"} for t in c.topics) else 0.0
    c.score = round(3.0 * push + 2.0 * release + 1.0 * docs + stars + topical, 4)
    reasons.append(f"pushed {c.pushed_at.date() if c.pushed_at else 'unknown'}")
    if c.release_tag:
        reasons.append(f"release {c.release_tag}")
    c.reasons = reasons
    return c


def to_candidate(item: dict, release: dict | None = None) -> Candidate:
    lic = (item.get("license") or {}) or {}
    return Candidate(
        full_name=item["full_name"],
        description=(item.get("description") or "").strip(),
        stars=int(item.get("stargazers_count") or 0),
        language=item.get("language"),
        license_spdx=lic.get("spdx_id") if lic.get("spdx_id") not in (None, "NOASSERTION") else None,
        topics=list(item.get("topics") or []),
        pushed_at=_parse(item.get("pushed_at")),
        homepage=(item.get("homepage") or "").strip() or None,
        has_release=bool(release),
        release_tag=(release or {}).get("tag_name"),
        release_published_at=_parse((release or {}).get("published_at")),
        raw=item,
    )


def discover(
    gh: GitHub,
    cfg: DiscoveryConfig,
    *,
    excluded: set[str],
) -> list[Candidate]:
    """Return ranked, de-duplicated candidates. May return an empty list."""
    since = (datetime.now(timezone.utc) - timedelta(days=cfg.activity_window_days)).date().isoformat()
    seen: dict[str, dict] = {}
    for template in cfg.queries:
        if len(seen) >= cfg.max_candidates:
            break
        query = template.format(since=since)
        try:
            payload = gh.search_repositories(query, per_page=min(30, cfg.max_candidates))
        except GitHubError as exc:
            log.warning("search %r failed: %s", query, exc)
            continue
        for item in payload.get("items", []):
            name = item.get("full_name")
            if not name or name in seen:
                continue
            if name in excluded:
                log.debug("skip %s: used within cooldown", name)
                continue
            if int(item.get("stargazers_count") or 0) < cfg.min_stars:
                continue
            if item.get("archived") or item.get("disabled") or item.get("fork"):
                continue
            seen[name] = item

    # First pass: rank on what the search response already told us. The search
    # payload carries pushed_at, stars, topics, licence and homepage, so no
    # extra request is needed to get a sensible ordering.
    candidates: list[Candidate] = []
    for name, item in seen.items():
        cand = score_candidate(to_candidate(item, release=None))
        if cfg.require_license and not cand.license_spdx:
            log.debug("skip %s: no detected licence", name)
            continue
        candidates.append(cand)
    candidates.sort(key=lambda c: c.score, reverse=True)

    # Second pass: release recency is worth a request, but only for the handful
    # that could actually win. Probing all of them costs one request each and
    # will exhaust an unauthenticated quota (60/hour) before evidence
    # collection even starts.
    probed = 0
    for cand in candidates[: cfg.release_probe_top_n]:
        try:
            release = gh.latest_release(cand.full_name)
        except RateLimited as exc:
            log.warning("rate limited after probing %d releases: %s", probed, exc)
            break
        probed += 1
        if release:
            cand.has_release = True
            cand.release_tag = release.get("tag_name")
            cand.release_published_at = _parse(release.get("published_at"))
            score_candidate(cand)
    candidates.sort(key=lambda c: c.score, reverse=True)

    log.info(
        "discovered %d ranked candidates (from %d raw, %d release probes)",
        len(candidates), len(seen), probed,
    )
    return candidates
