"""Planner v2 (server): coverage first, the requested count honoured through variants, identity chosen internally, relaxed duplicates
for variants, and a generation loop that tops up / rescues instead of falling short. Mirrors claude-edition/test/planner_v2.test.js."""
from app.services import validate
from app.services.generator import generate_questions
from app.services.planner import ANGLES, MAX_PER_OBJ, _pn, build_plan, target_count
from app.services.taxonomy import QTYPE_ORDER


def objs(n, types=("basic_recall", "understanding")):
    t = types if callable(types) is False else None
    return [{"id": f"o{i}", "statement": f"Objective {i}", "pages": [f"d1p{i}"], "capacity": 1 + (i % 3),
             "supports": {c: {"pages": [f"d1p{i}"]} for c in (t or types(i))}} for i in range(1, n + 1)]


def per(plan):
    m = {}
    for s in plan["slots"]:
        m[s["objective_id"]] = m.get(s["objective_id"], 0) + 1
    return m


def test_count_is_honoured_with_variants_and_every_objective_is_covered():
    plan = build_plan({"objectives": objs(6)}, {"count": 20})
    assert len(plan["slots"]) == 20 and plan["requested"] == 20 and plan["shortfall"] is None
    c = per(plan)
    assert len(c) == 6 and all(3 <= n <= 4 for n in c.values())
    assert all(s["variant"] == 0 for s in plan["slots"][:6]), "first pass over the lecture comes first"
    first = [_pn(s["pages"][0]) for s in plan["slots"][:6]]
    assert first == sorted(first), "and it is in lecture order"
    angles = {}
    for s in plan["slots"]:
        if s["variant"] > 0:
            assert s["angle"]
            angles.setdefault(s["objective_id"], []).append(s["angle"])
    assert all(len(set(a)) == len(a) for a in angles.values()), "variants of one objective use different angles"
    assert [s["slot"] for s in plan["slots"]] == list(range(1, 21))


def test_auto_count_covers_everything():
    assert target_count({"count": "auto"}, 6) == 10
    assert target_count({"count": "auto"}, 20) == 26
    assert target_count({"count": "auto"}, 30) == 39
    assert target_count({"count": "auto"}, 70) == 60
    assert target_count({}, 6) == 10
    p30 = build_plan({"objectives": objs(30)}, {"count": "auto"})
    assert p30["requested"] == 39 and len(per(p30)) == 30
    p70 = build_plan({"objectives": objs(70)}, {"count": "auto"})
    assert p70["requested"] == 60 and p70["coverage_partial"] is True


def test_fewer_questions_than_objectives_spread_over_the_whole_lecture():
    plan = build_plan({"objectives": objs(40)}, {"count": 10})
    assert len(plan["slots"]) == 10 and plan["coverage_partial"] is True
    pages = sorted(_pn(s["pages"][0])[1] for s in plan["slots"])
    assert pages[0] <= 4 and pages[-1] >= 37, pages
    assert len({s["objective_id"] for s in plan["slots"]}) == 10


def test_identity_is_chosen_from_what_each_objective_supports():
    sup = lambda i: [("basic_recall", "understanding"), ("mechanisms", "understanding"), ("sequence", "basic_recall"),
                     ("compare_contrast", "understanding"), ("application", "critical_thinking", "basic_recall")][i % 5]
    analysis = {"objectives": objs(10, sup)}
    heur = {c: {"level": "none" if c == "sequence" else "strong", "missing": "no steps"} for c in QTYPE_ORDER}
    plan = build_plan(analysis, {"count": 20}, heur)
    by = {o["id"]: o for o in analysis["objectives"]}
    for s in plan["slots"]:
        assert s["qtype"] in by[s["objective_id"]]["supports"] and s["qtype"] != "sequence"
    assert len({s["qtype"] for s in plan["slots"]}) >= 5, plan["distribution"]


def test_variants_of_the_same_objective_are_not_duplicates_but_copies_are():
    def q(o, stem, key, opts, slot=1):
        return {"slot": slot, "qtype": "basic_recall", "objective_id": o, "stem": stem, "purpose": "p " + stem, "options": [key, *opts], "correct_index": 0,
                "evidence": [{"page": "d1p1", "quote": "The enzyme binds the receptor firmly."}]}
    a = q("o1", "Which molecule binds the receptor firmly in this lecture?", "Enzyme", ["Ligand", "Vesicle", "Platelet"])
    reworded = q("o1", "Fill the gap: the _____ is the one that attaches to the receptor tightly.", "Enzyme", ["Hormone", "Synapse", "Nucleus"], 2)
    assert validate.duplicate_of(reworded, [a]) is None
    assert validate.duplicate_of(q("o1", a["stem"], "Enzyme", ["Ligand", "Vesicle", "Platelet"], 2), [a]) is not None
    assert validate.duplicate_of(q("o1", "Pick the binder of the receptor from the options below please.", "Enzyme", ["Ligand", "Vesicle", "Platelet"], 2), [a]) is not None
    assert validate.duplicate_of(q("o2", "Fill the gap: the _____ is the one that attaches to the receptor tightly.", "Enzyme", ["Hormone", "Synapse", "Nucleus"], 2), [a]) is not None
    assert validate.leaks_other(reworded, [{**a, "options": ["the enzyme binds the receptor", "x", "y", "z"]}]) is None


