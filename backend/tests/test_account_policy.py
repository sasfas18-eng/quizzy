import json
from pathlib import Path

from app.config import settings
from app.db import connect
from tests.conftest import make_client, run_quiz, upload


def reg(c, email, **extra):
    return c.post("/api/auth/register", json={"email": email, "name": "N", "password": "password-123", **extra})


def test_registration_closed_invite_domain_and_admin_bypass(env):
    c = make_client(env)
    try:
        settings.registration_mode = "closed"
        r = reg(c, "a@x.com")
        assert r.status_code == 403 and r.json()["code"] == "registration_closed"
        assert reg(make_client(env), "admin@example.com").status_code == 200          # configured admin can always bootstrap
        settings.registration_mode, settings.invite_codes = "invite", ["SECRET-1", "SECRET-2"]
        assert reg(c, "b@x.com").json()["code"] == "invalid_invite"
        assert reg(c, "b@x.com", invite_code="nope").json()["code"] == "invalid_invite"
        assert reg(c, "b@x.com", invite_code="SECRET-2").status_code == 200
        assert c.get("/api/auth/capabilities").json()["registration"] == "invite"
        settings.registration_mode, settings.allowed_email_domains = "open", ["uni.edu"]
        assert reg(make_client(env), "c@gmail.com").json()["code"] == "domain_not_allowed"
        assert reg(make_client(env), "d@uni.edu").status_code == 200
    finally:
        settings.registration_mode, settings.invite_codes, settings.allowed_email_domains = "open", [], []


def test_change_password_revokes_other_sessions(alice, env):
    other = make_client(env)
    assert other.post("/api/auth/login", json={"email": "alice@example.com", "password": "correct-horse-1"}).status_code == 200
    assert alice.post("/api/auth/password", json={"current_password": "wrong-one-123", "new_password": "brand-new-pass-1"}).status_code == 403
    assert alice.post("/api/auth/password", json={"current_password": "correct-horse-1", "new_password": "brand-new-pass-1"}).status_code == 200
    assert alice.get("/api/auth/me").status_code == 200                 # this device stays signed in
    assert other.get("/api/auth/me").status_code == 401                 # the other device is signed out
    assert make_client(env).post("/api/auth/login", json={"email": "alice@example.com", "password": "correct-horse-1"}).status_code == 401
    assert make_client(env).post("/api/auth/login", json={"email": "alice@example.com", "password": "brand-new-pass-1"}).status_code == 200


def test_export_and_account_deletion_erase_everything_and_only_mine(alice, bob, sample_pdf):
    adoc = upload(alice, sample_pdf)
    aq = run_quiz(alice, adoc["id"], "1-3")
    alice.post(f"/api/documents/{adoc['id']}/cards/generate", json={"pages": "1-3", "count": 6})
    bdoc = upload(bob, sample_pdf)
    stored = Path(connect().execute("SELECT stored_path FROM documents WHERE id=?", (adoc["id"],)).fetchone()[0])
    assert stored.exists()

    exp = alice.get("/api/auth/export")
    assert exp.status_code == 200 and "attachment" in exp.headers["content-disposition"]
    data = json.loads(exp.content)
    assert data["user"]["email"] == "alice@example.com" and [d["id"] for d in data["documents"]] == [adoc["id"]]
    assert data["quizzes"][0]["questions"] and data["flashcards"] and "bob@example.com" not in exp.text and bdoc["id"] not in exp.text

    assert alice.post("/api/auth/delete", json={"password": "wrong-password-1"}).status_code == 403
    assert alice.post("/api/auth/delete", json={"password": "correct-horse-1"}).status_code == 200
    assert alice.get("/api/auth/me").status_code == 401
    conn = connect()
    uid_rows = lambda t: conn.execute(f"SELECT COUNT(*) FROM {t} WHERE user_id IS NOT NULL").fetchone()[0]
    assert conn.execute("SELECT COUNT(*) FROM users WHERE email='alice@example.com'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM documents WHERE id=?", (adoc["id"],)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM questions WHERE quiz_id=?", (aq["id"],)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM pages WHERE document_id=?", (adoc["id"],)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM flashcards").fetchone()[0] == 0
    assert not stored.exists()
    assert bob.get(f"/api/documents/{bdoc['id']}").status_code == 200          # nobody else lost anything
