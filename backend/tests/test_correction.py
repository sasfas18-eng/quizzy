"""The ARABIC CORRECTION of a wrong answer (services/correction.py + POST /api/attempts/<id>/correction). Mirrors claude-edition/test/correction.test.js.
The model is free in its phrasing, never in its facts: what comes back must be Arabic, keep the ORIGINAL (the correct answer verbatim when short, else a key term) and bring no number the lecture
does not contain. It is made on demand, kept with the attempt, and never shows what the attempt may not show yet."""
import pytest

from app.db import connect
from app.routers import attempts as attempts_router
from app.services import correction as C
from app.services.llm import LLMUnavailable

from tests.conftest import run_quiz, upload

CTX = {"stem": "Complete the statement from the lecture: The cardiac cycle is the sequence of ____ and mechanical events during one heartbeat.",
       "options": ["pulmon", "muscular", "semilunar", "electrical"], "chosen": "pulmon", "correct": "electrical",
       "explanation": 'The correct answer follows the lecture text: "The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat".',
       "quote": "The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat."}
GOOD = "الصواب: electrical. دورة القلب هي تسلسل الأحداث الكهربائية (electrical) والميكانيكية خلال نبضة واحدة، فـ pulmon لا علاقة لها بما تقوله الجملة هنا."
NO_ORIGINAL = "الصواب: الكهربائية. دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة من نبضات القلب، وهذا ما تقوله الجملة."


class Scripted:
    name = "scripted"
    model = "t"

    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def json_call(self, task, system, prompt, payload=None, max_tokens=0):
        self.calls.append({"task": task, "system": system, "prompt": prompt})
        a = self.answers[min(len(self.calls) - 1, len(self.answers) - 1)]
        if isinstance(a, Exception):
            raise a
        return a


# ------------------------------------------------------------------------------------------------------------- the checks
def test_the_checks():
    assert C.check(GOOD, CTX) == []
    assert "not_arabic" in C.check("The correct answer is electrical because the lecture says so, and that is all there is to say about it.", CTX)
    assert "original_missing" in C.check(NO_ORIGINAL, CTX), "the original word must be there, not only its translation"
    assert C.check(NO_ORIGINAL.replace("الصواب: الكهربائية", "الصواب: ELECTRICAL"), CTX) == [], "case does not matter"
    assert "length" in C.check("قصير", CTX) and "length" in C.check(GOOD * 12, CTX)
    assert "invented_number" in C.check(GOOD + " وتتكرر 72 مرة في الدقيقة.", CTX)
    assert "invented_number" in C.check(GOOD + " وتتكرر ٧٢ مرة في الدقيقة.", CTX), "also with Arabic-Indic digits"
    num = {"stem": "The resting heart rate is about ____ beats per minute.", "options": ["72", "60", "90", "120"], "chosen": "90", "correct": "72",
           "explanation": "The lecture says the resting rate is about 72 beats per minute.", "quote": "The resting heart rate is about 72 beats per minute."}
    assert C.check("الصواب: 72. معدل القلب أثناء الراحة نحو ٧٢ نبضة في الدقيقة، وليس 90 ولا 60 كما قد يخطر لك.", num) == [], "numbers that the lecture / the options have are fine"
    long = {**CTX, "correct": "The sequence of electrical and mechanical events that happen during one complete heartbeat"}
    assert C.check("الصواب أنها تسلسل الأحداث الكهربائية (electrical) والميكانيكية خلال نبضة قلب كاملة واحدة كما تقول المحاضرة.", long) == [], "a long answer: one key term in the original is enough"
    assert "original_missing" in C.check(NO_ORIGINAL, long)
    ar = {"stem": "ما وظيفة الميتوكوندريا حسب المحاضرة؟", "options": ["إنتاج الطاقة", "تخزين الماء", "بناء الجدار", "نقل الصبغيات"], "chosen": "تخزين الماء", "correct": "إنتاج الطاقة",
          "explanation": "تنتج الميتوكوندريا الطاقة للخلية.", "quote": "تنتج الميتوكوندريا الطاقة للخلية."}
    assert C.check("الصواب: إنتاج الطاقة. الميتوكوندريا هي مصنع الطاقة في الخلية، وليست مخزنًا للماء كما اخترت.", ar) == [], "an Arabic answer has no original to keep"


def test_which_explanations_are_arabic():
    assert C.is_arabic("الإجابة الصحيحة مبنية على نص المحاضرة الأصلي: «The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat». الخيارات الأخرى تصف أشياء أخرى.")
    assert not C.is_arabic('The correct answer follows the lecture text: "The cardiac cycle is the sequence". The other options describe other items.')
    assert C.is_arabic("تنتج الميتوكوندريا الطاقة للخلية.") and C.is_arabic("«إنتاج الطاقة»") and not C.is_arabic("") and not C.is_arabic(None)


