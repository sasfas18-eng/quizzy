from __future__ import annotations

import hmac
import re
import shutil
import sqlite3

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from ..config import settings
from ..db import db_dep, new_id, now
from ..deps import COOKIE, ApiError, current_user
from ..security import hash_password, limiter, new_token, token_hash, verify_password
from ..services import mailer

router = APIRouter(prefix="/api/auth", tags=["auth"])
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterIn(BaseModel):
    email: str
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    invite_code: str | None = Field(default=None, max_length=100)


class LoginIn(BaseModel):
    email: str
    password: str


def _user_out(u: sqlite3.Row) -> dict:
    guest = u["role"] == "guest"
    return {"id": u["id"], "email": "" if guest else u["email"], "name": u["name"], "role": u["role"], **({"guest": True} if guest else {})}


def _start_session(conn, response: Response, user_id: str, days: int | None = None) -> None:
    days = days or settings.session_days
    tok = new_token()
    exp = now() + days * 86400
    conn.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", (token_hash(tok), user_id, now(), exp))
    response.set_cookie(COOKIE, tok, max_age=days * 86400, httponly=True, samesite="lax",
                        secure=settings.cookie_secure, path="/")


def erase_user(conn: sqlite3.Connection, uid: str) -> None:
    """Remove a user and everything that belongs to them: files on disk, runs, events, caches, and (by cascade) documents, quizzes, attempts, cards, reports."""
    shutil.rmtree(settings.upload_dir / uid, ignore_errors=True)
    for tbl in ("generation_runs", "events", "analysis_cache"):
        conn.execute(f"DELETE FROM {tbl} WHERE user_id=?", (uid,))
    conn.execute("DELETE FROM users WHERE id=?", (uid,))


_last_purge = 0.0


def purge_guests(conn: sqlite3.Connection, force: bool = False) -> int:
    """A guest account lives while it has a session (QUIZZY_GUEST_DAYS from its creation); a guest who left (no live session) or whose days are over is erased."""
    global _last_purge
    t = now()
    if not force and t - _last_purge < 600:
        return 0
    _last_purge = t
    ids = [r["id"] for r in conn.execute("SELECT id FROM users WHERE role='guest' AND id NOT IN (SELECT user_id FROM sessions WHERE expires_at>?)", (t,)).fetchall()]
    for uid in ids:
        erase_user(conn, uid)
    return len(ids)


def _guest_of(request: Request, conn: sqlite3.Connection):
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    return conn.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.role='guest'", (token_hash(tok), now())).fetchone()


def _ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _check_registration_allowed(email: str, invite_code: str | None) -> None:
    """Registration policy: QUIZZY_REGISTRATION = open | invite | closed, plus an optional email-domain allow-list.
    Configured admin emails can always register (so a closed site can still be bootstrapped)."""
    if email in settings.admin_emails:
        return
    mode = settings.registration_mode
    if mode == "closed":
        raise ApiError(403, "registration_closed", "التسجيل مغلق حاليًا.")
    if mode == "invite":
        code = (invite_code or "").strip()
        if not code or not any(hmac.compare_digest(code, c) for c in settings.invite_codes):
            raise ApiError(403, "invalid_invite", "رمز الدعوة غير صحيح.")
    if settings.allowed_email_domains and email.rsplit("@", 1)[-1] not in settings.allowed_email_domains:
        raise ApiError(403, "domain_not_allowed", "التسجيل متاح لبريد النطاقات المسموحة فقط.")


