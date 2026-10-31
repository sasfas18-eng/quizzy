import time

from app.db import connect
from tests.conftest import make_client, run_quiz, upload


def test_auth_basics(env):
    c = make_client(env)
    assert c.post("/api/auth/register", json={"email": "bad", "name": "x", "password": "password-1"}).status_code == 422
    assert c.post("/api/auth/register", json={"email": "a@b.co", "name": "x", "password": "short"}).status_code == 422
    assert c.post("/api/auth/register", json={"email": "a@b.co", "name": "x", "password": "password-1"}).status_code == 200
    assert c.get("/api/auth/me").json()["email"] == "a@b.co"
    c2 = make_client(env)
    assert c2.post("/api/auth/register", json={"email": "A@B.co", "name": "y", "password": "password-1"}).status_code == 409
    assert c2.post("/api/auth/login", json={"email": "a@b.co", "password": "wrong-password"}).status_code == 401
    assert c.post("/api/auth/logout").status_code == 200
    assert c.get("/api/auth/me").status_code == 401
    # password is never stored in clear
    conn = connect()
    h = conn.execute("SELECT pw_hash FROM users").fetchone()[0]
    assert h.startswith("scrypt$") and "password-1" not in h
    # session tokens are stored hashed
    assert conn.execute("SELECT COUNT(*) FROM sessions WHERE token_hash LIKE '%-%' OR length(token_hash)!=64").fetchone()[0] == 0


def test_login_rate_limit(env):
    c = make_client(env)
    c.post("/api/auth/register", json={"email": "r@b.co", "name": "x", "password": "password-1"})
    codes = [c.post("/api/auth/login", json={"email": "r@b.co", "password": "nope-nope-1"}).status_code for _ in range(10)]
    assert 429 in codes


def test_password_reset_flow(env, caplog):
    import logging
    c = make_client(env)
    c.post("/api/auth/register", json={"email": "p@b.co", "name": "x", "password": "password-1"})
    with caplog.at_level(logging.WARNING, logger="quizzy.mail"):
        assert c.post("/api/auth/forgot", json={"email": "p@b.co"}).status_code == 200
        assert c.post("/api/auth/forgot", json={"email": "ghost@b.co"}).status_code == 200   # no account enumeration
    link = next(r.message for r in caplog.records if "p@b.co" in r.message)
    token = link.split("token=")[1]
    assert c.post("/api/auth/reset", json={"token": "bogus", "password": "password-2"}).status_code == 400
    assert c.post("/api/auth/reset", json={"token": token, "password": "password-2"}).status_code == 200
    assert c.post("/api/auth/reset", json={"token": token, "password": "password-3"}).status_code == 400   # single use
    assert c.get("/api/auth/me").status_code == 401                                                      # old sessions revoked
    assert make_client(env).post("/api/auth/login", json={"email": "p@b.co", "password": "password-2"}).status_code == 200


def test_reset_reports_unavailable_without_smtp(env):
    from app.config import settings
    settings.dev_log_reset_links = False
    settings.smtp_host = ""
    c = make_client(env)
    r = c.post("/api/auth/forgot", json={"email": "p@b.co"})
    assert r.status_code == 503 and r.json()["code"] == "reset_unavailable"
    settings.dev_log_reset_links = True


def test_upload_validation(alice, tmp_path):
    bad = tmp_path / "x.pdf"
    bad.write_bytes(b"not a pdf at all")
    with open(bad, "rb") as f:
        assert alice.post("/api/documents", files={"file": ("x.pdf", f)}).status_code == 415
    txt = tmp_path / "x.txt"
    txt.write_text("hi")
    with open(txt, "rb") as f:
        assert alice.post("/api/documents", files={"file": ("x.txt", f)}).status_code == 415


def test_exam_timer_enforced_server_side(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    a = alice.post(f"/api/quizzes/{quiz['id']}/attempts", json={"mode": "exam", "timer_minutes": 1}).json()
    q0 = a["questions"][0]
    r = alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q0["id"], "option_id": q0["options"][0]["id"]}).json()
    assert r["saved"] and "correct_option_id" not in r and "explanation" not in r      # exam: nothing revealed
    assert "correct_option_id" not in alice.get(f"/api/attempts/{a['id']}").json()["questions"][0]
    conn = connect()
    conn.execute("UPDATE attempts SET started_at=? WHERE id=?", (time.time() - 3600, a["id"]))
    r = alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": q0["id"], "option_id": q0["options"][1]["id"]})
    assert r.status_code == 409 and r.json()["code"] == "time_up"
    st = alice.get(f"/api/attempts/{a['id']}").json()
    assert st["status"] == "submitted" and st["score"] is not None
    assert st["questions"][0]["selected_option_id"] == q0["options"][0]["id"]       # only the pre-deadline answer counted


