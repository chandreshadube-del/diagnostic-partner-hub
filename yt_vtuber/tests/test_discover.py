"""Discovery must not spend its request quota ranking candidates it will not use."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from vtuber.config import DiscoveryConfig
from vtuber.discover import discover, score_candidate, to_candidate
from vtuber.github_api import RateLimited


def _item(name: str, *, stars: int = 1000, days_ago: int = 2, spdx: str = "MIT") -> dict:
    pushed = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    return {
        "full_name": name,
        "description": f"{name} does a thing",
        "stargazers_count": stars,
        "language": "Python",
        "license": {"spdx_id": spdx},
        "topics": ["llm"],
        "pushed_at": pushed,
        "homepage": "https://example.invalid",
        "archived": False,
        "disabled": False,
        "fork": False,
    }


class FakeGitHub:
    def __init__(self, items: list[dict], *, release_budget: int = 999) -> None:
        self.items = items
        self.release_calls: list[str] = []
        self.release_budget = release_budget
        self.authenticated = False

    def search_repositories(self, q: str, per_page: int = 30, sort: str = "updated") -> dict:
        return {"items": self.items}

    def latest_release(self, full_name: str) -> dict | None:
        if len(self.release_calls) >= self.release_budget:
            raise RateLimited("rate limited; resets at 0")
        self.release_calls.append(full_name)
        return {"tag_name": "v1.0.0", "published_at": datetime.now(timezone.utc).isoformat()}


def _cfg(**over) -> DiscoveryConfig:
    base = DiscoveryConfig(queries=["topic:llm pushed:>={since}"], min_stars=100)
    for k, v in over.items():
        setattr(base, k, v)
    return base


def test_release_probing_is_capped(caplog):
    gh = FakeGitHub([_item(f"owner/repo{i}") for i in range(40)])
    cands = discover(gh, _cfg(release_probe_top_n=5), excluded=set())
    assert len(cands) == 40
    assert len(gh.release_calls) == 5, gh.release_calls


def test_probing_only_touches_top_ranked():
    """The probe budget must go to candidates that could actually win."""
    items = [_item(f"owner/stale{i}", days_ago=20, stars=200) for i in range(10)]
    items.append(_item("owner/fresh", days_ago=0, stars=5000))
    gh = FakeGitHub(items)
    discover(gh, _cfg(release_probe_top_n=1), excluded=set())
    assert gh.release_calls == ["owner/fresh"]


def test_rate_limit_mid_probe_stops_probing_but_keeps_candidates(caplog):
    gh = FakeGitHub([_item(f"owner/repo{i}") for i in range(20)], release_budget=3)
    cands = discover(gh, _cfg(release_probe_top_n=10), excluded=set())
    assert len(gh.release_calls) == 3
    assert len(cands) == 20, "a dead quota must not throw the candidate list away"


def test_excluded_repositories_are_dropped():
    gh = FakeGitHub([_item("owner/a"), _item("owner/b")])
    cands = discover(gh, _cfg(), excluded={"owner/a"})
    assert [c.full_name for c in cands] == ["owner/b"]


def test_unlicensed_repository_is_dropped_when_required():
    gh = FakeGitHub([_item("owner/a", spdx="NOASSERTION"), _item("owner/b")])
    cands = discover(gh, _cfg(require_license=True), excluded=set())
    assert [c.full_name for c in cands] == ["owner/b"]


def test_scoring_twice_does_not_duplicate_reasons():
    cand = score_candidate(to_candidate(_item("owner/a")))
    first = list(cand.reasons)
    cand.release_tag = "v2.0.0"
    cand.release_published_at = datetime.now(timezone.utc)
    score_candidate(cand)
    assert len(cand.reasons) == len(first) + 1
    assert cand.reasons.count("has official homepage/docs") == 1


def test_a_release_raises_the_score():
    before = score_candidate(to_candidate(_item("owner/a"))).score
    cand = to_candidate(_item("owner/a"))
    cand.release_tag = "v2.0.0"
    cand.release_published_at = datetime.now(timezone.utc)
    assert score_candidate(cand).score > before


def test_latest_release_does_not_disguise_a_rate_limit_as_no_release():
    """The bug that exhausted a real quota: 403 became None, so ranking ran on."""
    import httpx

    from vtuber.github_api import GitHub

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/releases/latest"):
            return httpx.Response(403, headers={"x-ratelimit-remaining": "0",
                                                "x-ratelimit-reset": "1793703547"},
                                  json={"message": "rate limit exceeded"})
        return httpx.Response(404, json={"message": "Not Found"})

    gh = GitHub(token="t")
    gh._client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RateLimited):
        gh.latest_release("owner/repo")


def test_a_genuine_404_still_means_no_release():
    import httpx

    from vtuber.github_api import GitHub

    gh = GitHub(token="t")
    gh._client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "Not Found"}))
    )
    assert gh.latest_release("owner/repo") is None


def test_a_rejected_token_is_named_not_a_generic_error():
    import httpx

    from vtuber.github_api import BadCredentials, GitHub

    gh = GitHub(token="stale")
    gh._client = httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(401, json={"message": "Bad credentials"})
        )
    )
    with pytest.raises(BadCredentials, match="vtuber token"):
        gh.rate_limit()


def test_a_rejected_token_skips_the_day_rather_than_crashing(cfg, monkeypatch):
    """An expired token on the 17:00 scheduled run must not abort with a traceback."""
    from vtuber import pipeline
    from vtuber.github_api import BadCredentials
    from vtuber.ledger import Ledger
    from vtuber.state import EpisodeStore

    class StaleTokenGitHub:
        authenticated = True

        def remaining(self):  # noqa: ANN202
            raise BadCredentials("GitHub rejected the stored token ... `vtuber token`")

        def __enter__(self):  # noqa: ANN204
            return self

        def __exit__(self, *exc):  # noqa: ANN002, ANN204
            return None

    monkeypatch.setattr(pipeline, "GitHub", StaleTokenGitHub)
    ctx = pipeline.RunContext(
        cfg=cfg,
        store=EpisodeStore(cfg.episodes_dir),
        ledger=Ledger(cfg.state_dir / "l.sqlite3"),
    )
    with pytest.raises(pipeline.PipelineSkip, match="rejected the stored token"):
        pipeline.stage_discover(ctx)
