const VERSION = "2026-07-28";
const IDENTITIES = [
  "Basic Recall", "Understanding", "Mechanisms & Detail", "Application",
  "Critical Thinking", "Clinical Scenarios", "Compare & Contrast",
  "Most Correct / Best Answer", "NOT / EXCEPT", "Sequence / Ordering"
];

const textBlock = (value) => ({ type: "text", text: JSON.stringify(value) });
const toolResult = (value, isError = false) => ({ content: [textBlock(value)], isError });
const tidy = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const key = (user, quiz) => `users/${encodeURIComponent(user)}/quizzes/${encodeURIComponent(quiz)}.json`;
const safeText = (value, max) => tidy(value).slice(0, max);

async function readQuiz(env, user, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error("معرّف الكويز غير صالح.");
  const object = await env.BUCKET.get(key(user, id));
  if (!object) throw new Error("الكويز غير موجود في حسابك.");
  return object.json();
}
async function writeQuiz(env, user, quiz) {
  quiz.updated_at = new Date().toISOString();
  await env.BUCKET.put(key(user, quiz.id), JSON.stringify(quiz), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

function validatePages(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new Error("أرسل من 1 إلى 100 صفحة مقروءة.");
  const seen = new Set();
  const pages = raw.map((page) => {
    const number = Number(page.number);
    const content = safeText(page.text, 12000);
    if (!Number.isInteger(number) || number < 1 || seen.has(number) || content.length < 30) {
      throw new Error("رقم صفحة مكرر أو نص صفحة غير كافٍ. اذكر الصفحات غير المقروءة للطالب.");
    }
    seen.add(number);
    return { number, text: content };
  });
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > 300000) {
    throw new Error("المصدر كبير لهذه العملية. اختر نطاق صفحات أصغر.");
  }
  return pages;
}

function validateQuestions(raw, pages, existing = []) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) {
    throw new Error("أرسل من 1 إلى 30 سؤالًا في الدفعة الواحدة.");
  }
  const pageMap = new Map(pages.map((page) => [page.number, page.text]));
  const stems = new Set(existing.map((q) => tidy(q.stem).toLocaleLowerCase()));
  const objectives = new Set(existing.map((q) => tidy(q.objective).toLocaleLowerCase()));
  return raw.map((item, index) => {
    const stem = safeText(item.stem, 1200);
    const objective = safeText(item.objective, 300);
    const explanation = safeText(item.explanation, 1600);
    const evidence = safeText(item.evidence, 1200);
    const page = Number(item.source_page);
    const identity = tidy(item.identity);
    const choices = item.choices;
    const stemKey = stem.toLocaleLowerCase();
    const objectiveKey = objective.toLocaleLowerCase();
    if (!stem || stem.length < 12 || !objective || !explanation || !IDENTITIES.includes(identity)) {
      throw new Error(`السؤال ${index + 1}: النص أو الغرض أو التفسير أو قسم الهوية ناقص.`);
    }
    if (stems.has(stemKey) || objectives.has(objectiveKey)) {
      throw new Error(`السؤال ${index + 1}: تكرار في السؤال أو غرضه؛ غيّر المهمة المعرفية لا الألفاظ فقط.`);
    }
    if (!pageMap.has(page) || evidence.length < 12 || !tidy(pageMap.get(page)).toLocaleLowerCase().includes(evidence.toLocaleLowerCase())) {
      throw new Error(`السؤال ${index + 1}: الدليل لا يطابق نص الصفحة المختارة.`);
    }
    if (!Array.isArray(choices) || choices.length !== 4) {
      throw new Error(`السؤال ${index + 1}: يلزم أربعة خيارات.`);
    }
    const cleanChoices = choices.map((choice) => ({
      id: safeText(choice.id, 20), text: safeText(choice.text, 500)
    }));
    if (cleanChoices.some((choice) => !choice.id || !choice.text) ||
        new Set(cleanChoices.map((choice) => choice.id)).size !== 4 ||
        new Set(cleanChoices.map((choice) => choice.text.toLocaleLowerCase())).size !== 4 ||
        !cleanChoices.some((choice) => choice.id === item.correct_choice_id)) {
      throw new Error(`السؤال ${index + 1}: الخيارات مكررة أو مفتاح الإجابة غير مطابق.`);
    }
    stems.add(stemKey);
    objectives.add(objectiveKey);
    return {
      id: crypto.randomUUID(), stem, objective, explanation, evidence,
      source_page: page, identity, choices: cleanChoices,
      correct_choice_id: item.correct_choice_id,
      version: 1, review_status: "model_generated_source_quote_checked"
    };
  });
}

