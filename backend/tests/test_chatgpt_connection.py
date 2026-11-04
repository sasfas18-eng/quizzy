"""No OpenAI credentials are used: exercise the browser-bound grant and provider contract."""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import settings
from app.db import connect
from app.services import chatgpt_oauth as oauth
from app.services.chatgpt_plan import ChatGPTPlanProvider
from app.services.llm import LLMError
from tests.conftest import upload, wait_for


@pytest.fixture(autouse=True)
def approved_client():
    before = (settings.secret, settings.chatgpt_client_id, settings.chatgpt_client_secret,
              settings.public_url, settings.chatgpt_model)
    settings.secret = "test-secret-is-at-least-thirty-two-characters-long"
    settings.chatgpt_client_id = "oaiapp_test"
    settings.chatgpt_client_secret = ""
    settings.public_url = "http://localhost:8000"
    settings.chatgpt_model = "gpt-6.1-sol"
    yield
    (settings.secret, settings.chatgpt_client_id, settings.chatgpt_client_secret,
     settings.public_url, settings.chatgpt_model) = before


def _start(client):
    r = client.get("/api/chatgpt/connect", follow_redirects=False)
    assert r.status_code == 302, r.text
    u = urlparse(r.headers["location"])
    assert u.scheme == "https" and u.netloc == "auth.openai.com"
    p = {k: v[0] for k, v in parse_qs(u.query).items()}
    assert p["redirect_uri"] == "http://localhost:8000/api/chatgpt/callback"
    assert p["code_challenge_method"] == "S256"
    assert "chatgpt.tokens.use.direct" in p["scope"]
    return p


