from __future__ import annotations

import random
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..db import db_dep, jdump, jload, new_id, now
from ..deps import ApiError, current_user, owned_attempt, owned_quiz
from ..services.taxonomy import type_label
from .quizzes import SCORING

router = APIRouter(tags=["attempts"])


class StartIn(BaseModel):
    mode: Literal["practice", "exam"] | None = None
    shuffle_options: bool | None = None
    shuffle_questions: bool = False
    timer_minutes: int | None = Field(default=None, ge=1, le=600)
    only_question_ids: list[str] | None = None  # e.g. review of flagged/wrong questions


def _snapshot(conn, question_id: str, version: int, current: sqlite3.Row) -> dict:
    """The question as the student saw it (admin edits create new versions; attempts keep their own)."""
    if version == current["version"]:
        return {"stem": current["stem"], "options": jload(current["options_json"]),
                "correct_option_id": current["correct_option_id"], "explanation": current["explanation"]}
    r = conn.execute("SELECT snapshot_json FROM question_revisions WHERE question_id=? AND version=?", (question_id, version)).fetchone()
    return jload(r["snapshot_json"]) if r else {"stem": current["stem"], "options": jload(current["options_json"]),
                                                "correct_option_id": current["correct_option_id"], "explanation": current["explanation"]}


def _time_state(a: sqlite3.Row) -> dict:
    if not a["timer_seconds"]:
        return {"limit": None, "remaining": None}
    used = int(now() - a["started_at"]) if a["mode"] == "exam" else a["elapsed_seconds"]
    return {"limit": a["timer_seconds"], "remaining": max(0, a["timer_seconds"] - used)}


def _expire_if_needed(conn, a: sqlite3.Row) -> sqlite3.Row:
    if a["status"] == "in_progress" and a["mode"] == "exam" and a["timer_seconds"] and now() - a["started_at"] > a["timer_seconds"] + 2:
        _finalize(conn, a)
        return conn.execute("SELECT * FROM attempts WHERE id=?", (a["id"],)).fetchone()
    return a


def _finalize(conn, a: sqlite3.Row) -> None:
    order = jload(a["question_order_json"])
    score = conn.execute("SELECT COALESCE(SUM(is_correct),0) s FROM attempt_answers WHERE attempt_id=?", (a["id"],)).fetchone()["s"]
    conn.execute("UPDATE attempts SET status='submitted', score=?, max_score=?, submitted_at=?, updated_at=? WHERE id=?",
                 (score, len(order), now(), now(), a["id"]))


