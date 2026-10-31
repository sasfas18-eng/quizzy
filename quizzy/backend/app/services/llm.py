"""LLM access. Real provider = Anthropic Messages API (server side). No key -> disabled, never faked.

A deterministic test provider exists (fake_llm.py) but only loads when QUIZZY_ALLOW_FAKE_LLM=1;
content it produces is stamped generator="test-generator" and shown with a visible badge.
"""
from __future__ import annotations

import json
import re
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
        model = self.verifier_model if task == "verify" else self.model
        last: Exception | None = None
        for attempt in range(2):
            try:
                msg = self.client.messages.create(
                    model=model, max_tokens=max_tokens, temperature=0.4 if task == "generate" else 0.0,
                    system=system + "\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.",
                    messages=[{"role": "user", "content": prompt}],
                )
                text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
                return _extract_json(text)
            except LLMError as e:  # malformed JSON -> one retry
                last = e
                time.sleep(1)
            except Exception as e:  # network / API errors already retried by SDK
                raise LLMError(f"{type(e).__name__}: {e}") from e
        raise LLMError(str(last))


class OpenAICompatProvider:
    """Chat-completions endpoint (Groq, OpenRouter, Gemini compat, Ollama...). Handles 429 with backoff.
    JSON is requested via the prompt and parsed defensively, because not every server supports response_format."""
    name = "openai-compat"

    def __init__(self, base_url: str, key: str, model: str):
        import httpx

        self.http = httpx.Client(timeout=180)
        self.base, self.key, self.model = base_url, key, model

    def json_call(self, task: str, system: str, prompt: str, payload: dict | None = None, max_tokens: int = 6000) -> Any:
        body = {"model": self.model, "max_tokens": max_tokens, "temperature": 0.4 if task == "generate" else 0.0,
                "messages": [{"role": "system", "content": system + "\n\nReturn ONLY one valid JSON value. No prose, no markdown fences."},
                             {"role": "user", "content": prompt}]}
        headers = {"Authorization": f"Bearer {self.key or 'none'}"}
        last: Exception | None = None
        for attempt in range(5):
            try:
                r = self.http.post(f"{self.base}/chat/completions", json=body, headers=headers)
                if r.status_code == 429 or r.status_code >= 500:
                    time.sleep(min(30, 2 ** attempt * 2))  # free tiers rate-limit: back off, don't hammer
                    last = LLMError(f"HTTP {r.status_code}")
                    continue
                r.raise_for_status()
                return _extract_json(r.json()["choices"][0]["message"]["content"] or "")
            except LLMError as e:
                last = e
            except Exception as e:  # noqa
                last = e
                time.sleep(1)
        raise LLMError(f"{type(last).__name__}: {last}")


def get_provider():
    if settings.anthropic_key:
        return AnthropicProvider(settings.anthropic_key, settings.model, settings.verifier_model)
    if settings.openai_compat:
        return OpenAICompatProvider(settings.llm_base_url, settings.llm_api_key, settings.llm_model)
    if settings.allow_fake_llm:
        from .fake_llm import FakeProvider

        return FakeProvider()
    raise LLMUnavailable("خدمة توليد الأسئلة غير مفعّلة: يلزم ضبط ANTHROPIC_API_KEY على الخادم.")


def generator_label(provider) -> str:
    return "test-generator" if provider.name == "fake" else f"anthropic:{provider.model}"
