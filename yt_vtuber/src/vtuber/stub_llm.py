"""Deterministic offline stand-in for a local model.

It is not a language model: it rearranges the evidence packet with fixed rules
so the schema, critic and quality gates can be tested end to end without
weights. Episodes it produces carry ``generator="stub:*"`` and
``gates.check_generator`` refuses to let them reach YouTube.
"""
from __future__ import annotations

import re
from typing import Any

_STOP = {
    "the", "a", "an", "is", "are", "for", "with", "and", "or", "to", "of", "in", "on",
    "that", "this", "it", "as", "by", "from", "your", "you", "we", "our", "be", "can",
    "project", "describes", "itself", "readme", "states",
}


def _keywords(text: str, n: int = 4) -> list[str]:
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9_.+-]{2,}", text)]
    out: list[str] = []
    for w in words:
        if w.lower() in _STOP or w.lower() in {o.lower() for o in out}:
            continue
        out.append(w)
        if len(out) >= n:
            break
    return out


class StubLLM:
    def __init__(self, role: str) -> None:
        self.role = role
        self.name = f"stub:{role}"

    def json_complete(
        self,
        system: str,
        user: str,
        *,
        schema_hint: str,
        schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = _parse_user(user)
        if self.role == "writer":
            return _write(payload)
        return _criticise(payload)


def _parse_user(user: str) -> dict[str, Any]:
    import json

    m = re.search(r"<payload>(.*)</payload>", user, re.S)
    return json.loads(m.group(1)) if m else {}


def _fact(facts: list[dict], prefix: str) -> dict | None:
    for f in facts:
        if f["fact_id"].startswith(prefix):
            return f
    return None


def _write(payload: dict[str, Any]) -> dict[str, Any]:
    repo: str = payload.get("repo_full_name", "owner/repo")
    short = repo.split("/")[-1]
    facts: list[dict] = payload.get("facts", [])
    lang = payload.get("language") or "Python"
    lic = payload.get("license_spdx") or "its stated"
    ident = _fact(facts, "f_identity")
    purpose = _fact(facts, "f_purpose") or _fact(facts, "f_readme_0")
    detail = _fact(facts, "f_usage_0") or _fact(facts, "f_readme_1") or purpose
    release = _fact(facts, "f_release")
    limitation_src = _fact(facts, "f_license") or ident
    kw = _keywords(" ".join(f.get("claim", "") for f in facts[:6]))

    detail_text = (detail or {}).get("quote") or (detail or {}).get("claim", "")
    first_cmd = detail_text.strip().splitlines()[0][:70] if detail_text else f"pip install {short}"

    scenes = [
        {
            "index": 0,
            "role": "hook",
            "template": "repo_overview",
            "avatar_pose": "point",
            "narration": f"Here is what actually changed this week in {short}, and where it still bites.",
            "fact_ids": [],
            "payload": {
                "kind": "repo_overview",
                "repo": short[:64],
                "tagline": (payload.get("description") or f"{short} on GitHub")[:110],
                "language": str(lang)[:64],
                "license": str(lic)[:64],
                "bullets": [f"Language: {lang}"[:96], f"Licence: {lic}"[:96]],
            },
        },
        {
            "index": 1,
            "role": "what",
            "template": "repo_overview",
            "avatar_pose": "talk",
            "narration": (
                f"{short} is a {lang} project. The maintainers describe it as "
                f"{_trim((purpose or {}).get('quote') or short, 90)}. That is their framing, not a benchmark."
            ),
            "fact_ids": [f["fact_id"] for f in (ident, purpose) if f],
            "payload": {
                "kind": "repo_overview",
                "repo": short[:64],
                "tagline": _trim((purpose or {}).get("quote") or short, 110),
                "language": str(lang)[:64],
                "license": str(lic)[:64],
                "bullets": [
                    _trim(f["claim"], 96) for f in facts[:3] if f.get("fact_id", "").startswith("f_readme")
                ][:3]
                or [f"Hosted on GitHub as {repo}"[:96], f"Licence: {lic}"[:96]],
            },
        },
        {
            "index": 2,
            "role": "detail",
            "template": "terminal_demo",
            "avatar_pose": "talk",
            "narration": (
                f"The concrete part: the documented entry point is {_trim(first_cmd, 60)}. "
                f"That is the one line that tells you whether it fits your stack."
            ),
            "fact_ids": [f["fact_id"] for f in [detail] if f],
            "payload": {
                "kind": "terminal_demo",
                "title": f"{short} quickstart"[:64],
                "lines": [["prompt", first_cmd[:72]], ["out", "# from the project README"[:72]]],
            },
        },
        {
            "index": 3,
            "role": "limitation",
            "template": "comparison",
            "avatar_pose": "think",
            "narration": (
                "The trade-off: everything above is the project's own account of itself. "
                "No independent benchmark here, so treat the claims as claims until you run it."
            ),
            "fact_ids": [f["fact_id"] for f in [limitation_src] if f],
            "payload": {
                "kind": "comparison",
                "title": "What is verified"[:64],
                "left_label": "Verified by retrieval",
                "right_label": "Project's own claim",
                "rows": [
                    ["Licence", str(lic)[:96], "n/a"],
                    ["Behaviour", "not measured", _trim((purpose or {}).get("quote") or "README text", 96)],
                ],
            },
        },
        {
            "index": 4,
            "role": "takeaway",
            "template": "architecture",
            "avatar_pose": "nod",
            "narration": (
                f"So: read the {short} release notes, run the quickstart on a throwaway branch, "
                "and judge it on your own workload rather than on the README."
            ),
            "fact_ids": [],
            "payload": {
                "kind": "architecture",
                "title": "How to evaluate it"[:64],
                "nodes": [
                    ["Read", "release notes"],
                    ["Run", "quickstart locally"],
                    ["Judge", "on your workload"],
                ],
                "edge_label": (release or {}).get("claim", "")[:32] or None,
            },
        },
    ]
    return {
        "angle": (
            f"Separates what GitHub's API verifies about {repo} from what the project only asserts "
            f"about itself, then gives one way to test the difference."
        )[:300],
        "scenes": scenes,
        "_keywords": kw,
    }


def _criticise(payload: dict[str, Any]) -> dict[str, Any]:
    """The stub critic approves nothing it cannot map; it only reports."""
    scenes = payload.get("scenes", [])
    known = {f["fact_id"] for f in payload.get("facts", [])}
    issues = []
    for s in scenes:
        for fid in s.get("fact_ids", []):
            if fid not in known:
                issues.append({"scene": s.get("index"), "problem": f"unknown fact_id {fid}"})
    return {"issues": issues, "verdict": "pass" if not issues else "revise", "scenes": scenes}


def _trim(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1].rstrip(" ,.;:") + "…"
