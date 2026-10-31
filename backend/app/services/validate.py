"""Deterministic question validators. Severity: 'decisive' => never delivered; 'minor' => flagged for review."""
from __future__ import annotations

import ast
import operator
import re
import unicodedata
from typing import Iterable

from .taxonomy import FIELDS

STOP = set("the a an of in on to and or is are was were be by for with as at from that this these those it its which what how why when "
           "في من على إلى عن مع هو هي هذا هذه ذلك التي الذي ما ماذا كيف لماذا أو و ثم قد كان يكون".split())
CLINICAL_RX = re.compile(r"\b(patient|patients|symptom|symptoms|diagnos\w*|clinical\w*|physician|nurse)\b|مريض|مرضى|أعراض|تشخيص|سريري", re.I)
ALL_NONE_RX = re.compile(r"\b(all|none) of the above\b|\bboth [A-D] and [A-D]\b|جميع (?:ما سبق|الإجابات)|كل ما سبق|لا شيء مما سبق|لا شيء مما ذكر|كلاهما", re.I)
NOT_RX = re.compile(r"\b(NOT|EXCEPT|FALSE|INCORRECT|LEAST)\b|ما عدا|عدا|غير صحيح|ليس|لا يُعد|لا يعد|خاطئة|الخاطئ", re.I)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"[ً-ٰٟـ]", "", s)  # arabic diacritics/tatweel
    s = s.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    s = re.sub(r"[^\w\s%=<>.+*/^-]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(s: str) -> list[str]:
    return [t for t in re.findall(r"\w+", norm(s)) if t not in STOP and len(t) > 1]


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    A, B = set(a), set(b)
    return len(A & B) / len(A | B) if A and B else 0.0


def issue(code: str, msg: str, severity: str = "decisive") -> dict:
    return {"code": code, "message": msg, "severity": severity}


def quote_in_text(quote: str, text: str) -> bool:
    q, t = norm(quote), norm(text)
    if len(q) < 10:
        return False
    if q in t:
        return True
    # tolerate small extraction noise: >=90% of quote tokens appear in order-insensitive window
    qt = q.split()
    if len(qt) < 4:
        return False
    tt = set(t.split())
    return sum(1 for w in qt if w in tt) / len(qt) >= 0.92 and _window_ok(qt, t.split())


def _window_ok(qt: list[str], tt: list[str]) -> bool:
    n = len(qt)
    qs = set(qt)
    best = 0
    for i in range(0, max(1, len(tt) - n + 1)):
        w = tt[i:i + n + 3]
        best = max(best, len(qs & set(w)))
        if best / n >= 0.9:
            return True
    return False


_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos, ast.Mod: operator.mod, ast.FloorDiv: operator.floordiv}


def safe_eval(expr: str) -> float:
    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            r = ev(n.right)
            if isinstance(n.op, ast.Pow) and abs(r) > 12:
                raise ValueError("exponent too large")
            return _OPS[type(n.op)](ev(n.left), r)
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        raise ValueError("unsupported expression")

    return float(ev(ast.parse(expr.strip(), mode="eval")))


def numbers_in(s: str) -> list[float]:
    out = []
    for m in re.findall(r"-?\d[\d,]*\.?\d*(?:[eE]-?\d+)?", (s or "").replace("٫", ".")):
        try:
            out.append(float(m.replace(",", "")))
        except ValueError:
            pass
    return out


def arabic_ratio(s: str) -> float:
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if "؀" <= c <= "ۿ") / len(letters)


