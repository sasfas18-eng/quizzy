"""Quiz generation engine:
extract -> analyse lecture -> objectives -> plan distribution -> draft candidates -> validate
-> verify (blind solve) -> duplicate/leak check -> approve and persist.
Nothing is padded: slots that cannot be written correctly are dropped and reported.
"""
from __future__ import annotations

import hashlib
import random
import sqlite3
import traceback
from concurrent.futures import ThreadPoolExecutor

from ..db import jdump, jload, new_id, now
from . import prompts, validate
from .extract import parse_page_spec
from .llm import LLMError, generator_label, get_provider
from .planner import build_plan
from .support import analyze_support
from .taxonomy import FIELDS, QTYPES

USABLE = ("ok", "low_text")
MAX_BATCH = 3
MAX_CHARS_PER_CALL = 24000


# ---------------------------------------------------------------- source

def load_source(conn: sqlite3.Connection, user_id: str, sources: list[dict]) -> dict:
    """sources: [{document_id, pages: '1-5,8' | [ints] | None}] -> pages + excluded report."""
    pages, excluded, docs = [], [], []
    for di, s in enumerate(sources, start=1):
        d = conn.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (s["document_id"], user_id)).fetchone()
        if not d:
            raise PermissionError("ملف غير موجود أو لا تملك صلاحية الوصول إليه.")
        if d["status"] != "ready":
            raise ValueError(f"الملف «{d['title']}» لم تكتمل معالجته بعد.")
        wanted = parse_page_spec(s.get("pages"), d["page_count"])
        rows = conn.execute("SELECT * FROM pages WHERE document_id=? ORDER BY page_no", (d["id"],)).fetchall()
        by_no = {r["page_no"]: r for r in rows}
        docs.append({"index": di, "id": d["id"], "title": d["title"], "field": d["field"]})
        for no in wanted:
            r = by_no.get(no)
            ref = f"d{di}p{no}"
            if r is None or r["status"] not in USABLE:
                excluded.append({"ref": ref, "document": d["title"], "page": no,
                                 "status": r["status"] if r else "missing",
                                 "reason": (r["notes"] if r else "صفحة مفقودة") or "غير مقروءة"})
                continue
            pages.append({"ref": ref, "doc_id": d["id"], "doc_title": d["title"], "page_no": no, "text": r["text"],
                          "status": r["status"], "image_count": r["image_count"]})
    return {"pages": pages, "excluded": excluded, "docs": docs}


def page_label(ref: str, src: dict) -> dict:
    for p in src["pages"]:
        if p["ref"] == ref:
            return {"doc_id": p["doc_id"], "doc_title": p["doc_title"], "page": p["page_no"], "ref": ref}
    return {"ref": ref}


# ---------------------------------------------------------------- analysis

def _chunks(pages: list[dict], max_chars: int = 18000) -> list[list[dict]]:
    out, cur, n = [], [], 0
    for p in pages:
        L = len(p["text"][:6000])
        if cur and n + L > max_chars:
            out.append(cur)
            cur, n = [], 0
        cur.append(p)
        n += L
    if cur:
        out.append(cur)
    return out


def analyse(provider, src: dict, settings: dict) -> dict:
    refs = {p["ref"] for p in src["pages"]}
    objectives, gaps, chars, disc = [], [], [], []
    def run(chunk):
        system, prompt = prompts.analyze_prompt(chunk, settings.get("field", "other"), settings.get("language", "source"),
                                                settings.get("external_mode") == "supplement")
        return provider.json_call("analyze", system, prompt, {"pages": chunk, "field": settings.get("field")})

    chunks = _chunks(src["pages"])
    with ThreadPoolExecutor(max_workers=min(4, len(chunks) or 1)) as ex:
        results = list(ex.map(run, chunks))
    for r in results:
        for ob in r.get("objectives", []):
            pg = [x for x in ob.get("pages", []) if x in refs]
            if not pg:
                continue
            sup = {}
            for t, v in (ob.get("supports") or {}).items():
                if t in QTYPES:
                    vp = [x for x in (v or {}).get("pages", pg) if x in refs] or pg
                    sup[t] = {"pages": vp, "task": (v or {}).get("task")}
            if not sup:
                continue
            objectives.append({"id": "", "statement": str(ob.get("statement", "")).strip()[:300], "pages": pg,
                               "key_terms": ob.get("key_terms", [])[:10],
                               "capacity": max(1, min(4, int(ob.get("capacity", 1) or 1))), "supports": sup})
        gaps += r.get("gaps", [])[:5]
        if r.get("lecture_character"):
            chars.append(r["lecture_character"])
        if r.get("discipline_guess"):
            disc.append(r["discipline_guess"])
    for i, ob in enumerate(objectives, start=1):
        ob["id"] = f"o{i}"
    return {"objectives": objectives, "gaps": gaps[:10], "lecture_character": " ".join(chars[:2]),
            "discipline_guess": max(set(disc), key=disc.count) if disc else None}


