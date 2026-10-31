"""Distribution planning: turn a source analysis + student settings into question slots.

The plan never pads. If the source supports fewer distinct questions than requested,
`feasible_count < requested` and the shortfall is explained with suggestions.
"""
from __future__ import annotations

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


def build_plan(analysis: dict, settings: dict, heuristic: dict | None = None) -> dict:
    """analysis: {objectives:[{id,statement,pages,capacity,supports:{type:{pages,task?}}}], ...}"""
    requested = int(settings.get("count", 20))
    focus = settings.get("focus", "balanced")
    field = settings.get("field", "other")
    difficulty = settings.get("difficulty", "mixed")
    objectives = analysis.get("objectives", [])

    # --- type availability (veto by heuristic when it found no textual footing at all)
    veto: dict[str, str] = {}
    if heuristic:
        for code in QTYPE_ORDER:
            h = heuristic.get(code) or {}
            if h.get("level") == "none" and code not in ("basic_recall", "understanding"):
                veto[code] = h.get("missing") or "لا دعم نصي كافٍ."
    avail: dict[str, list[dict]] = {c: [] for c in QTYPE_ORDER}
    for ob in objectives:
        for code, sup in (ob.get("supports") or {}).items():
            if code in avail and code not in veto:
                avail[code].append(ob)

    cap_left = {ob["id"]: max(1, int(ob.get("capacity", 1))) for ob in objectives}
    total_capacity = sum(cap_left.values())
    # Each (objective,type) pair is used at most once -> hard distinct-purpose bound.
    pair_capacity = {c: len(avail[c]) for c in QTYPE_ORDER}

    # --- weights
    mult = FOCUS.get(focus, {})
    # lecture character: types with strong textual footing (an explicit process, a side-by-side comparison, formulas...)
    # get a boost so the quiz reflects what this particular lecture is good for, not a fixed template.
    def character(c: str) -> float:
        lvl = ((heuristic or {}).get(c) or {}).get("level")
        return 1.8 if lvl == "strong" and c not in ("basic_recall", "understanding") else 1.0

    weights = {c: BASE_WEIGHTS[c] * mult.get(c, 1.0) * character(c) for c in QTYPE_ORDER if pair_capacity[c] > 0}
    feasible_total = min(requested, total_capacity, sum(pair_capacity.values()))
    quota = _largest_remainder(weights, feasible_total) if weights else {}
    # identity coverage: with enough questions, every supported type appears at least once
    if focus == "balanced" and feasible_total >= len(weights) >= 1:
        for c in weights:
            if quota.get(c, 0) == 0:
                donor = max(quota, key=lambda k: quota[k])
                if quota[donor] > 1:
                    quota[donor] -= 1
                    quota[c] = 1
    # cap by availability and redistribute overflow
    for _ in range(5):
        overflow = 0
        for c in list(quota):
            if quota[c] > pair_capacity[c]:
                overflow += quota[c] - pair_capacity[c]
                quota[c] = pair_capacity[c]
        if not overflow:
            break
        room = {c: weights[c] for c in weights if quota.get(c, 0) < pair_capacity[c]}
        add = _largest_remainder(room, overflow) if room else {}
        for c, n in add.items():
            quota[c] = quota.get(c, 0) + n

    # --- assign slots (scarcest type first)
    slots: list[dict] = []
    used_pair: set[tuple[str, str]] = set()
    for code in sorted(quota, key=lambda c: pair_capacity[c]):
        want = quota[code]
        cands = sorted(avail[code], key=lambda ob: (-cap_left[ob["id"]], min(ob.get("pages") or [0])))
        for ob in cands:
            if want <= 0:
                break
            if cap_left[ob["id"]] <= 0 or (ob["id"], code) in used_pair:
                continue
            sup = ob["supports"][code] or {}
            slots.append({"qtype": code, "objective_id": ob["id"], "objective": ob["statement"],
                          "pages": sup.get("pages") or ob.get("pages") or [], "task": sup.get("task")
                          if sup.get("task") in TASKS else None})
            cap_left[ob["id"]] -= 1
            used_pair.add((ob["id"], code))
            want -= 1
        quota[code] -= want  # actual
    # fill leftover requested (rare) by picking remaining capacity in any supported type
    deficit = feasible_total - len(slots)
    if deficit > 0:
        for code in sorted(weights, key=lambda c: -weights[c]):
            for ob in avail[code]:
                if deficit <= 0:
                    break
                if cap_left[ob["id"]] > 0 and (ob["id"], code) not in used_pair:
                    sup = ob["supports"][code] or {}
                    slots.append({"qtype": code, "objective_id": ob["id"], "objective": ob["statement"],
                                  "pages": sup.get("pages") or ob.get("pages") or [], "task": sup.get("task") if sup.get("task") in TASKS else None})
                    cap_left[ob["id"]] -= 1
                    used_pair.add((ob["id"], code))
                    deficit -= 1

    # --- THE REQUESTED COUNT IS ALWAYS PLANNED (same rule as the browser editions). The slots above are the "natural" ones (distinct
    # objective x type pairs within each objective's capacity). When the lecture is thinner than the request, the rest are REINFORCEMENT
    # slots: the same material asked from another angle / another fact / another direction, spread evenly over the lecture. They are verified
    # against the source like any other question; they are just not required to be about a brand-new topic.
    pool = []
    for ob in objectives:
        types = {}
        for code in QTYPE_ORDER:
            sup = (ob.get("supports") or {}).get(code, "__absent__")
            if sup == "__absent__" or code in veto:
                continue
            sup = sup or {}
            types[code] = {"pages": sup.get("pages") or ob.get("pages") or [], "task": sup.get("task") if sup.get("task") in TASKS else None}
        pool.append({"id": ob["id"], "statement": ob["statement"], "pages": ob.get("pages") or [], "types": types})
    natural = len(slots)
    per_obj: dict[str, int] = {}
    for s_ in slots:
        per_obj[s_["objective_id"]] = per_obj.get(s_["objective_id"], 0) + 1
    slots.extend(reinforcement_slots(pool, per_obj, requested - natural))

    # --- difficulty
    ladder = {"easy": ["easy"], "medium": ["medium"], "hard": ["hard"]}
    for i, s in enumerate(slots):
        if difficulty in ladder:
            s["difficulty"] = difficulty
        else:
            base = {"basic_recall": "easy", "understanding": "easy", "critical_thinking": "hard",
                    "scenarios": "hard", "best_answer": "hard"}.get(s["qtype"], "medium")
            s["difficulty"] = base if i % 3 else "medium"

    # --- order: follow the lecture flow (first page), keep types interleaved
    slots.sort(key=lambda s: (min(s["pages"]) if s["pages"] else 9999, QTYPE_ORDER.index(s["qtype"])))
    for i, s in enumerate(slots, start=1):
        s["slot"] = i

    actual: dict[str, int] = {}
    for s in slots:
        actual[s["qtype"]] = actual.get(s["qtype"], 0) + 1

    unsupported = []
    for code in QTYPE_ORDER:
        if actual.get(code):
            continue
        reason = veto.get(code) or ("لا يدعمها أي هدف تعليمي في النطاق المختار." if pair_capacity[code] == 0
                                    else "لم تتسع لها حصة هذا الطلب (التركيز المختار).")
        unsupported.append({"qtype": code, "label": type_label(code, field), "reason": reason,
                            "suggestion": _suggest(code)})

    shortfall = None
    if len(slots) < requested:
        shortfall = {
            "requested": requested, "possible": len(slots),
            "reason": "لا يوجد في هذا النطاق ما يُبنى عليه أي سؤال.",
            "suggestions": ["وسّع نطاق الصفحات أو أضف لكتشرًا آخر."],
        }
    return {
        "requested": requested, "feasible_count": len(slots), "natural_count": natural, "extra_count": len(slots) - natural, "slots": slots, "pool": pool,
        "distribution": {c: actual.get(c, 0) for c in QTYPE_ORDER},
        "unsupported_types": unsupported, "shortfall": shortfall,
        "focus": focus, "difficulty": difficulty,
        "objective_count": len(objectives),
    }


