"""Quiz generation engine:
extract -> analyse lecture -> objectives -> plan distribution -> draft candidates -> validate
-> verify (blind solve) -> duplicate/leak check -> approve and persist.
Nothing is padded: slots that cannot be written correctly are dropped and reported.
"""
from __future__ import annotations

import hashlib
import random
import re
import sqlite3
import traceback
from concurrent.futures import ThreadPoolExecutor

from ..db import jdump, jload, new_id, now
from . import owner_engine, profile as lecture_profile, prompts, validate
from .extract import parse_page_spec
from .llm import LLMError, generator_label, get_provider
from .planner import build_plan, difficulty_for, reinforcement_slots
from .support import analyze_support
from .taxonomy import FIELDS, QTYPES, QTYPE_ORDER

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


_TYPE_ALIASES = {
    "recall": "basic_recall", "basic": "basic_recall", "basic recall": "basic_recall", "concept": "understanding", "concepts": "understanding",
    "mechanism": "mechanisms", "mechanisms detail": "mechanisms", "detail": "mechanisms", "details": "mechanisms", "apply": "application",
    "critical": "critical_thinking", "critical thinking": "critical_thinking", "clinical": "scenarios", "clinical scenarios": "scenarios",
    "clinical scenario": "scenarios", "scenario": "scenarios", "case": "scenarios", "compare": "compare_contrast", "compare contrast": "compare_contrast",
    "comparison": "compare_contrast", "best": "best_answer", "best answer": "best_answer", "most correct": "best_answer", "most correct best answer": "best_answer",
    "not": "not_except", "except": "not_except", "not except": "not_except", "ordering": "sequence", "order": "sequence", "sequence ordering": "sequence", "steps": "sequence",
}


def norm_type(t) -> str | None:
    """'Critical Thinking' / 'NOT/EXCEPT' / 'recall' -> canonical quiz type code (or None)."""
    raw = str(t or "").strip().lower()
    k = re.sub(r"[\s\-/&]+", "_", raw)
    if k in QTYPES:
        return k
    return _TYPE_ALIASES.get(re.sub(r"\s+", " ", re.sub(r"[_\-/&]+", " ", raw)).strip())


def norm_refs(items, pages: list[dict]) -> list[str]:
    """Accept d1p3 / D1P3 / p3 / page 3 / slide 3 / 3 / '3-5' and keep only refs that exist."""
    have = {p["ref"] for p in pages}
    docs = sorted({re.match(r"d(\d+)p", r).group(1) for r in have})
    out: list[str] = []

    def add(doc, no):
        if doc or len(docs) == 1:
            r = f"d{doc or docs[0]}p{no}"
            if r in have:
                out.append(r)
        else:
            out.extend(r for r in (f"d{d}p{no}" for d in docs) if r in have)

    if items is None:
        items = []
    for x in (items if isinstance(items, list) else [items]):
        t = str(x).strip().lower()
        if m := re.fullmatch(r"d(\d+)\s*[-_ ]?\s*p(?:age)?\s*[-_ ]?(\d+)", t):
            add(m.group(1), int(m.group(2)))
        elif (m := re.fullmatch(r"(?:p|page|slide|pg|ص|صفحة|شريحة)?\s*[-_.:]?\s*(\d+)\s*[-–—]\s*(?:p|page|slide|pg)?\s*(\d+)", t)) and 0 <= int(m.group(2)) - int(m.group(1)) < 60:
            for n in range(int(m.group(1)), int(m.group(2)) + 1):
                add(None, n)
        elif m := re.fullmatch(r"(?:p|page|slide|pg|ص|صفحة|شريحة)?\s*[-_.:]?\s*(\d+)", t):
            add(None, int(m.group(1)))
        elif t in have:
            out.append(t)
    return list(dict.fromkeys(out))