# ---------------------------------------------------------------- generation

def _norm_candidate(raw: dict, slot: dict) -> dict:
    opts = [str(o).strip() for o in (raw.get("options") or [])]
    return {
        "slot": slot["slot"], "qtype": slot["qtype"], "task": slot.get("task"), "objective": slot["objective"],
        "objective_id": slot["objective_id"], "difficulty": slot["difficulty"],
        "stem": str(raw.get("stem", "")).strip(), "options": opts,
        "correct_index": raw.get("correct_index") if isinstance(raw.get("correct_index"), int) else -1,
        "explanation": str(raw.get("explanation", "")).strip(), "purpose": str(raw.get("purpose", "")).strip(),
        "reasoning_pattern": str(raw.get("reasoning_pattern", "")).strip(),
        "evidence": [{"page": e.get("page"), "quote": str(e.get("quote", "")).strip()} for e in (raw.get("evidence") or []) if isinstance(e, dict)],
        "calc": raw.get("calc") if isinstance(raw.get("calc"), dict) else None,
        "uses_external": bool(raw.get("uses_external")),
    }


def _ctx(src: dict, settings: dict) -> dict:
    page_text = {p["ref"]: p["text"] for p in src["pages"]}
    sample = " ".join(p["text"] for p in src["pages"][:10])
    return {"page_text": page_text, "allowed_refs": set(page_text), "field": settings.get("field", "other"),
            "language": settings.get("language", "source"), "source_lang_ar": validate.arabic_ratio(sample) > 0.4,
            "allow_external": settings.get("external_mode") == "supplement"}


def judge(r: dict, cand: dict, settings: dict) -> list[dict]:
    """Turn one blind-solver verdict into issues (decisive => never delivered)."""
    iss: list[dict] = []
    if r.get("chosen_index") != cand["correct_index"]:
        iss.append(validate.issue("solver_disagrees", "المحلل المستقل اختار إجابة مختلفة أو لم يستطع الحسم من المصدر."))
    if not r.get("answerable_from_source", False) and not (cand["uses_external"] and settings.get("external_mode") == "supplement"):
        iss.append(validate.issue("not_answerable", "السؤال لا يُجاب من المصدر وحده."))
    if not r.get("single_best_answer", False):
        iss.append(validate.issue("ambiguous_key", "أكثر من إجابة مقبولة أو لا توجد إجابة أرجح بوضوح."))
    if r.get("sufficient_data") is False:
        iss.append(validate.issue("insufficient_data", "المعطيات غير كافية."))
    if r.get("needs_outside_knowledge") and settings.get("external_mode") != "supplement":
        iss.append(validate.issue("outside_knowledge", "يحتاج معلومة من خارج المصدر."))
    for f in (r.get("flaws") or [])[:3]:
        iss.append(validate.issue("verifier_flaw", str(f)[:200], "decisive" if r.get("severity") == "decisive" else "minor"))
    return iss


