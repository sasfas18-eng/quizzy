"""Distribution planning: turn a source analysis + student settings into question slots.

Planner v2: coverage first (every objective is asked), and the requested count is honoured through VARIANTS of the same
objectives (different angle/wording/type) — only a very short lecture ends up below it, and then it says so.
"""
from __future__ import annotations

import math
import re

from .taxonomy import BASE_WEIGHTS, FOCUS, QTYPE_ORDER, QTYPES, TASKS, type_label


def _largest_remainder(weights: dict[str, float], total: int) -> dict[str, int]:
    s = sum(weights.values())
    if s <= 0 or total <= 0:
        return {k: 0 for k in weights}
    raw = {k: w / s * total for k, w in weights.items()}
    base = {k: int(v) for k, v in raw.items()}
    rem = total - sum(base.values())
    for k in sorted(raw, key=lambda k: raw[k] - base[k], reverse=True)[:rem]:
        base[k] += 1
    return base


MAX_PER_OBJ = 6
ANGLES = [
    "ask about the fact directly, in plain standard wording",
    "reverse it: describe or define the thing and ask for its name (or give the name and ask for the description)",
    "a fill-in-the-blank stem with four candidate completions",
    "which of four statements taken from the source is correct",
    "put the fact in a short concrete situation or example drawn from the source",
    "ask for the reason or the consequence behind the fact",
    "ask which statement is NOT correct / does NOT belong",
    "ask for the number, condition, limit or exact detail the source gives",
]


def target_count(settings: dict, n_obj: int) -> int:
    """How many questions: a number, or "auto" = enough to cover every objective (about 1.3 per objective, 10..40)."""
    c = settings.get("count", "auto")
    if c in ("auto", None, ""):
        t = max(10, min(40, math.ceil(n_obj * 1.3)))
        if n_obj > t:
            t = min(n_obj, 60)
        return t
    try:
        return max(5, min(80, int(c)))
    except (TypeError, ValueError):
        return 20


def _pn(ref) -> tuple[int, int]:
    m = re.match(r"^d(\d+)p(\d+)$", str(ref))
    return (int(m.group(1)), int(m.group(2))) if m else (999, 999999)


