"""The critic pass: mechanical claim verification plus an LLM review.

The mechanical half is authoritative. A second model gets a vote on wording
and filler, but it cannot talk an unsupported number past the gate — only the
deterministic checks decide whether the episode may continue.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from .config import ScriptConfig
from .llm import LLM, LLMError
from .models import TECHNICAL_TOKEN_RE, EvidencePacket, Script

log = logging.getLogger(__name__)

#: Phrases that carry no information. Their presence is a hard rejection rather
#: than something to silently strip, because a rewrite is cheap and a vague
#: script is the thing YouTube's repetitive-content rules punish.
FILLER_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bin this (?:video|short)\b", "self-referential framing"),
    (r"\b(?:don'?t forget to|be sure to|make sure to)\s+(?:like|subscribe|follow)\b", "engagement bait"),
    (r"\bsmash that\b", "engagement bait"),
    (r"\bgame.?changer\b", "empty superlative"),
    (r"\brevolutionar(?:y|ises|izes)\b", "empty superlative"),
    (r"\bblazing(?:ly)? fast\b", "unverifiable superlative"),
    (r"\bthe future of\b", "empty framing"),
    (r"\byou won'?t believe\b", "clickbait"),
    (r"\blet'?s dive (?:in|into)\b", "filler transition"),
    (r"\bwithout further ado\b", "filler transition"),
    (r"\bstay tuned\b", "filler"),
    (r"\bat the end of the day\b", "filler"),
)

#: Hedges that must accompany an attributed claim when it is voiced.
ATTRIBUTION_MARKERS = (
    "readme", "maintainers", "the project", "project says", "describes itself",
    "release notes", "according to", "claims", "claim", "states", "their framing",
    "docs say", "documentation says", "says it",
)

_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+/-]*")
_NUMBER = re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")


@dataclass(slots=True)
class CriticReport:
    unsupported_tokens: list[str] = field(default_factory=list)
    unsupported_numbers: list[str] = field(default_factory=list)
    filler: list[str] = field(default_factory=list)
    missing_citations: list[str] = field(default_factory=list)
    unattributed_claims: list[str] = field(default_factory=list)
    copied_runs: list[str] = field(default_factory=list)
    llm_issues: list[str] = field(default_factory=list)
    llm_verdict: str = "skipped"

    @property
    def blocking(self) -> list[str]:
        out: list[str] = []
        for label, items in (
            ("unsupported technical token", self.unsupported_tokens),
            ("unsupported number", self.unsupported_numbers),
            ("filler", self.filler),
            ("missing citation", self.missing_citations),
            ("unattributed project claim", self.unattributed_claims),
            ("copied passage", self.copied_runs),
        ):
            out += [f"{label}: {i}" for i in items]
        return out

    @property
    def passed(self) -> bool:
        return not self.blocking


def _norm(tok: str) -> str:
    return tok.strip(".,;:!?()[]\"'").lower()


def _token_pool(texts: list[str]) -> set[str]:
    pool: set[str] = set()
    for t in texts:
        for w in _WORD.findall(t):
            pool.add(_norm(w))
            # a dotted/slashed identifier also licenses its parts, so "owner/repo"
            # in the evidence permits saying "repo".
            for part in re.split(r"[./_-]", w):
                if part:
                    pool.add(_norm(part))
    return pool


#: Ordinary English compounds that look like identifiers to the token regex.
#: Anything outside this list still has to be evidenced, so the failure
#: direction is "ask for a rewrite", never "wave an invented name through".
_SAFE_COMPOUNDS = frozenset({
    "trade-off", "trade-offs", "n/a", "and/or", "read-only", "write-only",
    "open-source", "closed-source", "command-line", "end-to-end", "out-of-the-box",
    "real-time", "built-in", "drop-in", "set-up", "follow-up", "day-to-day",
    "self-hosted", "well-known", "state-of-the-art", "up-to-date", "off-the-shelf",
    "single-threaded", "multi-threaded", "fine-grained", "coarse-grained",
    "long-running", "short-lived", "first-class", "third-party", "high-level",
    "low-level", "side-effect", "side-effects", "plug-and-play", "to-do",
    "back-end", "front-end", "run-time", "copy-paste", "step-by-step",
    "rule-of-thumb", "so-called", "in-memory", "on-disk", "per-request",
    "cross-platform", "pre-release", "post-release", "non-trivial", "half-baked",
    "all-in-one", "line-by-line", "throwaway-branch",
})

#: Ordinary English words the token regex also matches; they need no evidence.
_SAFE = {
    "api", "cli", "cpu", "gpu", "ram", "os", "json", "yaml", "http", "https", "sdk",
    "ai", "ml", "llm", "llms", "ui", "ux", "io", "url", "urls", "oss", "mit", "sql",
    "i", "a", "ok", "pr", "prs", "ci", "cd", "tl", "dr", "faq", "readme", "github",
    "python", "javascript", "typescript", "rust", "go", "java", "c", "cpp",
}


def verify_claims(script: Script, packet: EvidencePacket) -> CriticReport:
    """Deterministic verification of the script against the evidence packet."""
    rep = CriticReport()
    by_id = {f.fact_id: f for f in packet.facts}
    all_fact_text = [f.claim for f in packet.facts] + [f.quote or "" for f in packet.facts]
    all_fact_text.append(packet.repo_full_name)
    all_fact_text.append(packet.topic)
    if packet.license_spdx:
        all_fact_text.append(packet.license_spdx)
    global_pool = _token_pool(all_fact_text)
    global_numbers = set(_NUMBER.findall(" ".join(all_fact_text)))

    for scene in script.scenes:
        unknown = [fid for fid in scene.fact_ids if fid not in by_id]
        if unknown:
            rep.missing_citations.append(f"scene {scene.index} cites unknown {unknown}")

        cited = [by_id[fid] for fid in scene.fact_ids if fid in by_id]
        texts = [c.claim for c in cited] + [c.quote or "" for c in cited]
        local_pool = _token_pool(texts) if texts else set()
        local_numbers = set(_NUMBER.findall(" ".join(texts)))

        # Scene text includes the visual payload: a number on screen needs
        # evidence just as much as a spoken one.
        scene_text = scene.narration + " " + _payload_text(scene)

        for tok in TECHNICAL_TOKEN_RE.findall(scene_text):
            n = _norm(tok)
            if n in _SAFE or n in _SAFE_COMPOUNDS or n.isdigit():
                continue
            if n in local_pool or n in global_pool:
                continue
            rep.unsupported_tokens.append(f"scene {scene.index}: {tok!r}")

        for num in _NUMBER.findall(scene_text):
            if num in local_numbers or num in global_numbers:
                continue
            # bare small integers used as prose ("one line", "five steps")
            if num.isdigit() and int(num) <= 10:
                continue
            rep.unsupported_numbers.append(f"scene {scene.index}: {num}")

        for pattern, why in FILLER_PATTERNS:
            if re.search(pattern, scene.narration, re.I):
                rep.filler.append(f"scene {scene.index}: {why} ({pattern})")

        if any(c.attributed for c in cited):
            low = scene.narration.lower()
            if not any(m in low for m in ATTRIBUTION_MARKERS):
                rep.unattributed_claims.append(
                    f"scene {scene.index} rests on an attributed claim but voices it as fact"
                )

    return rep


def _payload_text(scene) -> str:  # noqa: ANN001 - duck-typed scene payload
    # ``kind`` is the structural discriminator, not something anyone sees or
    # says, so it is not held to the evidence requirement.
    data = {k: v for k, v in scene.payload.model_dump().items() if k != "kind"}
    out: list[str] = []

    def walk(v: object) -> None:
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, (list, tuple)):
            for i in v:
                walk(i)
        elif isinstance(v, dict):
            for i in v.values():
                walk(i)

    walk(data)
    return " ".join(out)


def longest_copied_run(script: Script, packet: EvidencePacket) -> tuple[int, str]:
    """Longest run of consecutive words shared with any source document."""
    spoken = [_norm(w) for w in _WORD.findall(script.narration)]
    best, best_text = 0, ""
    for body in packet.corpus.values():
        src = [_norm(w) for w in _WORD.findall(body)]
        if not src:
            continue
        src_set = set(zip(src, src[1:])) if len(src) > 1 else set()
        i = 0
        while i < len(spoken) - 1:
            if (spoken[i], spoken[i + 1]) not in src_set:
                i += 1
                continue
            # extend greedily from i
            run = 2
            while True:
                window = spoken[i : i + run + 1]
                if len(window) <= run or not _contains(src, window):
                    break
                run += 1
            if run > best:
                best, best_text = run, " ".join(spoken[i : i + run])
            i += 1
    return best, best_text


def _contains(haystack: list[str], needle: list[str]) -> bool:
    n = len(needle)
    if n == 0 or n > len(haystack):
        return False
    first = needle[0]
    for idx in range(len(haystack) - n + 1):
        if haystack[idx] == first and haystack[idx : idx + n] == needle:
            return True
    return False


LLM_CRITIC_SYSTEM = """You are a fact checker for a short technical video script.

