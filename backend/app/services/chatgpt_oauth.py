"""Server-side Sign in with ChatGPT connection for an OpenAI-approved hosted app.

OAuth credentials never reach the page, logs, quiz rows, or the static Pages build.
This module is dormant until OpenAI issues a client ID and the operator configures a
persistent HTTPS backend. Its use of ChatGPT plan quota still depends on the grant.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
from urllib.parse import urlencode

import httpx
import jwt
from cryptography.fernet import Fernet, InvalidToken

from ..config import settings
from ..db import connect, now

ISSUER = "https://auth.openai.com"
AUTH_URL = ISSUER + "/api/accounts/authorize"
TOKEN_URL = ISSUER + "/api/accounts/oauth/token"
JWKS_URL = ISSUER + "/.well-known/jwks.json"
REVOCATION_URL = ISSUER + "/api/accounts/oauth/revoke"
RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"


class ChatGPTConnectionError(RuntimeError):
    pass


def _cipher() -> Fernet:
    if not settings.chatgpt_connection_available:
        raise ChatGPTConnectionError("ربط ChatGPT غير مفعّل على هذا الخادم.")
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.secret.encode()).digest())
    return Fernet(key)


def _seal(value: dict | str) -> str:
    raw = json.dumps(value, separators=(",", ":")) if isinstance(value, dict) else value
    return _cipher().encrypt(raw.encode()).decode()


def _open(value: str, as_json: bool = False):
    try:
        plain = _cipher().decrypt(value.encode()).decode()
    except InvalidToken as exc:
        raise ChatGPTConnectionError("تعذّر قراءة ربط ChatGPT؛ أعد ربط الحساب.") from exc
    return json.loads(plain) if as_json else plain


def callback_url() -> str:
    return settings.public_url.rstrip("/") + "/api/chatgpt/callback"


def make_authorization() -> tuple[str, str, str, str]:
    """Return URL, state, verifier, nonce for one browser-bound PKCE transaction."""
    _cipher()
    state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {
        "client_id": settings.chatgpt_client_id,
        "redirect_uri": callback_url(),
        "response_type": "code",
        "scope": settings.chatgpt_scopes,
        "resource": RESOURCE,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return AUTH_URL + "?" + urlencode(params), state, verifier, nonce


def state_hash(state: str) -> str:
    return hashlib.sha256(state.encode()).hexdigest()


def _token_request(form: dict) -> dict:
    form["client_id"] = settings.chatgpt_client_id
    if settings.chatgpt_client_secret:
        auth = (settings.chatgpt_client_id, settings.chatgpt_client_secret)
    else:
        auth = None
    try:
        with httpx.Client(timeout=20) as client:
            resp = client.post(TOKEN_URL, data=form, auth=auth)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ChatGPTConnectionError("تعذّر إكمال ربط ChatGPT لدى المزوّد. أعد المحاولة.") from exc
    if not isinstance(data, dict) or not data.get("access_token"):
        raise ChatGPTConnectionError("لم تُعد خدمة ChatGPT رمز وصول صالحًا.")
    return data


def exchange_code(code: str, verifier: str) -> dict:
    return _token_request({"grant_type": "authorization_code", "code": code,
                           "code_verifier": verifier, "redirect_uri": callback_url(), "resource": RESOURCE})


def verify_identity(id_token: str, nonce: str) -> dict:
    if not id_token:
        raise ChatGPTConnectionError("لم تُعد خدمة ChatGPT هوية موثقة.")
    try:
        key = jwt.PyJWKClient(JWKS_URL).get_signing_key_from_jwt(id_token).key
        claims = jwt.decode(id_token, key, algorithms=["RS256"], audience=settings.chatgpt_client_id,
                            issuer=ISSUER, leeway=60)
    except jwt.PyJWTError as exc:
        raise ChatGPTConnectionError("تعذّر التحقق من هوية حساب ChatGPT.") from exc
    if not secrets.compare_digest(str(claims.get("nonce", "")), nonce) or not claims.get("sub"):
        raise ChatGPTConnectionError("فشل التحقق من محاولة ربط ChatGPT.")
    return claims


def granted_scopes(tokens: dict) -> set[str]:
    value = tokens.get("scope", "")
    return set(value.split() if isinstance(value, str) else value if isinstance(value, list) else [])


def save_connection(conn, user_id: str, claims: dict, tokens: dict) -> None:
    scopes = granted_scopes(tokens)
    if PLAN_SCOPE not in scopes or "resource.invoke" not in scopes:
        raise ChatGPTConnectionError("سُجّل الدخول، لكن لم تُمنح صلاحية استخدام حصة ChatGPT للتوليد في كويزي.")
    if not tokens.get("refresh_token"):
        raise ChatGPTConnectionError("لم تُمنح صلاحية تجديد الربط؛ أعد المحاولة.")
    existing = conn.execute("SELECT subject FROM chatgpt_connections WHERE user_id=?", (user_id,)).fetchone()
    if existing and existing["subject"] != claims["sub"]:
        raise ChatGPTConnectionError("هذا حساب ChatGPT مختلف. افصل الحساب الحالي أولًا ثم أعد الربط.")
    exp = now() + max(60, int(tokens.get("expires_in", 3600)))
    creds = {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]}
    conn.execute("INSERT INTO chatgpt_connections(user_id,subject,email,credentials_cipher,scopes_json,expires_at,updated_at) "
                 "VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET subject=excluded.subject,email=excluded.email,"
                 "credentials_cipher=excluded.credentials_cipher,scopes_json=excluded.scopes_json,"
                 "expires_at=excluded.expires_at,updated_at=excluded.updated_at",
                 (user_id, claims["sub"], claims.get("email", ""), _seal(creds), json.dumps(sorted(scopes)), exp, now()))


def connection_status(conn, user_id: str) -> dict:
    row = conn.execute("SELECT email,scopes_json FROM chatgpt_connections WHERE user_id=?", (user_id,)).fetchone()
    return {"available": settings.chatgpt_connection_available, "connected": bool(row),
            "email": row["email"] if row else None,
            "plan_usage": bool(row and PLAN_SCOPE in json.loads(row["scopes_json"]))}


def require_connection(conn, user_id: str) -> None:
    if not connection_status(conn, user_id)["plan_usage"]:
        raise ChatGPTConnectionError("اربط حساب ChatGPT المؤهل من صفحة «حسابي» قبل إنشاء الكويز.")


_refresh_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def access_token(user_id: str) -> str:
    """Refresh rotating credentials once per user/process, and atomically replace the token pair."""
    with _locks_guard:
        lock = _refresh_locks.setdefault(user_id, threading.Lock())
    with lock:
        conn = connect()
        try:
            row = conn.execute("SELECT * FROM chatgpt_connections WHERE user_id=?", (user_id,)).fetchone()
            if not row or PLAN_SCOPE not in json.loads(row["scopes_json"]):
                raise ChatGPTConnectionError("ربط ChatGPT غير متاح لهذا الحساب.")
            creds = _open(row["credentials_cipher"], as_json=True)
            if row["expires_at"] > now() + 120:
                return creds["access_token"]
            try:
                refreshed = _token_request({"grant_type": "refresh_token", "refresh_token": creds["refresh_token"],
                                            "resource": RESOURCE})
            except ChatGPTConnectionError:
                # Another server process may have refreshed the rotating token first.
                newer = conn.execute("SELECT credentials_cipher FROM chatgpt_connections WHERE user_id=?", (user_id,)).fetchone()
                if newer and newer["credentials_cipher"] != row["credentials_cipher"]:
                    return _open(newer["credentials_cipher"], as_json=True)["access_token"]
                raise
            scopes = granted_scopes(refreshed) or set(json.loads(row["scopes_json"]))
            if PLAN_SCOPE not in scopes:
                raise ChatGPTConnectionError("انتهت صلاحية استخدام حصة ChatGPT؛ أعد ربط الحساب.")
            pair = {"access_token": refreshed["access_token"],
                    "refresh_token": refreshed.get("refresh_token") or creds["refresh_token"]}
            updated = conn.execute("UPDATE chatgpt_connections SET credentials_cipher=?,scopes_json=?,expires_at=?,updated_at=? "
                                   "WHERE user_id=? AND credentials_cipher=?",
                                   (_seal(pair), json.dumps(sorted(scopes)), now() + max(60, int(refreshed.get("expires_in", 3600))),
                                    now(), user_id, row["credentials_cipher"]))
            if updated.rowcount == 0:
                newer = conn.execute("SELECT credentials_cipher FROM chatgpt_connections WHERE user_id=?", (user_id,)).fetchone()
                if not newer:
                    raise ChatGPTConnectionError("فُصل حساب ChatGPT أثناء تجديد الربط.")
                return _open(newer["credentials_cipher"], as_json=True)["access_token"]
            return pair["access_token"]
        finally:
            conn.close()


def disconnect(conn, user_id: str) -> bool:
    row = conn.execute("SELECT credentials_cipher FROM chatgpt_connections WHERE user_id=?", (user_id,)).fetchone()
    if not row:
        return True
    try:
        creds = _open(row["credentials_cipher"], as_json=True)
    except ChatGPTConnectionError:
        conn.execute("DELETE FROM chatgpt_connections WHERE user_id=?", (user_id,))
        return False
    confirmed = False
    try:
        form = {"token": creds["refresh_token"], "token_type_hint": "refresh_token", "client_id": settings.chatgpt_client_id}
        with httpx.Client(timeout=10) as client:
            resp = client.post(REVOCATION_URL, data=form,
                               auth=(settings.chatgpt_client_id, settings.chatgpt_client_secret) if settings.chatgpt_client_secret else None)
        confirmed = resp.status_code == 200
    except httpx.HTTPError:
        pass
    conn.execute("DELETE FROM chatgpt_connections WHERE user_id=?", (user_id,))
    return confirmed
