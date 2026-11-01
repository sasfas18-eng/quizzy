"""Guest mode (server edition): use the site without registering. A temporary account - kept for a while, erased when the guest leaves, nothing promised -
that can become a real account later without losing what was made."""
import pytest

from app.config import settings
from app.db import connect
from app.routers import auth as auth_router

from tests.conftest import make_client, upload


@pytest.fixture()
def guests_on(monkeypatch):
    monkeypatch.setattr(settings, "allow_guests", True)
    monkeypatch.setattr(settings, "registration_mode", "open")
    auth_router._last_purge = 0.0


def _guest(env):
    c = make_client(env)
    r = c.post("/api/auth/guest")
    assert r.status_code == 200, r.text
    return c, r.json()


def test_a_guest_can_work_without_registering(env, guests_on, sample_pdf):
    caps = make_client(env).get("/api/auth/capabilities").json()
    assert caps["guest"] is True and caps["can_register"] is True and caps["guest_days"] == settings.guest_days
    c, me = _guest(env)
    assert me["guest"] is True and me["role"] == "guest" and me["email"] == "" and me["name"] == "ضيف"
    assert c.get("/api/auth/me").json()["guest"] is True
    doc = upload(c, sample_pdf)
    assert doc["status"] == "ready" and len(c.get("/api/documents").json()) == 1
    assert c.post("/api/auth/guest").json()["id"] == me["id"], "pressing the guest button again on the same browser keeps the same guest"


def test_guest_work_is_private(env, guests_on, sample_pdf):
    a, _ = _guest(env)
    b, _ = _guest(env)
    upload(a, sample_pdf)
    assert a.get("/api/documents").json() and b.get("/api/documents").json() == []


def test_guests_are_off_where_the_site_is_not_open(env, monkeypatch):
    for mode in ("closed", "invite"):
        monkeypatch.setattr(settings, "registration_mode", mode)
        assert make_client(env).get("/api/auth/capabilities").json()["guest"] is False
        assert make_client(env).post("/api/auth/guest").status_code == 403
    monkeypatch.setattr(settings, "registration_mode", "open")
    monkeypatch.setattr(settings, "allow_guests", False)
    assert make_client(env).get("/api/auth/capabilities").json()["guest"] is False
    assert make_client(env).post("/api/auth/guest").json()["code"] == "guests_disabled"


def test_a_guest_has_no_password_and_nothing_to_change(env, guests_on):
    c, _ = _guest(env)
    r = c.post("/api/auth/password", json={"current_password": "x", "new_password": "long-enough-1"})
    assert r.status_code == 403 and r.json()["code"] == "guest_no_password"


def test_registering_keeps_everything_the_guest_made(env, guests_on, sample_pdf):
    c, me = _guest(env)
    doc = upload(c, sample_pdf)
    r = c.post("/api/auth/register", json={"email": "Was.Guest@Example.com", "name": "كانت ضيفة", "password": "correct-horse-7"})
    assert r.status_code == 200, r.text
    u = r.json()
    assert u["id"] == me["id"] and u["role"] == "student" and u["email"] == "was.guest@example.com" and "guest" not in u, "the same account, now a real one"
    assert [d["id"] for d in c.get("/api/documents").json()] == [doc["id"]], "the guest's file is still there"
    assert c.get("/api/auth/me").json()["name"] == "كانت ضيفة"
    c2 = make_client(env)      # and it signs in like any account
    assert c2.post("/api/auth/login", json={"email": "was.guest@example.com", "password": "correct-horse-7"}).status_code == 200
    assert [d["id"] for d in c2.get("/api/documents").json()] == [doc["id"]]


def test_registering_with_a_taken_email_does_not_touch_the_guest(env, guests_on, alice, sample_pdf):
    c, me = _guest(env)
    upload(c, sample_pdf)
    r = c.post("/api/auth/register", json={"email": "alice@example.com", "name": "x", "password": "correct-horse-1"})
    assert r.status_code == 409
    assert c.get("/api/auth/me").json()["guest"] is True and len(c.get("/api/documents").json()) == 1


def test_a_guest_erases_the_temporary_account_without_a_password(env, guests_on, sample_pdf):
    c, me = _guest(env)
    upload(c, sample_pdf)
    folder = settings.upload_dir / me["id"]
    assert folder.exists()
    assert c.post("/api/auth/delete", json={"password": ""}).status_code == 200
    assert not folder.exists() and c.get("/api/auth/me").status_code == 401
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM users WHERE id=?", (me["id"],)).fetchone()[0] == 0
    finally:
        conn.close()


def test_a_real_account_still_needs_its_password_to_be_deleted(env, alice):
    assert alice.post("/api/auth/delete", json={"password": ""}).status_code == 403


def test_a_guest_who_left_is_erased_with_the_files_and_an_active_one_stays(env, guests_on, sample_pdf):
    gone, g1 = _guest(env)
    upload(gone, sample_pdf)
    stay, g2 = _guest(env)
    upload(stay, sample_pdf)
    assert gone.post("/api/auth/logout").status_code == 200          # leaving = the session is gone: nobody can come back to it
    assert (settings.upload_dir / g1["id"]).exists()
    conn = connect()
    try:
        assert auth_router.purge_guests(conn, force=True) == 1
        left = {r["id"] for r in conn.execute("SELECT id FROM users WHERE role='guest'").fetchall()}
        assert left == {g2["id"]} and not (settings.upload_dir / g1["id"]).exists() and (settings.upload_dir / g2["id"]).exists()
        assert conn.execute("SELECT COUNT(*) FROM documents WHERE user_id=?", (g1["id"],)).fetchone()[0] == 0, "its documents went with it"
    finally:
        conn.close()
    assert len(stay.get("/api/documents").json()) == 1


def test_a_guest_whose_days_are_over_is_erased(env, guests_on):
    _, g = _guest(env)
    conn = connect()
    try:
        conn.execute("UPDATE sessions SET expires_at=? WHERE user_id=?", (1.0, g["id"]))      # the days are over
        assert auth_router.purge_guests(conn, force=True) == 1
    finally:
        conn.close()


def test_guest_creation_is_rate_limited(env, guests_on):
    codes = [make_client(env).post("/api/auth/guest").status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429
