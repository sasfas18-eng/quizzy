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
    assert "ONLY one valid JSON" in calls[0]["system"][0]["text"]


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


class Clock:
    def __init__(self): self.t = 1000.0; self.slept = 0.0
    def monotonic(self): return self.t
    def sleep(self, s): self.t += s; self.slept += s


def pool(monkeypatch, handler, eps, max_wait=900):
    import httpx
    clk = Clock()
    monkeypatch.setattr(llm, "time", types.SimpleNamespace(monotonic=clk.monotonic, sleep=clk.sleep))
    p = llm.OpenAICompatProvider(eps, max_wait=max_wait)
    p.http = httpx.Client(transport=httpx.MockTransport(handler))
    return p, clk


OK = {"choices": [{"message": {"content": '```json\n{"ok": 1}\n```'}}]}


def test_pool_fails_over_on_429_and_cools_down(monkeypatch):
    import httpx
    hits = []

    def handler(req):
        hits.append(req.url.host)
        return httpx.Response(429, headers={"retry-after": "120"}) if req.url.host == "a.example" else httpx.Response(200, json=OK)

    p, clk = pool(monkeypatch, handler, [{"name": "A", "base_url": "http://a.example/v1", "model": "m", "rpm": 100},
                                         {"name": "B", "base_url": "http://b.example/v1", "model": "m", "rpm": 100}])
    assert p.json_call("generate", "s", "p") == {"ok": 1}
    assert hits == ["a.example", "b.example"]
    hits.clear()
    for _ in range(3):
        p.json_call("generate", "s", "p")
    assert set(hits) == {"b.example"}                      # A is cooling for 120s: not hammered
    clk.t += 130
    hits.clear()
    for _ in range(4):
        p.json_call("generate", "s", "p")
    assert "a.example" in hits                             # recovered after cooldown, back in rotation


def test_pool_paces_under_rpm_and_waits_instead_of_failing(monkeypatch):
    import httpx
    p, clk = pool(monkeypatch, lambda r: httpx.Response(200, json=OK), [{"name": "A", "base_url": "http://a/v1", "model": "m", "rpm": 3}])
    for _ in range(7):
        assert p.json_call("generate", "s", "p") == {"ok": 1}
    assert clk.slept > 60          # 7 calls at 3 rpm must have waited ~2 windows, never hit the server's limiter


def test_pool_gives_up_clearly_when_everything_exhausted(monkeypatch):
    import httpx
    p, clk = pool(monkeypatch, lambda r: httpx.Response(429, headers={"retry-after": "3000"}),
                  [{"name": "A", "base_url": "http://a/v1", "model": "m"}], max_wait=60)
    with pytest.raises(llm.LLMError) as e:
        p.json_call("generate", "s", "p")
    assert "استنفدوا" in str(e.value)


def test_pool_config_parsing(monkeypatch):
    from app.config import settings
    monkeypatch.setenv("QUIZZY_LLM_POOL", '[{"base_url":"https://x/v1/","model":"m1","api_key":"k"},{"base_url":"http://localhost:11434/v1","model":"qwen","rpm":600}]')
    eps = settings.llm_pool
    assert [e["base_url"] for e in eps] == ["https://x/v1", "http://localhost:11434/v1"] and eps[0]["rpm"] == 20 and eps[1]["rpm"] == 600
    monkeypatch.setenv("QUIZZY_LLM_POOL", "not json")
    assert settings.llm_pool == []
