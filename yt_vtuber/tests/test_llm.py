"""The Ollama client's request shape and its schema fallback."""
from __future__ import annotations

import json

import httpx
import pytest

from vtuber.config import LLMConfig
from vtuber.llm import LLMError, OllamaLLM
from vtuber.models import Script


def _client(llm: OllamaLLM, handler) -> None:  # noqa: ANN001
    llm._client = httpx.Client(base_url="http://x", transport=httpx.MockTransport(handler))


def _reply(body: dict) -> httpx.Response:
    return httpx.Response(200, json={"message": {"content": json.dumps(body)}})


def test_schema_is_sent_as_format_not_the_string_json():
    """Constrained decoding is the whole point: a required field cannot be dropped."""
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["format"])
        return _reply({"ok": True})

    llm = OllamaLLM(LLMConfig(), "m")
    _client(llm, handler)
    schema = Script.model_json_schema()
    llm.json_complete("sys", "usr", schema_hint="{}", schema=schema)
    assert seen == [schema]


def test_plain_json_mode_when_no_schema_is_given():
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["format"])
        return _reply({"ok": True})

    llm = OllamaLLM(LLMConfig(), "m")
    _client(llm, handler)
    llm.json_complete("sys", "usr", schema_hint="{}")
    assert seen == ["json"]


def test_a_rejected_schema_falls_back_to_json_mode():
    """An older or stricter server must degrade, not fail the attempt."""
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        fmt = json.loads(request.content)["format"]
        seen.append(fmt)
        if fmt != "json":
            return httpx.Response(400, text="invalid format")
        return _reply({"ok": True})

    llm = OllamaLLM(LLMConfig(), "m")
    _client(llm, handler)
    out = llm.json_complete("sys", "usr", schema_hint="{}", schema={"type": "object"})
    assert out == {"ok": True}
    assert seen == [{"type": "object"}, "json"]


def test_a_non_schema_error_is_not_swallowed():
    llm = OllamaLLM(LLMConfig(), "m")
    _client(llm, lambda r: httpx.Response(500, text="boom"))
    with pytest.raises(LLMError, match="500"):
        llm.json_complete("sys", "usr", schema_hint="{}")


def test_non_json_content_is_an_error():
    llm = OllamaLLM(LLMConfig(), "m")
    _client(llm, lambda r: httpx.Response(200, json={"message": {"content": "sorry, I cannot"}}))
    with pytest.raises(LLMError, match="did not return JSON"):
        llm.json_complete("sys", "usr", schema_hint="{}")


def test_the_script_schema_is_small_enough_to_be_a_grammar():
    """A huge schema converts to a slow grammar; keep an eye on the size."""
    assert len(json.dumps(Script.model_json_schema())) < 12_000
