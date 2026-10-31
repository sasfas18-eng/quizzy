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
    pass


def _extract_json(text: str) -> Any:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start < 0:
        raise LLMError("no JSON in model output")
    dec = json.JSONDecoder()
    obj, _ = dec.raw_decode(text[start:])
    return obj


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
                    model=model, max_tokens=max_tokens, temperature=0.4 if task == "generate" else 0.0,
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

    def wait_needed(self, now: float) -> float:
        """seconds until this endpoint may be used (0 = now)"""
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

    def _acquire(self, deadline: float, avoid: set[int]) -> _Endpoint:
        while True:
            with self.lock:
                now = time.monotonic()
                order = [(self.eps[(self.rr + k) % len(self.eps)], (self.rr + k) % len(self.eps)) for k in range(len(self.eps))]
                cands = [(e.wait_needed(now), i, e) for e, i in order]
                ready = [c for c in cands if c[0] <= 0 and c[1] not in avoid] or [c for c in cands if c[0] <= 0]
                if ready:
                    _, i, e = ready[0]
                    e.stamps.append(now)
                    self.rr = (i + 1) % len(self.eps)
                    return e
                wait = min(c[0] for c in cands)
            if time.monotonic() + wait > deadline:
                raise LLMError("كل مزوّدي التوليد المجانيين استنفدوا حدّهم الآن؛ أعد المحاولة لاحقًا أو أضف مزوّدًا/مفتاحًا آخر.")
            time.sleep(min(wait, 30) + 0.01)

    def _cool(self, e: _Endpoint, resp) -> None:
        secs = 30.0
        try:
            ra = resp.headers.get("retry-after")
            if ra:
                secs = float(ra)
            elif "day" in (resp.text or "").lower() and "per day" in (resp.text or "").lower():
                secs = 3600.0   # daily quota: stop hammering this endpoint for an hour
            else:
                secs = 20.0 * (1 + e.fails)
        except Exception:
            pass
        with self.lock:
            e.fails += 1
            e.cool_until = time.monotonic() + min(secs, 3600.0)

    def json_call(self, task: str, system: str, prompt: str, payload: dict | None = None, max_tokens: int = 6000) -> Any:
        deadline = time.monotonic() + self.max_wait
        avoid: set[int] = set()
        last: Exception | None = None
        for attempt in range(max(6, 3 * len(self.eps))):
            e = self._acquire(deadline, avoid)
            body = {"model": e.model, "max_tokens": max_tokens, "temperature": 0.4 if task == "generate" else 0.0,
                    "messages": [{"role": "system", "content": system + "\n\nReturn ONLY one valid JSON value. No prose, no markdown fences."},
                                 {"role": "user", "content": prompt}]}
            try:
                r = self.http.post(f"{e.base}/chat/completions", json=body, headers={"Authorization": f"Bearer {e.key or 'none'}"})
                if r.status_code in (429, 402, 403) or r.status_code >= 500:
                    self._cool(e, r)
                    avoid.add(self.eps.index(e))
                    last = LLMError(f"{e.name}: HTTP {r.status_code}")
                    continue
                r.raise_for_status()
                out = _extract_json(r.json()["choices"][0]["message"]["content"] or "")
                e.fails = 0
                return out
            except LLMError as ex:       # malformed JSON from this model: try again (maybe another endpoint)
                last = ex
                avoid.add(self.eps.index(e))
            except Exception as ex:  # noqa  network error
                last = ex
                self._cool(e, type("R", (), {"headers": {}, "text": ""})())
                avoid.add(self.eps.index(e))
        raise LLMError(f"{type(last).__name__}: {last}")


def get_provider():
    if settings.anthropic_key:
        return AnthropicProvider(settings.anthropic_key, settings.model, settings.verifier_model)
    if settings.openai_compat:
        return OpenAICompatProvider(settings.llm_pool)
    if settings.allow_fake_llm:
        from .fake_llm import FakeProvider

        return FakeProvider()
    raise LLMUnavailable("خدمة توليد الأسئلة غير مفعّلة: يلزم ضبط ANTHROPIC_API_KEY على الخادم.")


def generator_label(provider) -> str:
    return "test-generator" if provider.name == "fake" else f"anthropic:{provider.model}"
