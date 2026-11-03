"""Turn an evidence packet into a validated episode script.

Scenes are generated **one at a time**. A single call asking for a whole
five-scene episode failed repeatedly on a 7B model: it could satisfy the schema
or the word budget but not both, and a rejection threw away four good scenes
along with the bad one. One scene per call is a far smaller task, the schema
sent with it is a single ``Scene``, and a scene that comes back too short is
retried on its own.

The model never writes HTML or CSS. It returns scene *data* that populates the
four fixed templates, validated against the strict schemas in ``models`` before
anything downstream sees it.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from .config import ScriptConfig
from .llm import LLM, LLMError
from .models import SCENE_ROLES, TEMPLATE_NAMES, EvidencePacket, Scene, Script

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class RoleSpec:
    role: str
    words: int
    guidance: str
    preferred: tuple[str, ...]
    pose: str


#: Word targets sum into the configured budget; a test asserts that.
ROLE_SPECS: tuple[RoleSpec, ...] = (
    RoleSpec("hook", 18,
             "State the specific thing worth knowing about this project right now. "
             'No "in this video", no greeting, no question.',
             ("repo_overview",), "point"),
    RoleSpec("what", 28,
             "Say what the project does and who it is for. If you use the project's own "
             "description, attribute it to them.",
             ("repo_overview", "architecture"), "talk"),
    RoleSpec("detail", 30,
             "Give ONE concrete technical detail or use case drawn from the evidence — a "
             "command, a mechanism, a design decision. Explain why it matters.",
             ("terminal_demo", "repo_overview"), "talk"),
    RoleSpec("limitation", 26,
             "Give ONE real trade-off or limitation, or name something the evidence does "
             "NOT establish. Be specific and fair, not dismissive.",
             ("comparison", "architecture"), "think"),
    RoleSpec("takeaway", 20,
             "Say what the viewer should do or conclude. No call to subscribe.",
             ("architecture", "comparison"), "nod"),
)

TEMPLATE_RULES = """Templates and their hard item counts (too few items is rejected):
- repo_overview  {repo, tagline, language, license, bullets: 2 to 4 strings <=96 chars}
- terminal_demo  {title, lines: 2 to 10 pairs ["prompt"|"out"|"comment", text <=72 chars]}
- comparison     {title, left_label, right_label, rows: 2 to 4 triples [label, left, right]}
- architecture   {title, nodes: 2 to 5 pairs [name <=64, note <=48], edge_label}
"""

SCENE_SYSTEM = """You write ONE scene of a short technical explainer video.

Hard rules:
- Use only the EVIDENCE given. Cite the fact_id of every fact your narration rests on.
- A fact marked "attributed": true is the project's own claim about itself. Voice it that way
  ("the maintainers say", "the README states"), never as a verified result.
- Invent no numbers, benchmarks, prices, dates, version strings or feature claims.
- Add your own explanation or judgement. Do not paraphrase the README line by line.
- Narration must be speakable: plain words, no markdown, no emoji, no URLs, no brackets.
- Spell technical names exactly as the evidence spells them.