def test_making_it():
    p = Scripted({"ar": GOOD})
    assert C.make(p, CTX) == GOOD and len(p.calls) == 1 and p.calls[0]["task"] == "correction"
    assert "CHOSE (wrong): pulmon" in p.calls[0]["prompt"] and "CORRECT ANSWER: electrical" in p.calls[0]["prompt"] and "LECTURE SENTENCE (verbatim): The cardiac cycle" in p.calls[0]["prompt"]
    assert "ONLY what the lecture sentence" in p.calls[0]["system"] and "Keep the ORIGINAL" in p.calls[0]["system"]
    p = Scripted({"ar": NO_ORIGINAL}, {"ar": GOOD})
    assert C.make(p, CTX) == GOOD and len(p.calls) == 2, "one retry"
    assert "REJECTED" in p.calls[1]["prompt"] and "EXACTLY as written" in p.calls[1]["prompt"] and "REJECTED" not in p.calls[0]["prompt"]
    p = Scripted({"ar": NO_ORIGINAL})
    r = C.make(p, CTX)
    assert r.startswith("الصواب: «electrical» — الكهربائية.") and r.count("الصواب:") == 1 and C.check(r, CTX) == [] and len(p.calls) == 2, "only the original forgotten: named first, the lead not repeated"
    r = C.make(Scripted({"ar": "دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة من نبضات القلب كما تقول المحاضرة."}), CTX)
    assert r.startswith("الصواب: «electrical». دورة القلب") and C.check(r, CTX) == []
    p = Scripted({"ar": GOOD + " وتتكرر 72 مرة في الدقيقة."})
    assert C.make(p, CTX) is None and len(p.calls) == 2, "an invented number twice: nothing is shown"
    assert C.make(Scripted("Sorry, I cannot do that."), CTX) is None
    boom = RuntimeError("HTTP 429")
    with pytest.raises(RuntimeError):
        C.make(Scripted(boom), CTX)
    assert C.make(Scripted({"ar": NO_ORIGINAL}, boom), CTX).startswith("الصواب: «electrical»"), "an error on the retry does not lose a first attempt that only forgot the original"
    assert C.make(Scripted({"ar": GOOD + " وتتكرر 72 مرة في الدقيقة."}, boom), CTX) is None
    r = C.make(Scripted({"ar": "**الصواب: electrical.**\n- دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة."}), CTX)
    assert "*" not in r and "\n" not in r and r.startswith("الصواب: electrical."), "markdown and line breaks are stripped"
    assert C.make(Scripted("الصواب: electrical. دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة من نبضات القلب."), CTX).startswith("الصواب")
    p = Scripted({"ar": GOOD})
    C.make(p, {**CTX, "chosen": None})
    assert "LEFT IT BLANK" in p.calls[0]["prompt"] and "CHOSE" not in p.calls[0]["prompt"]


# ------------------------------------------------------------------------------------------------------------- the endpoint
@pytest.fixture()
def quiz(alice, sample_pdf):
    doc = upload(alice, sample_pdf)
    q = run_quiz(alice, doc["id"], "1-3", count=6)
    assert q["status"] == "ready", q
    conn = connect()
    try:      # the test provider explains in Arabic (around the lecture's English quotation); what needs an Arabic correction is an explanation in the lecture's own language
        conn.execute("UPDATE questions SET explanation=? WHERE quiz_id=?", ("The correct answer follows the lecture text, and the other options describe other items from the source that do not apply here.", q["id"]))
        conn.commit()
    finally:
        conn.close()
    return q


def _start(client, quiz, mode="practice"):
    a = client.post(f"/api/quizzes/{quiz['id']}/attempts", json={"mode": mode}).json()
    keys = {q["id"]: q["correct_option_id"] for q in client.get(f"/api/quizzes/{quiz['id']}/questions").json()}
    return a, keys


def _wrong(a, keys, i=0):
    q = a["questions"][i]
    return q["id"], next(o["id"] for o in q["options"] if o["id"] != keys[q["id"]]), keys[q["id"]]


def test_a_wrong_answer_gets_its_arabic_correction_once_and_it_is_kept(alice, quiz, monkeypatch):
    a, keys = _start(alice, quiz)
    qid, wrong, right = _wrong(a, keys)
    assert alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong}).json()["is_correct"] is False
    calls = []
    real = attempts_router.fix.make
    monkeypatch.setattr(attempts_router.fix, "make", lambda provider, ctx: calls.append(ctx) or real(provider, ctx))
    r = alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["available"] is True and j["cached"] is False and j["ar"].startswith("الصواب: ")
    right_text = next(o["text"] for o in a["questions"][0]["options"] if o["id"] == right)
    wrong_text = next(o["text"] for o in a["questions"][0]["options"] if o["id"] == wrong)
    assert right_text in j["ar"], "the ORIGINAL right answer is in the Arabic correction, exactly"
    assert calls and calls[0]["chosen"] == wrong_text and calls[0]["correct"] == right_text and calls[0]["quote"], "the model got the wrong choice, the right answer and the lecture's own sentence"
    again = alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json()
    assert again == {"available": True, "ar": j["ar"], "cached": True} and len(calls) == 1, "kept with the attempt: no second model call"


