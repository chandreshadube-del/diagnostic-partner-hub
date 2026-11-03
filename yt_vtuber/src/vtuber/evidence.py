"""Build a compact evidence packet from primary sources only.

Two classes of fact are produced and they are kept apart deliberately:

* **API facts** — values GitHub itself reports (licence, language, latest
  release tag and date, star count). Verified by retrieval.
* **Attributed claims** — sentences the project makes about itself in its own
  README. Marked ``attributed=True`` so the script must voice them as the
  project's claim, never as independent verification.

Nothing here invents a number. If the sources do not contain enough, the
packet fails schema validation and the day is skipped.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timezone

from .discover import Candidate
from .github_api import GitHub, GitHubError
from .models import EvidencePacket, Fact, SourceRef

log = logging.getLogger(__name__)

_CODE_FENCE = re.compile(r"```.*?```", re.S)
_HTML = re.compile(r"<[^>]+>")
_BADGE = re.compile(r"!?\[[^\]]*\]\([^)]*\)")
_HEADING = re.compile(r"^#{1,6}\s*", re.M)
_WS = re.compile(r"\s+")

#: Marketing words that make a README sentence useless as evidence.
_FLUFF = re.compile(
    r"\b(blazing(ly)?|revolutionary|game.changer|effortless|magic(al)?|simply the best"
    r"|world.class|cutting.edge|next.generation|insanely)\b",
    re.I,
)

_MIN_SENTENCE_WORDS = 7
_MAX_SENTENCE_WORDS = 42


def _clean_markdown(md: str) -> str:
    text = _CODE_FENCE.sub(" ", md)
    text = _BADGE.sub(" ", text)
    text = _HTML.sub(" ", text)
    text = _HEADING.sub("", text)
    return _WS.sub(" ", text).strip()


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text)
    out = []
    for p in parts:
        p = p.strip(" -*•\t")
        n = len(p.split())
        if _MIN_SENTENCE_WORDS <= n <= _MAX_SENTENCE_WORDS and not _FLUFF.search(p):
            out.append(p)
    return out


def _code_snippets(md: str, limit: int = 4) -> list[tuple[str, str]]:
    """Return (language, body) for fenced blocks that look like real commands."""
    out: list[tuple[str, str]] = []
    for m in re.finditer(r"```([a-zA-Z0-9_+-]*)\n(.*?)```", md, re.S):
        lang = (m.group(1) or "").lower()
        body = m.group(2).strip()
        if not body or len(body) > 600:
            continue
        if lang in {"bash", "sh", "shell", "console", "zsh", "powershell", ""} or body.startswith(
            ("pip ", "npm ", "uv ", "cargo ", "go ", "docker ", "curl ", "$ ")
        ):
            out.append((lang or "shell", body))
        if len(out) >= limit:
            break
    return out


def _ref(url: str, source_type: str, gh: GitHub, title: str | None = None, ref_id: str = "") -> SourceRef:
    prov = gh.provenance_for(url)
    retrieved_at, sha = prov if prov else (datetime.now(timezone.utc), None)
    return SourceRef(
        ref_id=ref_id or hashlib.sha1(url.encode()).hexdigest()[:10],
        url=url,  # type: ignore[arg-type]
        source_type=source_type,  # type: ignore[arg-type]
        retrieved_at=retrieved_at,
        title=title,
        content_sha256=sha,
    )


class ThinEvidence(RuntimeError):
    """Not enough primary-source material to build an honest episode."""


def collect(gh: GitHub, cand: Candidate) -> EvidencePacket:
    full = cand.full_name
    repo_url = f"https://github.com/{full}"
    refs: list[SourceRef] = []
    facts: list[Fact] = []
    corpus: dict[str, str] = {}

    # --- repository metadata (API fact) --------------------------------------
    api_url = f"https://api.github.com/repos/{full}"
    repo_ref = _ref(api_url, "repository", gh, title=f"{full} repository metadata", ref_id="repo")
    refs.append(repo_ref)

    facts.append(
        Fact(
            fact_id="f_identity",
            claim=(
                f"{full} is a {cand.language or 'multi-language'} project on GitHub"
                + (f" released under {cand.license_spdx}" if cand.license_spdx else "")
                + "."
            ),
            source_refs=["repo"],
        )
    )
    if cand.description:
        facts.append(
            Fact(
                fact_id="f_purpose",
                claim=f"The project describes itself as: {cand.description}",
                source_refs=["repo"],
                attributed=True,
                quote=cand.description,
            )
        )
    if cand.pushed_at:
        facts.append(
            Fact(
                fact_id="f_activity",
                claim=f"The default branch was last pushed on {cand.pushed_at.date().isoformat()}.",
                source_refs=["repo"],
            )
        )

    # --- licence (API fact) --------------------------------------------------
    license_spdx = cand.license_spdx
    lic = gh.license(full)
    if lic:
        lic_url = lic.get("html_url") or f"{repo_url}/blob/HEAD/LICENSE"
        refs.append(_ref(lic_url, "license", gh, title="LICENSE", ref_id="license"))
        spdx = ((lic.get("license") or {}).get("spdx_id") or "").strip()
        if spdx and spdx != "NOASSERTION":
            license_spdx = spdx
            facts.append(
                Fact(
                    fact_id="f_license",
                    claim=f"{full} is distributed under the {spdx} licence.",
                    source_refs=["license", "repo"],
                )
            )

    # --- latest release (API fact) ------------------------------------------
    release = gh.latest_release(full)
    if release and release.get("tag_name"):
        rel_url = release.get("html_url") or f"{repo_url}/releases/latest"
        refs.append(_ref(rel_url, "release", gh, title=release.get("name") or release["tag_name"], ref_id="release"))
        published = (release.get("published_at") or "")[:10]
        facts.append(
            Fact(
                fact_id="f_release",
                claim=(
                    f"The latest published release is {release['tag_name']}"
                    + (f", published {published}." if published else ".")
                ),
                source_refs=["release"],
            )
        )
        body = (release.get("body") or "").strip()
        if body:
            corpus["release_notes"] = body
            for i, s in enumerate(_sentences(_clean_markdown(body))[:2]):
                facts.append(
                    Fact(
                        fact_id=f"f_relnote_{i}",
                        claim=f"The release notes state: {s}",
                        source_refs=["release"],
                        attributed=True,
                        quote=s,
                    )
                )

    # --- README (attributed claims + demo material) --------------------------
    try:
        md, readme_url = gh.readme(full)
    except GitHubError as exc:
        raise ThinEvidence(f"{full}: no readable README ({exc})") from exc
    corpus["readme"] = md
    refs.append(_ref(f"https://api.github.com/repos/{full}/readme", "readme", gh, title="README", ref_id="readme"))
    refs.append(_ref(readme_url, "docs", gh, title="README (rendered)", ref_id="readme_html"))

    clean = _clean_markdown(md)
    sents = _sentences(clean)
    if len(sents) < 3:
        raise ThinEvidence(f"{full}: README yields only {len(sents)} usable sentences")
    for i, s in enumerate(sents[:6]):
        facts.append(
            Fact(
                fact_id=f"f_readme_{i}",
                claim=f"The README states: {s}",
                source_refs=["readme"],
                attributed=True,
                quote=s,
            )
        )

    snippets = _code_snippets(md)
    for i, (lang, body) in enumerate(snippets):
        facts.append(
            Fact(
                fact_id=f"f_usage_{i}",
                claim=f"The README documents this {lang} usage: {body.splitlines()[0][:120]}",
                source_refs=["readme"],
                attributed=True,
                quote=body,
            )
        )
    if snippets:
        corpus["snippets"] = "\n---\n".join(b for _, b in snippets)

    # --- official docs site --------------------------------------------------
    if cand.homepage and cand.homepage.startswith("http"):
        refs.append(_ref(cand.homepage, "docs", gh, title="Official project site", ref_id="homepage"))

    packet = EvidencePacket(
        topic=cand.description or full,
        repo_full_name=full,
        collected_at=datetime.now(timezone.utc),
        source_refs=refs,
        facts=facts,
        license_spdx=license_spdx,
        corpus=corpus,
    )
    log.info("evidence for %s: %d refs, %d facts", full, len(refs), len(facts))
    return packet
