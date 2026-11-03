"""Turn an evidence packet into a validated episode script.

The model never writes HTML or CSS. It returns scene *data* that populates the
four fixed templates, and that data is validated against the strict schemas in
``models`` before anything downstream sees it.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import ValidationError

from .config import ScriptConfig
from .llm import LLM, LLMError
from .models import EvidencePacket, Script

log = logging.getLogger(__name__)

SYSTEM = """You write one 45-60 second technical explainer script for a vertical short.

Hard rules:
- You may only state things supported by the EVIDENCE below. Cite the fact_id for every factual scene.
- A fact marked "attributed": true is the project's own claim. Voice it as the project's claim
  ("the maintainers say...", "the README states..."), never as a verified result.
- Invent no numbers, benchmarks, prices, download counts, dates or feature claims.
- Do not paraphrase the README line by line. Add an explanation or a judgement a reader would not
  get by skimming the repo.
- Keep every narration line speakable: plain words, no markdown, no emoji, no URLs, no bracketed asides.
- Spell technical names exactly as the evidence spells them.

Structure, exactly five scenes in this order:
0 hook       - one sentence that states the specific thing worth knowing. No "in this video".
1 what       - what the project does and for whom.
2 detail     - one concrete technical detail or use case, from the evidence.
3 limitation - one real trade-off, limitation, or thing the evidence does NOT establish.
4 takeaway   - what the viewer should do or conclude. No call to subscribe.

Templates. Use at least THREE distinct ones across the five scenes. Item counts are
hard minimums and maximums — a list with too few entries is rejected outright:

- repo_overview  bullets: 2 to 4 strings      (max 96 chars each)
- terminal_demo  lines:   2 to 10 pairs       ["prompt"|"out"|"comment", text<=72 chars]
- comparison     rows:    2 to 4 triples      [label, left, right], each <=96 chars
- architecture   nodes:   2 to 5 pairs        [name<=64, note<=48]

Which template suits which role, as a default — vary it when the evidence suggests better:
  hook       -> repo_overview
  what       -> repo_overview or architecture
  detail     -> terminal_demo
  limitation -> comparison
  takeaway   -> architecture

