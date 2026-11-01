"""A NEW file must be read right away, however many quiz jobs are running or queued.

The reported symptom: "I cannot create a new file once I have many quizzes". Reading a file (text extraction) and writing a quiz (many slow AI calls) used to share one
small worker pool, so a few long quiz jobs left every new upload "processing" for as long as they ran. Files now have their own workers."""
import threading

from app.config import settings
from app.deps import doc_pool, pool

from tests.conftest import wait_for


def _post(client, path, title="New"):
    with open(path, "rb") as f:
        r = client.post("/api/documents", files={"file": (path.name, f)}, data={"title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_new_file_is_read_while_every_quiz_worker_is_busy(alice, sample_pdf):
    gate = threading.Event()
    held = [pool.submit(gate.wait, 60) for _ in range(settings.workers + 3)]      # long quiz jobs: they hold every quiz worker and more of them are queued behind
    try:
        did = _post(alice, sample_pdf)
        doc = wait_for(lambda: (lambda d: d if d["status"] != "processing" else None)(alice.get(f"/api/documents/{did}").json()), timeout=8)
        assert doc["status"] == "ready" and doc["page_count"] > 0, doc
    finally:
        gate.set()
        for f in held:
            f.result(timeout=10)


def test_many_files_in_a_row_while_quiz_jobs_run(alice, sample_pdf):
    gate = threading.Event()
    held = [pool.submit(gate.wait, 60) for _ in range(settings.workers + 3)]
    try:
        ids = [_post(alice, sample_pdf, title=f"Lecture {i}") for i in range(8)]
        for did in ids:
            doc = wait_for(lambda: (lambda d: d if d["status"] != "processing" else None)(alice.get(f"/api/documents/{did}").json()), timeout=15)
            assert doc["status"] == "ready", doc
        assert len(alice.get("/api/documents").json()) == 8
    finally:
        gate.set()
        for f in held:
            f.result(timeout=10)


def test_file_workers_are_separate_from_quiz_workers():
    assert doc_pool is not pool and doc_pool._max_workers >= 2
