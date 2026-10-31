"""AnthropicProvider wiring, checked against a stub client (no network, no key)."""
import types

import pytest

from app.services import llm


def test_extract_json_variants():
    assert llm._extract_json('{"a": 1}') == {"a": 1}
    assert llm._extract_json('```json\n{"a": [1,2]}\n```') == {"a": [1, 2]}
    assert llm._extract_json('Here you go: {"a": 2} thanks') == {"a": 2}
    with pytest.raises(llm.LLMError):
        llm._extract_json("no json here")


class StubMessages:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def create(self, **kw):
        self.calls.append(kw)
        text = self.replies.pop(0)
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=text)])


def make(replies, verifier_model=""):
    p = llm.AnthropicProvider.__new__(llm.AnthropicProvider)
    p.model, p.verifier_model = "gen-model", verifier_model or "gen-model"
    p.client = types.SimpleNamespace(messages=StubMessages(replies))
    return p


def test_provider_retries_once_on_malformed_json_and_sets_params():
    p = make(["not json", '{"ok": true}'])
    assert p.json_call("generate", "sys", "prompt") == {"ok": True}
    calls = p.client.messages.calls
    assert len(calls) == 2 and calls[0]["model"] == "gen-model" and calls[0]["temperature"] == 0.4
    assert "ONLY one valid JSON" in calls[0]["system"]


def test_verifier_uses_separate_model_and_zero_temperature():
    p = make(['{"chosen_index": 1}'], verifier_model="judge-model")
    p.json_call("verify", "s", "p")
    c = p.client.messages.calls[0]
    assert c["model"] == "judge-model" and c["temperature"] == 0.0


def test_provider_selection(monkeypatch):
    from app.config import settings
    settings.anthropic_key, settings.allow_fake_llm = "", False
    with pytest.raises(llm.LLMUnavailable):
        llm.get_provider()
    settings.allow_fake_llm = True
    assert llm.get_provider().name == "fake"
    settings.allow_fake_llm = False


def test_openai_compat_provider(monkeypatch):
    import httpx
    from app.config import settings
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429)
        return httpx.Response(200, json={"choices": [{"message": {"content": '```json\n{"ok": 1}\n```'}}]})

    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    settings.anthropic_key, settings.allow_fake_llm = "", False
    settings.llm_base_url, settings.llm_model, settings.llm_api_key = "http://x/v1", "m1", "k"
    p = llm.get_provider()
    assert p.name == "openai-compat"
    p.http = httpx.Client(transport=httpx.MockTransport(handler))
    assert p.json_call("generate", "sys", "prompt") == {"ok": 1}      # retried after 429
    assert calls[1].url.path.endswith("/chat/completions") and calls[1].headers["authorization"] == "Bearer k"
    settings.llm_base_url = settings.llm_model = ""
