"""End-to-end student journey on the test provider + isolation between two accounts."""
import io
import re

import pypdfium2 as pdfium
import pytest
from pypdf import PdfReader

from tests.conftest import run_quiz, upload, wait_for


def test_full_journey(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    assert doc["status"] == "ready" and doc["page_count"] == 4
    assert doc["quality"]["image_only"] == [4]        # unreadable page is surfaced, not hidden

    # whole-range quiz: page 4 must be reported as excluded
    r = alice.post("/api/quizzes", json={"sources": [{"document_id": doc["id"], "pages": ""}], "settings": {"count": 10, "language": "en"}})
    assert r.status_code == 200
    ex = r.json()["source_preview"]["excluded_pages"]
    assert [e["page"] for e in ex] == [4] and ex[0]["status"] == "image_only"
    alice.delete(f"/api/quizzes/{r.json()['id']}")

    quiz = run_quiz(alice, doc["id"], "1-3", count=10)
    assert quiz["status"] == "ready", quiz
    rep = quiz["report"]
    assert rep["generator"] == "test-generator"
    assert rep["delivered"] == len(alice.get(f"/api/quizzes/{quiz['id']}/questions").json()) > 0
    assert rep["delivered"] <= rep["requested"]
    assert rep["objective_coverage"]["denominator"] >= 1

    qs = alice.get(f"/api/quizzes/{quiz['id']}/questions").json()
    for q in qs:
        assert len(q["options"]) == 4 and len({o["id"] for o in q["options"]}) == 4
        assert q["correct_option_id"] in {o["id"] for o in q["options"]}
        assert q["evidence"] and all(e["quote"] for e in q["evidence"]) and q["source_pages"]
        assert q["review_status"] in ("machine_verified", "flagged")      # never claims human review
        assert set(q["validation"]) >= {"issues", "verified"}
    # sources stay within the chosen scope
    assert all(set(q["source_pages"]) <= {1, 2, 3} for q in qs)
    # correct answers are spread over positions (no always-same-slot bias)
    pos = {[o["id"] for o in q["options"]].index(q["correct_option_id"]) for q in qs}
    assert len(pos) >= 2 if len(qs) >= 4 else True

    # ---- attempt in practice mode: key hidden before answering, shown after
    a = alice.post(f"/api/quizzes/{quiz['id']}/attempts", json={"mode": "practice", "shuffle_options": True}).json()
    assert a["questions"] and "correct_option_id" not in a["questions"][0] and "explanation" not in a["questions"][0]
    q0 = a["questions"][0]
    key = next(q for q in qs if q["id"] == q0["id"])["correct_option_id"]
    wrong = next(o["id"] for o in q0["options"] if o["id"] != key)
    r = alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q0["id"], "option_id": wrong}).json()
    assert r["saved"] and r["is_correct"] is False and r["correct_option_id"] == key and r["explanation"]
    # locked after reveal
    assert alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q0["id"], "option_id": key}).status_code == 409
    if len(a["questions"]) > 1:
        q1 = a["questions"][1]
        key1 = next(q for q in qs if q["id"] == q1["id"])["correct_option_id"]
        assert alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q1["id"], "option_id": key1}).json()["is_correct"] is True
        alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q1["id"], "flagged": True})
    alice.put(f"/api/attempts/{a['id']}/position", json={"index": 1, "elapsed_seconds": 42})

    # ---- resume "from another device" = fresh client logged in with same credentials
    from tests.conftest import make_client
    other_device = make_client(alice.app)
    assert other_device.post("/api/auth/login", json={"email": "alice@example.com", "password": "correct-horse-1"}).status_code == 200
    resumed = other_device.get(f"/api/attempts/{a['id']}").json()
    assert resumed["status"] == "in_progress" and resumed["current_index"] == min(1, len(qs) - 1) and resumed["elapsed_seconds"] == 42
    assert resumed["questions"][0]["selected_option_id"] == wrong
    assert resumed["answered"] >= 1

    done = other_device.post(f"/api/attempts/{a['id']}/submit").json()
    assert done["status"] == "submitted" and done["max_score"] == len(qs)
    expected = 1 if len(qs) > 1 else 0
    assert done["score"] == expected
    assert all("correct_option_id" in q for q in done["questions"])
    assert other_device.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q0["id"], "option_id": key}).status_code == 409
    hist = alice.get("/api/attempts", params={"quiz_id": quiz["id"]}).json()
    assert hist[0]["status"] == "submitted" and hist[0]["score"] == expected

    # ---- PDF: real file, key letter == position of key option in THIS pdf's order
    resp = alice.get(f"/api/quizzes/{quiz['id']}/pdf", params={"answer_key": "true"})
    assert resp.status_code == 200 and resp.headers["content-type"] == "application/pdf" and resp.content[:4] == b"%PDF"
    reader = PdfReader(io.BytesIO(resp.content))
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert "Answer Key" in text and "Quizzy" in text
    # same bank: every stem appears (first 30 chars) in the PDF
    flat = re.sub(r"\s+", " ", text)
    assert all(re.sub(r"\s+", " ", q["stem"])[:25] in flat for q in qs if "\n" not in q["stem"][:25])
    no_key = alice.get(f"/api/quizzes/{quiz['id']}/pdf", params={"answer_key": "false"})
    assert "Answer Key" not in "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(no_key.content)).pages)


