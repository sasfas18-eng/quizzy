from __future__ import annotations

import sqlite3
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from ..db import db_dep, jdump, jload, new_id, now
from ..deps import ApiError, current_user, owned_quiz, pool, require_llm
from ..services import generator
from ..services.extract import parse_page_spec
from ..services.quiz_pdf import build_pdf
from ..services.support import analyze_support
from ..services.taxonomy import DIFFICULTY_AR, FOCUS_AR, QTYPES, detect_field, type_label

router = APIRouter(prefix="/api/quizzes", tags=["quizzes"])


class SourceIn(BaseModel):
    document_id: str
    pages: str | list[int] | None = None  # "1-5, 8" ; empty = all


class QuizSettings(BaseModel):
    count: int = Field(default=20, ge=5, le=60)
    difficulty: Literal["easy", "medium", "hard", "mixed"] = "mixed"
    language: Literal["source", "ar", "en"] = "source"
    focus: Literal["balanced", "understand_apply", "critical", "recall"] = "balanced"
    mode: Literal["practice", "exam"] = "practice"
    shuffle_options: bool = True
    timer_minutes: int | None = Field(default=None, ge=1, le=600)
    delivery: Literal["online", "pdf"] = "online"
    pdf_include_key: bool = True
    external_mode: Literal["source_only", "supplement"] = "source_only"
    create_cards: bool = False


