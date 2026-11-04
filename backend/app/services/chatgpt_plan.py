"""Responses API provider using a student's approved ChatGPT-plan OAuth grant.

The plan-usage preview requires streamed, non-stored requests and forbids the
output-budget/temperature fields used by other providers. No ChatGPT web-session
cookies, browser automation, or owner's API key are involved.
"""
from __future__ import annotations

import json

import httpx

from ..config import settings
from . import chatgpt_oauth
from .llm import LLMError, _extract_json

RESPONSES_URL = "https://api.openai.com/v1/responses"
MODELS_URL = "https://api.openai.com/v1/models"


def _text_from_response(response: dict) -> str:
    parts = []
    for item in response.get("output", []):
        for block in item.get("content", []):
            if block.get("type") == "output_text":
                parts.append(block.get("text", ""))
    return "".join(parts)


class ChatGPTPlanProvider:
    name = "chatgpt-plan"

    def __init__(self, user_id: str):
        self.user_id = user_id
        self.model: str | None = None

    def _select_model(self, token: str) -> str:
        try:
            with httpx.Client(timeout=15) as client:
                resp = client.get(MODELS_URL, headers={"Authorization": "Bearer " + token})
            if resp.status_code >= 400:
                raise LLMError(f"تعذّر جلب نماذج حساب ChatGPT (HTTP {resp.status_code}).")
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise LLMError("تعذّر قراءة النماذج المتاحة لحساب ChatGPT.") from exc
        models = [m["slug"] for m in data.get("models", []) if isinstance(m, dict) and m.get("visibility") == "list" and m.get("slug")]
        if not models:
            raise LLMError("لا توجد نماذج توليد متاحة لحصة حساب ChatGPT المرتبط.")
        return settings.chatgpt_model if settings.chatgpt_model in models else models[0]

    def json_call(self, task: str, system: str, prompt: str, payload: dict | None = None, max_tokens: int = 8000):
        # `max_tokens` is accepted for the existing engine interface only. The
        # ChatGPT-plan Responses preview rejects max_output_tokens, so omit it.
        del task, payload, max_tokens
        try:
            token = chatgpt_oauth.access_token(self.user_id)
        except chatgpt_oauth.ChatGPTConnectionError as exc:
            raise LLMError(str(exc)) from exc
        if not self.model:
            self.model = self._select_model(token)
        body = {"model": self.model, "instructions": system,
                "input": [{"role": "user", "content": prompt}], "store": False, "stream": True}
        chunks: list[str] = []
        completed = None
        terminal = None
        try:
            with httpx.Client(timeout=httpx.Timeout(180, connect=15)) as client:
                with client.stream("POST", RESPONSES_URL, json=body,
                                   headers={"Authorization": "Bearer " + token, "Accept": "text/event-stream"}) as resp:
                    if resp.status_code == 401:
                        raise LLMError("انتهت صلاحية ربط ChatGPT؛ افصل الحساب ثم أعد ربطه.")
                    if resp.status_code == 429:
                        raise LLMError("بلغ حساب ChatGPT حدّ الاستخدام المحدد له؛ انتظر إعادة تعيين الحصة.")
                    if resp.status_code >= 400:
                        raise LLMError(f"رفضت خدمة ChatGPT طلب التوليد (HTTP {resp.status_code}).")
                    data_lines = []
                    for line in resp.iter_lines():
                        if line.startswith("data:"):
                            data_lines.append(line[5:].lstrip())
                            continue
                        if line or not data_lines:
                            continue
                        raw = "\n".join(data_lines)
                        data_lines = []
                        if raw == "[DONE]":
                            break
                        try:
                            event = json.loads(raw)
                        except ValueError:
                            continue
                        kind = event.get("type")
                        if kind == "response.output_text.delta":
                            chunks.append(event.get("delta", ""))
                        elif kind == "response.completed":
                            completed = event.get("response", {})
                            terminal = kind
                        elif kind in ("response.failed", "response.incomplete"):
                            terminal = kind
                            err = (event.get("response") or {}).get("error") or {}
                            code = err.get("code", "") if isinstance(err, dict) else ""
                            if code in ("subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"):
                                raise LLMError("حصة ChatGPT لهذا الحساب غير متاحة الآن؛ راجع حدود التطبيق في حسابك.")
                            raise LLMError("لم تُكمل خدمة ChatGPT إنشاء الأسئلة؛ حاول مرة أخرى.")
        except httpx.HTTPError as exc:
            raise LLMError("تعذّر الاتصال بخدمة ChatGPT أثناء التوليد.") from exc
        if terminal != "response.completed":
            raise LLMError("انقطع بث ChatGPT قبل اكتمال الإجابة؛ لم تُعتمد أسئلة ناقصة.")
        text = "".join(chunks) or _text_from_response(completed or {})
        if not text.strip():
            raise LLMError("أكملت خدمة ChatGPT الطلب دون نص أسئلة قابل للفحص.")
        return _extract_json(text)