Avatar poses: idle, talk, point, think, nod.
"""

#: A complete, well-formed example. Small local models copy the shape they are
#: shown far more reliably than they follow prose, so every template appears
#: here at its minimum legal size.
SCHEMA_HINT = """{
  "angle": "one sentence: the original framing this episode adds",
  "scenes": [
    {"index":0,"role":"hook","template":"repo_overview","avatar_pose":"point",
     "narration":"...","fact_ids":[],
     "payload":{"kind":"repo_overview","repo":"name","tagline":"...","language":"Python",
                "license":"MIT","bullets":["first bullet","second bullet"]}},
    {"index":1,"role":"what","template":"repo_overview","avatar_pose":"talk",
     "narration":"...","fact_ids":["f_identity"],
     "payload":{"kind":"repo_overview","repo":"name","tagline":"...","language":"Python",
                "license":"MIT","bullets":["first bullet","second bullet","third bullet"]}},
    {"index":2,"role":"detail","template":"terminal_demo","avatar_pose":"talk",
     "narration":"...","fact_ids":["f_usage_0"],
     "payload":{"kind":"terminal_demo","title":"quickstart",
                "lines":[["prompt","pip install name"],["out","# from the README"]]}},
    {"index":3,"role":"limitation","template":"comparison","avatar_pose":"think",
     "narration":"...","fact_ids":["f_license"],
     "payload":{"kind":"comparison","title":"What is verified",
                "left_label":"Verified","right_label":"Project's claim",
                "rows":[["Licence","MIT","n/a"],["Speed","not measured","fast, they say"]]}},
    {"index":4,"role":"takeaway","template":"architecture","avatar_pose":"nod",
     "narration":"...","fact_ids":[],
     "payload":{"kind":"architecture","title":"How to evaluate it",
                "nodes":[["Read","the release notes"],["Run","the quickstart"]],
                "edge_label":"then"}}
  ]
}"""


def _evidence_block(packet: EvidencePacket, cfg: ScriptConfig) -> str:
    facts = [
        {
            "fact_id": f.fact_id,
            "claim": f.claim,
            "attributed": f.attributed,
            "source_refs": f.source_refs,
        }
        for f in packet.facts
    ]
    payload = {
        "repo_full_name": packet.repo_full_name,
        "description": packet.topic,
        "license_spdx": packet.license_spdx,
        "language": _language_of(packet),
        "facts": facts,
        "word_budget": [cfg.target_words_min, cfg.target_words_max],
    }
    return (
        f"EVIDENCE (the only material you may use):\n<payload>{json.dumps(payload, indent=1)}</payload>\n\n"
        f"Total spoken words across all five narration fields must be between "
        f"{cfg.target_words_min} and {cfg.target_words_max}."
    )


def _language_of(packet: EvidencePacket) -> str | None:
    for f in packet.facts:
        if f.fact_id == "f_identity":
            parts = f.claim.split(" is a ", 1)
            if len(parts) == 2:
                return parts[1].split(" project")[0]
    return None


class ScriptGenerationError(RuntimeError):
    """Carries the last payload the model produced, for diagnosis."""

    def __init__(self, message: str, last_raw: dict | None = None) -> None:
        super().__init__(message)
        self.last_raw = last_raw


def generate(
    writer: LLM,
    packet: EvidencePacket,
    cfg: ScriptConfig,
    *,
    max_attempts: int = 3,
) -> tuple[Script, list[str]]:
    """Return (script, notes). Raises ``ScriptGenerationError`` after retries."""
    user = _evidence_block(packet, cfg)
    notes: list[str] = []
    last_error = ""
    last_raw: dict[str, Any] | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            raw: dict[str, Any] = writer.json_complete(
                SYSTEM, user, schema_hint=SCHEMA_HINT, schema=Script.model_json_schema()
            )
        except LLMError as exc:
            last_error = f"generation call failed: {exc}"
            notes.append(f"attempt {attempt}: {last_error}")
            continue
        raw.pop("_keywords", None)
        last_raw = raw
        try:
            script = Script.model_validate(raw)
        except ValidationError as exc:
            last_error = _compact_errors(exc)
            notes.append(f"attempt {attempt}: schema rejected: {last_error}")
            user = _evidence_block(packet, cfg) + _retry_note(last_error)
            continue
        words = script.word_count
        if not (cfg.target_words_min <= words <= cfg.target_words_max):
            last_error = f"{words} spoken words, need {cfg.target_words_min}-{cfg.target_words_max}"
            notes.append(f"attempt {attempt}: {last_error}")
            user = (
                _evidence_block(packet, cfg)
                + f"\n\nYour previous answer had {last_error}. Keep the same five scenes and the "
                  f"same facts; only tighten or expand the narration wording."
            )
            continue
        notes.append(f"accepted on attempt {attempt} ({words} words)")
        return script, notes
    raise ScriptGenerationError(
        f"no valid script after {max_attempts} attempts: {last_error}",
        last_raw=last_raw,
    ) from None


def _retry_note(errors: str) -> str:
    """Point the model at the exact field, and restate the rule it broke."""
    hints: list[str] = []
    if "bullets" in errors:
        hints.append("repo_overview.bullets must contain 2 to 4 strings")
    if "lines" in errors:
        hints.append("terminal_demo.lines must contain 2 to 10 [kind, text] pairs")
    if "rows" in errors:
        hints.append("comparison.rows must contain 2 to 4 [label, left, right] triples")
    if "nodes" in errors:
        hints.append("architecture.nodes must contain 2 to 5 [name, note] pairs")
    if "fact_ids" in errors:
        hints.append("the what, detail and limitation scenes each need at least one fact_id")
    if "template" in errors or "payload kind" in errors:
        hints.append("payload.kind must equal the scene's template")
    note = (
        f"\n\nYour previous answer was REJECTED by the schema:\n{errors}\n\n"
        "Return the whole JSON again with that fixed."
    )
    if hints:
        note += " Specifically: " + "; ".join(hints) + "."
    return note


def _compact_errors(exc: ValidationError, limit: int = 4) -> str:
    out = []
    for err in exc.errors()[:limit]:
        loc = ".".join(str(p) for p in err["loc"])
        out.append(f"{loc}: {err['msg']}")
    return "; ".join(out)