def norm_objectives(r, chunk: list[dict]) -> list[dict]:
    """Objectives with usable pages/supports from whatever shape the model returned (dict/list, supports as object or list)."""
    raw = r if isinstance(r, list) else ((r or {}).get("objectives") or (r or {}).get("learning_objectives") or (r or {}).get("units") or []) if isinstance(r, dict) else []
    if isinstance(raw, dict):
        raw = list(raw.values())
    out = []
    for ob in raw if isinstance(raw, list) else []:
        if not isinstance(ob, dict):
            continue
        pg = norm_refs(ob.get("pages") or ob.get("page") or ob.get("refs") or ob.get("page_refs"), chunk)
        if not pg and len(chunk) <= 3:
            pg = [p["ref"] for p in chunk]            # the model named no valid page: a short chunk is unambiguous
        if not pg:
            kt = [t for t in validate.tokens(" ".join([str(ob.get("statement", ""))] + [str(x) for x in ob.get("key_terms", []) or []])) if len(t) >= 4]
            if kt:
                best = max(chunk, key=lambda p: sum(1 for t in kt if t in p["text"].lower()))
                if sum(1 for t in kt if t in best["text"].lower()) >= 2:
                    pg = [best["ref"]]
        if not pg:
            continue
        sup: dict = {}

        def put(type_, v):
            t = norm_type(type_)
            if t:
                vp = norm_refs((v or {}).get("pages") or (v or {}).get("page") or (v or {}).get("refs"), chunk) if isinstance(v, dict) else []
                sup[t] = {"pages": vp or pg, "task": (v or {}).get("task") if isinstance(v, dict) else None}

        sp = ob.get("supports") or ob.get("support") or ob.get("types") or ob.get("supported_types")
        if isinstance(sp, list):
            for x in sp:
                put(x, None) if isinstance(x, str) else (put(x.get("type") or x.get("name") or x.get("key"), x) if isinstance(x, dict) else None)
        elif isinstance(sp, dict):
            for k, v in sp.items():
                if v not in (False, None):
                    put(k, v)
        if not sup:                                   # found but not classified: validators still gate every question
            sup = {"basic_recall": {"pages": pg, "task": None}, "understanding": {"pages": pg, "task": None}}
        try:
            cap = int(ob.get("capacity", 1) or 1)
        except (TypeError, ValueError):
            cap = 1
        stmt = str(ob.get("statement") or ob.get("title") or ob.get("objective") or "").strip()[:300] or next(p for p in chunk if p["ref"] == pg[0])["text"].split("\n")[0][:120]
        out.append({"id": "", "statement": stmt, "pages": pg, "key_terms": list(ob.get("key_terms") or [])[:10], "capacity": max(1, min(4, cap)), "supports": sup})
    return out


def fallback_objectives(pages: list[dict], field: str) -> list[dict]:
    """Deterministic units when the model produced nothing usable: one objective per page with real text."""
    out = []
    for p in pages:
        if len(p["text"].strip()) < 40:
            continue
        h = analyze_support([p["text"]], field)
        sup = {"basic_recall": {"pages": [p["ref"]], "task": None}, "understanding": {"pages": [p["ref"]], "task": None}}
        for t in QTYPES:
            if t not in sup and h[t]["level"] != "none":
                sup[t] = {"pages": [p["ref"]], "task": None}
        title = next((ln.strip() for ln in p["text"].splitlines() if ln.strip()), p["ref"])[:120]
        out.append({"id": "", "statement": title, "pages": [p["ref"]], "key_terms": [], "capacity": max(1, min(3, round(len(p["text"]) / 450))), "supports": sup})
    return out


def norm_profile(r, chunk: list[dict]) -> dict | None:
    """The profiler's answer, tolerantly: {types:{type:{capacity,pages}}} or a list of {type,capacity,pages}; at least three of the ten types must be named."""
    raw = r.get("types") or r.get("profile") or r.get("supported_types") or r.get("capacities") if isinstance(r, dict) else None
    if not isinstance(raw, (dict, list)):
        return None
    out: dict[str, dict] = {}

    def put(k, v):
        t = norm_type(k)
        if not t:
            return
        o = v if isinstance(v, dict) else {"capacity": v}
        n = next((o[x] for x in ("capacity", "count", "n", "questions") if o.get(x) is not None), 1 if v is True else 0)
        try:
            n = max(0, min(40, round(float(n))))
        except (TypeError, ValueError):
            n = 0
        out[t] = {"capacity": n, "pages": norm_refs(o.get("pages") or o.get("page") or o.get("refs"), chunk)}

    if isinstance(raw, list):
        for x in raw:
            if isinstance(x, dict):
                put(x.get("type") or x.get("name") or x.get("key"), x)
    else:
        for k, v in raw.items():
            put(k, v)
    return out if len(out) >= 3 else None


