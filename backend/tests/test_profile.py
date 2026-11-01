"""The lecture PROFILER (an internal agent): which of the ten question types THIS lecture supports and how many questions of each it can sustain, and the planner distributing
the questions from it. Nothing here is ever shown to the learner. Mirrors claude-edition/test/profile.test.js."""
import time

import pytest

from app.services import generator, planner
from app.services import profile as P
from app.services.taxonomy import QTYPE_ORDER


def mk(texts):
    return [{"ref": f"d1p{i + 1}", "text": t, "doc_id": "d", "page_no": i + 1} for i, t in enumerate(texts)]


DEFS = mk([f"Topic {i + 1} glossary\nAlpha{i}cyte: a specialised cell that stores energy for the organism during growth.\nBeta{i}zyme: an enzyme that breaks down complex sugars into simple units inside the gut.\n"
           f"Gamma{i}ine: a hormone that regulates the rate of metabolism in resting tissue.\nDelta{i}osis: the process in which a cell absorbs fluid from its surrounding environment." for i in range(10)])
STEPS = mk([f"Procedure {i + 1}\n1. Prepare the sample and label the tube {i}.\n2. Add the buffer and mix gently for thirty seconds.\n3. Incubate the mixture at room temperature for ten minutes.\n"
            f"4. Measure the absorbance and record the value.\nThe procedure ends after step 4 because the reaction is complete." for i in range(10)])
ST = {"count": 20, "focus": "balanced", "field": "science", "difficulty": "mixed", "language": "source", "external_mode": "source_only"}


def objectives_for(pages, types=QTYPE_ORDER):
    return [{"id": f"o{i}", "statement": p["text"].split("\n")[0], "pages": [p["ref"]], "key_terms": [], "capacity": 2, "supports": {c: {"pages": [p["ref"]]} for c in types}} for i, p in enumerate(pages)]


class Model:
    """A provider that answers `analyze` (an over-claiming analysis: every type everywhere) and `profile` (as told)."""

    def __init__(self, profile=None, delay=0.0, profile_error=None):
        self.profile, self.delay, self.profile_error, self.calls = profile, delay, profile_error, {"analyze": 0, "profile": 0}

    def json_call(self, task, system, prompt, payload=None, max_tokens=0):
        if self.delay:
            time.sleep(self.delay)
        if task == "profile":
            self.calls["profile"] += 1
            if self.profile_error:
                raise self.profile_error
            return self.profile
        self.calls["analyze"] += 1
        return {"lecture_character": "x", "objectives": objectives_for(payload["pages"])}


AGENT = {"types": {"basic_recall": {"capacity": 12, "pages": ["d1p1", "d1p2", "d1p3"]}, "understanding": {"capacity": 8, "pages": ["d1p2"]}, "mechanisms": {"capacity": 3, "pages": ["d1p4"]},
                   "application": {"capacity": 0}, "critical_thinking": {"capacity": 4, "pages": ["d1p5"]}, "scenarios": {"capacity": 0}, "compare_contrast": {"capacity": 5, "pages": ["d1p6", "d1p7"]},
                   "best_answer": {"capacity": 0}, "not_except": {"capacity": 0}, "sequence": {"capacity": 0}}}


def caps(prof):
    return {c: v["capacity"] for c, v in prof["types"].items()}


def run_analyse(provider, pages, st=ST):
    return generator.analyse(provider, {"pages": pages, "excluded": []}, st)


def test_levels():
    assert [P.level_of(n) for n in (0, 1, 2, 3, 5, 6)] == ["none", "limited", "limited", "good", "good", "strong"]


def test_the_structural_reading_follows_the_wording_of_the_lecture():
    steps, defs = P.structural(STEPS, "science"), P.structural(DEFS, "science")
    assert steps["types"]["sequence"]["capacity"] >= 4 and defs["types"]["sequence"]["capacity"] == 0, "numbered procedures have a sequence; a glossary has none"
    assert defs["types"]["basic_recall"]["capacity"] >= 1 and steps["source"] == "rules"