""" + TEMPLATE_RULES

ANGLE_SYSTEM = """You summarise, in one sentence, the original angle an explainer script takes:
what it adds beyond reading the project's README. Be concrete and specific to this script.
"""


class ScriptGenerationError(RuntimeError):
    """Carries the last payload the model produced, for diagnosis."""

    def __init__(self, message: str, last_raw: Any = None) -> None:
        super().__init__(message)
        self.last_raw = last_raw


# --------------------------------------------------------------------------- #
# prompt construction
# --------------------------------------------------------------------------- #


def _facts_json(packet: EvidencePacket) -> list[dict]:
    return [
        {"fact_id": f.fact_id, "claim": f.claim, "attributed": f.attributed}
        for f in packet.facts
    ]


def _language_of(packet: EvidencePacket) -> str | None:
    for f in packet.facts:
        if f.fact_id == "f_identity":
            parts = f.claim.split(" is a ", 1)
            if len(parts) == 2:
                return parts[1].split(" project")[0]
    return None


def _scene_user(
    spec: RoleSpec,
    index: int,
    packet: EvidencePacket,
    used_templates: list[str],
    previous: list[Scene],
) -> str:
    allowed = [t for t in spec.preferred] or list(TEMPLATE_NAMES)
    # Force variety: once two templates are spoken for, steer the rest away.
    fresh = [t for t in allowed if t not in used_templates]
    choose_from = fresh or allowed
    said = (
        "\n".join(f"  scene {s.index} ({s.role}): {s.narration}" for s in previous)
        or "  (nothing yet — this is the first scene)"
    )
    payload = {
        "repo_full_name": packet.repo_full_name,
        "description": packet.topic,
        "license_spdx": packet.license_spdx,
        "language": _language_of(packet),
        "facts": _facts_json(packet),
    }
    return (
        f"EVIDENCE (the only material you may use):\n"
        f"<payload>{json.dumps(payload, indent=1)}</payload>\n\n"
        f"Already said in earlier scenes — do not repeat it:\n{said}\n\n"
        f"Write scene {index}, role \"{spec.role}\".\n"
        f"{spec.guidance}\n\n"
        f"Length: about {spec.words} words. Write two sentences. "
        f"One short sentence is too few and will be rejected.\n"
        f"Set index to {index}, role to \"{spec.role}\", avatar_pose to \"{spec.pose}\".\n"
        f"Use template \"{choose_from[0]}\""
        + (f" (or \"{choose_from[1]}\")" if len(choose_from) > 1 else "")
        + f", and set payload.kind to the same value.\n"
        + ("fact_ids may be empty for this role.\n" if spec.role in ("hook", "takeaway")
           else "fact_ids must list at least one fact_id from the evidence above.\n")
    )


def _scene_schema() -> dict:
    return Scene.model_json_schema()


def _length_note(narration: str, target: int) -> str:
    actual = len(narration.split())
    verb = "longer" if actual < target else "shorter"
    return (
        f"\n\nYour previous narration was {actual} words, which is too {verb}. "
        f"You wrote:\n  \"{narration}\"\n\n"
        f"Rewrite the whole scene with narration of about {target} words — two full "
        f"sentences. Expand by explaining the point further, never by adding filler, "
        f"and never by claiming anything the evidence does not support."
    )


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
        hints.append("this scene needs at least one fact_id from the evidence")
    if "template" in errors or "payload kind" in errors or "discriminator" in errors:
        hints.append("payload.kind must equal the scene's template")
    note = f"\n\nYour previous answer was REJECTED by the schema:\n{errors}\n\nReturn it fixed."
    if hints:
        note += " Specifically: " + "; ".join(hints) + "."
    return note


def _compact_errors(exc: ValidationError, limit: int = 4) -> str:
    out = []
    for err in exc.errors()[:limit]:
        loc = ".".join(str(p) for p in err["loc"])
        out.append(f"{loc}: {err['msg']}")
    return "; ".join(out)


# --------------------------------------------------------------------------- #
# generation
# --------------------------------------------------------------------------- #

#: A scene within this fraction of its target is accepted; the whole-episode
#: budget is what actually matters, and per-scene precision is not achievable.
LENGTH_TOLERANCE_LOW = 0.65
LENGTH_TOLERANCE_HIGH = 1.6


def _generate_scene(
    writer: LLM,
    spec: RoleSpec,
    index: int,
    packet: EvidencePacket,
    used_templates: list[str],
    previous: list[Scene],
    *,
    max_attempts: int,
    notes: list[str],
) -> Scene:
    base = _scene_user(spec, index, packet, used_templates, previous)
    user = base
    last_error = "no attempt made"
    last_raw: Any = None
    for attempt in range(1, max_attempts + 1):
        try:
            raw = writer.json_complete(
                SCENE_SYSTEM, user, schema_hint=_scene_hint(spec), schema=_scene_schema()
            )
        except LLMError as exc:
            last_error = f"generation call failed: {exc}"
            notes.append(f"scene {index} attempt {attempt}: {last_error}")
            continue
        last_raw = raw
        # The role and position are ours to decide, not the model's.
        raw["index"] = index
        raw["role"] = spec.role
        try:
            scene = Scene.model_validate(raw)
        except ValidationError as exc:
            last_error = _compact_errors(exc)
            notes.append(f"scene {index} attempt {attempt}: schema rejected: {last_error}")
            user = base + _retry_note(last_error)
            continue

        words = len(scene.narration.split())
        if not (spec.words * LENGTH_TOLERANCE_LOW <= words <= spec.words * LENGTH_TOLERANCE_HIGH):
            last_error = f"{words} words, wanted about {spec.words}"
            notes.append(f"scene {index} attempt {attempt}: {last_error}")
            user = base + _length_note(scene.narration, spec.words)
            continue

        notes.append(f"scene {index} ({spec.role}): {words} words, {scene.template}")
        return scene

    raise ScriptGenerationError(
        f"scene {index} ({spec.role}) failed after {max_attempts} attempts: {last_error}",
        last_raw=last_raw,
    )


def _scene_hint(spec: RoleSpec) -> str:
    """A minimal valid example of the template this scene should use."""
    examples = {
        "repo_overview": '{"kind":"repo_overview","repo":"name","tagline":"what it is",'
                         '"language":"Python","license":"MIT",'
                         '"bullets":["first point","second point"]}',
        "terminal_demo": '{"kind":"terminal_demo","title":"quickstart",'
                         '"lines":[["prompt","pip install name"],["out","# from the README"]]}',
        "comparison": '{"kind":"comparison","title":"What is verified",'
                      '"left_label":"Verified","right_label":"Their claim",'
                      '"rows":[["Licence","MIT","n/a"],["Speed","not measured","fast"]]}',
        "architecture": '{"kind":"architecture","title":"How it fits",'
                        '"nodes":[["Read","the release notes"],["Run","the quickstart"]],'
                        '"edge_label":"then"}',
    }
    tmpl = spec.preferred[0]
    return (
        '{"index":0,"role":"%s","template":"%s","avatar_pose":"%s",'
        '"narration":"Two full sentences go here. The second one explains why it matters.",'
        '"fact_ids":["f_identity"],"payload":%s}'
        % (spec.role, tmpl, spec.pose, examples[tmpl])
    )


def _generate_angle(writer: LLM, scenes: list[Scene], packet: EvidencePacket) -> str:
    body = "\n".join(f"{s.role}: {s.narration}" for s in scenes)
    schema = {
        "type": "object",
        "properties": {"angle": {"type": "string"}},
        "required": ["angle"],
    }
    try:
        raw = writer.json_complete(
            ANGLE_SYSTEM,
            f"Repository: {packet.repo_full_name}\n\nScript:\n{body}\n\n"
            "In one sentence of 20 to 40 words, state the angle this script takes.",
            schema_hint='{"angle":"..."}',
            schema=schema,
        )
        angle = str(raw.get("angle", "")).strip()
    except LLMError as exc:
        log.warning("angle generation failed, falling back: %s", exc)
        angle = ""
    if not 20 <= len(angle) <= 300:
        angle = (
            f"Separates what the GitHub API verifies about {packet.repo_full_name} from what "
            f"the project claims about itself, and says how to tell the difference."
        )[:300]
    return angle


def generate(
    writer: LLM,
    packet: EvidencePacket,
    cfg: ScriptConfig,
    *,
    max_attempts: int = 3,
) -> tuple[Script, list[str]]:
    """Return (script, notes). Raises ``ScriptGenerationError`` on failure."""
    notes: list[str] = []
    scenes: list[Scene] = []
    used_templates: list[str] = []

    for index, spec in enumerate(ROLE_SPECS):
        scene = _generate_scene(
            writer, spec, index, packet, used_templates, scenes,
            max_attempts=max_attempts, notes=notes,
        )
        scenes.append(scene)
        used_templates.append(scene.template)

    angle = _generate_angle(writer, scenes, packet)
    try:
        script = Script(scenes=scenes, angle=angle)
    except ValidationError as exc:
        raise ScriptGenerationError(
            f"assembled script rejected: {_compact_errors(exc)}",
            last_raw=[s.model_dump() for s in scenes],
        ) from exc

    words = script.word_count
    if not (cfg.target_words_min <= words <= cfg.target_words_max):
        # Per-scene targets sum into the budget, so this is reachable only when
        # several scenes land at opposite ends of their tolerance.
        notes.append(f"total {words} words, outside {cfg.target_words_min}-{cfg.target_words_max}")
        raise ScriptGenerationError(
            f"{words} spoken words, need {cfg.target_words_min}-{cfg.target_words_max}",
            last_raw=[s.model_dump() for s in scenes],
        )

    notes.append(f"accepted: {words} words, templates {[s.template for s in scenes]}")
    return script, notes


#: Kept for the tests that assert the role plan agrees with the configured budget.
SYSTEM = SCENE_SYSTEM
