"""Deterministic offline stand-in for a local model.

It is not a language model: it rearranges the evidence packet with fixed rules
so the schema, critic and quality gates can be tested end to end without
weights. Episodes it produces carry ``generator="stub:*"`` and
``gates.check_generator`` refuses to let them reach YouTube.

It answers the same per-scene requests the real writer gets, so the test suite
exercises the real control flow rather than a parallel one.
"""
from __future__ import annotations

import json
import re
from typing import Any

_STOP = {
    "the", "a", "an", "is", "are", "for", "with", "and", "or", "to", "of", "in", "on",
    "that", "this", "it", "as", "by", "from", "your", "you", "we", "our", "be", "can",
    "project", "describes", "itself", "readme", "states",
}

_SCENE_RE = re.compile(r'Write scene (\d+), role "([a-z]+)"')
_TEMPLATE_RE = re.compile(r'Use template "([a-z_]+)"')
_POSE_RE = re.compile(r'avatar_pose to "([a-z]+)"')


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
        if self.role == "critic":
            return _criticise(_payload(user))
        if "state the angle this script takes" in user.lower():
            return {"angle": "Separates what the API verifies from what the project claims, "
                             "then gives one way to test the difference."}
        m = _SCENE_RE.search(user)
        if m:
            return _scene(int(m.group(1)), m.group(2), user)
        return {}


def _payload(user: str) -> dict[str, Any]:
    m = re.search(r"<payload>(.*?)</payload>", user, re.S)
    return json.loads(m.group(1)) if m else {}


def _fact(facts: list[dict], prefix: str) -> dict | None:
    for f in facts:
        if f["fact_id"].startswith(prefix):
            return f
    return None


def _trim(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1].rstrip(" ,.;:") + "…"


def _pad(text: str, target_words: int) -> str:
    """Stretch to roughly the asked-for length without inventing claims."""
    filler = (
        "That is worth checking against your own workload before you commit to it, "
        "because the evidence here describes the project rather than measuring it."
    ).split()
    words = text.split()
    i = 0
    while len(words) < target_words and i < len(filler):
        words.append(filler[i])
        i += 1
    out = " ".join(words)
    return out if out.endswith((".", "!", "?")) else out + "."


#: Mirrors ROLE_SPECS; kept here so the stub does not import from script_gen.
_TARGETS = {"hook": 18, "what": 28, "detail": 30, "limitation": 26, "takeaway": 20}


def _scene(index: int, role: str, user: str) -> dict[str, Any]:
    data = _payload(user)
    repo: str = data.get("repo_full_name", "owner/repo")
    short = repo.split("/")[-1]
    facts: list[dict] = data.get("facts", [])
    lang = data.get("language") or "Python"
    lic = data.get("license_spdx") or "its stated"

    tmpl_m = _TEMPLATE_RE.search(user)
    template = tmpl_m.group(1) if tmpl_m else "repo_overview"
    pose_m = _POSE_RE.search(user)
    pose = pose_m.group(1) if pose_m else "talk"

    ident = _fact(facts, "f_identity")
    purpose = _fact(facts, "f_purpose") or _fact(facts, "f_readme_0")
    detail = _fact(facts, "f_usage_0") or _fact(facts, "f_readme_1") or purpose
    license_fact = _fact(facts, "f_license") or ident

    narrations = {
        "hook": f"Here is what actually changed this week in {short}, and where it still bites.",
        "what": (
            f"{short} is a {lang} project. The maintainers describe it as "
            f"{_trim((purpose or {}).get('claim', short), 70)}."
        ),
        "detail": (
            f"The concrete part: the documented entry point is "
            f"{_trim((detail or {}).get('claim', 'the quickstart'), 60)}."
        ),
        "limitation": (
            "The trade-off is that everything above is the project's own account of itself. "
            "No independent benchmark here."
        ),
        "takeaway": (
            f"So read the {short} release notes, run the quickstart on a throwaway branch, "
            f"and judge it on your own workload."
        ),
    }
    fact_ids = {
        "hook": [],
        "what": [f["fact_id"] for f in (ident, purpose) if f],
        "detail": [f["fact_id"] for f in [detail] if f],
        "limitation": [f["fact_id"] for f in [license_fact] if f],
        "takeaway": [],
    }

    payloads = {
        "repo_overview": {
            "kind": "repo_overview",
            "repo": short[:64],
            "tagline": _trim(data.get("description") or short, 110),
            "language": str(lang)[:64],
            "license": str(lic)[:64],
            "bullets": [f"Language: {lang}"[:96], f"Licence: {lic}"[:96]],
        },
        "terminal_demo": {
            "kind": "terminal_demo",
            "title": f"{short} quickstart"[:64],
            "lines": [["prompt", f"pip install {short}"[:72]],
                      ["out", "# documented in the README"[:72]]],
        },
        "comparison": {
            "kind": "comparison",
            "title": "What is verified"[:64],
            "left_label": "Verified by retrieval",
            "right_label": "Project's own claim",
            "rows": [["Licence", str(lic)[:96], "n/a"],
                     ["Behaviour", "not measured", _trim((purpose or {}).get("claim", "README"), 96)]],
        },
        "architecture": {
            "kind": "architecture",
            "title": "How to evaluate it"[:64],
            "nodes": [["Read", "release notes"], ["Run", "quickstart locally"],
                      ["Judge", "on your workload"]],
            "edge_label": "then",
        },
    }

    return {
        "index": index,
        "role": role,
        "template": template,
        "avatar_pose": pose,
        "narration": _pad(narrations.get(role, narrations["what"]), _TARGETS.get(role, 24)),
        "fact_ids": fact_ids.get(role, []),
        "payload": payloads[template],
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


def _keywords(text: str, n: int = 4) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_.+-]{2,}", text)
    out: list[str] = []
    for w in words:
        if w.lower() in _STOP or w.lower() in {o.lower() for o in out}:
            continue
        out.append(w)
        if len(out) >= n:
            break
    return out
