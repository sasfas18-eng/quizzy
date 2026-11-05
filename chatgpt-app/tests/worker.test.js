import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

class Bucket {
  data = new Map();
  async put(key, value) { this.data.set(key, value); }
  async get(key) {
    const value = this.data.get(key);
    return value === undefined ? null : { json: async () => JSON.parse(value) };
  }
  async list({ prefix, limit }) {
    const objects = [...this.data.keys()].filter((item) => item.startsWith(prefix)).slice(0, limit).map((key) => ({ key }));
    return { objects, truncated: false };
  }
}
const env = { BUCKET: new Bucket() };
const page = "عملية التمثيل الضوئي تستخدم الضوء لتحويل الماء وثاني أكسيد الكربون إلى جلوكوز وأكسجين داخل البلاستيدات الخضراء.";
const question = {
  stem: "ما الناتج الذي تذكره الشريحة لعملية التمثيل الضوئي؟",
  choices: [
    { id: "a", text: "الجلوكوز والأكسجين" },
    { id: "b", text: "النيتروجين والماء" },
    { id: "c", text: "ثاني أكسيد الكربون فقط" },
    { id: "d", text: "الضوء والماء" }
  ],
  correct_choice_id: "a", explanation: "تذكر الشريحة أن الناتجين هما الجلوكوز والأكسجين.",
  identity: "Basic Recall", objective: "تحديد ناتج التمثيل الضوئي", source_page: 2,
  evidence: "إلى جلوكوز وأكسجين داخل البلاستيدات الخضراء"
};
async function call(user, name, args = {}) {
  const headers = { "content-type": "application/json" };
  if (user) headers["oai-authenticated-user-id"] = user;
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  }), env);
  const result = (await response.json()).result;
  return { ...result, data: JSON.parse(result.content[0].text) };
}

test("MCP discovery and tool catalog", async () => {
  for (const method of ["server/discover", "tools/list"]) {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method })
    }), env);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).result);
  }
});

test("source-grounded quiz saves, resumes, grades, and isolates two users", async () => {
  const created = await call("student-a", "create_quiz_from_slides", {
    title: "الأحياء", source_name: "محاضرة 1.pdf", mode: "practice",
    pages: [{ number: 2, text: page }], questions: [question]
  });
  assert.equal(created.data.saved, true);
  const id = created.data.id;
  const other = await call("student-b", "get_quiz_question", { quiz_id: id, question_number: 1 });
  assert.equal(other.isError, true);
  assert.equal((await call("student-b", "list_my_quizzes")).data.quizzes.length, 0);
  const shown = await call("student-a", "get_quiz_question", { quiz_id: id, question_number: 1 });
  assert.equal(shown.data.question.stem, question.stem);
  assert.equal(shown.data.question.correct_choice_id, undefined);
  const submitted = await call("student-a", "submit_quiz_answer", { quiz_id: id, question_number: 1, choice_id: "b" });
  assert.equal(submitted.data.saved, true);
  assert.equal(submitted.data.correct, false);
  const review = await call("student-a", "get_quiz_review", { quiz_id: id });
  assert.equal(review.data.score, 0);
  assert.equal(review.data.wrong_questions.length, 1);
  assert.equal((await call("student-a", "list_my_quizzes")).data.quizzes[0].answered_count, 1);
  assert.equal((await call("student-a", "submit_quiz_answer", { quiz_id: id, question_number: 1, choice_id: "a" })).isError, true);
});

test("rejects invented evidence, duplicate objectives, invalid key and anonymous writes", async () => {
  const base = { title: "الأحياء", source_name: "slides.pdf", pages: [{ number: 2, text: page }] };
  assert.equal((await call("student-a", "create_quiz_from_slides", { ...base, questions: [{ ...question, evidence: "معلومة غير موجودة في المصدر" }] })).isError, true);
  assert.equal((await call("student-a", "create_quiz_from_slides", { ...base, questions: [question, { ...question, stem: "ما ناتج العملية الحيوية في هذه الشريحة؟" }] })).isError, true);
  assert.equal((await call("student-a", "create_quiz_from_slides", { ...base, questions: [{ ...question, correct_choice_id: "z" }] })).isError, true);
  assert.equal((await call(null, "create_quiz_from_slides", { ...base, questions: [question] })).isError, true);
});

test("exam hides answer until all questions have been answered", async () => {
  const created = await call("student-c", "create_quiz_from_slides", {
    title: "اختبار", source_name: "slides.pdf", mode: "exam", pages: [{ number: 2, text: page }],
    questions: [question, { ...question, stem: "أين تحدث عملية التمثيل الضوئي كما تذكر الشريحة؟", objective: "تحديد موقع التمثيل الضوئي", correct_choice_id: "d",
      choices: [{ id: "a", text: "في النواة" }, { id: "b", text: "في الميتوكوندريا" }, { id: "c", text: "في الريبوسومات" }, { id: "d", text: "في البلاستيدات الخضراء" }],
      evidence: "داخل البلاستيدات الخضراء" }]
  });
  const id = created.data.id;
  const first = await call("student-c", "submit_quiz_answer", { quiz_id: id, question_number: 1, choice_id: "b" });
  assert.equal(first.data.correct_choice_id, undefined);
  const interim = await call("student-c", "get_quiz_review", { quiz_id: id });
  assert.equal(interim.data.complete, false);
  assert.equal(interim.data.review, undefined);
  const second = await call("student-c", "submit_quiz_answer", { quiz_id: id, question_number: 2, choice_id: "d" });
  assert.equal(second.data.complete, true);
  assert.equal((await call("student-c", "get_quiz_review", { quiz_id: id })).data.score, 1);
});