def test_nothing_for_a_right_answer_or_before_the_answer_may_be_shown(alice, quiz):
    a, keys = _start(alice, quiz)
    qid, wrong, right = _wrong(a, keys)
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).status_code == 409, "practice, not answered yet: nothing is revealed"
    alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": right})
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json() == {"available": False, "reason": "not_wrong"}
    ex, keys = _start(alice, quiz, "exam")
    q2, w2, _ = _wrong(ex, keys)
    alice.put(f"/api/attempts/{ex['id']}/answer", json={"question_id": q2, "option_id": w2})
    r = alice.post(f"/api/attempts/{ex['id']}/correction", json={"question_id": q2})
    assert r.status_code == 409 and r.json()["code"] == "not_revealed", "an exam reveals nothing until it is submitted"
    assert alice.post(f"/api/attempts/{ex['id']}/submit").status_code == 200
    j = alice.post(f"/api/attempts/{ex['id']}/correction", json={"question_id": q2}).json()
    assert j["available"] is True and j["ar"], "after the submit the wrong answer is corrected"
    blank = ex["questions"][1]["id"]
    j = alice.post(f"/api/attempts/{ex['id']}/correction", json={"question_id": blank}).json()
    assert j["available"] is True and j["ar"].startswith("الصواب"), "a question left blank is corrected too"
    assert alice.post(f"/api/attempts/{ex['id']}/correction", json={"question_id": "nope"}).status_code == 404


def test_it_is_private(alice, bob, quiz):
    a, keys = _start(alice, quiz)
    qid, wrong, _ = _wrong(a, keys)
    alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong})
    assert bob.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).status_code == 404


def test_without_an_ai_or_when_it_fails_the_page_keeps_the_plain_slip(alice, quiz, monkeypatch):
    a, keys = _start(alice, quiz)
    qid, wrong, _ = _wrong(a, keys)
    alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong})

    def none():
        raise LLMUnavailable("off")

    monkeypatch.setattr(attempts_router, "get_provider", none)
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json() == {"available": False, "reason": "no_ai"}
    monkeypatch.setattr(attempts_router, "get_provider", lambda: Scripted(RuntimeError("HTTP 500")))
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json() == {"available": True, "ar": None, "reason": "failed"}
    monkeypatch.setattr(attempts_router, "get_provider", lambda: Scripted("Sorry, I cannot."))
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json() == {"available": True, "ar": None, "reason": "rejected"}
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM corrections").fetchone()[0] == 0, "nothing was kept from the failures"
    finally:
        conn.close()
    from app.services.fake_llm import FakeProvider
    monkeypatch.setattr(attempts_router, "get_provider", lambda: FakeProvider())      # the provider works again: the next try is made (a failure is not remembered)
    j = alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json()
    assert j["available"] is True and j["ar"].startswith("الصواب: ") and j["cached"] is False


def test_an_explanation_that_is_already_arabic_needs_no_translation(alice, quiz):
    a, keys = _start(alice, quiz)
    qid, wrong, _ = _wrong(a, keys)
    conn = connect()
    try:
        conn.execute("UPDATE questions SET explanation=? WHERE id=?", ("الإجابة الصحيحة مبنية على نص المحاضرة: دورة القلب تتابع الأحداث الكهربائية والميكانيكية.", qid))
        conn.commit()
    finally:
        conn.close()
    alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong})
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json() == {"available": False, "reason": "already_arabic"}


def test_a_script_cannot_turn_it_into_a_bill(alice, quiz, monkeypatch):
    monkeypatch.setattr(attempts_router, "CORRECTIONS_PER_HOUR", 1)
    a, keys = _start(alice, quiz)
    done = []
    for i in range(2):
        qid, wrong, _ = _wrong(a, keys, i)
        alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong})
        done.append(alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json())
    assert done[0]["available"] is True and done[1] == {"available": False, "reason": "limit"}


def test_deleting_the_quiz_deletes_its_corrections(alice, quiz):
    a, keys = _start(alice, quiz)
    qid, wrong, _ = _wrong(a, keys)
    alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong})
    assert alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json()["ar"]
    assert alice.delete(f"/api/quizzes/{quiz['id']}").status_code == 200
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM corrections").fetchone()[0] == 0
    finally:
        conn.close()


def test_the_export_and_the_erasure_cover_the_corrections(alice, quiz):
    a, keys = _start(alice, quiz)
    qid, wrong, _ = _wrong(a, keys)
    alice.put(f"/api/attempts/{a['id']}/answer", json={"question_id": qid, "option_id": wrong})
    kept = alice.post(f"/api/attempts/{a['id']}/correction", json={"question_id": qid}).json()["ar"]
    att = next(x for x in alice.get("/api/auth/export").json()["attempts"] if x["id"] == a["id"])
    assert [(c["question_id"], c["option_id"], c["text"]) for c in att["corrections"]] == [(qid, wrong, kept)], "what the account owns, the corrections included"
    assert alice.post("/api/auth/delete", json={"password": "correct-horse-1"}).status_code == 200
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM corrections").fetchone()[0] == 0, "erasing the account erases them"
    finally:
        conn.close()