def build_plan(analysis: dict, settings: dict, heuristic: dict | None = None) -> dict:
    """Planner v2 — COVERAGE FIRST, and the requested count is always honoured:
    1. every objective of the lecture gets a question (an even spread over the lecture when fewer are asked for);
    2. when more are wanted than there are objectives, the extra questions are VARIANTS: the same fact tested again from a
       different angle / wording / type (repetition is welcome, copies are not);
    3. which of the ten internal question types each slot uses is decided here from what the lecture supports — never by the student."""
    objectives = list(analysis.get("objectives", []))
    n_obj = len(objectives)
    target = target_count(settings, n_obj)
    focus = settings.get("focus", "balanced")
    difficulty = settings.get("difficulty", "mixed")
    field = settings.get("field", "other")

    veto: dict[str, str] = {}
    if heuristic:
        for code in QTYPE_ORDER:
            h = heuristic.get(code) or {}
            if h.get("level") == "none" and code not in ("basic_recall", "understanding"):
                veto[code] = h.get("missing") or "لا دعم نصي كافٍ."
    mult = FOCUS.get(focus, {})

    def character(c: str) -> float:
        lvl = ((heuristic or {}).get(c) or {}).get("level")
        return 1.8 if lvl == "strong" and c not in ("basic_recall", "understanding") else 1.0

    weights = {c: BASE_WEIGHTS[c] * mult.get(c, 1.0) * character(c) for c in QTYPE_ORDER if c not in veto}

    def first_page(o: dict) -> tuple[int, int]:
        return min((_pn(p) for p in (o.get("pages") or [])), default=(999, 999999))

    by_page = sorted(objectives, key=first_page)
    idx_of = {o["id"]: i for i, o in enumerate(by_page)}
    # who gets a question: everyone when the count allows; otherwise an even spread over the WHOLE lecture
    chosen = by_page if target >= n_obj else [by_page[min(n_obj - 1, int((k + 0.5) * n_obj / target))] for k in range(target)]

    def types_of(o: dict) -> list[str]:
        t = [c for c in (o.get("supports") or {}) if c in weights]
        return t or ["basic_recall"]

    used = {c: 0 for c in QTYPE_ORDER}
    per_obj: dict[str, int] = {}
    seen: dict[str, set] = {}
    slots: list[dict] = []

    def pick(o: dict) -> str:
        best, bs = "basic_recall", -1.0
        for c in types_of(o):
            sc = weights.get(c, BASE_WEIGHTS[c]) / (1 + used[c])
            if used[c] == 0:
                sc *= 2.5
            if c in seen.get(o["id"], set()):
                sc *= 0.15
            if sc > bs + 1e-12:
                bs, best = sc, c
        return best

    def add(o: dict) -> None:
        c = pick(o)
        v = per_obj.get(o["id"], 0)
        sup = (o.get("supports") or {}).get(c) or {}
        used[c] += 1
        seen.setdefault(o["id"], set()).add(c)
        per_obj[o["id"]] = v + 1
        slots.append({"qtype": c, "objective_id": o["id"], "objective": o["statement"],
                      "pages": sup.get("pages") or o.get("pages") or [], "task": sup.get("task") if sup.get("task") in TASKS else None,
                      "variant": v, "angle": ANGLES[(v - 1 + idx_of[o["id"]]) % len(ANGLES)] if v else None})

    for o in sorted(chosen, key=lambda o: (len(types_of(o)), first_page(o))):    # most constrained objectives pick their type first
        add(o)
    prio = sorted(by_page, key=lambda o: (-(o.get("capacity") or 1), -len(o.get("pages") or []), first_page(o)))
    r = 1
    while r < MAX_PER_OBJ and len(slots) < target:
        for o in prio:
            if len(slots) >= target:
                break
            if per_obj.get(o["id"], 0) < MAX_PER_OBJ:
                add(o)
        r += 1

    fixed = difficulty if difficulty in ("easy", "medium", "hard") else None
    base_diff = {"basic_recall": "easy", "understanding": "easy", "critical_thinking": "hard", "scenarios": "hard", "best_answer": "hard"}
    for s in slots:
        s["difficulty"] = fixed or (["medium", "hard", "easy"][s["variant"] % 3] if s["variant"] else base_diff.get(s["qtype"], "medium"))
    # one pass over the lecture in page order, then the next pass (variants): repeated facts come back later in a different shape
    slots.sort(key=lambda s: (s["variant"], min((_pn(p) for p in s["pages"]), default=(999, 999999)), QTYPE_ORDER.index(s["qtype"])))
    for i, s in enumerate(slots, start=1):
        s["slot"] = i

    actual: dict[str, int] = {}
    for s in slots:
        actual[s["qtype"]] = actual.get(s["qtype"], 0) + 1
    unsupported = [{"qtype": code, "label": type_label(code, field), "reason": veto.get(code) or "لا يدعمها محتوى هذه المحاضرة.", "suggestion": _suggest(code)}
                   for code in QTYPE_ORDER if not actual.get(code)]
    index = {o["id"]: {"statement": o["statement"], "pages": o.get("pages") or [], "types": types_of(o),
                       "supports": {c: {"pages": (v or {}).get("pages"), "task": (v or {}).get("task")} for c, v in (o.get("supports") or {}).items()}}
             for o in objectives}
    shortfall = None
    if len(slots) < target:
        shortfall = {"requested": target, "possible": len(slots), "reason": "المحتوى قصير: لا يكفي لعدد أكبر حتى مع تنويع الصياغة.",
                     "suggestions": ["لزيادة العدد أضف صفحات أو لكتشرًا آخر."]}
    return {
        "requested": target, "requested_raw": settings.get("count", "auto"), "auto": settings.get("count", "auto") in ("auto", None, ""),
        "feasible_count": len(slots), "slots": slots, "distribution": {c: actual.get(c, 0) for c in QTYPE_ORDER},
        "unsupported_types": unsupported, "shortfall": shortfall, "focus": focus, "difficulty": difficulty,
        "objective_count": n_obj, "covered_objective_count": len(chosen), "coverage_partial": len(chosen) < n_obj, "objective_index": index,
    }


def _suggest(code: str) -> str:
    return {
        "scenarios": "أضف صفحات تتضمن حالات/أمثلة تطبيقية أو غيّر طلبك لاستبعاد السيناريوهات.",
        "sequence": "أضف صفحات تشرح خطوات/مراحل مرتبة، أو تجاهل هذا النوع.",
        "compare_contrast": "أضف صفحات تقارن بين عناصر متشابهة.",
        "application": "أضف أمثلة محلولة أو قوانين/معادلات.",
        "not_except": "أضف صفحات تتضمن قوائم أو تصنيفات.",
    }.get(code, "وسّع المصدر ليغطي هذا النوع.")