def test_admin_review_edit_rollback_and_attempt_snapshots(alice, admin, sample_pdf):
    doc = upload(alice, sample_pdf)
    quiz = run_quiz(alice, doc["id"], "1-3")
    qs = alice.get(f"/api/quizzes/{quiz['id']}/questions").json()
    q = qs[0]
    a = alice.post(f"/api/quizzes/{quiz['id']}/attempts", json={"mode": "exam", "shuffle_options": False}).json()
    old_stem = a["questions"][0]["stem"]
    # student reports; non-admin cannot see admin queue
    r = alice.post("/api/reports", json={"target_type": "question", "target_id": q["id"], "kind": "wrong_key", "message": "المفتاح خاطئ"})
    assert r.status_code == 200
    assert alice.post("/api/reports", json={"target_type": "question", "target_id": q["id"], "kind": "wrong_key"}).json().get("duplicate")
    assert alice.get("/api/admin/reports").status_code == 403
    rep = admin.get("/api/admin/reports", params={"status": "open"}).json()
    assert len(rep) == 1 and rep[0]["target"]["stem"] == q["stem"]

    # nobody is "human reviewed" until a reviewer says so
    assert admin.get(f"/api/admin/questions/{q['id']}").json()["review_status"] in ("machine_verified", "flagged")
    admin.post(f"/api/admin/questions/{q['id']}/review", json={"decision": "human_reviewed"})
    d = admin.get(f"/api/admin/questions/{q['id']}").json()
    assert d["review_status"] == "human_reviewed" and d["reviewed_by"] == "admin@example.com"

    # edit -> new version, loses reviewed status, past attempt keeps what the student saw
    texts = [o["text"] for o in q["options"]]
    new_stem = q["stem"] + " (clarified wording)"
    e = admin.put(f"/api/admin/questions/{q['id']}", json={"stem": new_stem, "options": texts, "correct_index": 0, "explanation": "Updated explanation text for clarity.", "reason": "إزالة لبس"})
    assert e.status_code == 200 and e.json()["version"] == 2
    d = admin.get(f"/api/admin/questions/{q['id']}").json()
    assert d["review_status"] == "edited_pending_review" and d["reviewed_by"] is None and len(d["revisions"]) == 2
    assert alice.get(f"/api/attempts/{a['id']}").json()["questions"][0]["stem"] == old_stem
    a2 = alice.post(f"/api/quizzes/{quiz['id']}/attempts", json={"shuffle_options": False}).json()
    assert a2["questions"][0]["stem"] == new_stem

    # rollback restores the original, with a log entry
    assert admin.post(f"/api/admin/questions/{q['id']}/rollback", json={"version": 1}).json()["version"] == 3
    assert admin.get(f"/api/admin/questions/{q['id']}").json()["stem"] == q["stem"]
    kinds = [c["kind"] for c in admin.get("/api/admin/changes").json()]
    assert "question_edit" in kinds and "question_rollback" in kinds
    # invalid edit refused
    bad = admin.put(f"/api/admin/questions/{q['id']}", json={"stem": new_stem, "options": ["a", "a", "b", "c"], "correct_index": 0, "explanation": "x" * 20, "reason": "bad"})
    assert bad.status_code == 422
    # close the report as confirmed -> shows up in the defect metric with its denominator
    admin.patch(f"/api/admin/reports/{rep[0]['id']}", json={"status": "resolved", "resolution": "confirmed: مفتاح خاطئ"})


def test_metrics_define_denominators_and_exclude_test_content(alice, admin, sample_pdf):
    doc = upload(alice, sample_pdf)
    run_quiz(alice, doc["id"], "1-3")
    m = admin.get("/api/admin/metrics").json()
    assert m["excluded_test_quizzes"] == 1
    assert m["objective_coverage"]["denominator"] == 0 and m["objective_coverage"]["value"] is None   # test content excluded, not faked
    for k in ("generation_success", "duplicate_rate", "attempt_completion", "save_success", "confirmed_defect_rate"):
        assert m[k]["definition"] and "denominator" in m[k]
    assert m["generation_success"]["denominator"] == 1 and m["generation_success"]["value"] == 1.0
    alice.post("/api/events", json={"kind": "save", "ok": True})
    alice.post("/api/events", json={"kind": "save", "ok": False})
    assert admin.get("/api/admin/metrics").json()["save_success"]["value"] == 0.5