@router.post("/register")
def register(body: RegisterIn, request: Request, response: Response, conn: sqlite3.Connection = Depends(db_dep)):
    email = body.email.strip().lower()
    if not EMAIL.match(email):
        raise ApiError(422, "bad_email", "البريد الإلكتروني غير صالح.")
    _check_registration_allowed(email, body.invite_code)
    if not limiter.allow("reg:" + _ip(request), 10, 3600):
        raise ApiError(429, "rate_limited", "محاولات كثيرة، حاول لاحقًا.")
    if conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        raise ApiError(409, "email_taken", "هذا البريد مسجّل مسبقًا.")
    role = "admin" if email in settings.admin_emails else "student"
    g = _guest_of(request, conn)
    if g:       # a guest who registers keeps everything made so far: the temporary account becomes the real one
        uid = g["id"]
        conn.execute("UPDATE users SET email=?, name=?, pw_hash=?, role=? WHERE id=?", (email, body.name.strip(), hash_password(body.password), role, uid))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    else:
        uid = new_id()
        conn.execute("INSERT INTO users(id,email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                     (uid, email, body.name.strip(), hash_password(body.password), role, now()))
    _start_session(conn, response, uid)
    return _user_out(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


@router.post("/guest")
def guest(request: Request, response: Response, conn: sqlite3.Connection = Depends(db_dep)):
    """Use the site without registering: a temporary account, kept for QUIZZY_GUEST_DAYS, with no promise that it stays."""
    if not settings.guests_enabled:
        raise ApiError(403, "guests_disabled", "الدخول كضيف غير مفعّل على هذا الخادم.")
    if not limiter.allow("guest:" + _ip(request), 30, 3600):
        raise ApiError(429, "rate_limited", "محاولات كثيرة، حاول لاحقًا.")
    if _guest_of(request, conn):        # already a guest on this browser: keep the same one
        return _user_out(_guest_of(request, conn))
    purge_guests(conn)
    uid = new_id()
    conn.execute("INSERT INTO users(id,email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                 (uid, f"guest-{uid}@guest.invalid", "ضيف", hash_password(new_token()), "guest", now()))
    _start_session(conn, response, uid, settings.guest_days)
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


@router.patch("/me")
def update_me(body: ProfileIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    conn.execute("UPDATE users SET name=COALESCE(?,name) WHERE id=?", ((body.name or "").strip() or None, user["id"]))
    return _user_out(conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())


class ForgotIn(BaseModel):
    email: str


@router.get("/capabilities")
def capabilities():
    return {"password_reset": settings.smtp_enabled, "llm": settings.llm_enabled, "registration": settings.registration_mode, "trial": settings.trial,
            "guest": settings.guests_enabled, "can_register": settings.registration_mode != "closed", "guest_days": settings.guest_days,
            "llm_is_test": settings.allow_fake_llm and not settings.anthropic_key,
            "chatgpt_connect_available": settings.chatgpt_connection_available}


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


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/password")
def change_password(body: PasswordIn, request: Request, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if user["role"] == "guest":
        raise ApiError(403, "guest_no_password", "الضيف بلا كلمة مرور. أنشئ حسابًا أولًا.")
    if not limiter.allow(f"pw:{user['id']}", 8, 600):
        raise ApiError(429, "rate_limited", "محاولات كثيرة. انتظر قليلًا.")
    if not verify_password(body.current_password, user["pw_hash"]):
        raise ApiError(403, "bad_credentials", "كلمة المرور الحالية غير صحيحة.")
    conn.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(body.new_password), user["id"]))
    keep = token_hash(request.cookies.get(COOKIE, ""))
    conn.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?", (user["id"], keep))   # sign out every other device
    return {"ok": True}


class DeleteIn(BaseModel):
    password: str


@router.post("/delete")
def delete_account(body: DeleteIn, response: Response, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    """Right to erasure: removes the account, every file, quiz, attempt, card and report belonging to it."""
    if not limiter.allow(f"del:{user['id']}", 5, 600):
        raise ApiError(429, "rate_limited", "محاولات كثيرة. انتظر قليلًا.")
    if user["role"] != "guest" and not verify_password(body.password, user["pw_hash"]):
        raise ApiError(403, "bad_credentials", "كلمة المرور غير صحيحة.")
    erase_user(conn, user["id"])        # FK cascades: sessions, documents/pages, quizzes/questions, attempts, cards, reports
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/export")
def export_data(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    """Everything the account owns, as one JSON download."""
    from ..db import jload

    uid = user["id"]
    rows = lambda sql, *a: [dict(r) for r in conn.execute(sql, a).fetchall()]
    docs = rows("SELECT id,title,filename,kind,page_count,status,created_at FROM documents WHERE user_id=?", uid)
    for d in docs:
        d["pages"] = rows("SELECT page_no,status,text FROM pages WHERE document_id=? ORDER BY page_no", d["id"])
    quizzes = rows("SELECT id,title,status,settings_json,report_json,created_at FROM quizzes WHERE user_id=?", uid)
    for q in quizzes:
        q["settings"], q["report"] = jload(q.pop("settings_json")), jload(q.pop("report_json"))
        qs = rows("SELECT id,position,qtype,stem,options_json,correct_option_id,explanation,purpose,source_pages_json,evidence_json,version,review_status FROM questions WHERE quiz_id=? ORDER BY position", q["id"])
        for x in qs:
            x["options"], x["source_pages"], x["evidence"] = jload(x.pop("options_json")), jload(x.pop("source_pages_json")), jload(x.pop("evidence_json"))
        q["questions"] = qs
    attempts = rows("SELECT id,quiz_id,mode,status,score,max_score,started_at,submitted_at FROM attempts WHERE user_id=?", uid)
    for a in attempts:
        a["answers"] = rows("SELECT question_id,question_version,selected_option_id,flagged,is_correct FROM attempt_answers WHERE attempt_id=?", a["id"])
        a["corrections"] = rows("SELECT question_id,option_id,text,created_at FROM corrections WHERE attempt_id=?", a["id"])      # the Arabic corrections of wrong answers
    data = {"exported_at": __import__("time").time(), "user": {"id": uid, "email": user["email"], "name": user["name"], "created_at": user["created_at"]},
            "documents": docs, "quizzes": quizzes, "attempts": attempts,
            "flashcards": rows("SELECT id,document_id,front,back,source_page,evidence,state,times_known,times_review,due_at FROM flashcards WHERE user_id=?", uid),
            "reports": rows("SELECT id,target_type,target_id,kind,message,status,created_at FROM reports WHERE user_id=?", uid)}
    return Response(__import__("json").dumps(data, ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": "attachment; filename=quizzy-export.json"})
