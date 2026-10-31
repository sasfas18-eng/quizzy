from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor

from fastapi import Cookie, Depends, HTTPException

from .config import settings
from .db import db_dep, now
from .security import token_hash

COOKIE = "quizzy_session"
pool = ThreadPoolExecutor(max_workers=settings.workers, thread_name_prefix="quizzy-job")


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(status_code=status, detail={"code": code, "message": message, **extra})


def current_user(conn: sqlite3.Connection = Depends(db_dep), quizzy_session: str | None = Cookie(default=None)) -> sqlite3.Row:
    if not quizzy_session:
        raise ApiError(401, "unauthenticated", "سجّل الدخول للمتابعة.")
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
        (token_hash(quizzy_session), now())).fetchone()
    if not row:
        raise ApiError(401, "session_expired", "انتهت الجلسة، سجّل الدخول مجددًا.")
    return row


def admin_user(user: sqlite3.Row = Depends(current_user)) -> sqlite3.Row:
    if user["role"] != "admin":
        raise ApiError(403, "forbidden", "هذه الصفحة للمشرفين فقط.")
    return user


def owned_quiz(conn: sqlite3.Connection, user_id: str, quiz_id: str) -> sqlite3.Row:
    """Every student-facing read goes through ownership checks; 404 (not 403) avoids leaking existence."""
    row = conn.execute("SELECT * FROM quizzes WHERE id=? AND user_id=?", (quiz_id, user_id)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "الكويز غير موجود.")
    return row


def owned_doc(conn: sqlite3.Connection, user_id: str, doc_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (doc_id, user_id)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "الملف غير موجود.")
    return row


def owned_attempt(conn: sqlite3.Connection, user_id: str, attempt_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM attempts WHERE id=? AND user_id=?", (attempt_id, user_id)).fetchone()
    if not row:
        raise ApiError(404, "not_found", "المحاولة غير موجودة.")
    return row


def require_llm():
    if not settings.llm_enabled:
        raise ApiError(503, "llm_not_configured",
                       "توليد الأسئلة يحتاج تفعيل خدمة الذكاء الاصطناعي على الخادم (ANTHROPIC_API_KEY). "
                       "رفع الملفات والبطاقات المحفوظة والحل متاحة، لكن لن يُنشأ كويز جديد قبل التفعيل.")
