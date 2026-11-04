"""LLM access. Real provider = Anthropic Messages API (server side). No key -> disabled, never faked.

A deterministic test provider exists (fake_llm.py) but only loads when QUIZZY_ALLOW_FAKE_LLM=1;
content it produces is stamped generator="test-generator" and shown with a visible badge.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any

from ..config import settings


class LLMUnavailable(RuntimeError):
    code = "llm_not_configured"


class LLMError(RuntimeError):
    truncated = False       # the reply ended in the middle of the JSON (cut by the output limit)


class LLMParked(LLMError):
    """every endpoint is parked (a model that never answers in JSON) or already refused this very request"""


_THINK_BLOCK = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.S | re.I)
_THINK_ORPHAN_CLOSE = re.compile(r"^.*</(?:think|thinking|reasoning)>", re.S | re.I)
_THINK_OPEN = re.compile(r"<(?:think|thinking|reasoning)>.*$", re.S | re.I)


def _temperature(task: str) -> float:
    """Generation is a little free (0.4). The Arabic correction of a wrong answer is the one place asked to be vivid (0.5): its facts are confined by the prompt and CHECKED afterwards
    (Arabic, the original kept, no invented number). Everything else is deterministic."""
    return {"generate": 0.4, "correction": 0.5}.get(task, 0.0)


def _strip_reasoning(text: str) -> str:
    """Reasoning models (DeepSeek-R1, Qwen3, gpt-oss... on Groq/Ollama/OpenRouter) write their thinking first, sometimes inside the text: <think>...</think> (it may contain
    braces, so it must go). A block that never closes means the model was cut while thinking: there is no answer in it. A lone closing tag: the template opened it in the prompt."""
    text = _THINK_BLOCK.sub("", text or "")
    text = _THINK_ORPHAN_CLOSE.sub("", text)
    return _THINK_OPEN.sub("", text)


def _repair_json(s: str) -> str:
    """Small slips json.loads refuses: a comma before } or ], a raw line break / tab inside a string."""
    out: list[str] = []
    in_str = esc = False
    for i, c in enumerate(s):
        if in_str:
            if esc:
                esc = False
                out.append(c)
            elif c == "\\":
                esc = True
                out.append(c)
            elif c == '"':
                in_str = False
                out.append(c)
            elif c == "\n":
                out.append("\\n")
            elif c == "\r":
                out.append("\\r")
            elif c == "\t":
                out.append("\\t")
            else:
                out.append(c)
            continue
        if c == '"':
            in_str = True
        elif c == ",":
            j = i + 1
            while j < len(s) and s[j].isspace():
                j += 1
            if j < len(s) and s[j] in "}]":
                continue
        out.append(c)
    return "".join(out)


def _next_start(t: str, frm: int) -> int:
    a, b = t.find("{", frm), t.find("[", frm)
    return a if b < 0 else b if a < 0 else min(a, b)


def _balanced_end(t: str, s: int) -> int:
    """index of the bracket closing the one at `s`, or -1 when the text ends first (strings are skipped)"""
    open_, close = t[s], "}" if t[s] == "{" else "]"
    depth, in_str, esc = 0, False, False
    for i in range(s, len(t)):
        c = t[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return i
    return -1


def _parse(x: str) -> tuple[bool, Any]:
    for cand in (x, None):
        try:
            return True, json.loads(x if cand is not None else _repair_json(x))
        except ValueError:
            continue
    return False, None


def _extract_json(text: str) -> Any:
    t = _strip_reasoning(text).strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    seen = truncated = False
    s, guard = _next_start(t, 0), 0
    while s >= 0 and guard < 60:
        guard += 1
        seen = True
        end = _balanced_end(t, s)
        if end < 0:
            truncated = True      # cut in the middle: whatever follows is part of it, not a second answer
            break
        ok, val = _parse(t[s:end + 1])
        if ok:
            return val
        s = _next_start(t, end + 1)   # that span was prose ("[page 3]", "{x}"): look after it
    err = LLMError("truncated JSON in model output" if truncated else "malformed JSON in model output" if seen else "no JSON in model output")
    err.truncated = truncated
    raise err


def _salvage_json(text: str) -> Any:
    """A reply cut by the output limit: keep what is COMPLETE. Safe cut points are only after a finished element of the list directly under the answer (the questions / results /
    objectives array) or after a finished top-level member - never inside a half-written item. None when there is nothing complete to keep."""
    t = re.sub(r"^\s*```(?:json)?\s*", "", _strip_reasoning(text), flags=re.I)
    m = re.search(r"[{\[]", t)
    if not m:
        return None
    s = m.start()
    stack: list[str] = []
    in_str = esc = scalar = False
    safe, safe_stack, prev, str_prev = -1, None, "", ""

    def mark(end: int) -> None:
        nonlocal safe, safe_stack
        top = stack[-1] if stack else ""
        if (top == "[" and len(stack) <= 2) or (top == "{" and len(stack) == 1):
            safe, safe_stack = end + 1, stack[:]

    for i in range(s, len(t)):
        c = t[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
                if (stack and stack[-1] == "[") or str_prev == ":":
                    mark(i)
                prev = '"'
            continue
        if scalar and (c.isspace() or c in ",}]"):
            scalar = False
            mark(i - 1)
        if c.isspace():
            continue
        if c == '"':
            in_str, str_prev = True, prev
            continue
        if c in "{[":
            stack.append(c)
            prev = c
            continue
        if c in "}]":
            if stack:
                stack.pop()
            if not stack:
                ok, val = _parse(t[s:i + 1])
                return val if ok else None
            mark(i)
            prev = c
            continue
        if c in ",:":
            prev = c
            continue
        scalar = True
        prev = "x"
    if safe < 0 or safe_stack is None:
        return None
    ok, val = _parse(t[s:safe] + "".join("}" if b == "{" else "]" for b in reversed(safe_stack)))
    return val if ok else None


_MAX_FAIL_WAIT = 60.0          # seconds
_BUSY_PARK = 120.0             # a provider that keeps answering 5xx / is unreachable: skipped this long, then probed again by itself
_OUT_JSON = 600.0              # a model that cannot answer in JSON: rests this long


def _busy_text(status: int, text: str) -> str:
    """what a 429 / 5xx means for a person: the KEY is fine (a wrong key is refused before this point)"""
    if status == 429:
        return "بلغ حدّ الطلبات المسموح به الآن"
    if status in (503, 529) or re.search(r"overload|unavailable|capacity|busy|high demand", text or "", re.I):
        return "الخدمة مزدحمة مؤقتًا عند المزوّد"
    return "عطل مؤقت عند المزوّد"


def _retry_delay(text: str) -> int:
    m = re.search(r"retry(?:Delay)?[\"']?\s*(?:in|:)?\s*[\"']?(\d+(?:\.\d+)?)\s*s", text or "", re.I)      # Gemini: "retryDelay": "34s"; others: "Please retry in 20.5s"
    return int(float(m.group(1)) + 0.999) if m else 0


_STRICT = ("\n\nIMPORTANT: your previous reply contained no usable JSON. Answer with the JSON value ONLY - it must start with { and end with }. "
           "Do not think aloud, explain, or add any other text.")
_PARAM_RE = re.compile(r"response_format|json_object|json mode|reasoning|thinking|unsupported (parameter|property|argument)|unknown (parameter|field|property|argument)|unrecognized|extra inputs?|additional properties|not permitted|does not support", re.I)
_REASONER_RE = re.compile(r"gpt-oss|qwen3|qwq|deepseek-r1|(^|[/:_-])r1([/:_.-]|$)|reason|think|magistral|(^|[/:])o[134](-|$)|gemini-(2\.5|3)", re.I)


def _is_reasoner(model: str) -> bool:
    return bool(_REASONER_RE.search(model or ""))


def _quiet_params(model: str, base: str) -> dict:
    """The knob that makes a thinking model think little (a provider that does not know it answers 400 and the knob is dropped for good)."""
    if re.search(r"qwen3|qwq", model, re.I):
        return {"reasoning_effort": "none"}
    if re.search(r"deepseek-r1|(^|[/:_-])r1([/:_.-]|$)", model, re.I):
        return {"reasoning_format": "hidden"} if "groq.com" in base else {}
    return {"reasoning_effort": "low"} if _is_reasoner(model) else {}


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, key: str, model: str, verifier_model: str = ""):
        import anthropic

        self.client = anthropic.Anthropic(api_key=key, max_retries=3, timeout=180)
        self.model = model
        self.verifier_model = verifier_model or model

    def json_call(self, task: str, system: str, prompt: str, payload: dict | None = None, max_tokens: int = 8000) -> Any:
        checker = task.startswith(("verify", "explain"))
        model = self.verifier_model if checker else self.model
        # The (static) instructions go in a cacheable system block: repeated calls of the same task reuse the cached prefix
        # (faster + cheaper where the prompt is long enough for Anthropic's prompt caching to apply).
        sys_block = [{"type": "text", "text": system + "\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.",
                      "cache_control": {"type": "ephemeral"}}]
        last: Exception | None = None
        for attempt in range(2):
            try:
                msg = self.client.messages.create(
                    model=model, max_tokens=max_tokens, temperature=_temperature(task),
                    system=sys_block, messages=[{"role": "user", "content": prompt}],
                )
                text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
                return _extract_json(text)
            except LLMError as e:  # malformed JSON -> one retry
                last = e
                time.sleep(1)
            except Exception as e:  # network / API errors already retried by SDK
                raise LLMError(f"{type(e).__name__}: {e}") from e
        raise LLMError(str(last))


class _Endpoint:
    def __init__(self, cfg: dict):
        self.name = cfg.get("name") or cfg["base_url"].split("//")[-1].split("/")[0]
        self.base, self.key, self.model = cfg["base_url"], cfg.get("api_key", ""), cfg["model"]
        self.rpm = max(1, int(cfg.get("rpm", 20)))
        self.stamps: list[float] = []   # recent request times (sliding 60s window)
        self.cool_until = 0.0           # set after 429/quota errors
        self.fails = 0
        self.no_param: set[str] = set()  # optional parameters this provider refused (JSON mode, "think little"): never sent again
        self.learned: dict | None = None  # the request shape that fixed an unusable answer: used from the start next time
        self.bad_json = 0               # consecutive requests it could not answer in JSON (asked in every way); two rest the endpoint
        self.out_until = 0.0            # resting (overloaded / unreachable / cannot answer in JSON): skipped until then, tried again by itself
        self.out_reason = ""

    def wait_needed(self, now: float) -> float:
        """seconds until this endpoint may be used (0 = now)"""
        if now < self.out_until:
            return float("inf")
        self.stamps = [t for t in self.stamps if now - t < 60]
        w = max(0.0, self.cool_until - now)
        if len(self.stamps) >= self.rpm:
            w = max(w, 60 - (now - self.stamps[0]) + 0.05)
        return w


class OpenAICompatProvider:
    """Pool of OpenAI-compatible endpoints (Groq, OpenRouter, Gemini compat, Ollama...).

    Goal: get as close to "no limit" as free tiers allow —
      * each endpoint is paced under its own requests/minute (never trips the limiter needlessly);
      * a request goes to the endpoint that is ready soonest (round-robin when several are ready);
      * on 429/quota the endpoint is put on cooldown (Retry-After honoured, long cooldown for daily quotas)
        and the same request moves to another endpoint;
      * if every endpoint is cooling the call WAITS (up to QUIZZY_LLM_MAX_WAIT seconds) instead of failing.
    JSON is requested via the prompt and parsed defensively (not every server supports response_format)."""
    name = "openai-compat"

    def __init__(self, endpoints: list[dict], max_wait: float | None = None):
        import httpx

        self.http = httpx.Client(timeout=180)
        self.eps = [_Endpoint(e) for e in endpoints]
        self.model = ", ".join(f"{e.name}:{e.model}" for e in self.eps)
        self.max_wait = float(os.environ.get("QUIZZY_LLM_MAX_WAIT", "900")) if max_wait is None else max_wait
        self.lock = threading.Lock()
        self.rr = 0

    def _acquire(self, deadline: float, avoid: set[int], skip: set[int] | None = None, prefer: set[int] | None = None) -> _Endpoint:
        while True:
            with self.lock:
                now = time.monotonic()
                order = [(self.eps[(self.rr + k) % len(self.eps)], (self.rr + k) % len(self.eps)) for k in range(len(self.eps))]
                cands = [(float("inf") if skip and i in skip else e.wait_needed(now), i, e) for e, i in order]
                if all(c[0] == float("inf") for c in cands):   # every endpoint is parked (a model that never answers in JSON): say so, do not wait for nothing
                    raise LLMParked("كل نماذج التوليد متوقفة مؤقتًا أو رفضت هذا الطلب: " + " | ".join(f"{c[2].name}: {c[2].out_reason or 'رُفض الطلب'}" for c in cands))
                ready = [c for c in cands if c[0] <= 0 and c[1] not in avoid] or [c for c in cands if c[0] <= 0]
                if ready:
                    _, i, e = ([c for c in ready if prefer and c[1] in prefer] or ready)[0]       # an endpoint whose answer is being asked again (adjusted) is asked again, if it is free
                    e.stamps.append(now)
                    self.rr = (i + 1) % len(self.eps)
                    return e
                best = min(cands, key=lambda c: c[0])
                wait = best[0]
                fail_wait = max(0.0, best[2].cool_until - now)
                give_up = wait > _MAX_FAIL_WAIT and fail_wait >= wait - 1       # cooling after a FAILURE for longer than a minute: the call gives up at once and the caller falls back (self-pacing is waited for)
            if give_up or time.monotonic() + wait > deadline:
                raise LLMError("كل مزوّدي التوليد المجانيين استنفدوا حدّهم الآن؛ أعد المحاولة لاحقًا أو أضف مزوّدًا/مفتاحًا آخر.")
            time.sleep(min(wait, 30) + 0.01)

    def _cool(self, e: _Endpoint, resp) -> None:
        secs = 30.0
        try:
            ra = resp.headers.get("retry-after")
            body = resp.text or ""
            asked = _retry_delay(body)
            if ra:
                secs = float(ra)
            elif asked:
                secs = asked + 1.0
            elif re.search(r"per ?day|daily", body, re.I):
                secs = 3600.0   # daily quota: stop hammering this endpoint for an hour
            else:
                secs = min(60.0, 8.0 * 2 ** e.fails)
        except Exception:
            pass
        with self.lock:
            e.fails += 1
            e.cool_until = time.monotonic() + min(secs, 3600.0)

    def _rest(self, e: _Endpoint, reason: str, secs: float) -> None:
        with self.lock:
            e.out_until = time.monotonic() + secs
            e.out_reason = reason

    def json_call(self, task: str, system: str, prompt: str, payload: dict | None = None, max_tokens: int = 6000) -> Any:
        """One request, answered by the first endpoint that can. An answer that arrives (HTTP 200) WITHOUT usable JSON is not fatal: a thinking model that spent the whole output budget
        thinking (empty reply, finish_reason "length"), a reply cut in the middle, prose instead of JSON. The same endpoint is asked again once, in a stronger way (more room, "think little",
        JSON mode, plain wording); at the cap the COMPLETE items of a cut reply are kept; otherwise the next endpoint serves. What worked is remembered; a model that keeps answering
        without JSON is parked with the reason."""
        deadline = time.monotonic() + self.max_wait
        avoid: set[int] = set()
        skip: set[int] = set()          # endpoints that cannot serve THIS request (asked in every way, still no JSON)
        prefer: set[int] = set()        # endpoints being asked again in a stronger way
        hints: dict[int, dict] = {}
        last: Exception | None = None
        attempt = 0
        while attempt < max(6, 3 * len(self.eps)):
            attempt += 1
            try:
                e = self._acquire(deadline, avoid, skip, prefer)
            except LLMParked:
                if last is not None:
                    raise LLMError(f"{type(last).__name__}: {last}") from None      # say what the last one answered
                raise
            idx = self.eps.index(e)
            h = hints.get(idx) or e.learned or {}
            out_tokens = max(64, min(16000, max_tokens * h.get("mul", 1)))
            extras: list[str] = []
            body = {"model": e.model, "max_tokens": out_tokens, "temperature": _temperature(task),
                    "messages": [{"role": "system", "content": system + "\n\nReturn ONLY one valid JSON value. No prose, no markdown fences." + (_STRICT if h.get("strict") else "")},
                                 {"role": "user", "content": prompt}]}
            if h.get("json") and "response_format" not in e.no_param:
                body["response_format"] = {"type": "json_object"}
                extras.append("response_format")
            if h.get("quiet"):
                for k, v in _quiet_params(e.model, e.base).items():
                    if k not in e.no_param:
                        body[k] = v
                        extras.append(k)
            try:
                r = self.http.post(f"{e.base}/chat/completions", json=body, headers={"Authorization": f"Bearer {e.key or 'none'}"})
                if r.status_code in (429, 402, 403) or r.status_code >= 500:
                    self._cool(e, r)
                    avoid.add(idx)
                    last = LLMError(f"{e.name} ({e.model}): {_busy_text(r.status_code, r.text)} (HTTP {r.status_code})")
                    if r.status_code >= 500 and e.fails >= 2:      # keeps failing: stop making every request wait for it
                        self._rest(e, f"{_busy_text(r.status_code, r.text)} (HTTP {r.status_code})؛ يُجرَّب ثانية تلقائيًا", _BUSY_PARK)
                    continue
                if extras and 400 <= r.status_code < 500 and _PARAM_RE.search(r.text or ""):
                    e.no_param.update(extras)          # an optional parameter this provider does not know: send the same request without it, for good
                    attempt -= 1
                    continue
                r.raise_for_status()
                choice = (r.json().get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                content = msg.get("content")
                if isinstance(content, list):          # parts: only the text ones (thinking parts are skipped)
                    content = "".join(x if isinstance(x, str) else (x.get("text") or "") for x in content if isinstance(x, str) or (isinstance(x, dict) and x.get("type") in (None, "text", "output_text")))
                text = content if isinstance(content, str) else ""
                cut = choice.get("finish_reason") == "length"
                try:
                    out = _extract_json(text)
                except LLMError as ex:
                    cut = cut or ex.truncated
                    thinker = bool(msg.get("reasoning") or msg.get("reasoning_content")) or _is_reasoner(e.model)
                    can_grow = out_tokens < 16000
                    nxt = dict(h)
                    changed = False
                    if cut:
                        if can_grow:
                            nxt["mul"] = h.get("mul", 1) * 3
                            changed = True
                    else:
                        if not nxt.get("strict"):
                            nxt["strict"], changed = True, True
                        if not nxt.get("json") and "response_format" not in e.no_param:
                            nxt["json"], changed = True, True
                    if thinker and not nxt.get("quiet") and any(k not in e.no_param for k in _quiet_params(e.model, e.base)):
                        nxt["quiet"], changed = True, True
                    if cut and can_grow and changed:
                        hints[idx] = nxt                 # more room first: the complete answer beats a partial one
                        prefer.add(idx)
                        attempt -= 1
                        continue
                    part = _salvage_json(text)
                    if part is not None:
                        e.fails, e.bad_json = 0, 0
                        return part
                    if changed:
                        hints[idx] = nxt
                        prefer.add(idx)
                        attempt -= 1
                        continue
                    shown = re.sub(r"\s+", " ", _strip_reasoning(text)).strip()[:140]
                    why = (f"انقطع جواب النموذج عند حدّ الإخراج ({out_tokens} رمزًا) قبل أن يكتمل" if cut else "ردّ النموذج بجواب فارغ" if not shown else f"لم يلتزم النموذج بالرد بصيغة JSON: «{shown}»")
                    last = LLMError(f"{e.name} ({e.model}): {why}.")
                    if not cut:                                      # asked in every way and still no JSON = one strike; the second in a row rests the model for a while (retries are not strikes)
                        e.bad_json += 1
                        if e.bad_json >= 2:
                            e.bad_json = 0
                            self._rest(e, f"النموذج {e.model} لا يردّ بصيغة JSON (جرّب نموذجًا غير تفكيري مثل llama-3.3-70b-versatile)", _OUT_JSON)
                    avoid.add(idx)
                    skip.add(idx)
                    prefer.discard(idx)
                    hints.pop(idx, None)
                    continue
                e.fails, e.bad_json = 0, 0
                if idx in hints:
                    e.learned = hints[idx]
                return out
            except LLMError as ex:       # malformed JSON from this model: try again (maybe another endpoint)
                last = ex
                avoid.add(idx)
            except Exception as ex:  # noqa  network error
                last = ex
                self._cool(e, type("R", (), {"headers": {}, "text": ""})())
                avoid.add(idx)
                if e.fails >= 3:                                    # unreachable three times in a row
                    self._rest(e, "لا يصل الخادم إلى المزوّد؛ يُجرَّب ثانية تلقائيًا", _BUSY_PARK)
        raise LLMError(f"{type(last).__name__}: {last}")


_cache: dict = {}
_cache_lock = threading.Lock()


def get_provider():
    """One provider per configuration for the whole process. This matters: the endpoint pool keeps per-endpoint rate-limit
    windows and cooldowns, and concurrent students' jobs must share them (otherwise each job would pace itself alone and
    together they would blow through the provider's limit)."""
    if settings.anthropic_key:
        key = ("anthropic", settings.anthropic_key, settings.model, settings.verifier_model)
        build = lambda: AnthropicProvider(settings.anthropic_key, settings.model, settings.verifier_model)
    elif settings.openai_compat:
        pool = settings.llm_pool
        key = ("pool", tuple((e["base_url"], e.get("api_key", ""), e["model"], e["rpm"]) for e in pool))
        build = lambda: OpenAICompatProvider(pool)
    elif settings.allow_fake_llm:
        from .fake_llm import FakeProvider

        return FakeProvider()          # test-only and stateful: never shared
    else:
        raise LLMUnavailable("خدمة توليد الأسئلة غير مفعّلة: يلزم ضبط ANTHROPIC_API_KEY (أو QUIZZY_LLM_POOL) على الخادم.")
    with _cache_lock:
        if key not in _cache:
            _cache.clear()             # configuration changed (tests/hot reload): drop stale providers
            _cache[key] = build()
        return _cache[key]


def generator_label(provider) -> str:
    if provider.name == "fake":
        return "test-generator"
    if provider.name == "chatgpt-plan":
        return f"chatgpt-plan:{provider.model}"
    return f"anthropic:{provider.model}"
