import test from "node:test";
import assert from "node:assert/strict";
import worker, { runTool } from "../worker/index.js";

class Bucket {
  data = new Map();
  getCalls = 0;
  async put(key, value, options) { this.data.set(key, { value, customMetadata: options?.customMetadata }); }
  async get(key) {
    this.getCalls += 1;
    const record = this.data.get(key);
    return record === undefined ? null : { json: async () => JSON.parse(record.value) };
  }
  async delete(key) { this.data.delete(key); }
  async list({ prefix, limit }) {
    const objects = [...this.data.keys()].filter((item) => item.startsWith(prefix)).slice(0, limit)
      .map((key) => ({ key, customMetadata: this.data.get(key).customMetadata }));
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

test("embedded Quizzy app is exposed as an MCP UI resource", async () => {
  const request = (method, params) => worker.fetch(new Request("https://example.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params })
  }), env);
  const listed = (await (await request("tools/list")).json()).result.tools;
  const opener = listed.find((item) => item.name === "open_quizzy");
  assert.equal(opener._meta.ui.resourceUri, "ui://quizzy/study-v1.html");
  const resource = (await (await request("resources/read", { uri: opener._meta.ui.resourceUri })).json()).result.contents[0];
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.match(resource.text, /id="make-form"/);
  assert.match(resource.text, /sendFollowUpMessage/);
  assert.doesNotMatch(resource.text, /href="https:\/\/chatgpt.com/);
  const script = resource.text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  const opened = await call("student-a", "open_quizzy");
  assert.equal(opened.data.title, "كويزي");
  assert.ok(Array.isArray(opened.data.quizzes));
});

test("embedded app saves only selected PDF pages and starts ChatGPT without typing", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "resources/read",
      params: { uri: "ui://quizzy/study-v1.html" } })
  }), env);
  const html = (await response.json()).result.contents[0].text;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const makeNode = () => ({ children: [], classList: { toggle() {} }, listeners: {},
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(type, callback) { this.listeners[type] = callback; }, textContent: "" });
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); },
    createElement: makeNode
  };
  let sent, saved;
  const pageText = "عملية التمثيل الضوئي تستخدم الضوء لتحويل الماء وثاني أكسيد الكربون إلى جلوكوز وأكسجين داخل البلاستيدات الخضراء.";
  const window = { openai: {
    callTool: async (name, args) => {
      if (name === "save_source_for_generation") {
        saved = args;
        return { structuredContent: { saved: true, source_id: "source-123", source_name: args.source_name, count: args.count } };
      }
      if (name === "list_my_sources") return { structuredContent: { sources: [] } };
      return { structuredContent: { quizzes: [] } };
    },
    sendFollowUpMessage: async ({ prompt }) => { sent = prompt; }
  }, pdfjsLib: {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: 2,
      getPage: async (n) => ({ getTextContent: async () => ({ items: [{ str: n === 1 ? "غلاف المحاضرة" : pageText }] }) })
    }) })
  } };
  new Function("window", "document", script)(window, document);
  document.getElementById("file").files = [{ name: "lecture.pdf", size: 20, arrayBuffer: async () => new ArrayBuffer(2) }];
  document.getElementById("pages").value = "2";
  document.getElementById("count").value = "10";
  document.getElementById("difficulty").value = "easy";
  document.getElementById("mode").value = "practice";
  await document.getElementById("make-form").listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(sent);
  assert.deepEqual(saved.pages.map((item) => item.number), [2]);
  assert.match(saved.pages[0].text, /التمثيل الضوئي/);
  assert.doesNotMatch(saved.pages[0].text, /غلاف المحاضرة/);
  assert.match(sent, /source-123/);
  assert.doesNotMatch(sent, /التمثيل الضوئي/);
  assert.match(sent, /10 سؤالًا/);
});