def llm_check_batch(provider, items: list[tuple[str, dict]], pages: dict[str, str], settings: dict) -> dict[str, list[dict]]:
    """Blind solve + explanation audit for a GROUP of questions in 2 LLM calls (not 2 per question).
    items: [(id, candidate)]. A question the reviewer does not answer is REJECTED, never passed silently."""
    out: dict[str, list[dict]] = {qid: [] for qid, _ in items}
    by_id = {qid: c for qid, c in items}
    blind = [{"id": qid, "qtype": c["qtype"], "stem": c["stem"], "options": c["options"]} for qid, c in items]
    try:
        system, prompt = prompts.verify_batch_prompt(blind, pages)
        r = provider.json_call("verify_batch", system, prompt, {"items": [{"id": q, "question": c} for q, c in items], "pages": pages}, max_tokens=2500)
        verdicts = {v.get("id"): v for v in (r.get("results") or []) if isinstance(v, dict)}
    except LLMError as e:
        return {qid: [validate.issue("verifier_error", f"فشل التحقق الآلي: {e}")] for qid, _ in items}
    for qid, c in items:
        v = verdicts.get(qid)
        out[qid] = judge(v, c, settings) if v else [validate.issue("verifier_error", "لم يُرجع المدقق نتيجة لهذا السؤال.")]
    todo = [qid for qid, _ in items if not validate.decisive(out[qid])]
    if todo:
        ex_items = [{"id": q, "stem": by_id[q]["stem"], "key": by_id[q]["options"][by_id[q]["correct_index"]], "explanation": by_id[q]["explanation"]} for q in todo]
        try:
            system, prompt = prompts.explain_batch_prompt(ex_items, pages)
            r = provider.json_call("explain_batch", system, prompt, {"items": [{"id": q, "question": by_id[q]} for q in todo], "pages": pages}, max_tokens=1500)
            for v in (r.get("results") or []):
                if isinstance(v, dict) and v.get("id") in out and (v.get("contradicts_source") or v.get("explanation_supported") is False):
                    out[v["id"]].append(validate.issue("explanation_unsupported", "التفسير غير مدعوم بالمصدر: " + str(v.get("notes", ""))[:150]))
        except LLMError:
            for q in todo:
                out[q].append(validate.issue("verifier_error", "تعذر تدقيق التفسير.", "minor"))
    return out


def _pages_for(cands: list[tuple[dict, dict]], ctx: dict, limit: int = 10) -> dict[str, str]:
    """Union of the pages a group of (slot, candidate) needs for verification."""
    out: dict[str, str] = {}
    for slot, cand in cands:
        for r in [e["page"] for e in cand["evidence"] if e.get("page") in ctx["page_text"]] + list(slot["pages"]):
            if r in ctx["page_text"] and r not in out and len(out) < limit:
                out[r] = ctx["page_text"][r][:5000]
    return out


