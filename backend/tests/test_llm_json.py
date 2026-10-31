"""An answer that arrives (HTTP 200) without usable JSON is recovered, never fatal — the "no JSON in model output" an operator met with Groq.
Real causes: a THINKING model (gpt-oss, Qwen3, DeepSeek-R1...) pays its hidden reasoning out of max_tokens, so on a small budget the answer is EMPTY (finish_reason "length"); a reply cut in
the middle; prose instead of JSON; thinking text (with braces) in the content. Same ladder as shared/pool.js (the website): ask the same endpoint again once, in a stronger way; keep the
COMPLETE items of a cut reply; otherwise the next endpoint serves; a model that never answers in JSON is parked with the reason."""
import types

import httpx
import pytest

from app.services import llm


class Clock:
    def __init__(self): self.t = 1000.0; self.slept = 0.0
    def monotonic(self): return self.t
    def sleep(self, s): self.t += s; self.slept += s


def pool(monkeypatch, handler, eps, max_wait=900):
    clk = Clock()
    monkeypatch.setattr(llm, "time", types.SimpleNamespace(monotonic=clk.monotonic, sleep=clk.sleep))
    p = llm.OpenAICompatProvider(eps, max_wait=max_wait)
    p.http = httpx.Client(transport=httpx.MockTransport(handler))
    return p, clk