class QuizIn(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    sources: list[SourceIn] = Field(min_length=1, max_length=6)
    settings: QuizSettings = QuizSettings()


SCORING = {"points_per_correct": 1, "negative_marking": False, "unanswered": 0,
           "text": "درجة واحدة لكل إجابة صحيحة، بلا خصم على الخطأ، والسؤال غير المجاب يساوي صفرًا. الدرجة = الصحيح ÷ عدد الأسئلة."}


def quiz_out(q: sqlite3.Row, full: bool = False) -> dict:
    out = {"id": q["id"], "title": q["title"], "status": q["status"], "settings": jload(q["settings_json"]),
           "error": q["error"], "is_demo": bool(q["is_demo"]), "generator": q["generator"],
           "progress": {"stage": q["progress_stage"], "pct": q["progress_pct"]},
           "created_at": q["created_at"], "updated_at": q["updated_at"], "scoring": SCORING}
    rep = jload(q["report_json"])
    if rep:
        out["report"] = rep
        out["question_count"] = rep.get("delivered")
    if full:
        out["plan"] = jload(q["plan_json"])
        a = jload(q["analysis_json"])
        if a:
            out["analysis"] = {k: a.get(k) for k in ("lecture_character", "gaps", "discipline_guess", "excluded_pages", "heuristic_support", "fallback")}
            out["analysis"]["objectives"] = [{"id": o["id"], "statement": o["statement"], "pages": o["pages"],
                                              "types": list(o["supports"])} for o in a.get("objectives", [])]
    return out


def source_preview(conn, user_id: str, sources: list[dict], field: str) -> dict:
    src = generator.load_source(conn, user_id, sources)
    heur = analyze_support([p["text"] for p in src["pages"]], field) if src["pages"] else {}
    types = {}
    for code in QTYPES:
        h = heur.get(code)
        if h:
            types[code] = {"label": type_label(code, field), "level": h["level"], "missing": h["missing"]}
    words = heur.get("_meta", {}).get("words", 0) if heur else 0
    return {"readable_pages": len(src["pages"]), "excluded_pages": src["excluded"], "words": words, "type_support": types}


@router.get("/options")
def options():
    return {"counts": [10, 20, 30], "default_count": 20, "difficulty": DIFFICULTY_AR, "focus": FOCUS_AR,
            "types": {k: {"ar": v["ar"], "en": v["en"]} for k, v in QTYPES.items()}, "scoring": SCORING}


@router.post("")
def create_quiz(body: QuizIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    st = body.settings.model_dump()
    sources = []
    for s in body.sources:
        d = conn.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (s.document_id, user["id"])).fetchone()
        if not d:
            raise ApiError(404, "not_found", "ملف غير موجود.")
        try:
            parse_page_spec(s.pages, d["page_count"] or 10**6)
        except ValueError as e:
            raise ApiError(422, "bad_pages", str(e))
        sources.append({"document_id": s.document_id, "pages": s.pages})
    st["sources"] = sources
    try:
        src = generator.load_source(conn, user["id"], sources)
        st["field"] = detect_field(" ".join(pg["text"] for pg in src["pages"]))
        prev = source_preview(conn, user["id"], sources, st["field"])
    except (ValueError, PermissionError) as e:
        raise ApiError(422, "source_error", str(e))
    if prev["readable_pages"] == 0:
        raise ApiError(422, "no_readable_pages", "لا توجد صفحات مقروءة في النطاق المختار.", excluded=prev["excluded_pages"])
    qid = new_id()
    title = (body.title or "").strip() or conn.execute("SELECT title FROM documents WHERE id=?", (sources[0]["document_id"],)).fetchone()["title"]
    conn.execute("INSERT INTO quizzes(id,user_id,title,settings_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                 (qid, user["id"], title[:120], jdump(st), "draft", now(), now()))
    out = quiz_out(conn.execute("SELECT * FROM quizzes WHERE id=?", (qid,)).fetchone(), True)
    out["source_preview"] = prev
    return out


@router.get("")
def list_quizzes(conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    rows = conn.execute("SELECT * FROM quizzes WHERE user_id=? ORDER BY created_at DESC", (user["id"],)).fetchall()
    return [quiz_out(r) for r in rows]


@router.get("/{quiz_id}")
def get_quiz(quiz_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    q = owned_quiz(conn, user["id"], quiz_id)
    out = quiz_out(q, True)
    st = jload(q["settings_json"])
    try:
        out["source_preview"] = source_preview(conn, user["id"], st["sources"], st.get("field", "other"))
    except Exception:
        out["source_preview"] = None
    return out


@router.post("/{quiz_id}/analyze")
def analyze(quiz_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    q = owned_quiz(conn, user["id"], quiz_id)
    require_llm()
    if q["status"] in ("analyzing", "generating"):
        raise ApiError(409, "busy", "المعالجة جارية بالفعل.")
    conn.execute("UPDATE quizzes SET status='analyzing', progress_stage='queued', progress_pct=0, error=NULL, updated_at=? WHERE id=?", (now(), quiz_id))
    pool.submit(generator.job_analyse, quiz_id)
    return {"ok": True}


class GenerateIn(BaseModel):
    accept_reduced: bool = False


@router.post("/{quiz_id}/generate")
def generate(quiz_id: str, body: GenerateIn, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    q = owned_quiz(conn, user["id"], quiz_id)
    require_llm()
    if q["status"] == "ready":
        raise ApiError(409, "already_ready", "الكويز جاهز بالفعل (ومحاولاتك مرتبطة بأسئلته). أنشئ كويزًا جديدًا بدل إعادة التوليد.")
    if q["status"] not in ("planned", "failed", "insufficient") or not q["plan_json"]:
        raise ApiError(409, "not_planned", "حلّل المحتوى وأكّد الخطة أولًا.")
    plan = jload(q["plan_json"])
    if plan["feasible_count"] == 0:
        raise ApiError(409, "nothing_feasible", "المصدر لا يدعم أي سؤال في النطاق الحالي؛ وسّع المصدر.")
    if plan["feasible_count"] < plan["requested"] and not body.accept_reduced:
        raise ApiError(409, "shortfall", f"المصدر يدعم {plan['feasible_count']} سؤالًا فقط من أصل {plan['requested']}. وافق على العدد الأقل أو وسّع المصدر.",
                       shortfall=plan.get("shortfall"))
    conn.execute("UPDATE quizzes SET status='generating', progress_stage='queued', progress_pct=0, error=NULL, updated_at=? WHERE id=?", (now(), quiz_id))
    pool.submit(generator.job_generate, quiz_id)
    return {"ok": True}


def question_out(r: sqlite3.Row, with_key: bool, field: str = "other") -> dict:
    out = {"id": r["id"], "position": r["position"], "qtype": r["qtype"], "type_label": type_label(r["qtype"], field),
           "task": r["task"], "difficulty": r["difficulty"], "stem": r["stem"], "options": jload(r["options_json"]),
           "version": r["version"], "review_status": r["review_status"]}
    if with_key:
        out.update({"correct_option_id": r["correct_option_id"], "explanation": r["explanation"], "purpose": r["purpose"],
                    "objective": r["objective"], "source_pages": jload(r["source_pages_json"]), "evidence": jload(r["evidence_json"]),
                    "validation": jload(r["validation_json"]), "prompt_version": r["prompt_version"]})
    return out


@router.get("/{quiz_id}/questions")
def questions(quiz_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    """Question bank with keys — the owner's own library view (the solving screen uses /api/attempts, which hides keys)."""
    q = owned_quiz(conn, user["id"], quiz_id)
    field = jload(q["settings_json"]).get("field", "other")
    rows = conn.execute("SELECT * FROM questions WHERE quiz_id=? ORDER BY position", (quiz_id,)).fetchall()
    return [question_out(r, True, field) for r in rows]


@router.patch("/{quiz_id}")
def rename(quiz_id: str, body: dict, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    owned_quiz(conn, user["id"], quiz_id)
    title = str(body.get("title", "")).strip()[:120]
    if not title:
        raise ApiError(422, "bad_title", "العنوان فارغ.")
    conn.execute("UPDATE quizzes SET title=?, updated_at=? WHERE id=?", (title, now(), quiz_id))
    return {"ok": True}


@router.delete("/{quiz_id}")
def delete_quiz(quiz_id: str, conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    owned_quiz(conn, user["id"], quiz_id)
    conn.execute("DELETE FROM quizzes WHERE id=?", (quiz_id,))
    return {"ok": True}


@router.get("/{quiz_id}/pdf")
def pdf(quiz_id: str, answer_key: bool = True, shuffle: bool | None = None, explanations: bool = True,
        conn: sqlite3.Connection = Depends(db_dep), user=Depends(current_user)):
    q = owned_quiz(conn, user["id"], quiz_id)
    if q["status"] != "ready":
        raise ApiError(409, "not_ready", "الكويز غير جاهز بعد.")
    st = jload(q["settings_json"])
    rows = conn.execute("SELECT * FROM questions WHERE quiz_id=? ORDER BY position", (quiz_id,)).fetchall()
    qs = [{"id": r["id"], "qtype": r["qtype"], "stem": r["stem"], "options": jload(r["options_json"]),
           "correct_option_id": r["correct_option_id"], "explanation": r["explanation"],
           "source_pages": jload(r["source_pages_json"])} for r in rows]
    st = {**st, "pdf_include_key": answer_key, "pdf_include_explanations": explanations}
    if shuffle is not None:
        st["shuffle_options"] = shuffle
    data, _ = build_pdf({"id": q["id"], "title": q["title"], "generator": q["generator"]}, qs, st, user["name"])
    safe = "".join(c for c in q["title"] if c.isalnum() or c in " _-")[:40].strip() or "quiz"
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=quizzy-{quiz_id[:6]}.pdf; filename*=UTF-8''{quote(safe.replace(' ', '_'))}.pdf"})