def test_pdf_key_matches_displayed_order(alice, sample_pdf, env):
    from app.services.quiz_pdf import build_pdf, display_order
    opts = [{"id": f"x{i}", "text": f"Option {i}"} for i in range(4)]
    qs = [{"id": f"q{i}", "qtype": "understanding", "stem": f"Question number {i} stem text here?", "options": opts,
           "correct_option_id": "x2", "explanation": "Because the lecture says so.", "source_pages": [i]} for i in range(6)]
    data, key = build_pdf({"id": "z", "title": "t", "generator": None}, qs, {"shuffle_options": True, "pdf_include_key": True}, "")
    for q in qs:
        order = display_order(q, True, "z:pdf")
        assert "ABCD"[[o["id"] for o in order].index("x2")] == key[q["id"]]
    assert len(PdfReader(io.BytesIO(data)).pages) >= 1


def test_isolation_between_accounts(alice, bob, sample_pdf):
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    qid = quiz["id"]
    qs = alice.get(f"/api/quizzes/{qid}/questions").json()
    a = alice.post(f"/api/quizzes/{qid}/attempts", json={}).json()
    cards = alice.post(f"/api/documents/{doc['id']}/cards/generate", json={"pages": "1-3", "count": 6}).json()
    assert cards["created"] >= 1
    card_id = alice.get("/api/cards").json()[0]["id"]

    probes = [
        ("get", f"/api/documents/{doc['id']}"), ("get", f"/api/documents/{doc['id']}/pages/1"), ("delete", f"/api/documents/{doc['id']}"),
        ("get", f"/api/quizzes/{qid}"), ("get", f"/api/quizzes/{qid}/questions"), ("get", f"/api/quizzes/{qid}/pdf"),
        ("post", f"/api/quizzes/{qid}/attempts"), ("get", f"/api/attempts/{a['id']}"), ("post", f"/api/attempts/{a['id']}/submit"),
        ("delete", f"/api/attempts/{a['id']}"), ("delete", f"/api/cards/{card_id}"),
    ]
    for method, url in probes:
        r = getattr(bob, method)(url)
        assert r.status_code == 404, (method, url, r.status_code)
    assert bob.put(f"/api/cards/{card_id}/state", json={"state": "known"}).status_code == 404
    assert bob.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qs[0]["id"], "option_id": "x"}).status_code == 404
    assert bob.post("/api/reports", json={"target_type": "question", "target_id": qs[0]["id"], "kind": "unclear"}).status_code == 404
    assert bob.post("/api/reports", json={"target_type": "flashcard", "target_id": card_id, "kind": "bad_card"}).status_code == 404
    assert bob.get("/api/documents").json() == [] and bob.get("/api/quizzes").json() == []
    assert bob.get("/api/attempts").json() == [] and bob.get("/api/cards").json() == []
    # bob can't build a quiz from alice's file
    r = bob.post("/api/quizzes", json={"sources": [{"document_id": doc["id"]}], "settings": {}})
    assert r.status_code == 404
    # nor read admin pages
    assert bob.get("/api/admin/metrics").status_code == 403
    # alice's data is intact
    assert alice.get(f"/api/quizzes/{qid}").status_code == 200