def validate_question(q: dict, ctx: dict) -> list[dict]:
    """q: {qtype,stem,options[4],correct_index,explanation,purpose,evidence[{page,quote}],calc?,uses_external?}
    ctx: {page_text: {ref: text}, allowed_refs:set, field, language, source_lang_ar:bool, allow_external:bool}"""
    iss: list[dict] = []
    stem = (q.get("stem") or "").strip()
    opts = [str(o).strip() for o in (q.get("options") or [])]
    ci = q.get("correct_index")
    qtype = q.get("qtype")

    if len(stem) < 15:
        iss.append(issue("stem_short", "نص السؤال قصير جدًا أو فارغ."))
    if len(opts) != 4 or any(not o for o in opts):
        iss.append(issue("options_count", "يجب أن يحتوي السؤال على 4 خيارات غير فارغة."))
        return iss
    if not isinstance(ci, int) or not 0 <= ci < 4:
        iss.append(issue("key_invalid", "مفتاح الإجابة غير صالح."))
        return iss
    nopts = [norm(o) for o in opts]
    if len(set(nopts)) < 4:
        iss.append(issue("options_duplicate", "خياران أو أكثر متطابقان."))
    for i in range(4):
        for j in range(i + 1, 4):
            if nopts[i] != nopts[j] and len(nopts[i]) > 12 and jaccard(tokens(opts[i]), tokens(opts[j])) >= 0.92:
                iss.append(issue("options_near_duplicate", f"الخياران {i + 1} و{j + 1} شبه متطابقين.", "minor"))
    if any(ALL_NONE_RX.search(o) for o in opts):
        iss.append(issue("all_none_above", "خيارات من نوع «كل ما سبق/لا شيء مما سبق» غير مسموحة."))
    if any(re.match(r"^\s*[A-Dأ-د][\.\)]\s", o) for o in opts):
        iss.append(issue("option_label_in_text", "نص الخيار يحتوي ترقيم A/B/C في داخله.", "minor"))
    lens = [len(o) for o in opts]
    others = [l for i, l in enumerate(lens) if i != ci]
    if lens[ci] > 1.6 * max(others) and lens[ci] > 40:
        iss.append(issue("length_cue", "الإجابة الصحيحة أطول بكثير من المشتتات (قرينة شكلية).", "minor"))

    # --- evidence
    ev = q.get("evidence") or []
    if not ev:
        iss.append(issue("no_evidence", "لا يوجد دليل من المصدر."))
    allowed = ctx.get("allowed_refs", set())
    ok_ev = 0
    for e in ev:
        ref, quote = e.get("page"), e.get("quote", "")
        if ref not in allowed:
            iss.append(issue("evidence_out_of_scope", f"الدليل يشير إلى صفحة خارج النطاق المحدد ({ref})."))
            continue
        if quote_in_text(quote, ctx["page_text"].get(ref, "")):
            ok_ev += 1
        else:
            iss.append(issue("evidence_not_found", f"الاقتباس غير موجود حرفيًا في {ref}."))
    if ev and ok_ev == 0 and not (q.get("uses_external") and ctx.get("allow_external")):
        iss.append(issue("unsupported", "لا يوجد دليل نصي متحقق منه يدعم الإجابة."))
    if q.get("uses_external") and not ctx.get("allow_external"):
        iss.append(issue("external_not_allowed", "السؤال يستعين بمعلومة خارج المصدر والوضع الحالي لا يسمح بذلك."))

    if len((q.get("explanation") or "").strip()) < 25:
        iss.append(issue("explanation_missing", "التفسير مفقود أو قصير."))
    if len((q.get("purpose") or "").strip()) < 8:
        iss.append(issue("purpose_missing", "الغرض المقيس غير محدد.", "minor"))

    # --- type specific
    if qtype == "not_except" and not NOT_RX.search(stem):
        iss.append(issue("not_marker_missing", "سؤال NOT/EXCEPT بلا صيغة نفي واضحة في السؤال."))
    if qtype != "not_except" and re.search(r"\b(NOT|EXCEPT)\b", stem):
        iss.append(issue("unexpected_negation", "صيغة نفي كبيرة في سؤال ليس من نوع NOT/EXCEPT.", "minor"))
    if qtype == "sequence":
        sets = [frozenset(re.findall(r"\d+|[A-Za-z؀-ۿ]+", re.sub(r"[→>\-,،]", " ", o))) for o in opts]
        if len(set(sets)) != 1 or len(next(iter(sets))) < 3:
            iss.append(issue("sequence_options_invalid", "خيارات الترتيب يجب أن تكون ترتيبات كاملة لنفس العناصر (3 عناصر على الأقل)."))
        if not re.search(r"(?:^|\n)\s*[\(\[]?\d+[\)\].:]", stem):
            iss.append(issue("sequence_items_missing", "عناصر الترتيب غير مرقمة داخل نص السؤال."))
    if qtype == "best_answer" and not re.search(r"best|most|أفضل|الأنسب|الأكثر|الأصح|الأمثل|الأكمل", stem, re.I):
        iss.append(issue("best_marker_missing", "سؤال أفضل إجابة بلا صيغة «الأفضل/الأنسب» في السؤال.", "minor"))
    if qtype == "scenarios" and len(stem) < 110:
        iss.append(issue("scenario_thin", "السيناريو قصير جدًا ولا يحوي تفاصيل حالة.", "minor"))

    # --- no cross-field import (e.g. clinical framing outside health)
    fld = ctx.get("field", "other")
    if not FIELDS.get(fld, FIELDS["other"])["clinical"]:
        src_all = " ".join(ctx["page_text"].get(r, "") for r in allowed)
        blob = stem + " " + " ".join(opts)
        for m in CLINICAL_RX.finditer(blob):
            if not re.search(re.escape(m.group(0)), src_all, re.I):
                iss.append(issue("cross_field_import", f"مصطلح طبي «{m.group(0)}» غير موجود في المصدر وتخصص الطالب غير صحي."))
                break

    # --- language
    lang = ctx.get("language", "source")
    ar = arabic_ratio(stem)
    want_ar = lang == "ar" or (lang == "source" and ctx.get("source_lang_ar"))
    want_en = lang == "en" or (lang == "source" and not ctx.get("source_lang_ar"))
    if want_ar and ar < 0.3:
        iss.append(issue("language_mismatch", "السؤال ليس بالعربية كما طُلب."))
    if want_en and ar > 0.15:
        iss.append(issue("language_mismatch", "السؤال ليس بالإنجليزية كما طُلب."))

    # --- calculations
    calc = q.get("calc")
    if calc:
        try:
            val = safe_eval(str(calc.get("expression")))
            exp = float(calc.get("expected"))
            if abs(val - exp) > 1e-6 * max(1.0, abs(exp)):
                iss.append(issue("calc_mismatch", f"الحساب المعلن ({val:g}) لا يساوي القيمة المتوقعة ({exp:g})."))
            else:
                nums = numbers_in(opts[ci])
                if not any(abs(n - exp) <= 0.011 * max(abs(exp), 1e-9) or abs(n - round(exp, 2)) < 0.006 for n in nums):
                    iss.append(issue("calc_key_mismatch", "رقم الإجابة الصحيحة لا يطابق نتيجة الحساب المعلنة."))
        except Exception:
            iss.append(issue("calc_invalid", "تعذّر تقييم تعبير الحساب المرفق."))
    elif qtype in ("application",) and len(numbers_in(stem)) >= 2 and re.search(r"[=×*/+]|calculate|احسب", stem + " " + (q.get("explanation") or ""), re.I):
        iss.append(issue("calc_unverified", "السؤال يحوي حسابًا لم يُرفق به تعبير للتحقق الآلي.", "minor"))
    return iss