@router.post("/api/quizzes/{quiz_id}/attempts")
def start(quiz_id: str, body: StartIn = StartIn(), conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    q = owned_quiz(conn, user["id"], quiz_id)
    if q["status"] != "ready":
        raise ApiError(409, "not_ready", "الكويز غير جاهز.")
    st = jload(q["settings_json"])
    rows = conn.execute("SELECT * FROM questions WHERE quiz_id=? AND review_status!='rejected' ORDER BY position", (quiz_id,)).fetchall()
    if body.only_question_ids:
        want = set(body.only_question_ids)
        rows = [r for r in rows if r["id"] in want]
    if not rows:
        raise ApiError(409, "empty", "لا توجد أسئلة.")
    aid = new_id()
    rng = random.Random(aid)
    ids = [r["id"] for r in rows]
    if body.shuffle_questions:
        rng.shuffle(ids)
    shuffle_opts = st.get("shuffle_options", True) if body.shuffle_options is None else body.shuffle_options
    order = {}
    for r in rows:
        oids = [o["id"] for o in jload(r["options_json"])]
        if shuffle_opts:
            rng.shuffle(oids)
        order[r["id"]] = oids
    mode = body.mode or st.get("mode", "practice")
    tm = body.timer_minutes if body.timer_minutes is not None else st.get("timer_minutes")
    conn.execute("""INSERT INTO attempts(id,user_id,quiz_id,mode,question_order_json,option_order_json,timer_seconds,started_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?)""", (aid, user["id"], quiz_id, mode, jdump(ids), jdump(order), tm * 60 if tm else None, now(), now()))
    for r in rows:
        conn.execute("INSERT INTO attempt_answers(attempt_id,question_id,question_version) VALUES(?,?,?)", (aid, r["id"], r["version"]))
    return attempt_state(conn, owned_attempt(conn, user["id"], aid))


def attempt_state(conn, a: sqlite3.Row) -> dict:
    a = _expire_if_needed(conn, a)
    q = conn.execute("SELECT * FROM quizzes WHERE id=?", (a["quiz_id"],)).fetchone()
    field = jload(q["settings_json"]).get("field", "other")
    order = jload(a["question_order_json"])
    oorder = jload(a["option_order_json"])
    answers = {r["question_id"]: r for r in conn.execute("SELECT * FROM attempt_answers WHERE attempt_id=?", (a["id"],)).fetchall()}
    submitted = a["status"] == "submitted"
    practice = a["mode"] == "practice"
    qrows = {r["id"]: r for r in conn.execute("SELECT * FROM questions WHERE quiz_id=?", (a["quiz_id"],)).fetchall()}
    items = []
    for qid in order:
        cur = qrows[qid]
        ans = answers[qid]
        snap = _snapshot(conn, qid, ans["question_version"], cur)
        by_id = {o["id"]: o for o in snap["options"]}
        opts = [by_id[i] for i in oorder[qid] if i in by_id]
        item = {"id": qid, "position": len(items) + 1, "qtype": cur["qtype"], "type_label": type_label(cur["qtype"], field),
                "stem": snap["stem"], "options": opts, "selected_option_id": ans["selected_option_id"],
                "flagged": bool(ans["flagged"]), "answered": ans["selected_option_id"] is not None,
                "source_pages": jload(cur["source_pages_json"])}
        reveal = submitted or (practice and ans["revealed"])
        if reveal:
            item.update({"correct_option_id": snap["correct_option_id"], "explanation": snap["explanation"],
                         "is_correct": bool(ans["is_correct"]) if ans["selected_option_id"] else False,
                         "evidence": [e for e in jload(cur["evidence_json"])]})
        items.append(item)
    return {"id": a["id"], "quiz_id": a["quiz_id"], "quiz_title": q["title"], "mode": a["mode"], "status": a["status"],
            "current_index": a["current_index"], "elapsed_seconds": a["elapsed_seconds"], "time": _time_state(a),
            "score": a["score"], "max_score": a["max_score"], "questions": items, "scoring": SCORING,
            "answered": sum(1 for i in items if i["answered"]), "total": len(items),
            "generator": q["generator"], "is_demo": bool(q["is_demo"]), "started_at": a["started_at"], "submitted_at": a["submitted_at"]}


@router.get("/api/attempts")
def list_attempts(quiz_id: str | None = None, status: str | None = None, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    sql = """SELECT a.*, q.title AS quiz_title FROM attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE a.user_id=?"""
    args: list = [user["id"]]
    if quiz_id:
        sql += " AND a.quiz_id=?"
        args.append(quiz_id)
    if status:
        sql += " AND a.status=?"
        args.append(status)
    rows = conn.execute(sql + " ORDER BY a.updated_at DESC LIMIT 100", args).fetchall()
    out = []
    for r in rows:
        r = _expire_if_needed(conn, r) if r["status"] == "in_progress" else r
        n = len(jload(r["question_order_json"]))
        ans = conn.execute("SELECT COUNT(selected_option_id) c FROM attempt_answers WHERE attempt_id=?", (r["id"],)).fetchone()["c"]
        out.append({"id": r["id"], "quiz_id": r["quiz_id"], "quiz_title": r["quiz_title"], "mode": r["mode"], "status": r["status"],
                    "answered": ans, "total": n, "score": r["score"], "max_score": r["max_score"],
                    "started_at": r["started_at"], "updated_at": r["updated_at"], "submitted_at": r["submitted_at"]})
    return out


@router.get("/api/attempts/{attempt_id}")
def get_attempt(attempt_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    return attempt_state(conn, owned_attempt(conn, user["id"], attempt_id))


class AnswerIn(BaseModel):
    question_id: str
    option_id: str | None = None
    flagged: bool | None = None
    clear: bool = False


@router.put("/api/attempts/{attempt_id}/answer")
def answer(attempt_id: str, body: AnswerIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    a = _expire_if_needed(conn, owned_attempt(conn, user["id"], attempt_id))
    if a["status"] == "submitted":
        raise ApiError(409, "time_up" if a["mode"] == "exam" and a["timer_seconds"] else "already_submitted", "المحاولة مسلَّمة ولا يمكن تعديلها.")
    ans = conn.execute("SELECT * FROM attempt_answers WHERE attempt_id=? AND question_id=?", (attempt_id, body.question_id)).fetchone()
    if not ans:
        raise ApiError(404, "not_found", "السؤال ليس ضمن المحاولة.")
    cur = conn.execute("SELECT * FROM questions WHERE id=?", (body.question_id,)).fetchone()
    snap = _snapshot(conn, body.question_id, ans["question_version"], cur)
    resp: dict = {"saved": True, "saved_at": now()}
    if body.option_id is not None or body.clear:
        if a["mode"] == "practice" and ans["revealed"]:
            raise ApiError(409, "locked", "تم عرض التفسير لهذا السؤال؛ لا يمكن تغيير الإجابة في وضع التدريب.")
        sel = None if body.clear else body.option_id
        if sel is not None and sel not in {o["id"] for o in snap["options"]}:
            raise ApiError(422, "bad_option", "الخيار لا ينتمي لهذا السؤال.")
        correct = None if sel is None else int(sel == snap["correct_option_id"])
        reveal = 1 if (a["mode"] == "practice" and sel is not None) else 0
        conn.execute("UPDATE attempt_answers SET selected_option_id=?, is_correct=?, revealed=?, answered_at=? WHERE attempt_id=? AND question_id=?",
                     (sel, correct, reveal, now() if sel else None, attempt_id, body.question_id))
        if reveal:
            resp.update({"is_correct": bool(correct), "correct_option_id": snap["correct_option_id"], "explanation": snap["explanation"],
                         "evidence": jload(cur["evidence_json"]), "source_pages": jload(cur["source_pages_json"])})
    if body.flagged is not None:
        conn.execute("UPDATE attempt_answers SET flagged=? WHERE attempt_id=? AND question_id=?", (int(body.flagged), attempt_id, body.question_id))
    conn.execute("UPDATE attempts SET updated_at=? WHERE id=?", (now(), attempt_id))
    return resp


class PositionIn(BaseModel):
    index: int = Field(ge=0)
    elapsed_seconds: int = Field(ge=0, le=86400 * 3)


@router.put("/api/attempts/{attempt_id}/position")
def position(attempt_id: str, body: PositionIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    a = _expire_if_needed(conn, owned_attempt(conn, user["id"], attempt_id))
    if a["status"] == "submitted":
        return {"saved": False, "status": "submitted"}
    n = len(jload(a["question_order_json"]))
    conn.execute("UPDATE attempts SET current_index=?, elapsed_seconds=MAX(elapsed_seconds,?), updated_at=? WHERE id=?",
                 (min(body.index, n - 1), body.elapsed_seconds, now(), attempt_id))
    return {"saved": True, "saved_at": now()}


@router.post("/api/attempts/{attempt_id}/submit")
def submit(attempt_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    a = _expire_if_needed(conn, owned_attempt(conn, user["id"], attempt_id))
    if a["status"] != "submitted":
        _finalize(conn, a)
    return attempt_state(conn, owned_attempt(conn, user["id"], attempt_id))


@router.delete("/api/attempts/{attempt_id}")
def delete_attempt(attempt_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    owned_attempt(conn, user["id"], attempt_id)
    conn.execute("DELETE FROM attempts WHERE id=?", (attempt_id,))
    return {"ok": True}
