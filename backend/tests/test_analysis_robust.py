"""Small/free models drift from the exact analysis format. The pipeline must still produce a plan (and never end with
"تعذر استخراج أهداف" while the source has real text)."""
import pytest

from app.services import generator
from app.services.fake_llm import FakeProvider
from tests.conftest import run_quiz, upload

PAGES = [{"ref": f"d1p{n}", "doc_id": "d", "doc_title": "t", "page_no": n,
          "text": f"Topic {n} heading\nThe {w} performs an important function inside the cell during stage {n}. Another sentence gives more detail about it."}
         for n, w in enumerate(["mitochondria", "ribosome", "nucleus", "lysosome"], start=1)]
MULTI = [{"ref": "d1p1", "text": "a"}, {"ref": "d2p1", "text": "b"}, {"ref": "d2p2", "text": "c"}]


def test_refs_and_types_are_normalised():
    nr = generator.norm_refs
    assert nr(["p3", "Page 2", 4, "D1P1", "slide 9", "d1p7", "1-2"], PAGES) == ["d1p3", "d1p2", "d1p4", "d1p1"]
    assert nr(None, PAGES) == [] and nr("d1p2", PAGES) == ["d1p2"]
    assert nr(["p1"], MULTI) == ["d1p1", "d2p1"] and nr(["d2p2"], MULTI) == ["d2p2"]
    nt = generator.norm_type
    assert (nt("Recall"), nt("Critical Thinking"), nt("compare & contrast"), nt("NOT/EXCEPT"), nt("Most Correct / Best Answer"), nt("Clinical Scenarios"), nt("sequence")) == \
        ("basic_recall", "critical_thinking", "compare_contrast", "not_except", "best_answer", "scenarios", "sequence")
    assert nt("banana") is None


class Fixed:
    name = "fixed"

    def __init__(self, resp):
        self.resp = resp

    def json_call(self, *a, **k):
        return self.resp


@pytest.mark.parametrize("resp", [
    {"objectives": [{"statement": "Organelles", "pages": ["p1", "Page 2"], "supports": ["Recall", "Understanding", "Critical Thinking"]}]},
    [{"title": "Ribosomes", "page": "d1p2", "supports": [{"type": "application", "pages": ["p2"]}, {"type": "nonsense"}]}],
    {"objectives": [{"statement": "Nucleus", "pages": [3]}]},
])
def test_sloppy_but_usable_output_is_understood(resp):
    a = generator.analyse(Fixed(resp), {"pages": PAGES}, {"field": "science"})
    assert len(a["objectives"]) == 1 and not a["fallback"]
    ob = a["objectives"][0]
    assert all(r in {p["ref"] for p in PAGES} for r in ob["pages"]) and ob["supports"] and all(t in generator.QTYPES for t in ob["supports"])


@pytest.mark.parametrize("junk", [{}, {"objectives": []}, {"objectives": [{"statement": "x", "pages": ["z99"]}]}, [], {"objectives": "none"}, {"objectives": [None, 5]}])
def test_unusable_output_falls_back_to_per_page_objectives(junk):
    a = generator.analyse(Fixed(junk), {"pages": PAGES}, {"field": "science"})
    assert a["fallback"] is True and len(a["objectives"]) == 4 and "تلقائيًا" in a["lecture_character"]
    assert all(o["supports"]["basic_recall"] and o["capacity"] >= 1 for o in a["objectives"])
    from app.services.planner import build_plan
    from app.services.support import analyze_support
    plan = build_plan(a, {"count": 10, "focus": "balanced", "field": "science"}, analyze_support([p["text"] for p in PAGES], "science"))
    assert plan["feasible_count"] >= 4


def test_pages_without_text_still_report_a_specific_reason():
    a = generator.analyse(Fixed({}), {"pages": [{"ref": "d1p1", "text": "x"}]}, {"field": "other"})
    assert a["objectives"] == []


class SloppyReader(FakeProvider):
    """A model that answers the reading review badly (it leaves fragments out): the reader refuses the whole answer, so every uncertain
    fragment stays out of evidence - and the quiz is still written from what the rules approved by themselves."""
    def _reading_review(self, p):
        r = super()._reading_review(p)
        return {"decisions": r["decisions"][:1]}


class FirstDraftBroken(FakeProvider):
    """A model whose first draft is not even JSON-shaped: the engine feeds the error back and the next draft is used."""
    def __init__(self):
        super().__init__()
        self.n = 0

    def _qe_generate(self, p):
        self.n += 1
        return {"note": "here are some questions"} if self.n == 1 else super()._qe_generate(p)


@pytest.mark.parametrize("prov", [SloppyReader, FirstDraftBroken])
def test_whole_journey_survives_a_sloppy_model(alice, sample_pdf, monkeypatch, prov):
    monkeypatch.setattr(generator, "get_provider", lambda: prov())
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3", count=5)
    assert quiz["status"] == "ready" and quiz["report"]["delivered"] >= 1, quiz.get("error")
    reading = quiz["report"]["reading"]
    if prov is SloppyReader:
        assert reading["model_error"] and reading["model_resolved"] == 0 and reading["kept_out_unresolved"] >= 1
    else:
        assert reading["model_error"] is None and quiz["report"]["stats"]["engine_errors"] == []
