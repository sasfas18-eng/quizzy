"""OAuth account connection. Available only for an OpenAI-approved client on a HTTPS server."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from ..config import settings
from ..db import db_dep, now
from ..deps import COOKIE, ApiError, current_user
from ..security import limiter, token_hash
from ..services import chatgpt_oauth as oauth

router = APIRouter(prefix="/api/chatgpt", tags=["chatgpt"])


@router.get("/status")
def status(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    return oauth.connection_status(conn, user["id"])


@router.get("/connect")
def connect(request: Request, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if not settings.chatgpt_connection_available:
        raise ApiError(503, "chatgpt_not_configured", "ربط ChatGPT ينتظر تفعيل OpenAI وخادمًا آمنًا.")
    if user["role"] == "guest":
        raise ApiError(403, "account_required", "أنشئ حساب كويزي أولًا لربط ChatGPT.")
    if not limiter.allow("chatgpt-oauth:" + user["id"], 8, 600):
        raise ApiError(429, "rate_limited", "محاولات ربط كثيرة؛ حاول بعد دقائق.")
    url, state, verifier, nonce = oauth.make_authorization()
    conn.execute("DELETE FROM chatgpt_oauth_pending WHERE expires_at<?", (now(),))
    conn.execute("INSERT INTO chatgpt_oauth_pending(state_hash,user_id,session_hash,verifier_cipher,nonce,expires_at) VALUES(?,?,?,?,?,?)",
                 (oauth.state_hash(state), user["id"], token_hash(request.cookies.get(COOKIE, "")),
                  oauth._seal(verifier), nonce, now() + 600))
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})


@router.get("/callback")
def callback(request: Request, state: str = "", code: str = "", error: str = "",
             client_id: str = "", conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if not state or len(state) > 256:
        raise ApiError(400, "bad_oauth_state", "محاولة الربط غير صالحة؛ ابدأ من صفحة حسابك.")
    row = conn.execute("SELECT * FROM chatgpt_oauth_pending WHERE state_hash=?", (oauth.state_hash(state),)).fetchone()
    if not row or row["expires_at"] < now() or row["user_id"] != user["id"] or row["session_hash"] != token_hash(request.cookies.get(COOKIE, "")):
        raise ApiError(400, "bad_oauth_state", "انتهت محاولة الربط أو لا تخص هذا الحساب؛ ابدأ من صفحة حسابك.")
    conn.execute("DELETE FROM chatgpt_oauth_pending WHERE state_hash=?", (row["state_hash"],))
    if error:
        return RedirectResponse("/#/account?chatgpt=denied", status_code=303)
    if not code or (client_id and client_id != settings.chatgpt_client_id):
        raise ApiError(400, "bad_oauth_callback", "ردّ ربط ChatGPT غير مكتمل أو يخص تطبيقًا آخر.")
    try:
        tokens = oauth.exchange_code(code, oauth._open(row["verifier_cipher"]))
        claims = oauth.verify_identity(tokens.get("id_token", ""), row["nonce"])
        oauth.save_connection(conn, user["id"], claims, tokens)
    except oauth.ChatGPTConnectionError as exc:
        # Return a fixed, non-sensitive status. Never put provider errors or credentials in a URL.
        raise ApiError(422, "chatgpt_connection_failed", str(exc)) from exc
    return RedirectResponse("/#/account?chatgpt=connected", status_code=303, headers={"Cache-Control": "no-store"})


@router.post("/disconnect")
def disconnect(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    try:
        confirmed = oauth.disconnect(conn, user["id"])
    except oauth.ChatGPTConnectionError as exc:
        raise ApiError(503, "chatgpt_disconnect_failed", str(exc)) from exc
    return {"disconnected": True, "remote_revocation_confirmed": confirmed}