For each scene, decide whether its narration is fully supported by the cited facts, and whether it
contains filler that adds no information. You may not add facts. Report problems only.

Return JSON: {"verdict":"pass"|"revise","issues":[{"scene":0,"problem":"..."}]}
"""


def run(
    script: Script,
    packet: EvidencePacket,
    cfg: ScriptConfig,
    critic_llm: LLM | None = None,
) -> CriticReport:
    rep = verify_claims(script, packet)

    run_len, run_text = longest_copied_run(script, packet)
    if run_len > cfg.max_copied_run_words:
        rep.copied_runs.append(f"{run_len} consecutive words copied from source: {run_text!r}")

    if critic_llm is not None:
        import json

        payload = {
            "facts": [
                {"fact_id": f.fact_id, "claim": f.claim, "attributed": f.attributed}
                for f in packet.facts
            ],
            "scenes": [
                {
                    "index": s.index,
                    "role": s.role,
                    "narration": s.narration,
                    "fact_ids": s.fact_ids,
                }
                for s in script.scenes
            ],
        }
        try:
            out = critic_llm.json_complete(
                LLM_CRITIC_SYSTEM,
                f"<payload>{json.dumps(payload)}</payload>",
                schema_hint='{"verdict":"pass","issues":[]}',
            )
            rep.llm_verdict = str(out.get("verdict", "unknown"))
            for issue in out.get("issues", []) or []:
                if isinstance(issue, dict):
                    rep.llm_issues.append(f"scene {issue.get('scene')}: {issue.get('problem')}")
                else:
                    rep.llm_issues.append(str(issue))
        except LLMError as exc:
            log.warning("LLM critic unavailable, mechanical checks stand alone: %s", exc)
            rep.llm_verdict = f"unavailable: {exc}"

    log.info(
        "critic: %s (%d blocking, llm=%s, %d llm notes)",
        "pass" if rep.passed else "FAIL",
        len(rep.blocking),
        rep.llm_verdict,
        len(rep.llm_issues),
    )
    return rep
