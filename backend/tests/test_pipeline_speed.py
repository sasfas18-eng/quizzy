"""Pipeline speed/economy properties: batched verification, parallel waves, analysis cache, prompt-caching params."""
import threading
import time
import types

import pytest

from app.config import settings
from app.services import generator, llm, prompts
from app.services.fake_llm import FakeProvider
from tests.conftest import run_quiz, upload


class Counting(FakeProvider):
    def __init__(self, delay=0.0):
        super().__init__()
        self.calls, self.delay, self.lock = [], delay, threading.Lock()
        self.inflight = self.max_inflight = 0

    def json_call(self, task, system, prompt, payload=None, max_tokens=0):
        with self.lock:
            self.calls.append(task)
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            time.sleep(self.delay)
            return super().json_call(task, system, prompt, payload, max_tokens)
        finally:
            with self.lock:
                self.inflight -= 1


def cand(i, key=1):
    return {"qtype": "understanding", "stem": f"stem {i}", "options": ["a", "b", "c", "d"], "correct_index": key, "explanation": "e" * 30, "uses_external": False}


def test_batch_check_uses_two_calls_and_stays_strict():
    class P:
        name = "stub"
        calls = []

        def json_call(self, task, system, prompt, payload=None, max_tokens=0):
            self.calls.append(task)
            if task == "verify_batch":
                ok = {"answerable_from_source": True, "single_best_answer": True, "sufficient_data": True, "flaws": [], "severity": "none"}
                return {"results": [{"id": "q0", "chosen_index": 1, **ok}, {"id": "q1", "chosen_index": 2, **ok},
                                    {"id": "q2", "chosen_index": 1, **{**ok, "single_best_answer": False}}]}   # q3 missing entirely
            return {"results": [{"id": "q0", "explanation_supported": False, "contradicts_source": True, "notes": "x"}]}

    p = P()
    r = generator.llm_check_batch(p, [(f"q{i}", cand(i)) for i in range(4)], {}, {})
    assert p.calls == ["verify_batch", "explain_batch"]                       # 2 calls for 4 questions
    codes = {k: {i["code"] for i in v} for k, v in r.items()}
    assert "explanation_unsupported" in codes["q0"]                           # bad explanation caught
    assert "solver_disagrees" in codes["q1"]                                  # wrong key caught
    assert "ambiguous_key" in codes["q2"]                                     # ambiguity caught
    assert "verifier_error" in codes["q3"] and generator.validate.decisive(r["q3"])   # no verdict => rejected


def test_waves_run_in_parallel_and_cut_wall_time(alice, sample_pdf, monkeypatch):
    prov = Counting(delay=0.15)
    monkeypatch.setattr(generator, "get_provider", lambda: prov)
    settings.llm_concurrency = 8
    doc = upload(alice, sample_pdf)
    t0 = time.perf_counter()
    quiz = run_quiz(alice, doc["id"], "1-3", count=10)
    assert quiz["status"] == "ready"
    assert prov.max_inflight >= 2, "batches should overlap"
    assert "verify" not in prov.calls and "verify_batch" in prov.calls         # batched checks only
    # verification stays BATCHED: at most one verify call per generation batch (a batch is up to 3 questions), never one per question —
    # also across the retry wave and the top-up round that make up the requested count
    assert prov.calls.count("verify_batch") <= prov.calls.count("generate")


def test_analysis_is_cached_per_user_and_pages(alice, bob, sample_pdf, monkeypatch):
    prov = Counting()
    monkeypatch.setattr(generator, "get_provider", lambda: prov)
    doc = upload(alice, sample_pdf)
    run_quiz(alice, doc["id"], "1-3", count=10)
    first = prov.calls.count("analyze")
    assert first >= 1
    run_quiz(alice, doc["id"], "1-3", count=10, focus="recall")                 # same pages, other settings
    assert prov.calls.count("analyze") == first, "second plan must reuse the cached analysis"
    run_quiz(alice, doc["id"], "1-2", count=10)                                 # different pages => new analysis
    assert prov.calls.count("analyze") == first + 1
    bdoc = upload(bob, sample_pdf)
    run_quiz(bob, bdoc["id"], "1-3", count=10)                                  # another user never shares the cache
    assert prov.calls.count("analyze") == first + 2


def test_anthropic_system_block_is_cacheable_and_verifier_routed():
    class Msgs:
        def __init__(self):
            self.calls = []

        def create(self, **kw):
            self.calls.append(kw)
            return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text='{"ok": 1}')])

    p = llm.AnthropicProvider.__new__(llm.AnthropicProvider)
    p.model, p.verifier_model, p.client = "gen", "judge", types.SimpleNamespace(messages=Msgs())
    p.json_call("verify_batch", "sys", "prompt")
    p.json_call("explain_batch", "sys", "prompt")
    p.json_call("generate", "sys", "prompt")
    c = p.client.messages.calls
    assert [x["model"] for x in c] == ["judge", "judge", "gen"]
    assert [x["temperature"] for x in c] == [0.0, 0.0, 0.4]
    assert c[0]["system"][0]["cache_control"] == {"type": "ephemeral"} and "ONLY one valid JSON" in c[0]["system"][0]["text"]
