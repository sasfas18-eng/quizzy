from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..db import db_dep, new_id, now
from ..deps import ApiError, current_user

router = APIRouter(prefix="/api", tags=["reports"])
KINDS = ("wrong_key", "unclear", "not_in_source", "duplicate", "bad_distractor", "language", "bad_card", "other")


class ReportIn(BaseModel):
    target_type: Literal["question", "flashcard"]
    target_id: str
    kind: Literal["wrong_key", "unclear", "not_in_source", "duplicate", "bad_distractor", "language", "bad_card", "other"]
    message: str = Field(default="", max_length=1000)


@router.post("/reports")
def create_report(body: ReportIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if body.target_type == "question":
        ok = conn.execute("SELECT 1 FROM questions q JOIN quizzes z ON z.id=q.quiz_id WHERE q.id=? AND z.user_id=?", (body.target_id, user["id"])).fetchone()
    else:
        ok = conn.execute("SELECT 1 FROM flashcards WHERE id=? AND user_id=?", (body.target_id, user["id"])).fetchone()
    if not ok:
        raise ApiError(404, "not_found", "العنصر غير موجود.")
    dup = conn.execute("SELECT id FROM reports WHERE user_id=? AND target_id=? AND kind=? AND status='open'", (user["id"], body.target_id, body.kind)).fetchone()
    if dup:
        return {"id": dup["id"], "duplicate": True}
    rid = new_id()
    conn.execute("INSERT INTO reports(id,user_id,target_type,target_id,kind,message,created_at) VALUES(?,?,?,?,?,?,?)",
                 (rid, user["id"], body.target_type, body.target_id, body.kind, body.message.strip(), now()))
    return {"id": rid}


@router.get("/reports/mine")
def mine(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    rows = conn.execute("SELECT id,target_type,target_id,kind,message,status,resolution,created_at FROM reports WHERE user_id=? ORDER BY created_at DESC", (user["id"],)).fetchall()
    return [dict(r) for r in rows]


class EventIn(BaseModel):
    kind: Literal["save", "quiz_rating"]
    ok: bool | None = None
    value: float | None = Field(default=None, ge=1, le=5)
    ref: str | None = None


@router.post("/events")
def event(body: EventIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    if body.kind == "quiz_rating":
        if body.value is None or not conn.execute("SELECT 1 FROM quizzes WHERE id=? AND user_id=?", (body.ref, user["id"])).fetchone():
            raise ApiError(422, "bad_event", "تقييم غير صالح.")
    conn.execute("INSERT INTO events(user_id,kind,ref,ok,value,created_at) VALUES(?,?,?,?,?,?)",
                 (user["id"], body.kind, body.ref, None if body.ok is None else int(body.ok), body.value, now()))
    return {"ok": True}