def analyse(provider, src: dict, settings: dict) -> dict:
    objectives, gaps, chars, disc = [], [], [], []
    field = settings.get("field", "other")

    def run(chunk):
        system, prompt = prompts.analyze_prompt(chunk, field, settings.get("language", "source"), settings.get("external_mode") == "supplement")
        return provider.json_call("analyze", system, prompt, {"pages": chunk, "field": settings.get("field")})

    def run_profile(chunk):
        try:        # the agent only refines: when it fails the structural reading stands (the objective analysis reports real service failures itself)
            system, prompt = prompts.profile_prompt(chunk, field)
            return norm_profile(provider.json_call("profile", system, prompt, {"pages": chunk, "field": settings.get("field")}, 3000), chunk)
        except Exception:  # noqa
            return None

    chunks = _chunks(src["pages"])
    pchunks = _chunks([{**p, "text": p["text"][:1100]} for p in src["pages"]], 18000)      # the same size as the analysis pieces: what the provider takes for one it takes for the other
    with ThreadPoolExecutor(max_workers=min(6, len(chunks) + len(pchunks) or 1)) as ex:
        pfuts = [ex.submit(run_profile, c) for c in pchunks]         # beside the objective analysis: no extra waiting
        results = list(ex.map(run, chunks))
        agent = lecture_profile.merge_agent([f.result() for f in pfuts])
    for chunk, r in zip(chunks, results):
        objectives += norm_objectives(r, chunk)
        d = r if isinstance(r, dict) else {}
        gaps += list(d.get("gaps") or [])[:5]
        if d.get("lecture_character"):
            chars.append(str(d["lecture_character"]))
        if d.get("discipline_guess"):
            disc.append(d["discipline_guess"])
    fallback = False
    if not objectives:
        objectives = fallback_objectives(src["pages"], field)
        fallback = bool(objectives)
    for i, ob in enumerate(objectives, start=1):
        ob["id"] = f"o{i}"
    prof = lecture_profile.reconcile(lecture_profile.structural(src["pages"], field), agent, lecture_profile.words_of([p["text"] for p in src["pages"]]))
    lecture_profile.attach_supports(objectives, prof)
    note = "تعذّر على النموذج تقسيم المحاضرة إلى أهداف بصيغة مفهومة، فقُسّمت تلقائيًا بحسب الصفحات؛ تُطبَّق نفس فحوص الدليل والتحقق على كل سؤال." if fallback else " ".join(chars[:2])
    return {"objectives": objectives, "gaps": gaps[:10], "lecture_character": note, "fallback": fallback, "profile": prof,
            "discipline_guess": max(set(disc), key=disc.count) if disc and all(isinstance(x, str) for x in disc) else None}


# ---------------------------------------------------------------- generation

def _page_key(pages: list) -> int:
    nums = [int(m.group(1)) for r in pages if (m := re.search(r"p(\d+)$", str(r)))]
    return min(nums) if nums else 9999


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
        "extra": bool(slot.get("extra")), "variant": slot.get("variant", 0), "pk": _page_key(slot.get("pages") or []),
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