# ---- generation: a fake model that writes a cloze question from the page text (different wording per variant)
TERMS = ["Glucose", "Membrane", "Receptor", "Enzyme", "Ligand", "Vesicle", "Nucleus", "Hormone", "Antibody", "Synapse"]
VERBS = ["stabilises", "amplifies", "suppresses", "transports", "degrades", "binds", "activates", "filters", "recruits", "modulates"]
NOUNS = ["sodium", "calcium", "oxygen", "lactate", "insulin", "thyroxine", "collagen", "fibrin", "myosin", "cortisol"]
V2 = ["lowers", "elevates", "delays", "prevents", "restores", "shortens", "prolongs", "balances", "reduces", "enhances"]
N3 = ["renal", "hepatic", "neural", "vascular", "muscular", "thyroid", "cardiac", "immune", "skeletal", "pancreatic"]
N4 = ["fasting", "exercise", "infection", "dehydration", "fever", "hypoxia", "trauma", "starvation", "pregnancy", "altitude"]
LEAD = ["Complete according to the lecture:", "Select the missing word that finishes this statement:", "Choose the term that fits the blank below:", "Identify the word hidden in this lecture sentence:"]
PAGES = [{"ref": f"d1p{i + 1}", "doc_id": "d", "doc_title": "t", "page_no": i + 1,
          "text": f"Topic {i}: {TERMS[i]} is the {'rapid' if i % 2 else 'gradual'} regulator that {VERBS[i]} {NOUNS[i]} inside {NOUNS[(i + 5) % 10]} tissue and also {V2[i]} the {N3[i]} pathway during {N4[i]} stress."}
         for i in range(10)]


class FakeModel:
    def __init__(self, refuse=None):
        self.refuse = refuse or (lambda s: False)

    def json_call(self, task, system, prompt, payload=None, max_tokens=0):
        if task == "generate":
            out = []
            for s in payload["slots"]:
                if self.refuse(s):
                    out.append({"slot": s["slot"], "unwritable_reason": "cannot write this one"})
                    continue
                ref = s["pages"][0]
                text = payload["pages"][ref]
                term = text.split(": ")[1].split()[0]
                out.append({"slot": s["slot"], "unwritable_reason": None, "stem": f"{LEAD[(s.get('variant', 0) + s['slot']) % 4]} {text.replace(term, '_____')}",
                            "options": [term, f"{term}AltA{s['slot']}", f"{term}AltB{s['slot']}", f"{term}AltC{s['slot']}"], "correct_index": 0,
                            "explanation": "الإجابة مبنية على نص المحاضرة: «" + text + "». الخيارات الأخرى لا تظهر في هذا السياق.",
                            "purpose": f"p{ref}v{s.get('variant', 0)}s{s['slot']}", "reasoning_pattern": "r", "evidence": [{"page": ref, "quote": text}], "calc": None, "uses_external": False})
            return {"questions": out}
        if task == "verify_batch":
            return {"results": [{"id": it["id"], "chosen_index": it["question"]["correct_index"], "answerable_from_source": True, "single_best_answer": True,
                                 "sufficient_data": True, "needs_outside_knowledge": False, "flaws": [], "severity": "none"} for it in payload["items"]]}
        if task == "explain_batch":
            return {"results": [{"id": it["id"], "explanation_supported": True, "contradicts_source": False, "notes": ""} for it in payload["items"]]}
        return {}


ST = {"field": "science", "language": "en", "external_mode": "source_only"}


def run(plan, refuse=None):
    return generate_questions(FakeModel(refuse), plan, {"pages": PAGES, "excluded": []}, ST)


def test_generation_delivers_the_count_and_covers_everything():
    plan = build_plan({"objectives": objs(10)}, {**ST, "count": 25})
    r = run(plan)
    assert len(r["accepted"]) == 25 and not r["uncovered_objectives"] and len(r["covered_objectives"]) == 10
    stems = [c["stem"] for c in r["accepted"]]
    assert len(set(stems)) == len(stems) and any(c["variant"] > 0 for c in r["accepted"])


def test_an_objective_the_model_cannot_write_is_rescued_by_the_final_round():
    plan = build_plan({"objectives": objs(10)}, {**ST, "count": 12})
    n = len(plan["slots"])
    r = run(plan, lambda s: s["objective"] == "Objective 2" and s["slot"] <= n)
    assert "o2" in r["covered_objectives"] and not r["uncovered_objectives"] and r["stats"]["topup"] >= 1 and len(r["accepted"]) == 12


def test_a_never_writable_objective_is_reported_while_the_count_is_still_met():
    plan = build_plan({"objectives": objs(10)}, {**ST, "count": 14})
    r = run(plan, lambda s: s["objective"] == "Objective 3")
    assert len(r["accepted"]) == 14 and r["uncovered_objectives"] == ["o3"] and not any(c["objective_id"] == "o3" for c in r["accepted"])