def generate_questions(provider, plan: dict, src: dict, settings: dict, progress=lambda stage, pct: None) -> dict:
    """Pipelined generation. Each wave runs up to `llm_concurrency` batches IN PARALLEL; every batch does
    draft -> static validation -> batched blind verification on its own. Merging (duplicate/leak checks against what is
    already accepted) is sequential, so acceptance order stays deterministic. Rejected slots get one retry wave."""
    from ..config import settings as cfg

    ctx = _ctx(src, settings)
    total = len(plan["slots"])
    accepted: list[dict] = []
    dropped: list[dict] = []
    stats = {"drafted": 0, "rejected_validation": 0, "rejected_verifier": 0, "rejected_duplicate": 0,
             "rejected_leak": 0, "unwritable": 0, "retries": 0}
    feedback: dict[int, list[str]] = {}
    pending = list(plan["slots"])
    width = max(1, cfg.llm_concurrency)

    def work(batch: list[dict], known: list[dict]) -> dict:
        """Runs in a worker thread; reads shared state only (known/feedback), returns a result record."""
        res = {"batch": batch, "error": None, "unwritable": [], "rejected": [], "survivors": [], "checks": {}}
        pages, used = {}, 0
        for s in batch:
            for r in s["pages"]:
                if r in ctx["page_text"] and r not in pages:
                    t = ctx["page_text"][r][:6000]
                    if used + len(t) <= MAX_CHARS_PER_CALL:
                        pages[r] = t
                        used += len(t)
        existing = [{"purpose": a["purpose"], "stem": a["stem"][:160], "type": a["qtype"]} for a in known]
        system, prompt = prompts.generate_prompt(batch, pages, settings, existing, feedback)
        try:
            resp = provider.json_call("generate", system, prompt, {"slots": batch, "pages": pages, "settings": settings})
        except LLMError as e:
            res["error"] = e
            return res
        by_slot = {q.get("slot"): q for q in resp.get("questions", []) if isinstance(q, dict)}
        for s in batch:
            raw = by_slot.get(s["slot"])
            if not raw or raw.get("unwritable_reason"):
                res["unwritable"].append((s, ("المولّد رفض كتابة السؤال: " + str(raw.get("unwritable_reason"))) if raw else "لم يُرجع المولّد سؤالًا لهذه الخانة."))
                continue
            c = _norm_candidate(raw, s)
            iss = validate.validate_question(c, ctx)
            if validate.decisive(iss):
                res["rejected"].append((s, "rejected_validation", [i["message"] for i in iss if i["severity"] == "decisive"]))
            elif (d := validate.duplicate_of(c, known)):
                res["rejected"].append((s, "rejected_duplicate", [f"مكرر للسؤال {d['of']}: غيّر الحقيقة المقيسة وطريقة الاستدلال."]))
            elif (lk := validate.leaks_other(c, known)):
                res["rejected"].append((s, "rejected_leak", [f"يكشف إجابة سؤال آخر ({lk['direction']}). أعد الصياغة."]))
            else:
                res["survivors"].append((s, c, iss))
        if res["survivors"]:
            ids = [(f"q{s['slot']}", c) for s, c, _ in res["survivors"]]
            res["checks"] = llm_check_batch(provider, ids, _pages_for([(s, c) for s, c, _ in res["survivors"]], ctx), settings)
        res["drafted"] = len(by_slot)
        return res

    for attempt in (1, 2):
        if not pending:
            break
        batches = [pending[i:i + MAX_BATCH] for i in range(0, len(pending), MAX_BATCH)]
        pending = []
        for w in range(0, len(batches), width):
            wave = batches[w:w + width]
            known = list(accepted)
            progress("drafting" if attempt == 1 else "retrying", int(100 * len(accepted) / max(1, total)))
            with ThreadPoolExecutor(max_workers=len(wave)) as ex:
                results = list(ex.map(lambda b: work(b, known), wave))
            for res in results:  # sequential merge
                if res["error"]:
                    for s in res["batch"]:
                        dropped.append({"slot": s["slot"], "qtype": s["qtype"], "reasons": [f"خطأ في خدمة التوليد: {res['error']}"], "final": True})
                    continue
                stats["drafted"] += len(res["survivors"]) + len(res["rejected"])
                for s, reason in res["unwritable"]:
                    stats["unwritable"] += 1
                    dropped.append({"slot": s["slot"], "qtype": s["qtype"], "reasons": [reason], "final": True})
                for s, key, msgs in res["rejected"]:
                    stats[key] += 1
                    feedback[s["slot"]] = msgs
                    pending.append(s)
                for s, c, iss in res["survivors"]:
                    vi = res["checks"].get(f"q{s['slot']}", [])
                    if validate.decisive(vi):
                        stats["rejected_verifier"] += 1
                        feedback[s["slot"]] = [i["message"] for i in vi if i["severity"] == "decisive"]
                        pending.append(s)
                    elif validate.duplicate_of(c, accepted) or validate.leaks_other(c, accepted):
                        stats["rejected_duplicate"] += 1
                        feedback[s["slot"]] = ["تعارض مع سؤال معتمد في الدفعة نفسها."]
                        pending.append(s)
                    else:
                        c["issues"] = iss + vi
                        c["verified"] = {"static": True, "blind_solver": True}
                        accepted.append(c)
        if pending:
            stats["retries"] += len(pending)
    for s in pending:
        dropped.append({"slot": s["slot"], "qtype": s["qtype"], "reasons": feedback.get(s["slot"], ["فشل التحقق"]), "final": True})
    return {"accepted": accepted, "dropped": dropped, "stats": stats}


# ---------------------------------------------------------------- persistence

def _assign_options(cand: dict, target_pos: int, rng: random.Random) -> tuple[list[dict], str]:
    """Give options stable ids; place the key at target_pos (balances key position across the quiz)."""
    opts = [{"id": "o" + hashlib.sha1(f"{new_id()}{i}".encode()).hexdigest()[:8], "text": t} for i, t in enumerate(cand["options"])]
    key = opts[cand["correct_index"]]
    others = [o for o in opts if o is not key]
    rng.shuffle(others)
    others.insert(target_pos, key)
    return others, key["id"]


