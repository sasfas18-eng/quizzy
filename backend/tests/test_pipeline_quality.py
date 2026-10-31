"""The pipeline must refuse to deliver defective questions and must say so."""
import copy

from app.config import settings
from app.services import generator
from app.services.fake_llm import FakeProvider
from tests.conftest import run_quiz, upload


class Sabotage(FakeProvider):
    """Wraps the test generator and injects specific defects, keyed by call count."""
    def __init__(self, mode):
        super().__init__()
        self.mode = mode

    def _generate(self, p):
        out = super()._generate(p)
        for q in out["questions"]:
            if q.get("unwritable_reason"):
                continue
            if self.mode == "fake_quote":
                q["evidence"] = [{"page": q["evidence"][0]["page"], "quote": "This sentence never appears anywhere in the uploaded lecture file."}]
            elif self.mode == "wrong_key":
                q["correct_index"] = (q["correct_index"] + 1) % 4   # key now points at a distractor
            elif self.mode == "ambiguous":
                pass
        return out

    def _verify(self, p):
        r = super()._verify(p)
        if self.mode == "ambiguous":
            r["single_best_answer"] = False
        return r


def test_fabricated_evidence_is_never_delivered(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("fake_quote"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["status"] == "insufficient"
    assert alice.get(f"/api/quizzes/{quiz['id']}/questions").json() == []
    assert quiz["report"]["dropped"] and quiz["report"]["delivered"] == 0
    assert quiz["report"]["stats"]["rejected_validation"] > 0


def test_wrong_key_caught_by_blind_solver(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("wrong_key"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["report"]["delivered"] == 0
    assert quiz["report"]["stats"]["rejected_verifier"] > 0
    assert any("المحلل المستقل" in r for d in quiz["report"]["dropped"] for r in d["reasons"])


def test_ambiguity_flag_from_verifier_blocks_delivery(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("ambiguous"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["report"]["delivered"] == 0


def test_requested_count_is_planned_without_a_consent_step(alice, sample_pdf):
    """Asking for 30 is planned as 30 (reinforcement slots on the same material); there is no 'only N possible, do you accept?' step any more."""
    doc = upload(alice, sample_pdf)
    r = alice.post("/api/quizzes", json={"sources": [{"document_id": doc["id"], "pages": "1"}], "settings": {"count": 30, "language": "en"}})
    qid = r.json()["id"]
    alice.post(f"/api/quizzes/{qid}/analyze")
    from tests.conftest import wait_for
    q = wait_for(lambda: (lambda x: x if x["status"] not in ("analyzing", "draft") else None)(alice.get(f"/api/quizzes/{qid}").json()))
    plan = q["plan"]
    assert plan["feasible_count"] == 30 and plan["shortfall"] is None and plan["extra_count"] > 0
    r = alice.post(f"/api/quizzes/{qid}/generate", json={})
    assert r.status_code == 200, "no consent flag needed: the count asked for is the count planned"
    quiz = wait_for(lambda: (lambda x: x if x["status"] not in ("planned", "generating") else None)(alice.get(f"/api/quizzes/{qid}").json()))
    rep = quiz["report"]
    assert 4 <= rep["delivered"] <= 30     # one short page: the test generator can only vary so much; the count logic itself is in test_count_guarantee.py
    assert (rep["delivered"] < 30) == bool(rep["shortfall"]), "a shortfall is reported only when the text really cannot give more"
    assert plan["unsupported_types"], "types the source cannot support must be listed"


def test_no_questions_without_llm_key(env, monkeypatch):
    from tests.conftest import make_client
    settings.allow_fake_llm = False
    settings.anthropic_key = ""
    c = make_client(env)
    c.post("/api/auth/register", json={"email": "x@example.com", "name": "X", "password": "password-123"})
    import tempfile, pathlib
    from tests import fixtures
    p = fixtures.make_pdf(pathlib.Path(tempfile.mkdtemp()) / "a.pdf")
    doc = upload(c, p)                       # upload/extraction work without AI
    assert doc["status"] == "ready"
    r = c.post("/api/quizzes", json={"sources": [{"document_id": doc["id"], "pages": "1-3"}], "settings": {"field": "health"}})
    assert r.status_code == 200
    r2 = c.post(f"/api/quizzes/{r.json()['id']}/analyze")
    assert r2.status_code == 503 and r2.json()["code"] == "llm_not_configured"
    assert c.post(f"/api/documents/{doc['id']}/cards/generate", json={"pages": "1-3"}).status_code == 503
    assert c.get("/api/auth/capabilities").json()["llm"] is False
    # the heuristic source preview still works without AI
    assert r.json()["source_preview"]["type_support"]["sequence"]["level"] in ("strong", "limited")


def test_identity_report_and_page_scope(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "2", count=10)        # only the ordered-steps page
    qs = alice.get(f"/api/quizzes/{quiz['id']}/questions").json()
    assert qs and all(q["source_pages"] == [2] for q in qs)
    assert "sequence" in {q["qtype"] for q in qs}
    seq = next(q for q in qs if q["qtype"] == "sequence")
    assert "→" in seq["options"][0]["text"]
    # types needing other material are explained as unsupported, not fabricated
    unsup = {u["qtype"] for u in quiz["report"]["unsupported_types"]}
    assert "scenarios" in unsup or "compare_contrast" in unsup
    assert quiz["report"]["identity_coverage"]["denominator"] >= 1
