"""Local text generation. Ollama over localhost, or a deterministic stub.

No hosted API is ever called and no project data leaves the machine. The stub
backend exists so the schema, critic and gate chain can be exercised without
model weights; episodes it produces are blocked from upload by
``gates.check_generator``.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Protocol

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import LLMConfig

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


class LLMUnavailable(LLMError):
    pass


class LLM(Protocol):
    name: str

    def json_complete(
        self,
        system: str,
        user: str,
        *,
        schema_hint: str,
        schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class OllamaLLM:
    """Ollama ``/api/chat`` with ``format: json``."""

    def __init__(self, cfg: LLMConfig, model: str) -> None:
        self.cfg = cfg
        self.model = model
        self.name = f"ollama:{model}"
        self._client = httpx.Client(base_url=cfg.base_url, timeout=cfg.timeout_s)

    def close(self) -> None:
        self._client.close()

    def available_models(self) -> list[str]:
        try:
            r = self._client.get("/api/tags")
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMUnavailable(f"Ollama not reachable at {self.cfg.base_url}: {exc}") from exc
        return [m["name"] for m in r.json().get("models", [])]

    def ensure_model(self) -> None:
        tags = self.available_models()
        if self.model in tags:
            return
        base = self.model.split(":")[0]
        if any(t.split(":")[0] == base for t in tags):
            log.warning("exact tag %s absent; present tags for %s: %s", self.model, base, tags)
        raise LLMUnavailable(
            f"model {self.model!r} is not pulled. Run: ollama pull {self.model}"
        )

    @retry(
        reraise=True,
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=10),
        retry=retry_if_exception_type((httpx.TransportError, LLMError)),
    )
    def json_complete(
        self,
        system: str,
        user: str,
        *,
        schema_hint: str,
        schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Ask for JSON, constrained by ``schema`` where the server supports it.

        Passing a JSON Schema as ``format`` makes Ollama decode against a
        grammar, so a required field cannot simply be omitted. Prose
        instructions do not give that guarantee, and a 7B model will drop
        fields however firmly it is asked not to. If the server rejects the
        schema, this falls back to plain JSON mode once rather than failing the
        attempt outright.
        """
        for fmt in ([schema, "json"] if schema is not None else ["json"]):
            payload = {
                "model": self.model,
                "stream": False,
                "format": fmt,
                "options": {
                    "temperature": self.cfg.temperature,
                    "num_ctx": self.cfg.num_ctx,
                },
                "messages": [
                    {"role": "system",
                     "content": f"{system}\n\nReturn ONLY JSON matching:\n{schema_hint}"},
                    {"role": "user", "content": user},
                ],
            }
            try:
                r = self._client.post("/api/chat", json=payload)
            except httpx.HTTPError as exc:
                raise LLMUnavailable(f"Ollama request failed: {exc}") from exc
            if r.status_code == 400 and fmt != "json":
                log.warning(
                    "Ollama rejected the JSON schema (%s); falling back to plain JSON mode",
                    r.text[:200].strip(),
                )
                continue
            break
        if r.status_code >= 400:
            raise LLMError(f"Ollama {r.status_code}: {r.text[:300]}")
        content = (r.json().get("message") or {}).get("content", "")
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise LLMError(f"model did not return JSON: {content[:300]}") from exc
        if not isinstance(data, dict):
            raise LLMError(f"model returned {type(data).__name__}, expected object")
        return data


def build(cfg: LLMConfig, role: str, total_ram_gb: float | None = None) -> LLM:
    """Pick the writer or critic model, downgrading on low-RAM machines."""
    low = total_ram_gb is not None and total_ram_gb < cfg.low_ram_gb
    if role == "writer":
        model = cfg.writer_model_low_ram if low else cfg.writer_model
    elif role == "critic":
        model = cfg.critic_model_low_ram if low else cfg.critic_model
    else:
        raise ValueError(role)
    if cfg.backend == "stub":
        from .stub_llm import StubLLM

        return StubLLM(role)
    return OllamaLLM(cfg, model)
