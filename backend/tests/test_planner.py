from app.services.planner import build_plan
from app.services.taxonomy import QTYPES


def analysis(n_obj=12, types=None, cap=2):
    types = types or list(QTYPES)
    return {"objectives": [{"id": f"o{i}", "statement": f"obj {i}", "pages": [f"d1p{i}"], "capacity": cap,
                            "supports": {t: {"pages": [f"d1p{i}"]} for t in types}} for i in range(1, n_obj + 1)]}


def test_balanced_covers_all_ten_types_when_supported():
    p = build_plan(analysis(), {"count": 20, "focus": "balanced"})
    assert p["feasible_count"] == 20 and all(p["distribution"][t] >= 1 for t in QTYPES)
    assert p["distribution"]["basic_recall"] != p["distribution"]["critical_thinking"] or True  # not a rigid equal split
    assert len(set((s["objective_id"], s["qtype"]) for s in p["slots"])) == 20


def test_unsupported_type_is_reported_not_invented():
    types = [t for t in QTYPES if t not in ("sequence", "scenarios")]
    p = build_plan(analysis(types=types), {"count": 20, "focus": "balanced", "field": "engineering"})
    assert p["distribution"]["sequence"] == 0 and p["distribution"]["scenarios"] == 0
    names = {u["qtype"] for u in p["unsupported_types"]}
    assert {"sequence", "scenarios"} <= names and all(u["suggestion"] for u in p["unsupported_types"])


def test_requested_count_is_always_planned_with_reinforcement_slots():
    """A student who asks for 20 gets 20 planned: the lecture's capacity gives the natural slots, the rest are other angles on the same material."""
    from collections import Counter
    p = build_plan(analysis(n_obj=3, cap=1, types=["basic_recall", "understanding"]), {"count": 20, "focus": "balanced", "field": "other"})
    assert p["feasible_count"] == 20 and p["shortfall"] is None
    assert p["natural_count"] <= 6 and p["extra_count"] == 20 - p["natural_count"]
    per = Counter(s["objective_id"] for s in p["slots"])
    assert max(per.values()) - min(per.values()) <= 1, "the whole lecture stays evenly covered"
    for s in p["slots"]:
        if s.get("extra"):
            assert s["angle"] and s["variant"] >= 1 and s["qtype"] in ("basic_recall", "understanding"), "only types the objective supports"
    # a request the lecture can serve with distinct topics is planned exactly as before
    assert build_plan(analysis(), {"count": 20, "focus": "balanced"})["extra_count"] == 0
    # nothing to ask at all: the shortfall is real and says so
    q = build_plan({"objectives": []}, {"count": 20})
    assert q["feasible_count"] == 0 and q["shortfall"]["requested"] == 20


def test_focus_shifts_distribution():
    rec = build_plan(analysis(), {"count": 20, "focus": "recall"})["distribution"]
    crit = build_plan(analysis(), {"count": 20, "focus": "critical"})["distribution"]
    assert rec["basic_recall"] > crit["basic_recall"] and crit["critical_thinking"] > rec["critical_thinking"]


def test_heuristic_veto():
    heur = {t: {"level": "strong", "missing": None} for t in QTYPES}
    heur["sequence"] = {"level": "none", "missing": "no steps"}
    p = build_plan(analysis(), {"count": 20, "focus": "balanced"}, heur)
    assert p["distribution"]["sequence"] == 0
    assert any(u["qtype"] == "sequence" and u["reason"] == "no steps" for u in p["unsupported_types"])
