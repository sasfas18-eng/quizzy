"""The server writes quizzes with the owner's engine (quiz_engine.py) over the owner's reading rules (lecture_reader.py): it must
refuse to deliver defective questions and must say so."""
from app.config import settings
from app.services import generator
from app.services.fake_llm import FakeProvider
from tests.conftest import run_quiz, upload, wait_for


class Sabotage(FakeProvider):
    """The test model, with one specific defect planted in the engine's draft."""
    def __init__(self, mode):
        super().__init__()
        self.mode = mode

    def _qe_generate(self, p):
        out = super()._qe_generate(p)
        for q in out.get("questions", []):
            if self.mode == "fake_quote":
                q["evidence"] = [{"slide_id": q["evidence"][0]["slide_id"], "quote": "This sentence never appears anywhere in the uploaded lecture file."}]
            elif self.mode == "wrong_key":
                q["correct_option_id"] = "opt2"           # the key now points at a distractor
            elif self.mode == "objective_quote":
                q["evidence"] = [{"slide_id": q["evidence"][0]["slide_id"], "quote": "Cardiac Physiology"}]   # a heading: context, never evidence
        return out

    def _qe_review(self, p):
        r = super()._qe_review(p)
        if self.mode == "ambiguous":
            r = {**r, "approved": False, "issues": [{"question_id": r["checked_question_ids"][0], "reason": "Two options are defensible."}]}
        return r


def test_fabricated_evidence_is_never_delivered(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("fake_quote"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["status"] == "insufficient"
    assert alice.get(f"/api/quizzes/{quiz['id']}/questions").json() == []
    assert quiz["report"]["delivered"] == 0 and any("approved" in e or "quotation" in e for e in quiz["report"]["stats"]["engine_errors"])


def test_heading_quotes_are_not_evidence(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("objective_quote"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["report"]["delivered"] == 0
    assert any("excluded/context-only/unapproved" in e for e in quiz["report"]["stats"]["engine_errors"])


def test_wrong_key_caught_by_the_review(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("wrong_key"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["report"]["delivered"] == 0
    assert any("Reviewer rejected draft" in e and "not what the quoted source says" in e for e in quiz["report"]["stats"]["engine_errors"])


def test_an_ambiguity_flag_from_the_review_blocks_delivery(alice, sample_pdf, monkeypatch):
    monkeypatch.setattr(generator, "get_provider", lambda: Sabotage("ambiguous"))
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    assert quiz["report"]["delivered"] == 0 and quiz["status"] == "insufficient" and quiz["error"]


def test_requested_count_is_planned_without_a_consent_step_and_never_padded(alice, sample_pdf):
    """Asking for 30 is planned as 30; the engine says how many the approved text carries, and that many are written - no filler."""
    doc = upload(alice, sample_pdf)
    r = alice.post("/api/quizzes", json={"sources": [{"document_id": doc["id"], "pages": "1"}], "settings": {"count": 30, "language": "en"}})
    qid = r.json()["id"]
    alice.post(f"/api/quizzes/{qid}/analyze")
    q = wait_for(lambda: (lambda x: x if x["status"] not in ("analyzing", "draft") else None)(alice.get(f"/api/quizzes/{qid}").json()))
    assert q["plan"]["feasible_count"] == 30 and q["plan"]["shortfall"] is None
    assert alice.post(f"/api/quizzes/{qid}/generate", json={}).status_code == 200, "no consent flag needed"
    quiz = wait_for(lambda: (lambda x: x if x["status"] not in ("planned", "generating") else None)(alice.get(f"/api/quizzes/{qid}").json()))
    rep = quiz["report"]
    assert quiz["status"] == "ready" and 1 <= rep["delivered"] < 30 and rep["shortfall"]["requested"] == 30
    assert rep["stats"]["counts_tried"][0] == 30 and rep["stats"]["counts_tried"][-1] == rep["delivered"]


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


def test_page_scope_and_the_reading_audit(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "2", count=5)
    qs = alice.get(f"/api/quizzes/{quiz['id']}/questions").json()
    assert qs and all(q["source_pages"] == [2] for q in qs)
    reading = quiz["report"]["reading"]
    assert reading["engine"] == "owner-1" and reading["counts_are_not_scientific_coverage"] is True and reading["counts"]["include"] >= 1
    for q in qs:      # every quote sits in a unit the reader approved, and the engine's category is kept
        assert q["validation"]["unit_evidence"] and q["validation"]["category"] in generator.owner_engine.CATEGORY_TO_QTYPE