function summary(quiz) {
  const answered = Object.keys(quiz.answers ?? {}).length;
  const identities = [...new Set(quiz.questions.map((q) => q.identity))];
  return {
    id: quiz.id, title: quiz.title, source_name: quiz.source_name,
    question_count: quiz.questions.length, answered_count: answered,
    mode: quiz.mode, identities, missing_identities: IDENTITIES.filter((name) => !identities.includes(name)),
    created_at: quiz.created_at, updated_at: quiz.updated_at
  };
}

const questionShape = {
  type: "object", additionalProperties: false,
  required: ["stem", "choices", "correct_choice_id", "explanation", "identity", "objective", "source_page", "evidence"],
  properties: {
    stem: { type: "string" },
    choices: { type: "array", minItems: 4, maxItems: 4, items: { type: "object", required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" } } } },
    correct_choice_id: { type: "string" }, explanation: { type: "string" },
    identity: { type: "string", enum: IDENTITIES }, objective: { type: "string" },
    source_page: { type: "integer" }, evidence: { type: "string" }
  }
};

const TOOLS = [
  {
    name: "create_quiz_from_slides",
    description: "أنشئ كويز كويزي من ملف رفعه الطالب داخل محادثة ChatGPT. اقرأ الملف أولًا وحدد الصفحات المقروءة بدقة. انسخ نص المصدر والاقتباس الداعم من الصفحة نفسها، ثم صغ أسئلة متنوعة بأربع خيارات وجواب واحد. لا تختلق نص صفحة أو دليلًا. إن تعذر قراءة الملف فأخبر الطالب ولا تستدع الأداة. أسئلة هذا التطبيق يولدها نموذج ChatGPT في المحادثة، ولا تستدعي الأداة نموذجًا آخر.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["title", "source_name", "pages", "questions"],
      properties: {
        title: { type: "string" }, source_name: { type: "string" },
        mode: { type: "string", enum: ["practice", "exam"] },
        pages: { type: "array", items: { type: "object", required: ["number", "text"], properties: { number: { type: "integer" }, text: { type: "string" } } } },
        questions: { type: "array", minItems: 1, maxItems: 30, items: questionShape }
      }
    }
  },
  {
    name: "add_quiz_questions",
    description: "أضف دفعة أسئلة جديدة إلى كويز محفوظ حتى 100 سؤال إجمالًا. استخدم الصفحة والدليل المحفوظين وغيّر الغرض وطريقة التفكير؛ لا تكرر الفكرة بتبديل الكلمات.",
    inputSchema: { type: "object", required: ["quiz_id", "questions"], properties: { quiz_id: { type: "string" }, questions: { type: "array", minItems: 1, maxItems: 30, items: questionShape } } }
  },
  {
    name: "list_my_quizzes",
    description: "اعرض كويزات الطالب المحفوظة في حسابه داخل كويزي، مع عدد الأسئلة والتقدم.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_quiz_question",
    description: "اعرض سؤالًا من كويز محفوظ دون كشف المفتاح. يبدأ ترقيم الأسئلة من 1. يمكن استخدامه لاستئناف الحل.",
    inputSchema: { type: "object", required: ["quiz_id", "question_number"], properties: { quiz_id: { type: "string" }, question_number: { type: "integer", minimum: 1 } } }
  },
  {
    name: "submit_quiz_answer",
    description: "احفظ إجابة الطالب لسؤال في حسابه. التدريب يعرض التصحيح فورًا؛ الاختبار يحجبه حتى الإجابة عن الكل. لا تعلن نجاح الحفظ إلا بعد نجاح الأداة.",
    inputSchema: { type: "object", required: ["quiz_id", "question_number", "choice_id"], properties: { quiz_id: { type: "string" }, question_number: { type: "integer", minimum: 1 }, choice_id: { type: "string" } } }
  },
  {
    name: "get_quiz_review",
    description: "اعرض النتيجة والأسئلة الخاطئة والتفسيرات من كويز الطالب المحفوظ. في وضع الاختبار لا تُظهر الإجابات قبل اكتمال المحاولة.",
    inputSchema: { type: "object", required: ["quiz_id"], properties: { quiz_id: { type: "string" } } }
  }
];

async function runTool(name, args, env, user) {
  if (!env.BUCKET) throw new Error("تخزين كويزي غير مفعّل على الخادم.");
  if (name === "create_quiz_from_slides") {
    const pages = validatePages(args.pages);
    const questions = validateQuestions(args.questions, pages);
    const now = new Date().toISOString();
    const quiz = {
      id: crypto.randomUUID(), title: safeText(args.title, 160),
      source_name: safeText(args.source_name, 160), mode: args.mode === "exam" ? "exam" : "practice",
      pages, questions, answers: {}, created_at: now, updated_at: now
    };
    if (!quiz.title || !quiz.source_name) throw new Error("اسم المصدر وعنوان الكويز مطلوبان.");
    await writeQuiz(env, user, quiz);
    return { saved: true, ...summary(quiz), note: "فُحص تطابق الاقتباسات مع النص المرسل للأداة. لم تُجرَ مراجعة بشرية مستقلة للملف." };
  }
  if (name === "list_my_quizzes") {
    const result = await env.BUCKET.list({ prefix: `users/${encodeURIComponent(user)}/quizzes/`, limit: 100 });
    const quizzes = await Promise.all(result.objects.map(async (item) => {
      const object = await env.BUCKET.get(item.key);
      return object ? summary(await object.json()) : null;
    }));
    return { quizzes: quizzes.filter(Boolean).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), truncated: result.truncated };
  }
  const quiz = await readQuiz(env, user, args.quiz_id);
  if (name === "add_quiz_questions") {
    if (Object.keys(quiz.answers).length) throw new Error("بدأ حل هذا الكويز؛ أنشئ كويزًا جديدًا للحفاظ على نسخة المحاولة.");
    if (quiz.questions.length + (args.questions?.length ?? 0) > 100) throw new Error("الحد الأقصى 100 سؤال للكويز.");
    quiz.questions.push(...validateQuestions(args.questions, quiz.pages, quiz.questions));
    await writeQuiz(env, user, quiz);
    return { saved: true, ...summary(quiz) };
  }
  if (name === "get_quiz_question") {
    const index = Number(args.question_number) - 1;
    const question = quiz.questions[index];
    if (!question) throw new Error("رقم السؤال خارج الكويز.");
    return {
      quiz: summary(quiz), question_number: index + 1,
      question: { id: question.id, stem: question.stem, choices: question.choices, identity: question.identity, source_page: question.source_page },
      answered: Boolean(quiz.answers[question.id])
    };
  }
  if (name === "submit_quiz_answer") {
    const index = Number(args.question_number) - 1;
    const question = quiz.questions[index];
    if (!question) throw new Error("رقم السؤال خارج الكويز.");
    if (!question.choices.some((choice) => choice.id === args.choice_id)) throw new Error("معرّف الخيار غير موجود.");
    if (quiz.answers[question.id]) throw new Error("أُجيب عن السؤال سابقًا؛ لن تُستبدل الإجابة المحفوظة.");
    quiz.answers[question.id] = { choice_id: args.choice_id, answered_at: new Date().toISOString() };
    await writeQuiz(env, user, quiz);
    const complete = Object.keys(quiz.answers).length === quiz.questions.length;
    return {
      saved: true, question_number: index + 1, answered_count: Object.keys(quiz.answers).length,
      total: quiz.questions.length, complete,
      ...(quiz.mode === "practice" || complete ? {
        correct: args.choice_id === question.correct_choice_id,
        correct_choice_id: question.correct_choice_id, explanation: question.explanation,
        source_page: question.source_page, evidence: question.evidence
      } : {})
    };
  }
  if (name === "get_quiz_review") {
    const complete = Object.keys(quiz.answers).length === quiz.questions.length;
    if (quiz.mode === "exam" && !complete) {
      return { complete: false, answered_count: Object.keys(quiz.answers).length, total: quiz.questions.length, message: "أكمل الاختبار قبل مراجعة الإجابات." };
    }
    const review = quiz.questions.flatMap((question, index) => {
      const answer = quiz.answers[question.id];
      if (!answer) return [];
      return [{
      question_number: index + 1, stem: question.stem,
      selected_choice_id: answer.choice_id,
      correct_choice_id: question.correct_choice_id,
      correct: answer.choice_id === question.correct_choice_id,
      explanation: question.explanation, source_page: question.source_page,
      evidence: question.evidence, identity: question.identity
      }];
    });
    return {
      complete, score: review.filter((item) => item.correct).length,
      answered_count: review.length, total: quiz.questions.length,
      wrong_questions: review.filter((item) => !item.correct),
      review
    };
  }
  throw new Error("أداة غير معروفة.");
}

