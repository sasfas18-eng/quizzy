"""A student who asks for N questions gets N: the planner plans N (extra slots = other angles on the same material), the generator tops up what was
rejected with ONE bounded, verified round, reinforcement questions may share a topic but are never copies, and the order keeps the lecture flow."""
import json
from collections import Counter
from pathlib import Path

from app.services import generator, planner, validate
from app.services.fake_llm import FakeProvider

PAGES = json.loads((Path(__file__).resolve().parents[2] / "claude-edition" / "test" / "samples" / "pages.json").read_text(encoding="utf-8"))["lecture_en"]
SETTINGS = {"count": 30, "language": "en", "field": "health", "difficulty": "mixed", "external_mode": "source_only", "focus": "balanced"}


def source():
    return {"pages": [{"ref": f"d1p{i}", "doc_id": "d", "doc_title": "lecture", "page_no": i, "text": t, "status": "ok", "image_count": 0} for i, t in enumerate(PAGES, start=1)], "excluded": [], "docs": []}


def plan_for(count):
    st = {**SETTINGS, "count": count}
    a = FakeProvider()._analyze({"pages": source()["pages"], "field": "health"})
    for i, ob in enumerate(a["objectives"], start=1):
        ob["id"] = f"o{i}"
    return build(a, st), st


def build(a, st):
    return planner.build_plan(a, st)


class Refusing(FakeProvider):
    """Refuses a share of the first-round slots (what a real model does when a slot has no new fact)."""
    def __init__(self, refuse):
        super().__init__()
        self.refuse = refuse
        self.calls = {"generate": 0, "verify": 0}

    def _generate(self, p):
        self.calls["generate"] += 1
        out = super()._generate(p)
        slots = {s["slot"]: s for s in p["slots"]}
        for q in out["questions"]:
            no = q["slot"]
            if self.refuse(slots[no]):
                q.clear()
                q.update({"slot": no, "unwritable_reason": "no new fact on these pages"})
        return out

    def _verify_batch(self, p):
        self.calls["verify"] += 1
        return super()._verify_batch(p)


def test_reinforcement_slots_cover_evenly_and_rotate_angles():
    pool = [{"id": f"o{i}", "statement": f"s{i}", "pages": [f"d1p{i}"], "types": {"basic_recall": {"pages": [f"d1p{i}"], "task": None}, "understanding": {"pages": [f"d1p{i}"], "task": None}}} for i in range(1, 4)]
    slots = planner.reinforcement_slots(pool, {}, 12)
    assert len(slots) == 12 and Counter(s["objective_id"] for s in slots) == {"o1": 4, "o2": 4, "o3": 4}
    assert len({(s["objective_id"], s["angle"]) for s in slots}) >= 9 and all(s["extra"] and s["variant"] >= 1 for s in slots)
    assert planner.reinforcement_slots([], {}, 5) == [] and planner.reinforcement_slots(pool, {}, 0) == []
    # an objective whose earlier attempts produced nothing is asked less
    steered = planner.reinforcement_slots(pool, {}, 6, tries={"o1": 6})
    assert Counter(s["objective_id"] for s in steered)["o1"] < 2


def test_relaxed_duplicate_rule_allows_another_word_not_a_copy():
    def q(stem, key, quote="The sinoatrial node is the natural pacemaker that initiates each heartbeat."):
        return {"stem": stem, "purpose": "", "options": [key, "alpha", "beta", "gamma"], "correct_index": 0, "evidence": [{"page": "d1p2", "quote": quote}], "qtype": "basic_recall", "slot": 1}
    a = q("Complete: The ____ node is the natural pacemaker that initiates each heartbeat.", "sinoatrial")
    other_word = q("Complete: The sinoatrial node is the natural ____ that initiates each heartbeat.", "pacemaker")
    copy = q("Complete: The ____ node is the natural pacemaker that initiates each heartbeat now.", "sinoatrial")
    assert validate.duplicate_of(other_word, [a])["of"] == 1, "strict (planned) slots still refuse a near-copy"
    assert validate.duplicate_of(other_word, [a], relaxed=True) is None, "a reinforcement question may blank another word of the same sentence"
    assert validate.duplicate_of(copy, [a], relaxed=True) is not None, "...but never repeat the same question"
    # two questions about the same sentence necessarily share its words: not a leak among reinforcement questions
    long_key = q("Which phrase completes: the natural pacemaker that initiates each heartbeat?", "the natural pacemaker that initiates each heartbeat")
    assert validate.leaks_other(a, [long_key]) is not None and validate.leaks_other(a, [long_key], relaxed=True) is None


def test_top_up_round_delivers_what_the_first_round_could_not():
    plan, st = plan_for(30)
    assert plan["feasible_count"] == 30 and plan["shortfall"] is None
    prov = Refusing(lambda s: not s.get("extra") and s["slot"] % 3 == 0)
    first = generator.generate_questions(Refusing(lambda s: not s.get("extra") and s["slot"] % 3 == 0), plan, source(), st)
    out = generator.generate_to_count(prov, plan, source(), st)
    assert len(out["accepted"]) > len(first["accepted"]) and len(out["accepted"]) <= 30, (len(first["accepted"]), len(out["accepted"]))
    assert out["stats"]["topup_rounds"] == 1, "one bounded top-up round"
    keys = {(validate.norm(c["stem"]), validate.norm(c["options"][c["correct_index"]])) for c in out["accepted"]}
    assert len(keys) == len(out["accepted"]), "no question is a copy of another"
    assert any(c.get("extra") for c in out["accepted"]) and all(c.get("verified", {}).get("blind_solver") for c in out["accepted"]), "reinforcement questions are verified like any other"


def test_unusable_model_output_means_no_further_rounds_and_a_clean_stop():
    plan, st = plan_for(30)
    prov = Refusing(lambda s: True)
    out = generator.generate_to_count(prov, plan, source(), st)
    assert out["accepted"] == [] and out["stats"]["topup_rounds"] == 0, "nothing usable in round 1: no further AI rounds (no spending for nothing)"
    assert prov.calls["generate"] == -(-len(plan["slots"]) // generator.MAX_BATCH) or prov.calls["generate"] <= 12


def test_questions_follow_the_lecture_and_echoes_are_kept_apart():
    plan, st = plan_for(40)
    out = generator.generate_to_count(FakeProvider(), plan, source(), st)
    ordered = generator.order_questions(out["accepted"])
    pks = [c["pk"] for c in ordered]
    assert pks == sorted(pks), "lecture (page) order"
    assert len(ordered) == len(out["accepted"])