test("embedded app opens the saved quiz after ChatGPT confirms creation", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/read",
      params: { uri: "ui://quizzy/study-v1.html" } })
  }), env);
  const html = (await response.json()).result.contents[0].text;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const makeNode = () => ({ children: [], classList: { toggle() {} }, listeners: {},
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(type, callback) { this.listeners[type] = callback; }, textContent: "" });
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); },
    createElement: makeNode
  };
  let modelStarted = false;
  const calls = [];
  const quiz = { id: "8fb43b25-789e-4f93-935e-4a3da6b24b4a", title: "اختبار محفوظ",
    source_name: "lecture.pdf", source_id: "source-456", question_count: 1, answered_count: 0 };
  const window = { openai: {
    callTool: async (name, args) => {
      calls.push(name);
      if (name === "save_source_for_generation") return { structuredContent: {
        saved: true, source_id: "source-456", source_name: args.source_name, count: args.count
      } };
      if (name === "list_my_sources") return { structuredContent: { sources: [] } };
      if (name === "list_my_quizzes") return { structuredContent: { quizzes: modelStarted ? [quiz] : [] } };
      if (name === "get_quiz_question") return { structuredContent: {
        quiz, question: { stem: question.stem, source_page: 2, choices: question.choices }, answered: false
      } };
      throw new Error("Unexpected tool: " + name + JSON.stringify(args));
    },
    sendFollowUpMessage: async () => { modelStarted = true; }
  }, pdfjsLib: {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: page }] }) })
    }) })
  } };
  const immediateTimer = (callback) => { queueMicrotask(callback); return { unref() {} }; };
  new Function("window", "document", "setTimeout", script)(window, document, immediateTimer);
  document.getElementById("file").files = [{ name: "lecture.pdf", size: 20, arrayBuffer: async () => new ArrayBuffer(2) }];
  document.getElementById("pages").value = "1";
  document.getElementById("count").value = "10";
  document.getElementById("difficulty").value = "easy";
  document.getElementById("mode").value = "practice";
  await document.getElementById("make-form").listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.includes("get_quiz_question"));
  assert.match(document.getElementById("status").textContent, /حُفظ 1 سؤالًا/);
});

test("long quiz: the screen keeps waiting while ChatGPT saves batch after batch, and never closes it early — embedded app opens the saved quiz after ChatGPT confirms creation", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/read",
      params: { uri: "ui://quizzy/study-v1.html" } })
  }), env);
  const html = (await response.json()).result.contents[0].text;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const makeNode = () => ({ children: [], classList: { toggle() {} }, listeners: {},
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(type, callback) { this.listeners[type] = callback; }, textContent: "" });
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); },
    createElement: makeNode
  };
  let modelStarted = false; let polls = 0;
  const calls = [];
  const quiz = { id: "8fb43b25-789e-4f93-935e-4a3da6b24b4a", title: "اختبار محفوظ",
    source_name: "lecture.pdf", source_id: "source-456", question_count: 1, answered_count: 0 };
  const window = { openai: {
    callTool: async (name, args) => {
      calls.push(name);
      if (name === "save_source_for_generation") return { structuredContent: {
        saved: true, source_id: "source-456", source_name: args.source_name, count: args.count
      } };
      if (name === "list_my_sources") return { structuredContent: { sources: [] } };
      if (name === "list_my_quizzes") { if (!modelStarted) return { structuredContent: { quizzes: [] } }; polls++; const n = Math.min(10, polls * 2); return { structuredContent: { quizzes: [{ ...quiz, question_count: n, generation_status: n < 10 ? "generating" : "ready" }] } }; }
      if (name === "finish_quiz_generation") throw new Error("closed early");
      if (name === "get_quiz_question") return { structuredContent: {
        quiz, question: { stem: question.stem, source_page: 2, choices: question.choices }, answered: false
      } };
      throw new Error("Unexpected tool: " + name + JSON.stringify(args));
    },
    sendFollowUpMessage: async () => { modelStarted = true; }
  }, pdfjsLib: {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: page }] }) })
    }) })
  } };
  const immediateTimer = (callback) => { queueMicrotask(callback); return { unref() {} }; };
  new Function("window", "document", "setTimeout", script)(window, document, immediateTimer);
  document.getElementById("file").files = [{ name: "lecture.pdf", size: 20, arrayBuffer: async () => new ArrayBuffer(2) }];
  document.getElementById("pages").value = "1";
  document.getElementById("count").value = "10";
  document.getElementById("difficulty").value = "easy";
  document.getElementById("mode").value = "practice";
  await document.getElementById("make-form").listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.includes("get_quiz_question"));
  assert.ok(!calls.includes("finish_quiz_generation"), "never closed while it was still growing"); assert.match(document.getElementById("status").textContent, /حُفظ 10 سؤالًا/);
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

