#!/usr/bin/env python3
"""End-to-end smoke test against a RUNNING Quizzy server (e.g. the Docker image in CI).

  python scripts/smoke.py http://127.0.0.1:8000 phase1   # sign up, upload, generate, solve, PDF, cards, export
  docker restart quizzy
  python scripts/smoke.py http://127.0.0.1:8000 phase2   # data must have survived the restart; then erase the account

The server must run with QUIZZY_ALLOW_FAKE_LLM=1 (deterministic test generator). Exit code != 0 on any failure."""
import sys, tempfile, time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from tests import fixtures  # noqa: E402

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8000"
PHASE = sys.argv[2] if len(sys.argv) > 2 else "phase1"
EMAIL, PASSWORD = "smoke@example.com", "smoke-password-123"
T0 = time.time()


def step(msg):
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


def ok(cond, msg):
    if not cond:
        print("FAIL:", msg, flush=True)
        sys.exit(1)


def wait(fn, timeout=90, what="condition"):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
        except httpx.TransportError:      # server still starting
            v = None
        if v:
            return v
        time.sleep(0.3)
    ok(False, f"timeout waiting for {what}")


c = httpx.Client(base_url=BASE, timeout=60, follow_redirects=True)
wait(lambda: c.get("/api/health").status_code == 200, 60, "health")
step("health ok")
index = c.get("/")
ok(index.status_code == 200 and "كويزي" in index.text, "index page")
ok("gzip" in c.get("/static/js/main.js", headers={"Accept-Encoding": "gzip"}).headers.get("content-encoding", "gzip"), "static served")

if PHASE == "phase1":
    r = c.post("/api/auth/register", json={"email": EMAIL, "name": "Smoke", "password": PASSWORD})
    ok(r.status_code == 200, f"register {r.status_code} {r.text}")
    ok(c.get("/api/auth/me").json()["email"] == EMAIL, "me")
    pdf = fixtures.make_pdf(Path(tempfile.mkdtemp()) / "smoke.pdf")
    with open(pdf, "rb") as f:
        d = c.post("/api/documents", files={"file": ("smoke.pdf", f)}, data={"title": "Smoke"}).json()
    doc = wait(lambda: (lambda x: x if x["status"] != "processing" else None)(c.get(f"/api/documents/{d['id']}").json()), 60, "extraction")
    ok(doc["status"] == "ready" and doc["quality"]["image_only"] == [4], f"extraction quality {doc['quality']}")
    step("upload + extraction ok (image-only page flagged)")
    q = c.post("/api/quizzes", json={"sources": [{"document_id": d["id"], "pages": "1-3"}], "settings": {"count": 10}}).json()
    ok(c.post(f"/api/quizzes/{q['id']}/analyze").status_code == 200, "analyze")
    planned = wait(lambda: (lambda x: x if x["status"] not in ("draft", "analyzing") else None)(c.get(f"/api/quizzes/{q['id']}").json()), 90, "plan")
    ok(planned["status"] == "planned", f"plan status {planned['status']} {planned.get('error')}")
    ok(c.post(f"/api/quizzes/{q['id']}/generate", json={"accept_reduced": True}).status_code == 200, "generate")
    ready = wait(lambda: (lambda x: x if x["status"] not in ("planned", "generating") else None)(c.get(f"/api/quizzes/{q['id']}").json()), 120, "generation")
    ok(ready["status"] == "ready" and ready["report"]["delivered"] >= 1, f"generation {ready['status']} {ready.get('error')}")
    step(f"quiz ready: {ready['report']['delivered']} questions, generator={ready['generator']}")
    qs = c.get(f"/api/quizzes/{q['id']}/questions").json()
    ok(all(len(x["options"]) == 4 and x["correct_option_id"] in {o["id"] for o in x["options"]} and x["evidence"] for x in qs), "question shape")
    a = c.post(f"/api/quizzes/{q['id']}/attempts", json={"mode": "practice"}).json()
    first = a["questions"][0]
    ok("correct_option_id" not in first, "key hidden before answering")
    r = c.put(f"/api/attempts/{a['id']}/answer", json={"question_id": first["id"], "option_id": first["options"][0]["id"]}).json()
    ok(r["saved"] and "correct_option_id" in r, "answer + feedback")
    done = c.post(f"/api/attempts/{a['id']}/submit").json()
    ok(done["status"] == "submitted" and done["max_score"] == len(qs), "submit")
    pdfr = c.get(f"/api/quizzes/{q['id']}/pdf")
    ok(pdfr.status_code == 200 and pdfr.content[:4] == b"%PDF" and len(pdfr.content) > 2000, "pdf export")
    cards = c.post(f"/api/documents/{d['id']}/cards/generate", json={"pages": "1-3", "count": 6}).json()
    ok(cards["created"] >= 1, "cards")
    ok(len(c.get("/api/auth/export").json()["quizzes"]) == 1, "export")
    step("phase1 passed (solve, PDF, cards, export)")
elif PHASE == "phase2":
    r = c.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    ok(r.status_code == 200, f"login after restart {r.status_code}")
    ok(len(c.get("/api/quizzes").json()) == 1 and len(c.get("/api/documents").json()) == 1, "data survived the restart")
    ok(len(c.get("/api/attempts").json()) == 1 and len(c.get("/api/cards").json()) >= 1, "attempts + cards survived")
    step("persistence across restart ok")
    ok(c.post("/api/auth/delete", json={"password": PASSWORD}).status_code == 200, "delete account")
    ok(c.get("/api/auth/me").status_code == 401, "signed out after delete")
    step("phase2 passed (account erased)")
else:
    ok(False, "phase must be phase1 or phase2")
print("SMOKE OK", PHASE, f"{time.time() - T0:.1f}s")