# the angles a reinforcement question may take (the generator is told which one)
ANGLES = ["reverse", "other_fact", "not_true", "apply", "compare", "detail"]


def difficulty_for(settings: dict, qtype: str) -> str:
    d = settings.get("difficulty", "mixed")
    if d in ("easy", "medium", "hard"):
        return d
    return {"basic_recall": "easy", "understanding": "easy", "critical_thinking": "hard", "scenarios": "hard", "best_answer": "hard"}.get(qtype, "medium")


def reinforcement_slots(pool: list[dict], counts: dict[str, int], n: int, tries: dict[str, int] | None = None) -> list[dict]:
    """`n` extra slots over the objectives of `pool`, always on the objective that has the fewest questions so far (so the whole lecture stays
    covered), rotating its supported types and the angle. `counts` (objective id -> questions already planned/accepted) and `tries` (earlier
    attempts that produced nothing) steer the choice."""
    out: list[dict] = []
    if not pool or n <= 0:
        return out
    c, t = dict(counts), (tries or {})
    for _ in range(n):
        o = min(pool, key=lambda ob: (c.get(ob["id"], 0) + 0.5 * t.get(ob["id"], 0), min(ob["pages"]) if ob["pages"] else "~"))
        types = list(o["types"].keys()) or ["basic_recall"]
        k = c.get(o["id"], 0) + t.get(o["id"], 0)
        code = types[k % len(types)]
        sup = o["types"].get(code) or {}
        out.append({"qtype": code, "objective_id": o["id"], "objective": o["statement"], "pages": sup.get("pages") or o["pages"], "task": sup.get("task"),
                    "extra": True, "variant": c.get(o["id"], 0) + 1, "angle": ANGLES[k % len(ANGLES)]})
        c[o["id"]] = c.get(o["id"], 0) + 1
    return out


def _suggest(code: str) -> str:
    return {
        "scenarios": "أضف صفحات تتضمن حالات/أمثلة تطبيقية أو غيّر طلبك لاستبعاد السيناريوهات.",
        "sequence": "أضف صفحات تشرح خطوات/مراحل مرتبة، أو تجاهل هذا النوع.",
        "compare_contrast": "أضف صفحات تقارن بين عناصر متشابهة.",
        "application": "أضف أمثلة محلولة أو قوانين/معادلات.",
        "not_except": "أضف صفحات تتضمن قوائم أو تصنيفات.",
    }.get(code, "وسّع المصدر ليغطي هذا النوع.")