function landing() {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>كويزي داخل ChatGPT</title><style>body{margin:0;min-height:100vh;background:#101a2a;color:#eef5f3;font-family:system-ui,sans-serif;display:grid;place-items:center}main{max-width:610px;padding:32px}.tag{color:#a4decf;letter-spacing:.12em;font-size:14px}h1{font-size:clamp(38px,7vw,66px);line-height:1.12;margin:12px 0}p{color:#c6d4d5;line-height:1.9}a{color:#a4decf}.card{background:#19283c;border:1px solid #304958;border-radius:24px;padding:28px;margin-top:28px}ol{line-height:2.1;padding-right:22px}</style><main><div class="tag">QUIZZY · CHATGPT APP</div><h1>اسأل ملفك، وابدأ الكويز.</h1><p>نسخة كويزي داخل ChatGPT: يقرأ نموذج المحادثة السلايدات التي ترفعها هنا، ويكوّن أسئلة من صفحاتها، ثم تحفظ أدوات كويزي الكويز وإجاباتك.</p><div class="card"><strong>للبدء داخل ChatGPT</strong><ol><li>ثبّت تطبيق كويزي الخاص من قائمة التطبيقات.</li><li>ارفع PDF أو PPTX في المحادثة.</li><li>اكتب: «كوّن لي كويز من هذا الملف باستخدام كويزي».</li></ol><p>التوليد يعتمد على قدرة حساب ChatGPT والملف المرفوع. لا يلزم مفتاح API لصاحب الموقع لهذا المسار.</p></div><p>الموقع المستقل الحالي: <a href="https://sasfas18-eng.github.io/quizzy/">كويزي على GitHub</a></p></main></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(landing(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname !== "/mcp" || request.method !== "POST") return new Response("Not found", { status: 404 });
    let payload;
    try { payload = await request.json(); } catch { return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
    const id = payload?.id ?? null;
    const reply = (result) => Response.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
    if (payload?.method === "server/discover") return reply({ supportedVersions: [VERSION], capabilities: { tools: {} } });
    if (payload?.method === "tools/list") return reply({ tools: TOOLS });
    if (payload?.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const user = request.headers.get("oai-authenticated-user-id");
    if (!user) return reply(toolResult({ error: "يلزم تسجيل الدخول إلى ChatGPT لاستخدام أدوات كويزي." }, true));
    const name = payload.params?.name;
    if (!TOOLS.some((tool) => tool.name === name)) return reply(toolResult({ error: "أداة غير معروفة." }, true));
    try {
      return reply(toolResult(await runTool(name, payload.params?.arguments ?? {}, env, user)));
    } catch (error) {
      return reply(toolResult({ error: error instanceof Error ? error.message : "تعذرت العملية." }, true));
    }
  }
};

export { runTool, validatePages, validateQuestions, TOOLS };
