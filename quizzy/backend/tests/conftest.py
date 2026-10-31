import os
import tempfile
import time
from pathlib import Path

os.environ.setdefault("QUIZZY_DATA_DIR", tempfile.mkdtemp(prefix="quizzy-test-"))
os.environ["QUIZZY_ALLOW_FAKE_LLM"] = "1"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ["QUIZZY_ADMIN_EMAILS"] = "admin@example.com"
os.environ["QUIZZY_DEV_LOG_RESET_LINKS"] = "1"

import pytest
from fastapi.testclient import TestClient

from app import config
from app.config import settings
from app.db import init_db
from app.security import limiter
from tests import fixtures


@pytest.fixture()
def env(tmp_path):
    settings.data_dir = tmp_path / "data"
    settings.allow_fake_llm = True
    settings.anthropic_key = ""
    init_db()
    limiter.reset()
    from app.main import app
    yield app


def make_client(app) -> TestClient:
    return TestClient(app, base_url="http://testserver")


@pytest.fixture()
def client(env):
    return make_client(env)


@pytest.fixture()
def alice(env):
    c = make_client(env)
    r = c.post("/api/auth/register", json={"email": "alice@example.com", "name": "Alice", "password": "correct-horse-1"})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture()
def bob(env):
    c = make_client(env)
    r = c.post("/api/auth/register", json={"email": "bob@example.com", "name": "Bob", "password": "correct-horse-2"})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture()
def admin(env):
    c = make_client(env)
    r = c.post("/api/auth/register", json={"email": "admin@example.com", "name": "Admin", "password": "correct-horse-3"})
    assert r.json()["role"] == "admin"
    return c


def wait_for(fn, timeout=60, interval=0.15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(interval)
    raise AssertionError("timeout waiting for condition")


def upload(client, path: Path, title="Cardiac", field="health"):
    with open(path, "rb") as f:
        r = client.post("/api/documents", files={"file": (path.name, f)}, data={"title": title, "field": field})
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    doc = wait_for(lambda: (lambda d: d if d["status"] != "processing" else None)(client.get(f"/api/documents/{did}").json()))
    return doc


@pytest.fixture()
def sample_pdf(tmp_path):
    return fixtures.make_pdf(tmp_path / "cardiac.pdf")


def run_quiz(client, doc_id, pages="1-3", **settings_over):
    st = {"count": 10, "language": "en", **settings_over}
    r = client.post("/api/quizzes", json={"sources": [{"document_id": doc_id, "pages": pages}], "settings": st})
    assert r.status_code == 200, r.text
    qid = r.json()["id"]
    assert client.post(f"/api/quizzes/{qid}/analyze").status_code == 200
    quiz = wait_for(lambda: (lambda q: q if q["status"] not in ("analyzing", "draft") else None)(client.get(f"/api/quizzes/{qid}").json()))
    assert quiz["status"] == "planned", quiz
    r = client.post(f"/api/quizzes/{qid}/generate", json={"accept_reduced": True})
    assert r.status_code == 200, r.text
    quiz = wait_for(lambda: (lambda q: q if q["status"] not in ("planned", "generating") else None)(client.get(f"/api/quizzes/{qid}").json()))
    return quiz
