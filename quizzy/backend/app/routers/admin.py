from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..db import db_dep, jdump, jload, new_id, now
from ..deps import ApiError, admin_user
from ..services import validate

router = APIRouter(prefix="/api/admin", tags=["admin"])


def ratio(n: float, d: float, definition: str, sample: str) -> dict:
    return {"value": round(n / d, 4) if d else None, "numerator": n, "denominator": d, "definition": definition, "sample": sample}


@router.get("/metrics")
def metrics(conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    q1 = lambda sql, *a: conn.execute(sql, a).fetchone()[0] or 0
    runs_done = q1("SELECT COUNT(*) FROM generation_runs WHERE status IN ('ready','insufficient','failed')")
    runs_ok = q1("SELECT COUNT(*) FROM generation_runs WHERE status='ready'")
    reps = [jload(r["report_json"]) for r in conn.execute("SELECT report_json FROM quizzes WHERE status='ready' AND generator!='test-generator' AND report_json IS NOT NULL")]
    cov_n = sum(r["objective_coverage"]["numerator"] for r in reps)
    cov_d = sum(r["objective_coverage"]["denominator"] for r in reps)
    drafted = sum(r["stats"]["drafted"] for r in reps)
    dup = sum(r["stats"]["rejected_duplicate"] for r in reps)
    delivered = q1("SELECT COUNT(*) FROM questions q JOIN quizzes z ON z.id=q.quiz_id WHERE z.generator!='test-generator'")
    confirmed = q1("""SELECT COUNT(DISTINCT target_id) FROM reports WHERE kind IN ('wrong_key','not_in_source') AND resolution LIKE 'confirmed%' AND target_type='question'""")
    att_total = q1("SELECT COUNT(*) FROM attempts")
    att_done = q1("SELECT COUNT(*) FROM attempts WHERE status='submitted'")
    saves = q1("SELECT COUNT(*) FROM events WHERE kind='save'")
    saves_ok = q1("SELECT COUNT(*) FROM events WHERE kind='save' AND ok=1")
    ratings = conn.execute("SELECT COUNT(*) c, AVG(value) a FROM events WHERE kind='quiz_rating'").fetchone()
    test_q = q1("SELECT COUNT(*) FROM quizzes WHERE generator='test-generator'")
    return {
        "note": "الإحصاءات تُحسب من بيانات الاستخدام الفعلية فقط؛ المحتوى الذي ولّده المولّد الاختباري مستبعد من نسب الجودة.",
        "excluded_test_quizzes": test_q,
        "generation_success": ratio(runs_ok, runs_done, "تشغيلات التوليد التي أنتجت كويزًا جاهزًا ÷ كل التشغيلات المنتهية", f"{runs_done} تشغيلًا"),
        "objective_coverage": ratio(cov_n, cov_d, "أهداف المصدر المغطاة بسؤال مُسلَّم ÷ كل الأهداف المستخرجة", f"{len(reps)} كويزًا جاهزًا"),
        "duplicate_rate": ratio(dup, drafted, "مرشحون رُفضوا للتكرار ÷ كل المرشحين المصاغين", f"{drafted} مرشحًا"),
        "confirmed_defect_rate": ratio(confirmed, delivered, "أسئلة ثبت بعد مراجعة بلاغ أن مفتاحها خاطئ أو غير مدعوم بالمصدر ÷ كل الأسئلة المُسلَّمة", f"{delivered} سؤالًا"),
        "attempt_completion": ratio(att_done, att_total, "محاولات سُلّمت ÷ كل المحاولات التي بدأت", f"{att_total} محاولة"),
        "save_success": ratio(saves_ok, saves, "عمليات حفظ نجحت ÷ كل محاولات الحفظ التي أبلغ عنها المتصفح", f"{saves} عملية"),
        "student_usefulness": {"value": round(ratings["a"], 2) if ratings["a"] else None, "numerator": None, "denominator": ratings["c"],
                               "definition": "متوسط تقييم الطلاب (1–5) لوضوح وفائدة الكويز بعد التسليم", "sample": f"{ratings['c']} تقييمًا"},
        "reports": {"open": q1("SELECT COUNT(*) FROM reports WHERE status='open'"), "total": q1("SELECT COUNT(*) FROM reports")},
    }


@router.get("/reports")
def reports(status: str | None = None, conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    sql = "SELECT r.*, u.email FROM reports r JOIN users u ON u.id=r.user_id"
    args: list = []
    if status:
        sql += " WHERE r.status=?"
        args.append(status)
    out = []
    for r in conn.execute(sql + " ORDER BY r.created_at DESC LIMIT 200", args).fetchall():
        d = dict(r)
        if r["target_type"] == "question":
            q = conn.execute("SELECT stem, qtype, quiz_id, version, review_status FROM questions WHERE id=?", (r["target_id"],)).fetchone()
            d["target"] = dict(q) if q else None
        else:
            c = conn.execute("SELECT front, back FROM flashcards WHERE id=?", (r["target_id"],)).fetchone()
            d["target"] = dict(c) if c else None
        out.append(d)
    return out


class ResolveIn(BaseModel):
    status: Literal["open", "resolved", "rejected"]
    resolution: str = Field(default="", max_length=500)


@router.patch("/reports/{rid}")
def resolve(rid: str, body: ResolveIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    if not conn.execute("SELECT 1 FROM reports WHERE id=?", (rid,)).fetchone():
        raise ApiError(404, "not_found", "البلاغ غير موجود.")
    conn.execute("UPDATE reports SET status=?, resolution=?, resolved_by=?, resolved_at=? WHERE id=?",
                 (body.status, body.resolution, user["email"], now(), rid))
    return {"ok": True}


def _full_question(conn, qid: str) -> dict:
    r = conn.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
    if not r:
        raise ApiError(404, "not_found", "السؤال غير موجود.")
    d = dict(r)
    d["options"] = jload(d.pop("options_json"))
    d["evidence"] = jload(d.pop("evidence_json"))
    d["source_pages"] = jload(d.pop("source_pages_json"))
    d["validation"] = jload(d.pop("validation_json"))
    d["revisions"] = [dict(x) | {"snapshot": jload(x["snapshot_json"])} for x in
                      conn.execute("SELECT id,version,snapshot_json,reason,actor,created_at FROM question_revisions WHERE question_id=? ORDER BY version", (qid,))]
    for x in d["revisions"]:
        x.pop("snapshot_json", None)
    return d


@router.get("/questions/{qid}")
def get_question(qid: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    return _full_question(conn, qid)


class EditIn(BaseModel):
    stem: str = Field(min_length=10)
    options: list[str] = Field(min_length=4, max_length=4)
    correct_index: int = Field(ge=0, le=3)
    explanation: str = Field(min_length=10)
    reason: str = Field(min_length=3, max_length=300)


def _apply_snapshot(conn, qid: str, snap: dict, reason: str, actor: str, review_status: str, kind: str):
    cur = conn.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
    new_v = cur["version"] + 1
    before = {"stem": cur["stem"], "options": jload(cur["options_json"]), "correct_option_id": cur["correct_option_id"], "explanation": cur["explanation"], "version": cur["version"]}
    conn.execute("UPDATE questions SET stem=?, options_json=?, correct_option_id=?, explanation=?, version=?, review_status=?, reviewed_by=NULL, reviewed_at=NULL WHERE id=?",
                 (snap["stem"], jdump(snap["options"]), snap["correct_option_id"], snap["explanation"], new_v, review_status, qid))
    conn.execute("INSERT INTO question_revisions(question_id,version,snapshot_json,reason,actor,created_at) VALUES(?,?,?,?,?,?)",
                 (qid, new_v, jdump(snap), reason, actor, now()))
    conn.execute("INSERT INTO change_log(kind,ref,description,before_json,after_json,actor,created_at) VALUES(?,?,?,?,?,?,?)",
                 (kind, qid, reason, jdump(before), jdump({**snap, "version": new_v}), actor, now()))
    return new_v


@router.put("/questions/{qid}")
def edit_question(qid: str, body: EditIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    cur = _full_question(conn, qid)
    # keep option ids stable where the text is unchanged so past attempts remain interpretable
    old = {o["text"]: o["id"] for o in cur["options"]}
    opts = [{"id": old.get(t) or "o" + new_id()[:8], "text": t.strip()} for t in body.options]
    key = opts[body.correct_index]["id"]
    probe = {"qtype": cur["qtype"], "stem": body.stem, "options": [o["text"] for o in opts], "correct_index": body.correct_index,
             "explanation": body.explanation, "purpose": cur["purpose"], "evidence": cur["evidence"] and [{"page": "x", "quote": ""}]}
    iss = [i for i in validate.validate_question(probe, {"page_text": {}, "allowed_refs": set(), "field": "health", "language": "source", "source_lang_ar": False})
           if i["code"] in ("options_count", "options_duplicate", "all_none_above", "key_invalid")]
    if iss:
        raise ApiError(422, "invalid_question", iss[0]["message"])
    v = _apply_snapshot(conn, qid, {"stem": body.stem.strip(), "options": opts, "correct_option_id": key, "explanation": body.explanation.strip()},
                        body.reason, user["email"], "edited_pending_review", "question_edit")
    return {"version": v}


class RollbackIn(BaseModel):
    version: int


@router.post("/questions/{qid}/rollback")
def rollback(qid: str, body: RollbackIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    r = conn.execute("SELECT snapshot_json FROM question_revisions WHERE question_id=? AND version=?", (qid, body.version)).fetchone()
    if not r:
        raise ApiError(404, "not_found", "الإصدار غير موجود.")
    v = _apply_snapshot(conn, qid, jload(r["snapshot_json"]), f"رجوع إلى الإصدار {body.version}", user["email"], "edited_pending_review", "question_rollback")
    return {"version": v}


class ReviewIn(BaseModel):
    decision: Literal["human_reviewed", "rejected", "machine_verified"]


@router.post("/questions/{qid}/review")
def review(qid: str, body: ReviewIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    """'human_reviewed' is set ONLY here, by a signed-in reviewer, for the current version."""
    _full_question(conn, qid)
    conn.execute("UPDATE questions SET review_status=?, reviewed_by=?, reviewed_at=? WHERE id=?",
                 (body.decision, user["email"] if body.decision == "human_reviewed" else None, now(), qid))
    conn.execute("INSERT INTO change_log(kind,ref,description,actor,created_at) VALUES('question_review',?,?,?,?)",
                 (qid, f"قرار المراجعة: {body.decision}", user["email"], now()))
    return {"ok": True}


@router.get("/changes")
def changes(conn: sqlite3.Connection = Depends(db_dep), user=Depends(admin_user)):
    return [dict(r) for r in conn.execute("SELECT id,kind,ref,description,actor,reverted,created_at FROM change_log ORDER BY id DESC LIMIT 200")]