def test_unauthenticated_access(client):
    for url in ["/api/documents", "/api/quizzes", "/api/attempts", "/api/cards", "/api/auth/me", "/api/admin/metrics"]:
        assert client.get(url).status_code == 401
    assert client.get("/api/health").json()["ok"] is True


def test_cards_state_persists_and_review_filter(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    alice.post(f"/api/documents/{doc['id']}/cards/generate", json={"pages": "1-3", "count": 6})
    cards = alice.get("/api/cards", params={"document_id": doc["id"]}).json()
    assert cards and all(c["state"] == "new" and c["source_page"] in (1, 2, 3) and c["evidence"] for c in cards)
    assert alice.put(f"/api/cards/{cards[0]['id']}/state", json={"state": "review"}).json()["saved"]
    if len(cards) > 1:
        alice.put(f"/api/cards/{cards[1]['id']}/state", json={"state": "known"})
    assert [c["id"] for c in alice.get("/api/cards", params={"state": "review"}).json()] == [cards[0]["id"]]
    stats = alice.get("/api/cards/stats").json()[0]
    assert stats["review"] == 1 and stats["total"] == len(cards)
    # regenerating does not duplicate existing cards
    again = alice.post(f"/api/documents/{doc['id']}/cards/generate", json={"pages": "1-3", "count": 6}).json()
    assert again["rejected"]["duplicate"] >= 1 or again["created"] == 0


def test_field_is_auto_detected_not_asked(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    r = alice.post("/api/quizzes", json={"sources": [{"document_id": doc["id"], "pages": "1-3"}], "settings": {"field": "law"}})
    assert r.status_code == 200
    from app.db import connect, jload
    st = jload(connect().execute("SELECT settings_json FROM quizzes WHERE id=?", (r.json()["id"],)).fetchone()[0])
    assert st["field"] == "health"                       # inferred from the cardiac slides; client value ignored
    assert "fields" not in alice.get("/api/auth/capabilities").json()
    assert "field" not in alice.get("/api/auth/me").json()


def test_spaced_repetition_and_static_perf(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    alice.post(f"/api/documents/{doc['id']}/cards/generate", json={"pages": "1-3", "count": 6})
    cards = alice.get("/api/cards").json()
    assert len(alice.get("/api/cards", params={"due": "true"}).json()) == len(cards)   # new cards are due
    r = alice.put(f"/api/cards/{cards[0]['id']}/state", json={"state": "known"}).json()
    assert r["interval_days"] == 1.0 and r["due_at"] > 0
    r2 = alice.put(f"/api/cards/{cards[0]['id']}/state", json={"state": "known"}).json()
    assert r2["interval_days"] == 2.2
    assert cards[0]["id"] not in [c["id"] for c in alice.get("/api/cards", params={"due": "true"}).json()]
    alice.put(f"/api/cards/{cards[1]['id']}/state", json={"state": "review"})
    assert alice.get("/api/cards/stats").json()[0]["due"] == len(cards) - 2   # known (1d) and review (10min) are not due yet
    # gzip + cache policy
    big = alice.get("/api/documents/" + doc["id"], headers={"Accept-Encoding": "gzip"})
    assert big.headers.get("content-encoding") == "gzip"
    js = alice.get("/static/js/main.js")
    assert js.headers["cache-control"] == "no-cache" and js.headers.get("etag")
    assert "immutable" in alice.get("/static/fonts/inter-latin-400-normal.woff2").headers["cache-control"]


def test_trial_flag_is_exposed(client):
    from app.config import settings
    assert client.get("/api/auth/capabilities").json()["trial"] is False
    settings.trial = True
    try:
        assert client.get("/api/auth/capabilities").json()["trial"] is True
    finally:
        settings.trial = False