def test_the_agents_counts_drive_the_profile_and_zeros_take_a_type_away():
    a = run_analyse(Model(AGENT), DEFS)
    words = P.words_of([p["text"] for p in DEFS])
    max_cap = -(-words // 70)
    assert a["profile"]["source"] == "agent"
    assert caps(a["profile"]) == {"basic_recall": min(12, max_cap), "understanding": min(8, max_cap), "mechanisms": 3, "application": 0, "not_except": 0, "sequence": 0,
                                  "compare_contrast": 5, "critical_thinking": 4, "best_answer": 0, "scenarios": 0}
    for c in ("application", "scenarios", "best_answer", "not_except", "sequence"):
        assert all(c not in o["supports"] for o in a["objectives"]), c + ": the agent found nothing for it, so no objective carries it any more"
    plan = planner.build_plan(a, ST, None)
    assert plan["feasible_count"] == 20 and plan["profile"]["sequence"]["capacity"] == 0
    for c in ("application", "scenarios", "best_answer", "not_except", "sequence"):
        assert plan["distribution"][c] == 0, c + " is not planned"
    for c in ("basic_recall", "understanding", "mechanisms", "critical_thinking", "compare_contrast"):
        assert plan["distribution"][c] >= 1, (c, plan["distribution"])
    assert plan["distribution"]["basic_recall"] >= plan["distribution"]["mechanisms"], "more material -> a bigger share"


def test_supports_are_added_where_the_agent_names_pages():
    sparse = {"objectives": [{"statement": "a", "pages": ["d1p2"], "supports": ["recall"]}, {"statement": "b", "pages": ["d1p3"], "supports": ["recall"]},
                             {"statement": "c", "pages": ["d1p9"], "supports": ["recall"]}]}

    class M:
        def json_call(self, task, system, prompt, payload=None, max_tokens=0):
            return {"types": {**AGENT["types"], "sequence": {"capacity": 3, "pages": ["d1p2", "d1p3"]}}} if task == "profile" else sparse

    a = run_analyse(M(), STEPS)
    assert "sequence" in a["objectives"][0]["supports"] and "sequence" in a["objectives"][1]["supports"] and "sequence" not in a["objectives"][2]["supports"]


def test_an_over_claim_is_bounded_by_what_the_text_shows_and_a_zero_does_not_erase_a_strong_signal():
    a = run_analyse(Model({"types": {**AGENT["types"], "sequence": {"capacity": 30, "pages": ["d1p1"]}}}), DEFS)
    assert a["profile"]["types"]["sequence"]["capacity"] <= 3, "no steps in the text: at most 3"
    a = run_analyse(Model({"types": {**AGENT["types"], "sequence": {"capacity": 0}}}), STEPS)
    assert a["profile"]["types"]["sequence"]["capacity"] >= 2, "ten numbered procedures: not zero"
    tiny = mk(["Alpha: a short note about cells.\nBeta: another short note about tissue and organs in the body."])
    a = run_analyse(Model({"types": {c: {"capacity": 40, "pages": ["d1p1"]} for c in QTYPE_ORDER}}), tiny)
    assert all(t["capacity"] <= 2 for t in a["profile"]["types"].values()), "a tiny lecture cannot sustain 40 of anything"


@pytest.mark.parametrize("bad", [{"profile_error": RuntimeError("HTTP 500")}, {"profile": {}}, {"profile": None}, {"profile": "not json"}, {"profile": {"types": "none"}},
                                 {"profile": {"types": {"basic_recall": 3}}}, {"profile": []}])
def test_when_the_agent_fails_or_answers_with_junk_the_structural_reading_stands(bad):
    a = run_analyse(Model(**bad), STEPS)
    assert len(a["objectives"]) >= 1 and a["profile"]["source"] == "rules"


def test_tolerant_parsing_of_the_agents_answer():
    a = run_analyse(Model({"profile": None, "types": [{"type": "Recall", "count": "7", "pages": ["p1"]}, {"name": "Critical Thinking", "capacity": 2}, {"key": "compare & contrast", "n": 3},
                                                      {"type": "Sequence Ordering", "capacity": 0}]}), DEFS)
    assert a["profile"]["types"]["basic_recall"]["capacity"] == 7 and a["profile"]["types"]["critical_thinking"]["capacity"] == 2 and a["profile"]["types"]["compare_contrast"]["capacity"] == 3


def test_the_agent_runs_beside_the_analysis_not_after_it():
    t = time.time()
    run_analyse(Model(AGENT, delay=0.25), DEFS)
    took = time.time() - t
    assert took < 0.25 * 1.8, f"one wait, not two: {took:.2f}s"


def test_a_real_failure_of_the_objective_analysis_is_not_hidden_by_the_agent():
    class M:
        def json_call(self, task, system, prompt, payload=None, max_tokens=0):
            if task == "profile":
                return AGENT
            raise generator.LLMError("HTTP 401")

    with pytest.raises(Exception):
        run_analyse(M(), DEFS)


def plan_of(types_caps, n):
    fake = {"objectives": [{"id": f"o{i + 1}", "statement": f"s{i}", "pages": ["d1p1"], "capacity": 1, "supports": {c: {"pages": ["d1p1"]} for c in ("basic_recall", "mechanisms", "sequence")}} for i in range(40)],
            "profile": {"types": {c: {"capacity": types_caps.get(c, 0), "level": "strong", "pages": ["d1p1"]} for c in QTYPE_ORDER}}}
    return planner.build_plan(fake, {**ST, "count": n}, None)


def test_weights_are_the_square_root_of_what_the_lecture_can_sustain():
    d = plan_of({"basic_recall": 36, "mechanisms": 9, "sequence": 4}, 11)["distribution"]
    assert (d["basic_recall"], d["mechanisms"], d["sequence"]) == (6, 3, 2), d
    assert plan_of({"basic_recall": 36, "mechanisms": 9, "sequence": 1}, 11)["distribution"]["sequence"] <= 1, "no type is asked for more than the lecture can sustain"


def test_an_analysis_made_before_profiles_existed_still_plans():
    fake = {"objectives": objectives_for(DEFS, ("basic_recall", "mechanisms", "sequence"))}
    plan = planner.build_plan(fake, {**ST, "count": 10}, None)
    assert plan["feasible_count"] == 10 and plan["profile"] is None


def test_different_lectures_get_different_distributions():
    ad, as_ = run_analyse(Model(None), DEFS), run_analyse(Model(None), STEPS)       # no agent answer: the structural reading alone
    pd, ps = planner.build_plan(ad, ST, None), planner.build_plan(as_, ST, None)
    assert pd["distribution"] != ps["distribution"]
    assert ps["distribution"]["sequence"] >= pd["distribution"]["sequence"]