def persist_quiz(conn: sqlite3.Connection, quiz_id: str, result: dict, src: dict, prompt_version: str) -> list[str]:
    rng = random.Random(quiz_id)
    accepted = sorted(result["accepted"], key=lambda c: c["slot"])
    positions = [i % 4 for i in range(len(accepted))]
    rng.shuffle(positions)
    conn.execute("DELETE FROM questions WHERE quiz_id=?", (quiz_id,))
    ids = []
    for pos, (c, tp) in enumerate(zip(accepted, positions), start=1):
        opts, key_id = _assign_options(c, tp, rng)
        qid = new_id()
        refs = [e["page"] for e in c["evidence"]]
        labels = [page_label(r, src) for r in dict.fromkeys(refs)]
        pages = sorted({l.get("page") for l in labels if l.get("page")})
        doc_id = labels[0]["doc_id"] if labels and "doc_id" in labels[0] else None
        minor = [i for i in c.get("issues", []) if i["severity"] == "minor"]
        status = "flagged" if minor else "machine_verified"
        ev = [{**e, **page_label(e["page"], src)} for e in c["evidence"]]
        conn.execute(
            """INSERT INTO questions(id,quiz_id,position,qtype,task,objective,difficulty,stem,options_json,correct_option_id,
               explanation,purpose,source_doc_id,source_pages_json,evidence_json,version,review_status,validation_json,fingerprint,
               prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (qid, quiz_id, pos, c["qtype"], c.get("task"), c["objective"], c["difficulty"], c["stem"], jdump(opts), key_id,
             c["explanation"], c["purpose"], doc_id, jdump(pages), jdump(ev), 1, status,
             jdump({"issues": c.get("issues", []), "verified": c.get("verified"), "uses_external": c["uses_external"],
                    "objective_id": c["objective_id"], "reasoning_pattern": c.get("reasoning_pattern")}),
             hashlib.sha1(validate.norm(c["stem"]).encode()).hexdigest()[:16], prompt_version, now()))
        conn.execute("INSERT INTO question_revisions(question_id,version,snapshot_json,reason,actor,created_at) VALUES(?,?,?,?,?,?)",
                     (qid, 1, jdump({"stem": c["stem"], "options": opts, "correct_option_id": key_id, "explanation": c["explanation"]}),
                      "initial", "system", now()))
        ids.append(qid)
    return ids


def build_report(plan: dict, result: dict, src: dict, analysis: dict, provider) -> dict:
    acc = result["accepted"]
    delivered_obj = {c["objective_id"] for c in acc}
    by_type = {t: 0 for t in QTYPES}
    for c in acc:
        by_type[c["qtype"]] += 1
    planned_types = {t for t, n in plan["distribution"].items() if n}
    return {
        "requested": plan["requested"], "planned": plan["feasible_count"], "delivered": len(acc),
        "by_type": by_type,
        "identity_coverage": {"numerator": sum(1 for t in planned_types if by_type[t]), "denominator": len(planned_types),
                              "definition": "أنواع الهوية المخطط لها (بدعم من المصدر) التي سُلّم منها سؤال واحد على الأقل."},
        "objective_coverage": {"numerator": len(delivered_obj), "denominator": len(analysis["objectives"]),
                               "definition": "أهداف المصدر المستخرجة التي غطاها سؤال مُسلَّم واحد على الأقل."},
        "dropped": result["dropped"], "stats": result["stats"],
        "excluded_pages": src["excluded"], "unsupported_types": plan["unsupported_types"],
        "flagged": sum(1 for c in acc if any(i["severity"] == "minor" for i in c.get("issues", []))),
        "shortfall": plan.get("shortfall"),
        "generator": generator_label(provider), "prompt_version": prompts.PROMPT_VERSION,
    }


# ---------------------------------------------------------------- orchestration (called from routers)

def set_progress(conn, quiz_id, stage, pct, status=None):
    if status:
        conn.execute("UPDATE quizzes SET status=?, progress_stage=?, progress_pct=?, updated_at=? WHERE id=?",
                     (status, stage, pct, now(), quiz_id))
    else:
        conn.execute("UPDATE quizzes SET progress_stage=?, progress_pct=?, updated_at=? WHERE id=?", (stage, pct, now(), quiz_id))


def fail(conn, quiz_id, msg):
    conn.execute("UPDATE quizzes SET status='failed', error=?, updated_at=? WHERE id=?", (msg, now(), quiz_id))


def cached_analysis(conn: sqlite3.Connection, user_id: str, provider, src: dict, st: dict) -> dict:
    """Lecture analysis is the slowest single call and depends only on the page texts + a few settings:
    reuse it when the same student re-plans the same pages (new quiz, different count/focus/difficulty, retry)."""
    key = hashlib.sha1(jdump([user_id, [[p["ref"], hashlib.sha1(p["text"].encode()).hexdigest()] for p in src["pages"]],
                              st.get("field"), st.get("language"), st.get("external_mode"), prompts.PROMPT_VERSION,
                              generator_label(provider)]).encode()).hexdigest()
    row = conn.execute("SELECT analysis_json FROM analysis_cache WHERE key=? AND user_id=?", (key, user_id)).fetchone()
    if row:
        a = jload(row["analysis_json"])
        a["cached"] = True
        return a
    a = analyse(provider, src, st)
    if a["objectives"]:  # never cache an empty/failed analysis
        conn.execute("INSERT OR REPLACE INTO analysis_cache(key,user_id,analysis_json,created_at) VALUES(?,?,?,?)", (key, user_id, jdump(a), now()))
    return a


def job_analyse(quiz_id: str):
    from ..db import connect

    conn = connect()
    try:
        q = conn.execute("SELECT * FROM quizzes WHERE id=?", (quiz_id,)).fetchone()
        st = jload(q["settings_json"])
        try:
            provider = get_provider()
            set_progress(conn, quiz_id, "reading_source", 10, "analyzing")
            src = load_source(conn, q["user_id"], st["sources"])
            if not src["pages"]:
                return fail(conn, quiz_id, "لا توجد صفحات مقروءة في النطاق المختار.")
            heur = analyze_support([p["text"] for p in src["pages"]], st.get("field", "other"))
            set_progress(conn, quiz_id, "analyzing_lecture", 30)
            analysis = cached_analysis(conn, q["user_id"], provider, src, st)
            if not analysis["objectives"]:
                conn.execute("UPDATE quizzes SET analysis_json=?, status='insufficient', error=?, updated_at=? WHERE id=?",
                             (jdump(analysis), "تعذر استخراج أهداف قابلة للاختبار من النطاق المختار؛ وسّع المصدر.", now(), quiz_id))
                return
            if analysis.get("discipline_guess") in FIELDS:
                st["field"] = analysis["discipline_guess"]
                conn.execute("UPDATE quizzes SET settings_json=? WHERE id=?", (jdump(st), quiz_id))
            plan = build_plan(analysis, st, heur)
            analysis["heuristic_support"] = heur
            analysis["excluded_pages"] = src["excluded"]
            conn.execute("UPDATE quizzes SET analysis_json=?, plan_json=?, status='planned', progress_stage='planned', progress_pct=100, error=NULL, updated_at=? WHERE id=?",
                         (jdump(analysis), jdump(plan), now(), quiz_id))
        except Exception as e:  # noqa
            traceback.print_exc()
            fail(conn, quiz_id, f"{type(e).__name__}: {e}")
    finally:
        conn.close()


def job_generate(quiz_id: str):
    from ..db import connect

    conn = connect()
    run_id = new_id()
    try:
        q = conn.execute("SELECT * FROM quizzes WHERE id=?", (quiz_id,)).fetchone()
        st, plan, analysis = jload(q["settings_json"]), jload(q["plan_json"]), jload(q["analysis_json"])
        conn.execute("INSERT INTO generation_runs(id,quiz_id,user_id,status,prompt_version,started_at) VALUES(?,?,?,?,?,?)",
                     (run_id, quiz_id, q["user_id"], "running", prompts.PROMPT_VERSION, now()))
        try:
            provider = get_provider()
            src = load_source(conn, q["user_id"], st["sources"])
            set_progress(conn, quiz_id, "drafting", 5, "generating")
            result = generate_questions(provider, plan, src, st, lambda s, p: set_progress(conn, quiz_id, s, p))
            set_progress(conn, quiz_id, "finalizing", 95)
            persist_quiz(conn, quiz_id, result, src, prompts.PROMPT_VERSION)
            report = build_report(plan, result, src, analysis, provider)
            status = "ready" if result["accepted"] else "insufficient"
            conn.execute("UPDATE quizzes SET status=?, report_json=?, generator=?, progress_stage='done', progress_pct=100, error=?, updated_at=? WHERE id=?",
                         (status, jdump(report), generator_label(provider),
                          None if result["accepted"] else "لم ينجح أي سؤال في اجتياز التحقق.", now(), quiz_id))
            conn.execute("UPDATE generation_runs SET status=?, stats_json=?, model=?, finished_at=? WHERE id=?",
                         (status, jdump({"stats": result["stats"], "delivered": len(result["accepted"]), "planned": plan["feasible_count"]}),
                          generator_label(provider), now(), run_id))
        except Exception as e:  # noqa
            traceback.print_exc()
            fail(conn, quiz_id, f"{type(e).__name__}: {e}")
            conn.execute("UPDATE generation_runs SET status='failed', stats_json=?, finished_at=? WHERE id=?",
                         (jdump({"error": str(e)}), now(), run_id))
    finally:
        conn.close()