def generate_questions(provider, plan: dict, src: dict, settings: dict, progress=lambda stage, pct: None, base: list[dict] | None = None) -> dict:
    """Pipelined generation. Each wave runs up to `llm_concurrency` batches IN PARALLEL; every batch does
    draft -> static validation -> batched blind verification on its own. Merging (duplicate/leak checks against what is
    already accepted) is sequential, so acceptance order stays deterministic. Rejected slots get one retry wave. `base` = questions accepted by earlier
    rounds: context for duplicate/leak checks and the prompt, never returned."""
    from ..config import settings as cfg

    ctx = _ctx(src, settings)
    total = len(plan["slots"])
    accepted: list[dict] = []
    dropped: list[dict] = []
    stats = {"drafted": 0, "rejected_validation": 0, "rejected_verifier": 0, "rejected_duplicate": 0,
             "rejected_leak": 0, "unwritable": 0, "retries": 0}
    feedback: dict[int, list[str]] = {}
    pending = list(plan["slots"])
    base = list(base or [])
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
            elif (d := validate.duplicate_of(c, known, relaxed=c["extra"])):
                res["rejected"].append((s, "rejected_duplicate", [f"مكرر للسؤال {d['of']}: غيّر الحقيقة المقيسة وطريقة الاستدلال."]))
            elif (lk := validate.leaks_other(c, known, relaxed=c["extra"])):
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
            known = base + accepted
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
                    elif validate.duplicate_of(c, base + accepted, relaxed=c["extra"]) or validate.leaks_other(c, base + accepted, relaxed=c["extra"]):
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


TOPUP_ROUNDS = 1   # one bounded AI round for what was rejected (a little over-asked); the wait and the cost stay bounded