def decisive(issues: list[dict]) -> bool:
    return any(i["severity"] == "decisive" for i in issues)


# ---------- cross-question checks ----------

def duplicate_of(cand: dict, accepted: list[dict], stem_thr: float = 0.62, purpose_thr: float = 0.6) -> dict | None:
    cs, cp = tokens(cand["stem"]), tokens(cand.get("purpose", ""))
    ck = norm(cand["options"][cand["correct_index"]])
    cev = {norm(e.get("quote", ""))[:80] for e in cand.get("evidence", [])}
    for a in accepted:
        s = jaccard(cs, tokens(a["stem"]))
        p = jaccard(cp, tokens(a.get("purpose", ""))) if cp else 0
        same_key = ck == norm(a["options"][a["correct_index"]]) and len(ck) > 3
        a_ev = {norm(e.get("quote", ""))[:80] for e in a.get("evidence", [])}
        same_ev = bool(cev & a_ev) and cand.get("qtype") == a.get("qtype")
        if s >= stem_thr or p >= purpose_thr or (same_key and s >= 0.35) or same_ev:
            return {"of": a.get("slot") or a.get("id"), "stem_sim": round(s, 2), "purpose_sim": round(p, 2)}
    return None


def leaks_other(cand: dict, accepted: list[dict]) -> dict | None:
    """Does the candidate's stem reveal a previously accepted question's correct answer
    (or does an accepted stem reveal the candidate's)? Exact multi-word containment."""
    def key_text(q): return norm(q["options"][q["correct_index"]])
    cs = norm(cand["stem"])
    ck = key_text(cand)
    for a in accepted:
        ak, as_ = key_text(a), norm(a["stem"])
        if len(ak.split()) >= 3 and len(ak) >= 14 and ak in cs:
            return {"direction": "candidate_stem_reveals_other_key", "other": a.get("slot")}
        if len(ck.split()) >= 3 and len(ck) >= 14 and ck in as_:
            return {"direction": "other_stem_reveals_candidate_key", "other": a.get("slot")}
    return None
