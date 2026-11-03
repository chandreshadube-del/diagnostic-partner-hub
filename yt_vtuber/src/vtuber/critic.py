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

#: Longest verbatim run a scene may share with a source before it counts as
#: copying. ``ScriptConfig.max_copied_run_words`` overrides it per run.
DEFAULT_MAX_COPIED_RUN = 7

_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+/-]*")
_NUMBER = re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")


#: Limitations that are true of almost any repository and therefore say nothing.
VACUOUS_LIMITATIONS: tuple[str, ...] = (
    r"not been benchmark",
    r"hasn'?t been benchmark",
    r"no benchmark",
    r"not been (?:independently )?(?:tested|verified|measured)",
    r"still (?:young|new|early)",
    r"documentation (?:could|might) be better",
    r"may not suit everyone",
    r"your mileage may vary",
    r"not for everyone",
)

#: Connectives that mark the script reasoning about the evidence rather than
#: restating it. An episode with none of these is a README read aloud.
ANALYSIS_MARKERS: tuple[str, ...] = (
    "which means", "that means", "so if", "the trade-off", "the catch",
    "in practice", "worth knowing", "the point is", "which matters",
    "because", "so you", "that is why", "the upshot", "the cost is",
    "unlike", "compared", "instead of", "rather than", "the risk",
)


@dataclass(slots=True)
class CriticReport:
    unsupported_tokens: list[str] = field(default_factory=list)
    unsupported_numbers: list[str] = field(default_factory=list)
    filler: list[str] = field(default_factory=list)
    missing_citations: list[str] = field(default_factory=list)
    unattributed_claims: list[str] = field(default_factory=list)
    copied_runs: list[str] = field(default_factory=list)
    repeated_openings: list[str] = field(default_factory=list)
    repeated_phrases: list[str] = field(default_factory=list)
    vacuous_limitation: list[str] = field(default_factory=list)
    no_analysis: list[str] = field(default_factory=list)
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
            ("repeated opening", self.repeated_openings),
            ("repeated phrase", self.repeated_phrases),
            ("vacuous limitation", self.vacuous_limitation),
            ("no original analysis", self.no_analysis),
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


#: Common English words. A hyphenated or slashed token whose parts are all in
#: here is ordinary prose ("on-the-go", "trade-off", "read-only"), not an
#: identifier needing evidence. Checking the PARTS rather than enumerating whole
#: compounds is what stops this list leaking: "on-the-go" slipped past a list of
#: compounds on the first real run.
_ENGLISH_PARTS = frozenset("""
a an and are as at be been but by can could did do does for from get go goes going
had has have he her him his how i if in into is it its me my no not of off on one
or our out over she should so some than that the their them then there these they
this those to too two up us was we were what when where which who why will with
would you your
after again against all also always any back because before best better between
both come coming day days down each end even every few find first free full give
given good great hand here high hold home just keep kept know large last late
less let level light like line little long look low made make many more most much
must need never new next now number old only open other own part place point
public put read real right run same say see self set several short show side
single small source start state still such sure take team tell test thing think
time today turn under use used user using very want way week well while work
world write year
built case check clean close code core cost data deep done drive drop easy edge
fast file flow form free front full grade half hard head heavy hour human idea
item join kind lead learn live load local main mark mass mind mode move name
near note once order pace pack page pair pass past path pick plan play plus
power press pull push quick rate ready rest rich road role room rough round
rule safe save scale scene search send sense serve shape share sharp ship shop
sign site size slow soft solid sort sound space speak speed spend stand step
stop store strong study style super sweet switch table talk task term thin
third throw tight tool top total touch track trade train true trust try type
view voice wait walk warm watch wave wide win wire wise wood word
box case off ons the go
hosted party shelf baked grained threaded trivial sized facing ended going
coming looking running sitting standing based driven minded ready proof wise
""".split())

def _is_english_compound(token: str) -> bool:
    """True when every part of a hyphen/slash/underscore compound is a plain word."""
    parts = [p for p in re.split(r"[-_/]", token.lower()) if p]
    if len(parts) < 2:
        return False
    return all(p.isalpha() and p in _ENGLISH_PARTS for p in parts)


#: Ordinary English words the token regex also matches; they need no evidence.
_SAFE = {
    "api", "cli", "cpu", "gpu", "ram", "os", "json", "yaml", "http", "https", "sdk",
    "ai", "ml", "llm", "llms", "ui", "ux", "io", "url", "urls", "oss", "mit", "sql",
    "i", "a", "ok", "pr", "prs", "ci", "cd", "tl", "dr", "faq", "readme", "github",
    "python", "javascript", "typescript", "rust", "go", "java", "c", "cpp",
    "n/a", "tbd", "etc", "e.g", "i.e", "vs",
}


def _evidence_pools(packet: EvidencePacket) -> tuple[set[str], set[str]]:
    texts = [f.claim for f in packet.facts] + [f.quote or "" for f in packet.facts]
    texts += [packet.repo_full_name, packet.topic]
    if packet.license_spdx:
        texts.append(packet.license_spdx)
    return _token_pool(texts), set(_NUMBER.findall(" ".join(texts)))


