"""Thin, retrying client for the official GitHub REST API.

Authentication is optional: an unauthenticated client works but is rate
limited hard, so ``bootstrap`` recommends storing a read-only token.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

log = logging.getLogger(__name__)

API = "https://api.github.com"
UA = "vtuber-shorts/0.1 (+local pipeline)"


class GitHubError(RuntimeError):
    pass


class RateLimited(GitHubError):
    pass


class Transient(GitHubError):
    pass


class BadCredentials(GitHubError):
    """The token we sent was rejected — expired, revoked or regenerated."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class GitHub:
    def __init__(self, token: str | None = None, timeout: float = 30.0) -> None:
        if token is None:
            token = os.environ.get("VTUBER_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if token is None:
            # Stored by `vtuber token`, in the OS credential store.
            try:
                from .secrets_store import KEY_GITHUB_TOKEN, get_secret

                token = get_secret(KEY_GITHUB_TOKEN)
            except Exception as exc:  # noqa: BLE001 - a missing backend is not fatal
                log.debug("no keyring GitHub token: %s", exc)
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": UA,
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self.authenticated = bool(token)
        self._client = httpx.Client(headers=headers, timeout=timeout, follow_redirects=True)
        #: url -> (retrieved_at, sha256) for every body actually fetched.
        self.provenance: dict[str, tuple[datetime, str]] = {}

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "GitHub":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @retry(
        reraise=True,
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=2, min=2, max=16),
        retry=retry_if_exception_type((Transient, httpx.TransportError)),
    )
    def _get(self, path: str, **params: Any) -> httpx.Response:
        url = path if path.startswith("http") else f"{API}{path}"
        r = self._client.get(url, params=params or None)
        if r.status_code in (403, 429) and r.headers.get("x-ratelimit-remaining") == "0":
            raise RateLimited(f"rate limited; resets at {r.headers.get('x-ratelimit-reset')}")
        if r.status_code >= 500:
            raise Transient(f"{r.status_code} from {url}")
        if r.status_code == 401:
            raise BadCredentials(
                "GitHub rejected the stored token (401 Bad credentials). It has expired, "
                "been revoked, or been regenerated since it was saved. Store the current "
                "value with `vtuber token`, or drop it with `vtuber token --delete` to fall "
                "back to unauthenticated access."
            )
        if r.status_code == 404:
            raise GitHubError(f"404 {url}")
        if r.status_code >= 400:
            raise GitHubError(f"{r.status_code} {url}: {r.text[:300]}")
        self.provenance[str(r.url)] = (_utcnow(), hashlib.sha256(r.content).hexdigest())
        return r

    # -- endpoints --------------------------------------------------------- #

    def search_repositories(self, q: str, per_page: int = 30, sort: str = "updated") -> dict:
        return self._get("/search/repositories", q=q, per_page=per_page, sort=sort, order="desc").json()

    def repo(self, full_name: str) -> dict:
        return self._get(f"/repos/{full_name}").json()

    def readme(self, full_name: str) -> tuple[str, str]:
        """Return (decoded_markdown, html_url)."""
        data = self._get(f"/repos/{full_name}/readme").json()
        content = base64.b64decode(data.get("content", "")).decode("utf-8", errors="replace")
        return content, data.get("html_url") or f"https://github.com/{full_name}#readme"

    def latest_release(self, full_name: str) -> dict | None:
        """``None`` means the repo has no release — never "we ran out of quota"."""
        try:
            return self._get(f"/repos/{full_name}/releases/latest").json()
        except RateLimited:
            raise
        except GitHubError as exc:
            log.debug("no latest release for %s: %s", full_name, exc)
            return None

    def license(self, full_name: str) -> dict | None:
        try:
            return self._get(f"/repos/{full_name}/license").json()
        except RateLimited:
            raise
        except GitHubError:
            return None

    def rate_limit(self) -> dict:
        return self._get("/rate_limit").json()

    def remaining(self) -> tuple[int, int]:
        """(core_remaining, search_remaining). ``/rate_limit`` is itself free."""
        res = self.rate_limit().get("resources", {})
        return (
            int(res.get("core", {}).get("remaining", 0)),
            int(res.get("search", {}).get("remaining", 0)),
        )

    def provenance_for(self, url: str) -> tuple[datetime, str] | None:
        if url in self.provenance:
            return self.provenance[url]
        for key, val in self.provenance.items():
            if key.split("?")[0] == url.split("?")[0]:
                return val
        return None