def generate_to_count(provider, plan: dict, src: dict, settings: dict, progress=lambda stage, pct: None) -> dict:
    """Deliver the REQUESTED count. The planned slots first (the planner already plans the full count: natural slots + reinforcement slots); then, for whatever
    was rejected or unwritable, a top-up round of reinforcement slots (another angle, another fact, another direction on the least-covered parts of the lecture),
    each question verified like any other. It stops when the count is met, when a round brings nothing, or when the service itself fails (no calls wasted)."""
    want = plan["requested"]
    first = generate_questions(provider, plan, src, settings, progress)
    out = {"accepted": list(first["accepted"]), "dropped": list(first["dropped"]), "stats": {**first["stats"], "topup_rounds": 0}}

    def down(r: dict) -> bool:
        return bool(r["dropped"]) and not r["accepted"] and all(any(str(x).startswith("خطأ في خدمة التوليد") for x in d.get("reasons", [])) for d in r["dropped"])

    if down(first) or not first["accepted"]:
        return out   # the service failed, or nothing the model wrote was usable: more rounds would only repeat that
    tries: dict[str, int] = {}
    last_no = max([s["slot"] for s in plan["slots"]] or [0])
    for rnd in range(1, TOPUP_ROUNDS + 1):
        if len(out["accepted"]) >= want:
            break
        deficit = want - len(out["accepted"])
        n = deficit + min(5, -(-deficit * 3 // 10))      # ask a little more than is missing: some will be rejected
        counts: dict[str, int] = {}
        for c in out["accepted"]:
            counts[c["objective_id"]] = counts.get(c["objective_id"], 0) + 1
        slots = reinforcement_slots(plan.get("pool") or [], counts, n, tries)
        if not slots:
            break
        slots.sort(key=lambda s_: (min(s_["pages"]) if s_["pages"] else "~", QTYPE_ORDER.index(s_["qtype"])))
        for s_ in slots:
            last_no += 1
            s_["slot"] = last_no
            s_["difficulty"] = difficulty_for(settings, s_["qtype"])
            tries[s_["objective_id"]] = tries.get(s_["objective_id"], 0) + 1
        have = len(out["accepted"])
        r = generate_questions(provider, {**plan, "slots": slots, "requested": want}, src, settings,
                               lambda stage, pct: progress("retrying", min(99, int(100 * (have + pct / 100 * deficit) / want))), base=out["accepted"])
        out["accepted"] += r["accepted"]
        out["dropped"] += r["dropped"]
        for k, v in r["stats"].items():
            out["stats"][k] = out["stats"].get(k, 0) + v
        out["stats"]["topup_rounds"] = rnd
        if down(r) or not r["accepted"]:
            break
    if len(out["accepted"]) > want:   # exactly the count asked for: the surplus goes first among reinforcement questions that carry remarks, then the latest
        def rank(c):
            return (0 if not c.get("extra") else 2 if any(i["severity"] == "minor" for i in c.get("issues", [])) else 1, c["slot"])
        out["accepted"] = sorted(out["accepted"], key=rank)[:want]
    return out


def order_questions(accepted: list[dict]) -> list[dict]:
    """Lecture order (by page), but within a page the questions about DIFFERENT sentences come first and a second/third question about the same sentence only
    after them, so a reinforcement question never sits right next to the question it echoes."""
    def key(c): return validate.norm((c.get("evidence") or [{}])[0].get("quote") or c["stem"])[:60]
    out: list[dict] = []
    for pk in sorted({c.get("pk", 9999) for c in accepted}):
        group = sorted([c for c in accepted if c.get("pk", 9999) == pk], key=lambda c: (QTYPE_ORDER.index(c["qtype"]), c["slot"]))
        lanes: dict[str, list[dict]] = {}
        for c in group:
            lanes.setdefault(key(c), []).append(c)
        r = 0
        while any(len(v) > r for v in lanes.values()):
            for v in lanes.values():
                if len(v) > r:
                    out.append(v[r])
            r += 1
    return out


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
    accepted = order_questions(result["accepted"])
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
        "extra": sum(1 for c in acc if c.get("extra")), "local_filled": 0,
        "shortfall": ({"requested": plan["requested"], "possible": len(acc),
                       "reason": "نص هذا النطاق قصير جدًا: استُنفدت كل الصياغات الممكنة منه دون تكرار حرفي لسؤال.",
                       "suggestions": ["لزيادة العدد: وسّع نطاق الصفحات أو أضف لكتشرًا آخر."]} if len(acc) < plan["requested"] else plan.get("shortfall")),
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


# ---------------------------------------------------------------- the owner's engine: reading rules + quiz engine (owner_engine.py)

def _seed(quiz_id: str) -> int:
    return int(hashlib.sha1(quiz_id.encode()).hexdigest()[:8], 16)


def persist_owner(conn: sqlite3.Connection, quiz_id: str, qs: list[dict]) -> list[str]:
    """The owner's engine already placed every answer (its balanced letters): stored in that order, with stable option ids."""
    conn.execute("DELETE FROM questions WHERE quiz_id=?", (quiz_id,))
    ids = []
    for pos, q in enumerate(qs, start=1):
        opts = [{"id": "o" + hashlib.sha1(f"{quiz_id}:{pos}:{letter}".encode()).hexdigest()[:8], "text": text} for letter, text in q["options"]]
        key_id = opts["ABCD".index(q["answer"])]["id"]
        qid = new_id()
        conn.execute(
            """INSERT INTO questions(id,quiz_id,position,qtype,task,objective,difficulty,stem,options_json,correct_option_id,
               explanation,purpose,source_doc_id,source_pages_json,evidence_json,version,review_status,validation_json,fingerprint,
               prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (qid, quiz_id, pos, q["qtype"], None, q["concept_id"], q["difficulty"], q["stem"], jdump(opts), key_id,
             q["explanation"], "", q["doc_id"], jdump(q["pages"]), jdump(q["evidence"]), 1, "machine_verified",
             jdump({"issues": [], "verified": "owner_engine_model_review", "uses_external": False, "engine": owner_engine.ENGINE_VERSION,
                    "category": q["category"], "concept_id": q["concept_id"], "unit_evidence": q["unit_evidence"]}),
             hashlib.sha1(validate.norm(q["stem"]).encode()).hexdigest()[:16], owner_engine.ENGINE_VERSION, now()))
        conn.execute("INSERT INTO question_revisions(question_id,version,snapshot_json,reason,actor,created_at) VALUES(?,?,?,?,?,?)",
                     (qid, 1, jdump({"stem": q["stem"], "options": opts, "correct_option_id": key_id, "explanation": q["explanation"]}),
                      "initial", "system", now()))
        ids.append(qid)
    return ids


def owner_report(requested: int, qs: list[dict], written: dict, reading: dict, src_excluded: list, provider) -> dict:
    by_type = {t: 0 for t in QTYPES}
    for q in qs:
        by_type[q["qtype"]] = by_type.get(q["qtype"], 0) + 1
    concepts = {q["concept_id"] for q in qs}
    cited = {e["unit_id"] for q in qs for e in q["unit_evidence"]}
    allowed = reading.get("counts", {}).get("include", 0)
    last = (written.get("errors") or [""])[-1]
    return {
        "requested": requested, "planned": requested, "delivered": len(qs), "by_type": by_type, "engine": owner_engine.ENGINE_VERSION,
        "identity_coverage": {"numerator": sum(1 for v in by_type.values() if v), "denominator": len(QTYPES),
                              "definition": "فئات محرك الكويز العشر التي جاء منها سؤال واحد على الأقل (يختار المحرك ما يدعمه المحتوى فقط)."},
        "objective_coverage": {"numerator": len(concepts), "denominator": max(1, len(concepts)),
                               "definition": "الأفكار المستقلة (concept_id) التي سأل عنها المحرك: فكرة واحدة لكل سؤال."},
        "source_coverage": {"numerator": len(cited), "denominator": allowed, "counts_are_not_scientific_coverage": True,
                            "definition": "الأجزاء المعتمدة للسؤال (include) التي استشهد بها سؤال واحد على الأقل."},
        "reading": reading, "dropped": [], "flagged": 0, "extra": 0, "local_filled": 0,
        "stats": {"counts_tried": written.get("tried", []), "engine_errors": written.get("errors", [])},
        "excluded_pages": src_excluded, "unsupported_types": [],
        "shortfall": ({"requested": requested, "possible": len(qs),
                       "reason": "قال محرك الكويز إن النص المعتمد في هذا النطاق لا يحمل أكثر من ذلك دون حشو." + (f" ({last[:300]})" if last else ""),
                       "suggestions": ["لزيادة العدد: وسّع نطاق الصفحات أو أضف لكتشرًا آخر."]} if len(qs) < requested else None),
        "generator": generator_label(provider), "prompt_version": owner_engine.ENGINE_VERSION,
    }


def _provider_for_quiz(q: sqlite3.Row, st: dict):
    if st.get("generator") == "chatgpt_plan":
        from .chatgpt_plan import ChatGPTPlanProvider

        return ChatGPTPlanProvider(q["user_id"])
    return get_provider()


def job_analyse(quiz_id: str, auto_generate: bool = False):
    """READ the lecture with the owner's reading rules (lecture_reader.py), the uncertain fragments settled by the server's model,
    and record the plan: the count asked for. With `auto_generate` the same job carries straight on to writing (no confirm step)."""
    from ..db import connect

    chain = False
    conn = connect()
    try:
        q = conn.execute("SELECT * FROM quizzes WHERE id=?", (quiz_id,)).fetchone()
        st = jload(q["settings_json"])
        try:
            provider = _provider_for_quiz(q, st)
            set_progress(conn, quiz_id, "reading_source", 10, "analyzing")
            src = load_source(conn, q["user_id"], st["sources"])
            if not src["pages"]:
                return fail(conn, quiz_id, "لا توجد صفحات مقروءة في النطاق المختار.")
            c = owner_engine.collect(conn, q["user_id"], st["sources"])
            set_progress(conn, quiz_id, "analyzing_lecture", 30)
            report, overrides, reading = owner_engine.resolve(c, provider)
            analysis = {"objectives": [], "engine": owner_engine.ENGINE_VERSION, "reading": reading, "overrides": overrides,
                        "excluded_pages": src["excluded"]}
            requested = int(st.get("count") or 20)
            allowed = reading["counts"].get("include", 0)
            plan = {"requested": requested, "feasible_count": requested if allowed else 0, "distribution": {}, "unsupported_types": [],
                    "engine": owner_engine.ENGINE_VERSION, "shortfall": None}
            if not allowed:
                conn.execute("UPDATE quizzes SET analysis_json=?, plan_json=?, status='insufficient', error=?, updated_at=? WHERE id=?",
                             (jdump(analysis), jdump(plan), "قواعد قراءة المحاضرة لم تجد في هذا النطاق نصًا تعليميًا معتمدًا يُسأل عنه "
                              f"({len(src['pages'])} صفحة): ما فيه عناوين أو أهداف أو بيانات المحاضِر أو أجزاء لم تتأكد. وسّع نطاق الصفحات.", now(), quiz_id))
                return
            chain = bool(auto_generate)
            # status goes straight to 'generating' when chaining, so a polling client never sees a 'planned' flicker
            conn.execute("UPDATE quizzes SET analysis_json=?, plan_json=?, status=?, progress_stage=?, progress_pct=?, error=NULL, updated_at=? WHERE id=?",
                         (jdump(analysis), jdump(plan), "generating" if chain else "planned", "drafting" if chain else "planned",
                          5 if chain else 100, now(), quiz_id))
        except Exception as e:  # noqa
            traceback.print_exc()
            fail(conn, quiz_id, f"{type(e).__name__}: {e}")
    finally:
        conn.close()
    if chain:
        job_generate(quiz_id)


def job_generate(quiz_id: str):
    """WRITE with the owner's quiz engine (quiz_engine.py) through the reader's make_quiz_engine: every quote inside an approved
    unit, the model's review passed, no padding (a smaller count when the source cannot carry the one asked for)."""
    from ..db import connect

    conn = connect()
    run_id = new_id()
    try:
        q = conn.execute("SELECT * FROM quizzes WHERE id=?", (quiz_id,)).fetchone()
        st, analysis = jload(q["settings_json"]), jload(q["analysis_json"])
        conn.execute("INSERT INTO generation_runs(id,quiz_id,user_id,status,prompt_version,started_at) VALUES(?,?,?,?,?,?)",
                     (run_id, quiz_id, q["user_id"], "running", owner_engine.ENGINE_VERSION, now()))
        try:
            provider = _provider_for_quiz(q, st)
            src = load_source(conn, q["user_id"], st["sources"])
            set_progress(conn, quiz_id, "drafting", 5, "generating")
            c = owner_engine.collect(conn, q["user_id"], st["sources"])
            report = owner_engine.read(c, analysis.get("overrides") or {})      # the same reading as the analysis, no second model call
            written = owner_engine.write(provider, report, st, _seed(quiz_id), lambda s, p: set_progress(conn, quiz_id, s, p))
            set_progress(conn, quiz_id, "finalizing", 95)
            requested = int(st.get("count") or 20)
            qs = owner_engine.questions_for_storage(report, written, c["where"], st.get("difficulty") if st.get("difficulty") in ("easy", "medium", "hard") else "medium") if written["quiz"] else []
            persist_owner(conn, quiz_id, qs)
            rep = owner_report(requested, qs, written, analysis.get("reading") or {}, src["excluded"], provider)
            status = "ready" if qs else "insufficient"
            err = None if qs else ("لم يقبل محرك الكويز أي مسودة من هذا النص المعتمد" + (f": {written['errors'][-1][:400]}" if written["errors"] else "."))
            conn.execute("UPDATE quizzes SET status=?, report_json=?, generator=?, progress_stage='done', progress_pct=100, error=?, updated_at=? WHERE id=?",
                         (status, jdump(rep), generator_label(provider), err, now(), quiz_id))
            conn.execute("UPDATE generation_runs SET status=?, stats_json=?, model=?, finished_at=? WHERE id=?",
                         (status, jdump({"stats": rep["stats"], "delivered": len(qs), "planned": requested}), generator_label(provider), now(), run_id))
        except Exception as e:  # noqa
            traceback.print_exc()
            fail(conn, quiz_id, f"{type(e).__name__}: {e}")
            conn.execute("UPDATE generation_runs SET status='failed', stats_json=?, finished_at=? WHERE id=?",
                         (jdump({"error": str(e)}), now(), run_id))
    finally:
        conn.close()