def verify_scene(  # noqa: ANN001
    scene,
    packet: EvidencePacket,
    rep: CriticReport | None = None,
    *,
    max_copied_run: int = DEFAULT_MAX_COPIED_RUN,
) -> CriticReport:
    """Check one scene. Used by the generator's retry loop and by the full pass.

    Running these per scene is what lets a bad scene be rewritten on its own;
    checking only at the end throws away four good scenes with the fifth.
    """
    rep = rep or CriticReport()
    by_id = {f.fact_id: f for f in packet.facts}
    global_pool, global_numbers = _evidence_pools(packet)

    unknown = [fid for fid in scene.fact_ids if fid not in by_id]
    if unknown:
        rep.missing_citations.append(f"scene {scene.index} cites unknown {unknown}")

    cited = [by_id[fid] for fid in scene.fact_ids if fid in by_id]
    texts = [c.claim for c in cited] + [c.quote or "" for c in cited]
    local_pool = _token_pool(texts) if texts else set()
    local_numbers = set(_NUMBER.findall(" ".join(texts)))

    scene_text = scene.narration + " " + _payload_text(scene)

    for tok in TECHNICAL_TOKEN_RE.findall(scene_text):
        n = _norm(tok)
        if n in _SAFE or n.isdigit() or _is_english_compound(n):
            continue
        if n in local_pool or n in global_pool:
            continue
        rep.unsupported_tokens.append(f"scene {scene.index}: {tok!r}")

    for num in _NUMBER.findall(scene_text):
        if num in local_numbers or num in global_numbers:
            continue
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

    # Catching a lifted sentence here rather than after all five scenes exist
    # means the offending scene is rewritten on its own.
    run_len, run_text = longest_copied_run_in(scene.narration, packet)
    if run_len > max_copied_run:
        rep.copied_runs.append(
            f"scene {scene.index}: {run_len} consecutive words copied from a source: {run_text!r}"
        )
    return rep


#: Longest run of words a scene may share with an earlier scene.
MAX_INTERNAL_REPEAT = 4
#: How many scenes may open with the same three words.
MAX_SAME_OPENING = 2


def check_self_repetition(script: Script) -> CriticReport:
    """Catch an episode repeating itself — the pattern that reads as mass-produced.

    A real run opened all five scenes with "The maintainers say" and put the
    same shell command in two of them. Both satisfied every other check.
    """
    rep = CriticReport()

    openings: dict[str, list[int]] = {}
    for scene in script.scenes:
        key = " ".join(_norm(w) for w in scene.narration.split()[:3])
        openings.setdefault(key, []).append(scene.index)
    for key, indices in openings.items():
        if len(indices) > MAX_SAME_OPENING:
            rep.repeated_openings.append(
                f"{len(indices)} scenes open with {key!r} (scenes {indices})"
            )

    seen: dict[tuple[str, ...], int] = {}
    for scene in script.scenes:
        words = [_norm(w) for w in _WORD.findall(scene.narration)]
        local: set[tuple[str, ...]] = set()
        for i in range(len(words) - MAX_INTERNAL_REPEAT + 1):
            gram = tuple(words[i : i + MAX_INTERNAL_REPEAT])
            if all(w in _SAFE or len(w) < 3 for w in gram):
                continue  # a run of common short words is not a repeat worth flagging
            if gram in seen and seen[gram] != scene.index:
                rep.repeated_phrases.append(
                    f"scene {scene.index} repeats {' '.join(gram)!r} from scene {seen[gram]}"
                )
                break
            local.add(gram)
        for gram in local:
            seen.setdefault(gram, scene.index)

    for scene in script.scenes:
        if scene.role != "limitation":
            continue
        for pattern in VACUOUS_LIMITATIONS:
            if re.search(pattern, scene.narration, re.I):
                rep.vacuous_limitation.append(
                    f"scene {scene.index}: {pattern!r} is true of nearly any project"
                )
                break

    low = script.narration.lower()
    if not any(m in low for m in ANALYSIS_MARKERS):
        rep.no_analysis.append(
            "no scene reasons about the evidence — the script restates the sources"
        )
    return rep


def verify_claims(
    script: Script, packet: EvidencePacket, *, max_copied_run: int = DEFAULT_MAX_COPIED_RUN
) -> CriticReport:
    """Deterministic verification of the whole script against the evidence packet."""
    rep = CriticReport()
    for scene in script.scenes:
        verify_scene(scene, packet, rep, max_copied_run=max_copied_run)
    repetition = check_self_repetition(script)
    rep.repeated_openings = repetition.repeated_openings
    rep.repeated_phrases = repetition.repeated_phrases
    rep.vacuous_limitation = repetition.vacuous_limitation
    rep.no_analysis = repetition.no_analysis
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


def longest_copied_run_in(text: str, packet: EvidencePacket) -> tuple[int, str]:
    """Longest run of consecutive words ``text`` shares with any source document."""
    spoken = [_norm(w) for w in _WORD.findall(text)]
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


def longest_copied_run(script: Script, packet: EvidencePacket) -> tuple[int, str]:
    """Longest run of consecutive words the whole script shares with a source."""
    return longest_copied_run_in(script.narration, packet)


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
    rep = verify_claims(script, packet, max_copied_run=cfg.max_copied_run_words)

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
                schema={
                    "type": "object",
                    "properties": {
                        "verdict": {"type": "string", "enum": ["pass", "revise"]},
                        "issues": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "scene": {"type": "integer"},
                                    "problem": {"type": "string"},
                                },
                                "required": ["scene", "problem"],
                            },
                        },
                    },
                    "required": ["verdict", "issues"],
                },
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