test("practice review does not expose unanswered questions", async () => {
  const created = await call("student-d", "create_quiz_from_slides", {
    title: "تدريب", source_name: "slides.pdf", mode: "practice", pages: [{ number: 2, text: page }],
    questions: [question, { ...question, stem: "أين تحدث العملية الحيوية بحسب نص الصفحة؟",
      objective: "تحديد موقع العملية الحيوية", evidence: "داخل البلاستيدات الخضراء",
      choices: [{ id: "a", text: "في النواة" }, { id: "b", text: "في الميتوكوندريا" },
        { id: "c", text: "في الريبوسومات" }, { id: "d", text: "في البلاستيدات الخضراء" }],
      correct_choice_id: "d" }]
  });
  const id = created.data.id;
  await call("student-d", "submit_quiz_answer", { quiz_id: id, question_number: 1, choice_id: "a" });
  const review = await call("student-d", "get_quiz_review", { quiz_id: id });
  assert.equal(review.data.complete, false);
  assert.equal(review.data.total, 2);
  assert.equal(review.data.answered_count, 1);
  assert.equal(review.data.review.length, 1);
  assert.equal(review.data.review[0].question_number, 1);
});

test("browser dashboard assets and owner-scoped quiz lifecycle", async () => {
  for (const path of ["/", "/app.css", "/app.js", "/favicon.svg"]) {
    const response = await worker.fetch(new Request("https://example.test" + path), env);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 200);
  }
  const created = await call("web-student", "create_quiz_from_slides", {
    title: "اختبار واجهة", source_name: "lecture.pdf", pages: [{ number: 2, text: page }], questions: [question]
  });
  const id = created.data.id;
  const browser = async (user, path, method = "GET", body, origin = "https://example.test") => {
    const response = await worker.fetch(new Request("https://example.test" + path, {
      method, headers: { "oai-authenticated-user-id": user, origin, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), env);
    return { status: response.status, data: await response.json() };
  };
  const list = await browser("web-student", "/api/quizzes");
  assert.equal(list.data.quizzes.some((quiz) => quiz.id === id), true);
  assert.equal((await browser("other-student", "/api/quizzes/" + id + "/question/1")).status, 404);
  const questionResponse = await browser("web-student", "/api/quizzes/" + id + "/question/1");
  assert.equal(questionResponse.data.question.correct_choice_id, undefined);
  assert.equal((await browser("web-student", "/api/quizzes/" + id + "/answer", "POST", {
    question_number: 1, choice_id: "b"
  }, "https://attacker.test")).status, 403);
  const answer = await browser("web-student", "/api/quizzes/" + id + "/answer", "POST", {
    question_number: 1, choice_id: "b"
  });
  assert.equal(answer.data.saved, true);
  const review = await browser("web-student", "/api/quizzes/" + id + "/review");
  assert.equal(review.data.wrong_questions[0].correct_choice_text, "الجلوكوز والأكسجين");
  const retry = await browser("web-student", "/api/quizzes/" + id + "/restart", "POST");
  assert.equal(retry.data.saved, true);
  assert.equal(retry.data.answered_count, 0);
  assert.equal(retry.data.attempt_of, id);
  assert.equal((await browser("web-student", "/api/quizzes/" + retry.data.id, "DELETE")).data.deleted, true);
  assert.equal((await browser("web-student", "/api/quizzes/" + id, "DELETE")).data.deleted, true);
  assert.equal((await browser("web-student", "/api/quizzes")).data.quizzes.length, 0);
  assert.equal((await browser("", "/api/quizzes")).status, 401);
});

test("Site stages readable source for ChatGPT, then saves a grounded quiz for its owner", async () => {
  const site = async (user, body, origin = "https://example.test") => {
    const response = await worker.fetch(new Request("https://example.test/api/sources", {
      method: "POST", headers: { "oai-authenticated-user-id": user, origin, "content-type": "application/json" },
      body: JSON.stringify(body)
    }), env);
    return { status: response.status, data: await response.json() };
  };
  const input = { source_name: "lecture.pdf", pages: [{ number: 2, text: page }],
    count: 20, difficulty: "mixed", mode: "practice", unreadable_pages: [1] };
  assert.equal((await site("source-owner", input, "https://attacker.test")).status, 403);
  const staged = await site("source-owner", input);
  assert.equal(staged.status, 200);
  assert.equal(staged.data.saved, true);
  assert.equal(staged.data.page_count, 1);
  const source_id = staged.data.source_id;
  const listResponse = await worker.fetch(new Request("https://example.test/api/sources", {
    headers: { "oai-authenticated-user-id": "source-owner" }
  }), env);
  assert.equal((await listResponse.json()).sources.some((item) => item.source_id === source_id), true);
  const otherList = await worker.fetch(new Request("https://example.test/api/sources", {
    headers: { "oai-authenticated-user-id": "other-owner" }
  }), env);
  assert.equal((await otherList.json()).sources.some((item) => item.source_id === source_id), false);
  assert.equal((await call("other-owner", "get_source_for_generation", { source_id })).isError, true);
  const source = await call("source-owner", "get_source_for_generation", { source_id });
  assert.equal(source.data.pages[0].number, 2);
  assert.equal(source.data.count, 20);
  const invented = await call("source-owner", "create_quiz_from_slides", {
    source_id, pages: [{ number: 2, text: "دليل مختلق وغير موجود في الملف" }],
    questions: [{ ...question, evidence: "دليل مختلق وغير موجود في الملف" }]
  });
  assert.equal(invented.isError, true);
  const created = await call("source-owner", "create_quiz_from_slides", { source_id, questions: [question] });
  assert.equal(created.data.saved, true);
  assert.equal(created.data.source_name, "lecture.pdf");
  assert.equal(created.data.source_id, source_id);
  assert.equal(created.data.generation_status, "generating");
  assert.equal((await call("source-owner", "get_source_for_generation", { source_id })).isError, false);
  assert.equal((await call("source-owner", "list_my_sources")).data.sources.some((item) => item.source_id === source_id), true);
  assert.equal((await call("source-owner", "finish_quiz_generation", { quiz_id: created.data.id })).data.generation_status, "ready");
  assert.equal((await call("source-owner", "create_quiz_from_slides", { source_id, questions: [question] })).data.saved, true);
  assert.equal((await call("other-owner", "get_quiz_question", { quiz_id: created.data.id, question_number: 1 })).isError, true);
  assert.equal((await site("source-owner", { ...input, count: 15 })).status, 400);
  const another = await site("source-owner", input);
  const deleted = await worker.fetch(new Request("https://example.test/api/sources/" + another.data.source_id, {
    method: "DELETE", headers: { "oai-authenticated-user-id": "source-owner", origin: "https://example.test" }
  }), env);
  assert.equal((await deleted.json()).deleted, true);
  assert.equal((await call("source-owner", "get_source_for_generation", { source_id: another.data.source_id })).isError, true);
});

test("cards from a grounded quiz save per-student review state", async () => {
  const created = await call("cards-owner", "create_quiz_from_slides", {
    title: "بطاقات الأحياء", source_name: "biology.pdf", pages: [{ number: 2, text: page }], questions: [question]
  });
  const quiz_id = created.data.id;
  const cards = await call("cards-owner", "get_quiz_cards", { quiz_id });
  assert.equal(cards.data.cards.length, 1);
  assert.equal(cards.data.cards[0].front, question.stem);
  assert.equal(cards.data.cards[0].back, "الجلوكوز والأكسجين");
  assert.equal(cards.data.cards[0].source_page, 2);
  assert.equal(cards.data.cards[0].state, "new");
  const question_id = cards.data.cards[0].id;
  assert.equal((await call("other-cards-owner", "get_quiz_cards", { quiz_id })).isError, true);
  assert.equal((await call("other-cards-owner", "set_quiz_card_state", { quiz_id, question_id, state: "review" })).isError, true);
  assert.equal((await call("cards-owner", "set_quiz_card_state", { quiz_id, question_id, state: "review" })).data.saved, true);
  assert.equal((await call("cards-owner", "get_quiz_cards", { quiz_id })).data.cards[0].state, "review");
  assert.equal((await call("cards-owner", "set_quiz_card_state", { quiz_id, question_id, state: "invalid" })).isError, true);
});

test("standalone Site offers ChatGPT source handoff and has valid client script", async () => {
  const html = await (await worker.fetch(new Request("https://example.test/"), env)).text();
  assert.match(html, /id="source-file"/);
  assert.match(html, /احفظ الملف وافتح ChatGPT/);
  assert.doesNotMatch(html, /محرّك كويزي المحلي/);
  const response = await worker.fetch(new Request("https://example.test/app.js"), env);
  const script = await response.text();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /get_source_for_generation/);
  assert.doesNotMatch(script, /local_rules/);
});

test("quiz list uses small stored summaries instead of reading source pages again", async () => {
  const bucket = new Bucket();
  const storage = { BUCKET: bucket };
  await runTool("create_quiz_from_slides", {
    title: "سرعة القائمة", source_name: "lecture.pdf", pages: [{ number: 2, text: page }],
    questions: [question]
  }, storage, "speed-student");
  bucket.getCalls = 0;
  const result = await runTool("list_my_quizzes", {}, storage, "speed-student");
  assert.equal(result.quizzes.length, 1);
  assert.equal(bucket.getCalls, 0);
});
