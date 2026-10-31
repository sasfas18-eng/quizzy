from __future__ import annotations

import re
import sqlite3

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from ..config import settings
from ..db import db_dep, new_id, now
from ..deps import COOKIE, ApiError, current_user
from ..security import hash_password, limiter, new_token, token_hash, verify_password
from ..services import mailer
from ..services.taxonomy import FIELDS

router = APIRouter(prefix="/api/auth", tags=["auth"])
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterIn(BaseModel):
    email: str
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    field: str | None = None


class LoginIn(BaseModel):
    email: str
    password: str


def _user_out(u: sqlite3.Row) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "field": u["field"]}


def _start_session(conn, response: Response, user_id: str) -> None:
    tok = new_token()
    exp = now() + settings.session_days * 86400
    conn.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", (token_hash(tok), user_id, now(), exp))
    response.set_cookie(COOKIE, tok, max_age=settings.session_days * 86400, httponly=True, samesite="lax",
                        secure=settings.cookie_secure, path="/")


def _ip(request: Request) -> str:
    return request.client.host if request.client else "?"


@router.post("/register")
def register(body: RegisterIn, request: Request, response: Response, conn: sqlite3.Connection = Depends(db_dep)):
    email = body.email.strip().lower()
    if not EMAIL.match(email):
        raise ApiError(422, "bad_email", "البريد الإلكتروني غير صالح.")
    if body.field and body.field not in FIELDS:
        raise ApiError(422, "bad_field", "التخصص غير معروف.")
    if not limiter.allow("reg:" + _ip(request), 10, 3600):
        raise ApiError(429, "rate_limited", "محاولات كثيرة، حاول لاحقًا.")
    if conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        raise ApiError(409, "email_taken", "هذا البريد مسجّل مسبقًا.")
    uid = new_id()
    role = "admin" if email in settings.admin_emails else "student"
    conn.execute("INSERT INTO users(id,email,name,pw_hash,role,field,created_at) VALUES(?,?,?,?,?,?,?)",
                 (uid, email, body.name.strip(), hash_password(body.password), role, body.field, now()))
    _start_session(conn, response, uid)
    return _user_out(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn: sqlite3.Connection = Depends(db_dep)):
    email = body.email.strip().lower()
    if not limiter.allow(f"login:{_ip(request)}:{email}", 8, 300):
        raise ApiError(429, "rate_limited", "محاولات دخول كثيرة. انتظر بضع دقائق.")
    u = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not u or not verify_password(body.password, u["pw_hash"]):
        raise ApiError(401, "bad_credentials", "البريد أو كلمة المرور غير صحيحة.")
    if email in settings.admin_emails and u["role"] != "admin":
        conn.execute("UPDATE users SET role='admin' WHERE id=?", (u["id"],))
        u = conn.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    _start_session(conn, response, u["id"])
    return _user_out(u)


@router.post("/logout")
def logout(response: Response, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user), request: Request = None):
    tok = request.cookies.get(COOKIE) if request else None
    if tok:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(tok),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user=Depends(current_user)):
    return _user_out(user)


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    field: str | None = None


@router.patch("/me")
def update_me(body: ProfileIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if body.field and body.field not in FIELDS:
        raise ApiError(422, "bad_field", "التخصص غير معروف.")
    conn.execute("UPDATE users SET name=COALESCE(?,name), field=COALESCE(?,field) WHERE id=?",
                 ((body.name or "").strip() or None, body.field, user["id"]))
    return _user_out(conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())


class ForgotIn(BaseModel):
    email: str


@router.get("/capabilities")
def capabilities():
    return {"password_reset": settings.smtp_enabled, "llm": settings.llm_enabled,
            "llm_is_test": settings.allow_fake_llm and not settings.anthropic_key,
            "fields": {k: v["ar"] for k, v in FIELDS.items()}}


@router.post("/forgot")
def forgot(body: ForgotIn, request: Request, conn: sqlite3.Connection = Depends(db_dep)):
    if not settings.smtp_enabled and not settings.dev_log_reset_links:
        raise ApiError(503, "reset_unavailable", "استعادة كلمة المرور بالبريد غير مفعّلة بعد على هذا الخادم (تحتاج إعداد SMTP).")
    email = body.email.strip().lower()
    if not limiter.allow(f"forgot:{_ip(request)}", 5, 3600):
        raise ApiError(429, "rate_limited", "محاولات كثيرة.")
    u = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if u:
        tok = new_token()
        conn.execute("INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)", (token_hash(tok), u["id"], now() + 3600))
        link = f"{settings.public_url}/#/reset?token={tok}"
        mailer.send_reset(email, link)
    return {"ok": True, "message": "إن كان البريد مسجلًا فقد أُرسل إليه رابط الاستعادة (صالح ساعة)."}


class ResetIn(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=200)


@router.post("/reset")
def reset(body: ResetIn, conn: sqlite3.Connection = Depends(db_dep)):
    r = conn.execute("SELECT * FROM reset_tokens WHERE token_hash=? AND used=0 AND expires_at>?", (token_hash(body.token), now())).fetchone()
    if not r:
        raise ApiError(400, "bad_token", "الرابط غير صالح أو منتهي.")
    conn.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(body.password), r["user_id"]))
    conn.execute("UPDATE reset_tokens SET used=1 WHERE token_hash=?", (r["token_hash"],))
    conn.execute("DELETE FROM sessions WHERE user_id=?", (r["user_id"],))
    return {"ok": True}
