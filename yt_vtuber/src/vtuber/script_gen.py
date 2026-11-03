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

Templates (pick per scene, use at least three distinct ones across the episode):
- repo_overview  {repo, tagline, language, license, bullets[2-4]}
- terminal_demo  {title, lines[[kind,text],...]} kind is "prompt" | "out" | "comment"
- comparison     {title, left_label, right_label, rows[[label,left,right],...]}
- architecture   {title, nodes[[name,note],...], edge_label}

Avatar poses: idle, talk, point, think, nod.
"""

SCHEMA_HINT = """{
  "angle": "one sentence: the original framing this episode adds",
  "scenes": [
    {"index":0,"role":"hook","template":"repo_overview","avatar_pose":"point",
     "narration":"...","fact_ids":[],
     "payload":{"kind":"repo_overview","repo":"name","tagline":"...","language":"Python",
                "license":"MIT","bullets":["...","..."]}}
  ]
}"""


class ScriptGenerationError(RuntimeError):
    pass


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
    for attempt in range(1, max_attempts + 1):
        try:
            raw: dict[str, Any] = writer.json_complete(SYSTEM, user, schema_hint=SCHEMA_HINT)
        except LLMError as exc:
            last_error = f"generation call failed: {exc}"
            notes.append(f"attempt {attempt}: {last_error}")
            continue
        raw.pop("_keywords", None)
        try:
            script = Script.model_validate(raw)
        except ValidationError as exc:
            last_error = _compact_errors(exc)
            notes.append(f"attempt {attempt}: schema rejected: {last_error}")
            user = _evidence_block(packet, cfg) + f"\n\nYour previous answer was rejected: {last_error}\nFix it."
            continue
        words = script.word_count
        if not (cfg.target_words_min <= words <= cfg.target_words_max):
            last_error = f"{words} spoken words, need {cfg.target_words_min}-{cfg.target_words_max}"
            notes.append(f"attempt {attempt}: {last_error}")
            user = _evidence_block(packet, cfg) + f"\n\nYour previous answer had {last_error}. Rewrite to fit."
            continue
        notes.append(f"accepted on attempt {attempt} ({words} words)")
        return script, notes
    raise ScriptGenerationError(f"no valid script after {max_attempts} attempts: {last_error}")


def _compact_errors(exc: ValidationError, limit: int = 4) -> str:
    out = []
    for err in exc.errors()[:limit]:
        loc = ".".join(str(p) for p in err["loc"])
        out.append(f"{loc}: {err['msg']}")
    return "; ".join(out)
