"""The two modules supplied by the site owner, added to the server as written (backend/lecture_reader.py, backend/quiz_engine.py):
they import from the server's working directory (as `python run.py` and the Docker image run them), their offline demonstrations
work, and their guards hold - the reading rules sort a lecture into what may be asked / context / excluded / to review, and no
question can cite an objective or a presenter line; the quiz engine refuses a draft that does not match its source."""
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))      # backend/, where both modules live
import lecture_reader as LR  # noqa: E402
import quiz_engine as QE  # noqa: E402


def test_reading_rules_demo_sorts_every_fragment():
    r = LR.demo()
    got = {u.text.strip(): (u.decision, u.category) for u in r.units}
    assert got["Prepared by Dr. Ahmed"] == ("exclude", "presenter")
    assert got["College of Nursing"] == ("exclude", "institution")
    assert got["Learning Outcomes"] == ("context", "objectives_heading")
    assert got["• Describe urine formation."] == ("exclude", "learning_objective")
    assert got["Each kidney contains approximately 1 million nephrons."] == ("include", "educational_claim")
    # a scientist's name and a date inside a taught fact stay assessable
    assert got["Dr. Loretta Ford developed the first nurse practitioner program in 1965."] == ("include", "educational_claim")
    assert r.as_dict()["counts"] == {"context": 4, "exclude": 4, "include": 4}


def test_evidence_must_come_from_an_allowed_unit():
    r = LR.demo()
    fact = next(u for u in r.units if u.text.startswith("Each kidney"))
    objective = next(u for u in r.units if u.category == "learning_objective")
    r.validate_question_evidence([{"document_id": r.document_id, "unit_id": fact.unit_id, "quote": "approximately 1 million nephrons"}])
    with pytest.raises(ValueError):
        r.validate_question_evidence([{"document_id": r.document_id, "unit_id": objective.unit_id, "quote": objective.text.strip()}])
    with pytest.raises(ValueError):
        r.validate_question_evidence([{"document_id": r.document_id, "unit_id": fact.unit_id, "quote": "2 million nephrons"}])
    with pytest.raises(ValueError):
        r.validate_question_evidence([{"document_id": r.document_id, "unit_id": fact.unit_id, "quote": "approximately 1 million nephrons"}], "Who prepared this lecture?")
    payload = r.generator_payload()
    assert {u["unit_id"] for u in payload["allowed_units"]} == {u.unit_id for u in r.units if u.decision == "include"}
    # the reader hands its approved text to the quiz engine (the import it makes works from the server's directory)
    slides = r.to_quiz_engine_slides()
    assert [s.slide_id for s in slides] == [2, 3, 4] and all(isinstance(s, QE.Slide) for s in slides)


def test_unresolved_reading_blocks_generation():
    r = LR.read_pages([LR.Page(1, (LR.Block("Renal pelvis: collects urine from the calyces"),))], "doc-x")
    assert any(u.decision == "review" for u in r.units)
    with pytest.raises(ValueError):
        r.generator_payload()


def test_quiz_engine_demo_and_its_checks():
    quiz = QE.run_demo()
    assert len(quiz["questions"]) == 3 and len(quiz["answer_key"]) == 3
    for q, k in zip(quiz["questions"], quiz["answer_key"]):
        assert set(q["options"]) == set("ABCD") and k["answer"] in "ABCD"
    slides, draft = QE.demo_fixture()
    QE.validate_draft(draft, slides, 3)
    bad = copy.deepcopy(draft); bad["questions"][0]["evidence"][0]["quote"] = "The ureter is the functional unit."
    with pytest.raises(ValueError):
        QE.validate_draft(bad, slides, 3)
    with pytest.raises(ValueError):      # no padding: the exact count or nothing
        QE.validate_draft(draft, slides, 4)