def test_oauth_is_bound_to_account_session_and_tokens_are_encrypted(alice, bob, monkeypatch):
    p = _start(alice)
    monkeypatch.setattr(oauth, "exchange_code", lambda code, verifier: {
        "access_token": "private-access-token", "refresh_token": "private-refresh-token",
        "id_token": "signed-id-token", "expires_in": 3600,
        "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    })
    monkeypatch.setattr(oauth, "verify_identity", lambda token, nonce: {"sub": "openai-alice", "email": "alice@chatgpt.invalid"})
    callback = "/api/chatgpt/callback?state=" + p["state"] + "&code=temporary-code"
    assert bob.get(callback, follow_redirects=False).status_code == 400
    assert alice.get(callback, follow_redirects=False).status_code == 303
    assert alice.get(callback, follow_redirects=False).status_code == 400, "OAuth state is one-use"
    assert alice.get("/api/chatgpt/status").json()["plan_usage"] is True
    assert bob.get("/api/chatgpt/status").json()["connected"] is False
    with connect() as conn:
        row = conn.execute("SELECT * FROM chatgpt_connections WHERE subject='openai-alice'").fetchone()
        assert row is not None
        assert "private-access-token" not in row["credentials_cipher"]
        assert "private-refresh-token" not in row["credentials_cipher"]
        with pytest.raises(oauth.ChatGPTConnectionError):
            oauth.require_connection(conn, "another-student")


def test_oauth_rejects_identity_without_plan_permission(alice, monkeypatch):
    p = _start(alice)
    monkeypatch.setattr(oauth, "exchange_code", lambda code, verifier: {
        "access_token": "identity-only", "refresh_token": "renewable", "id_token": "signed",
        "scope": "openid profile email offline_access",
    })
    monkeypatch.setattr(oauth, "verify_identity", lambda token, nonce: {"sub": "identity-only", "email": "alice@example.com"})
    r = alice.get("/api/chatgpt/callback?state=" + p["state"] + "&code=code", follow_redirects=False)
    assert r.status_code == 422
    assert alice.get("/api/chatgpt/status").json()["connected"] is False


def test_quiz_creation_requires_the_students_own_connection(alice, bob, sample_pdf):
    a_doc = upload(alice, sample_pdf)
    b_doc = upload(bob, sample_pdf)
    body = lambda doc: {"sources": [{"document_id": doc["id"], "pages": "1-3"}],
                        "settings": {"count": 10, "generator": "chatgpt_plan"}}
    assert alice.post("/api/quizzes", json=body(a_doc)).status_code == 409
    with connect() as conn:
        uid = conn.execute("SELECT id FROM users WHERE email='alice@example.com'").fetchone()["id"]
        oauth.save_connection(conn, uid, {"sub": "openai-alice", "email": "alice@chatgpt.invalid"}, {
            "access_token": "alice-token", "refresh_token": "alice-refresh", "expires_in": 3600,
            "scope": "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
        })
    created = alice.post("/api/quizzes", json=body(a_doc))
    assert created.status_code == 200, created.text
    assert created.json()["settings"]["generator"] == "chatgpt_plan"
    assert bob.post("/api/quizzes", json=body(b_doc)).status_code == 409
    with connect() as conn:
        uid = conn.execute("SELECT id FROM users WHERE email='bob@example.com'").fetchone()["id"]
        oauth.save_connection(conn, uid, {"sub": "openai-bob", "email": "bob@chatgpt.invalid"}, {
            "access_token": "bob-token", "refresh_token": "bob-refresh", "expires_in": 3600,
            "scope": "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
        })
    assert bob.post("/api/quizzes", json=body(a_doc)).status_code == 404


def test_connected_account_is_used_by_the_existing_quiz_pipeline(alice, sample_pdf, monkeypatch):
    from app.services.chatgpt_plan import ChatGPTPlanProvider
    from app.services.fake_llm import FakeProvider
    doc = upload(alice, sample_pdf)
    with connect() as conn:
        uid = conn.execute("SELECT id FROM users WHERE email='alice@example.com'").fetchone()["id"]
        oauth.save_connection(conn, uid, {"sub": "openai-alice", "email": "alice@chatgpt.invalid"}, {
            "access_token": "fake-access", "refresh_token": "fake-refresh", "expires_in": 3600,
            "scope": "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
        })
    fake = FakeProvider()
    def simulated_chatgpt(self, task, system, prompt, payload=None, max_tokens=8000):
        self.model = settings.chatgpt_model
        return fake.json_call(task, system, prompt, payload, max_tokens)
    monkeypatch.setattr(ChatGPTPlanProvider, "json_call", simulated_chatgpt)
    r = alice.post("/api/quizzes", json={"sources": [{"document_id": doc["id"], "pages": "1-3"}],
                                         "settings": {"count": 10, "generator": "chatgpt_plan"}})
    assert r.status_code == 200, r.text
    qid = r.json()["id"]
    assert alice.post(f"/api/quizzes/{qid}/analyze", json={"auto_generate": True}).status_code == 200
    quiz = wait_for(lambda: (lambda q: q if q["status"] not in ("draft", "analyzing", "planned", "generating") else None)(alice.get(f"/api/quizzes/{qid}").json()))
    assert quiz["status"] == "ready", quiz
    assert quiz["generator"] == "chatgpt-plan:gpt-6.1-sol"
    assert len(alice.get(f"/api/quizzes/{qid}/questions").json()) >= 1


def test_id_token_signature_audience_issuer_and_nonce(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(oauth.jwt, "PyJWKClient", lambda url: type("Jwks", (), {
        "get_signing_key_from_jwt": lambda self, token: type("Key", (), {"key": key.public_key()})()
    })())
    def signed(**changes):
        claims = {"iss": oauth.ISSUER, "aud": settings.chatgpt_client_id, "sub": "student-1",
                  "nonce": "expected-nonce", "exp": int(oauth.now()) + 60, **changes}
        return jwt.encode(claims, key, algorithm="RS256")
    assert oauth.verify_identity(signed(), "expected-nonce")["sub"] == "student-1"
    with pytest.raises(oauth.ChatGPTConnectionError):
        oauth.verify_identity(signed(), "wrong-nonce")
    with pytest.raises(oauth.ChatGPTConnectionError):
        oauth.verify_identity(signed(aud="another-app"), "expected-nonce")


def test_responses_provider_uses_plan_contract_and_requires_completed(monkeypatch):
    from app.services import chatgpt_plan
    monkeypatch.setattr(oauth, "access_token", lambda uid: "student-bearer")
    sent = []
    class Stream:
        status_code = 200
        def __init__(self, complete=True): self.complete = complete
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def iter_lines(self):
            yield 'data: ' + json.dumps({"type": "response.output_text.delta", "delta": '{"questions": []}'})
            yield ''
            if self.complete:
                yield 'data: ' + json.dumps({"type": "response.completed", "response": {"output": []}})
                yield ''
    class Client:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def stream(self, method, url, **kwargs):
            sent.append((method, url, kwargs))
            return Stream(complete=len(sent) == 1)
    monkeypatch.setattr(chatgpt_plan.httpx, "Client", Client)
    provider = ChatGPTPlanProvider("alice-id")
    provider.model = "gpt-6.1-sol"
    assert provider.json_call("generate", "Rules", "Make a quiz", max_tokens=12000) == {"questions": []}
    method, url, kwargs = sent[0]
    assert method == "POST" and url == chatgpt_plan.RESPONSES_URL
    assert kwargs["headers"]["Authorization"] == "Bearer student-bearer"
    assert kwargs["json"] == {"model": "gpt-6.1-sol", "instructions": "Rules", "input": [{"role": "user", "content": "Make a quiz"}], "store": False, "stream": True}
    with pytest.raises(LLMError, match="انقطع"):
        provider.json_call("generate", "Rules", "Make a quiz")