def chat(content, finish="stop", **msg):
    return httpx.Response(200, json={"choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content, **msg}}]})


def ep(name="A", model="m", base=None):
    return {"name": name, "base_url": base or f"http://{name.lower()}.example/v1", "model": model, "rpm": 1000}


def body_of(req):
    import json
    return json.loads(req.content)


def test_extract_json_hardening():
    with pytest.raises(llm.LLMError):
        llm._extract_json('<think>I should output {"ok": true} perhaps, let me think')       # a cut-off thinking block is not an answer
    assert llm._extract_json('reasoning with {braces} first</think>\n{"a":1}') == {"a": 1}
    assert llm._extract_json('See [page 3] for details. Here you go: {"a":1}') == {"a": 1}
    assert llm._extract_json('{"a":"x\ny","b":[1,2,],}') == {"a": "x\ny", "b": [1, 2]}
    assert llm._extract_json('[{"a":1}]') == [{"a": 1}]
    assert llm._extract_json('{"a":"x } y"} trailing words {"b":2}') == {"a": "x } y"}
    assert llm._extract_json('<think>maybe {"x": [1, 2]} or {oops</think>\n```json\n{"a":1}\n```') == {"a": 1}
    with pytest.raises(llm.LLMError) as e:
        llm._extract_json('{"questions":[{"slot":1,"stem":"cut')
    assert e.value.truncated is True
    with pytest.raises(llm.LLMError) as e2:
        llm._extract_json("nothing here")
    assert e2.value.truncated is False


def test_salvage_keeps_only_complete_items():
    cut = '{"questions":[{"slot":1,"stem":"a"},{"slot":2,"stem":"b"},{"slot":3,"stem":"c'
    assert llm._salvage_json(cut) == {"questions": [{"slot": 1, "stem": "a"}, {"slot": 2, "stem": "b"}]}
    assert llm._salvage_json('{"results":[{"id":"q1","ok":true},{"id":"q2","ok":false},') == {"results": [{"id": "q1", "ok": True}, {"id": "q2", "ok": False}]}
    assert llm._salvage_json('[{"a":1},{"a":2},{"a"') == [{"a": 1}, {"a": 2}]
    assert llm._salvage_json('{"questions":[{"slot":1,"stem":"par') is None
    assert llm._salvage_json('{"questions":[{"slot":1,"options":["a","b"') is None
    assert llm._salvage_json("no json here") is None and llm._salvage_json("") is None
    assert llm._salvage_json('{"lecture_character":"abc","objectives":[{"id":"o1","statement":"x","pa') == {"lecture_character": "abc"}


def test_thinking_model_empty_answer_is_asked_again_quietly_with_room_and_learned(monkeypatch):
    seen = []

    def handler(req):
        b = body_of(req)
        seen.append(b)
        need = 200 if b.get("reasoning_effort") == "low" else 3000     # hidden reasoning is paid from max_tokens first
        return chat("", "length", reasoning="Okay, the user wants JSON...") if b["max_tokens"] < need else chat('{"ok": true}')

    p, _ = pool(monkeypatch, handler, [ep("Groq", "openai/gpt-oss-20b", "https://api.groq.com/openai/v1")])
    assert p.json_call("generate", "s", "p", max_tokens=500) == {"ok": True}
    assert len(seen) == 2 and seen[1]["reasoning_effort"] == "low" and seen[1]["max_tokens"] > seen[0]["max_tokens"]
    seen.clear()
    assert p.json_call("generate", "s", "p", max_tokens=500) == {"ok": True}
    assert len(seen) == 1 and seen[0]["reasoning_effort"] == "low"      # learned: no failed first try again


def test_refused_optional_parameter_is_dropped_for_good(monkeypatch):
    seen = []

    def handler(req):
        b = body_of(req)
        seen.append(b)
        if "reasoning_effort" in b:
            return httpx.Response(400, json={"error": {"message": "`reasoning_effort` is not supported with this model"}})
        return chat("", "length") if b["max_tokens"] < 1200 else chat('{"ok":1}')

    p, _ = pool(monkeypatch, handler, [ep("Groq", "qwen/qwen3-32b", "https://api.groq.com/openai/v1")])
    assert p.json_call("generate", "s", "p", max_tokens=500) == {"ok": 1}
    assert any("reasoning_effort" in b for b in seen) and "reasoning_effort" not in seen[-1]
    seen.clear()
    p.json_call("generate", "s", "p", max_tokens=500)
    assert all("reasoning_effort" not in b for b in seen)


def test_prose_answer_is_asked_again_strictly_and_in_json_mode(monkeypatch):
    seen = []

    def handler(req):
        b = body_of(req)
        seen.append(b)
        return chat('{"ok":1}') if b.get("response_format") == {"type": "json_object"} else chat("I'm sorry, but I can't help with that request.")

    p, _ = pool(monkeypatch, handler, [ep("A")])
    assert p.json_call("generate", "SYS", "p") == {"ok": 1} and len(seen) == 2
    assert "start with {" in seen[1]["messages"][0]["content"] and seen[1]["messages"][0]["content"].startswith("SYS")
    seen.clear()
    assert p.json_call("generate", "SYS", "p") == {"ok": 1} and len(seen) == 1       # learned: JSON mode from the start

    seen2 = []

    def handler2(req):
        b = body_of(req)
        seen2.append(b)
        if "response_format" in b:
            return httpx.Response(400, json={"error": {"message": "Unrecognized request argument supplied: response_format"}})
        return chat('{"ok":2}') if "start with {" in b["messages"][0]["content"] else chat("Sure! I will do it.")

    p2, _ = pool(monkeypatch, handler2, [ep("B")])
    assert p2.json_call("generate", "s", "p") == {"ok": 2} and len(seen2) == 3 and "response_format" not in seen2[2]


def test_cut_reply_gets_more_room_then_keeps_complete_items(monkeypatch):
    full = {"questions": [{"slot": n, "stem": f"question {n}"} for n in (1, 2, 3, 4)]}
    import json
    text = json.dumps(full)
    seen = []

    def handler(req):
        b = body_of(req)
        seen.append(b["max_tokens"])
        return chat(text) if b["max_tokens"] >= 2000 else chat(text[:70], "length")

    p, _ = pool(monkeypatch, handler, [ep("A")])
    assert p.json_call("generate", "s", "p", max_tokens=1000) == full and seen[1] > seen[0]
    cut = text[: text.index('"slot": 3') + 9]
    p2, _ = pool(monkeypatch, lambda r: chat(cut, "length"), [ep("B")])
    assert [q["slot"] for q in p2.json_call("generate", "s", "p", max_tokens=16000)["questions"]] == [1, 2]      # no more room to give: the complete questions are kept


def test_thinking_text_and_content_parts(monkeypatch):
    p, _ = pool(monkeypatch, lambda r: chat('<think>maybe {"x":1}</think>{"ok":3}'), [ep("A")])
    assert p.json_call("generate", "s", "p") == {"ok": 3}
    p2, _ = pool(monkeypatch, lambda r: chat([{"type": "thinking", "thinking": "hmm {\"no\": true}"}, {"type": "text", "text": '{"ok":2}'}]), [ep("A")])
    assert p2.json_call("generate", "s", "p") == {"ok": 2}


def test_model_that_never_answers_in_json_is_parked_and_the_other_serves(monkeypatch):
    hits = {"a": 0, "b": 0}

    def handler(req):
        k = "a" if req.url.host == "a.example" else "b"
        hits[k] += 1
        return chat("Sorry, I will not do that.") if k == "a" else chat('{"from":"b"}')

    p, _ = pool(monkeypatch, handler, [ep("A"), ep("B")])
    for _ in range(6):
        assert p.json_call("generate", "s", "p") == {"from": "b"}
    assert p.eps[0].dead_reason and "JSON" in p.eps[0].dead_reason
    before = hits["a"]
    for _ in range(3):
        p.json_call("generate", "s", "p")
    assert hits["a"] == before                                  # parked: no more requests to it


def test_a_retry_that_works_is_not_a_strike(monkeypatch):
    p, _ = pool(monkeypatch, lambda r: chat('{"ok":1}') if body_of(r).get("response_format") else chat("Sure, here you go."), [ep("A")])
    for _ in range(5):
        assert p.json_call("generate", "s", "p") == {"ok": 1}
    assert p.eps[0].bad_json == 0 and not p.eps[0].dead_reason


def test_nobody_can_answer_in_json_says_which_model_and_what_it_said(monkeypatch):
    p, _ = pool(monkeypatch, lambda r: chat("عذرًا، لا أستطيع المساعدة في هذا الطلب."), [ep("Groq", "some-chat-model")])
    with pytest.raises(llm.LLMError) as e:
        p.json_call("analyze", "s", "p")
    msg = str(e.value)
    assert "some-chat-model" in msg and "JSON" in msg and "لا أستطيع المساعدة" in msg
    p2, _ = pool(monkeypatch, lambda r: chat(""), [ep("Groq", "some-chat-model")])
    with pytest.raises(llm.LLMError) as e2:
        p2.json_call("analyze", "s", "p")
    assert "فارغ" in str(e2.value)
    p3, _ = pool(monkeypatch, lambda r: chat("", "length", reasoning="thinking..."), [ep("Groq", "openai/gpt-oss-20b")])
    with pytest.raises(llm.LLMError) as e3:
        p3.json_call("analyze", "s", "p", max_tokens=16000)
    assert "انقطع" in str(e3.value)


def test_a_clean_answer_is_one_request_with_the_same_body_as_before(monkeypatch):
    seen = []

    def handler(req):
        seen.append(body_of(req))
        return chat('{"ok":1}')

    p, _ = pool(monkeypatch, handler, [ep("A")])
    p.json_call("generate", "SYS", "USER", max_tokens=3000)
    assert len(seen) == 1 and sorted(seen[0]) == ["max_tokens", "messages", "model", "temperature"] and seen[0]["max_tokens"] == 3000
    assert seen[0]["messages"][0]["content"] == "SYS\n\nReturn ONLY one valid JSON value. No prose, no markdown fences."
