"""One-step flow used by the website: create -> analyze(auto_generate) -> ready, with no "confirm the plan" step.
Reading = the owner's lecture_reader.py, writing = the owner's quiz_engine.py (its categories stay an internal matter)."""
from tests.conftest import upload, wait_for


def _create(alice, doc_id, pages, **st):
    r = alice.post("/api/quizzes", json={"sources": [{"document_id": doc_id, "pages": pages}], "settings": {"count": 10, "language": "en", **st}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _done(alice, qid):
    return wait_for(lambda: (lambda q: q if q["status"] not in ("draft", "analyzing", "planned", "generating") else None)(alice.get(f"/api/quizzes/{qid}").json()))


def test_auto_generate_runs_analysis_and_generation_in_one_job(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    qid = _create(alice, doc["id"], "1-3")
    assert alice.post(f"/api/quizzes/{qid}/analyze", json={"auto_generate": True}).status_code == 200
    seen = set()

    def poll():
        q = alice.get(f"/api/quizzes/{qid}").json()
        seen.add(q["status"])
        return q if q["status"] not in ("draft", "analyzing", "planned", "generating") else None

    quiz = wait_for(poll)
    assert quiz["status"] == "ready", quiz
    assert "planned" not in seen, "a chained job must never expose the intermediate 'planned' state to the UI"
    assert quiz["report"]["delivered"] >= 1
    qs = alice.get(f"/api/quizzes/{qid}/questions").json()
    assert len(qs) == quiz["report"]["delivered"]
    # written by the owner's engine over the owner's reading rules: each question keeps the engine's category and the approved unit it quotes
    assert all(x["validation"]["engine"] == "owner-2" and x["validation"]["unit_evidence"] for x in qs)
    assert quiz["report"]["reading"]["counts"]["include"] >= 1


def test_auto_generate_accepts_a_smaller_count_and_reports_the_shortfall(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    qid = _create(alice, doc["id"], "1", count=30)         # one page cannot support 30 distinct questions
    assert alice.post(f"/api/quizzes/{qid}/analyze", json={"auto_generate": True}).status_code == 200
    quiz = _done(alice, qid)
    assert quiz["status"] == "ready", quiz
    rep = quiz["report"]
    assert rep["delivered"] < 30 and rep["requested"] == 30 and rep["shortfall"], "no padding: the shortfall is reported, not hidden"


def test_plain_analyze_still_stops_at_the_plan(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    qid = _create(alice, doc["id"], "1-3")
    assert alice.post(f"/api/quizzes/{qid}/analyze").status_code == 200       # no body at all (API users)
    q = wait_for(lambda: (lambda x: x if x["status"] not in ("draft", "analyzing") else None)(alice.get(f"/api/quizzes/{qid}").json()))
    assert q["status"] == "planned" and q["plan"]["feasible_count"] >= 1


def test_ready_quiz_cannot_be_reanalysed(alice, sample_pdf):
    """Re-planning a finished quiz would let a later generate replace the questions that attempts point to."""
    doc = upload(alice, sample_pdf)
    qid = _create(alice, doc["id"], "1-3")
    alice.post(f"/api/quizzes/{qid}/analyze", json={"auto_generate": True})
    assert _done(alice, qid)["status"] == "ready"
    r = alice.post(f"/api/quizzes/{qid}/analyze", json={"auto_generate": True})
    assert r.status_code == 409 and r.json()["code"] == "already_ready"
