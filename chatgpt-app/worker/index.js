import "./owner_rules.js";      // the owner's lecture_reader.py + quiz_engine.py rules, ported (shared/owner_rules.js; the build inlines it)
const O = globalThis.QZ_OWNER;
const VERSION = "2026-07-28";
const WIDGET_URI = "ui://quizzy/study-v1.html";
const IDENTITIES = [
  "Basic Recall", "Understanding", "Mechanisms & Detail", "Application",
  "Critical Thinking", "Clinical Scenarios", "Compare & Contrast",
  "Most Correct / Best Answer", "NOT / EXCEPT", "Sequence / Ordering"
];

const textBlock = (value) => ({ type: "text", text: JSON.stringify(value) });
const toolResult = (value, isError = false) => ({ content: [textBlock(value)], isError });
const tidy = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const key = (user, quiz) => `users/${encodeURIComponent(user)}/quizzes/${encodeURIComponent(quiz)}.json`;
const sourceKey = (user, source) => `users/${encodeURIComponent(user)}/sources/${encodeURIComponent(source)}.json`;
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
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { summary: JSON.stringify(summary(quiz)) }
  });
}

function validatePages(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new Error("أرسل من 1 إلى 100 صفحة مقروءة.");
  const seen = new Set();
  const pages = raw.map((page) => {
    const number = Number(page.number);
    const content = String(page.text ?? "").normalize("NFKC").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").slice(0, 12000);
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
    source_id: quiz.source_id ?? null,
    question_count: quiz.questions.length, answered_count: answered,
    requested_count: quiz.requested_count ?? quiz.questions.length,
    generation_status: quiz.generation_status ?? "ready",
    shortfall: Math.max(0, (quiz.requested_count ?? quiz.questions.length) - quiz.questions.length),
    mode: quiz.mode, identities, missing_identities: IDENTITIES.filter((name) => !identities.includes(name)),
    created_at: quiz.created_at, updated_at: quiz.updated_at,
    generator: quiz.generator ?? "chatgpt_conversation",
    attempt_of: quiz.attempt_of ?? null
  };
}

/** lecture_reader on a saved source: every part of every page classified by the owner's rules. The model that writes the questions (ChatGPT in this
 *  conversation) is the reader of the uncertain parts; excluded and context-only parts are never evidence. Kept with the source. */
function readSourcePages(pages, id) {
  const report = O.readPages(pages.map((page) => O.pageFromText(page.number, page.text)), "source-" + id);
  return { counts: report.counts(), units: report.units.map((u) => ({ page: u.page, text: u.text, decision: u.decision, category: u.category })) };
}
function readingOf(source) { if (!source.reading) source.reading = readSourcePages(source.pages, source.id); return source.reading; }
/** validate_question_evidence, for a saved source: the quote lies in an assessable part of its page (include, or an uncertain part the model judged
 *  to be taught content), never in a heading, an objective, a credit or a footer; and the question does not ask about the lecture's metadata. */
function ownerCheck(reading, item, index) {
  if (O.matches(O.QUESTION_META, String(item.stem ?? ""))) throw new Error(`السؤال ${index + 1}: يسأل عن المحاضر أو رقم المحاضرة أو أهدافها، لا عن محتواها (قواعد قراءة المحاضرة).`);
  const quote = tidy(item.evidence).toLocaleLowerCase(); const page = Number(item.source_page);
  const ok = reading.units.some((u) => u.page === page && (u.decision === "include" || u.decision === "review") && tidy(u.text).toLocaleLowerCase().includes(quote));
  if (!ok) throw new Error(`السؤال ${index + 1}: الاقتباس ليس من جزء تعليمي في الصفحة (عنوان أو هدف أو بيانات محاضر أو تذييل). استشهد بجملة تعليمية كاملة من الصفحة.`);
}
async function stageSource(raw, env, user) {
  const pages = validatePages(raw.pages);
  const source_name = safeText(raw.source_name, 160);
  const count = Number(raw.count);
  const difficulty = String(raw.difficulty || "mixed");
  if (!source_name || ![10, 20, 30, 50, 75, 100].includes(count) ||
      !["easy", "medium", "advanced", "mixed"].includes(difficulty)) {
    throw new Error("اسم الملف أو إعدادات الكويز غير صالحة.");
  }
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > 30000) {
    throw new Error("النطاق طويل للتوليد في محادثة واحدة؛ اختر صفحات أقل.");
  }
  const unreadable_pages = Array.isArray(raw.unreadable_pages)
    ? raw.unreadable_pages.filter((number) => Number.isInteger(number) && number > 0).slice(0, 100) : [];
  const source = { id: crypto.randomUUID(), source_name, pages, count, difficulty,
    mode: raw.mode === "exam" ? "exam" : "practice", unreadable_pages,
    created_at: new Date().toISOString() };
  source.reading = readSourcePages(pages, source.id);
  const sourceSummary = { source_id: source.id, source_name, page_count: pages.length,
    count, difficulty, mode: source.mode, unreadable_pages, created_at: source.created_at };
  await env.BUCKET.put(sourceKey(user, source.id), JSON.stringify(source), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { summary: JSON.stringify(sourceSummary) }
  });
  return { saved: true, source_id: source.id, source_name, page_count: pages.length,
    unreadable_pages, count, note: "حُفظ نص الصفحات في حسابك. لم يُنشأ الكويز بعد؛ سيولّده نموذج ChatGPT داخل المحادثة." };
}

async function readSource(env, user, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error("معرّف المصدر غير صالح.");
  const object = await env.BUCKET.get(sourceKey(user, id));
  if (!object) throw new Error("المصدر غير موجود في حسابك.");
  return object.json();
}

async function listSources(env, user) {
  const result = await env.BUCKET.list({ prefix: `users/${encodeURIComponent(user)}/sources/`,
    limit: 100, include: ["customMetadata"] });
  const sources = await Promise.all(result.objects.map(async (item) => {
    if (item.customMetadata?.summary) {
      try { return JSON.parse(item.customMetadata.summary); } catch { /* Read legacy object. */ }
    }
    const object = await env.BUCKET.get(item.key);
    if (!object) return null;
    const source = await object.json();
    return { source_id: source.id, source_name: source.source_name,
      page_count: source.pages.length, count: source.count, difficulty: source.difficulty,
      mode: source.mode, unreadable_pages: source.unreadable_pages,
      created_at: source.created_at };
  }));
  return { sources: sources.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    truncated: result.truncated };
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
    name: "open_quizzy",
    description: "افتح واجهة كويزي داخل ChatGPT لإنشاء كويز من ملف PDF أو PPTX ومتابعة الكويزات المحفوظة وحلها. استدع هذه الأداة عندما يطلب الطالب فتح التطبيق أو البدء من واجهته.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI }
  },
  {
    name: "save_source_for_generation",
    description: "احفظ نص صفحات PDF أو PPTX الذي قرأته واجهة كويزي المضمّنة في حساب الطالب قبل طلب التوليد. هذه الأداة تخزّن المصدر فقط ولا تنشئ أسئلة.",
    inputSchema: { type: "object", required: ["source_name", "pages", "count"], properties: {
      source_name: { type: "string" }, count: { type: "integer" },
      difficulty: { type: "string", enum: ["mixed", "easy", "medium", "advanced"] },
      mode: { type: "string", enum: ["practice", "exam"] },
      unreadable_pages: { type: "array", items: { type: "integer" } },
      pages: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["number", "text"], properties: { number: { type: "integer" }, text: { type: "string" } } } }
    } }
  },
  {
    name: "list_my_sources",
    description: "اعرض الملفات النصية التي رفعها الطالب في كويزي، ليعيد إنشاء كويز منها دون رفعها مجددًا.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "delete_my_source",
    description: "احذف نص مصدر محفوظ من حساب الطالب عندما يضغط حذف في كويزي. لا يحذف الكويزات المنشأة منه.",
    inputSchema: { type: "object", required: ["source_id"], properties: { source_id: { type: "string" } } }
  },
  {
    name: "get_source_for_generation",
    description: "اقرأ نص الصفحات الذي رفعه الطالب من صفحة كويزي المرتبطة بحساب ChatGPT. استخدم معرّف المصدر الذي أعطاه الطالب. لا تخمّن الصفحات الناقصة، ثم أنشئ الأسئلة بأداة create_quiz_from_slides مع source_id نفسه ليُفحص الدليل مقابل النص المحفوظ.",
    inputSchema: { type: "object", required: ["source_id"], properties: { source_id: { type: "string" } } }
  },
  {
    name: "create_quiz_from_slides",
    description: "أنشئ كويز كويزي من ملف رفعه الطالب داخل ChatGPT أو من source_id لملف محفوظ في موقع كويزي المرتبط. عند source_id استخدم get_source_for_generation أولًا وأرسل المصدر نفسه؛ يفحص الخادم الدليل مقابل الصفحات المحفوظة لا نسخة يكتبها النموذج. انسخ الاقتباس الداعم من الصفحة، وصغ أسئلة متنوعة بأربع خيارات وجواب واحد. لا تختلق نص صفحة أو دليلًا. أسئلة هذا التطبيق يولدها نموذج ChatGPT في المحادثة، ولا تستدعي الأداة نموذجًا آخر.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["questions"],
      properties: {
        title: { type: "string" }, source_name: { type: "string" },
        source_id: { type: "string" },
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
    name: "finish_quiz_generation",
    description: "اعتمد الكويز بعد اكتمال جميع الدفعات، أو عند عدم كفاية المصدر لعدد أكبر من الأسئلة المميزة. استدعها بعد الإضافة النهائية حتى يظهر الكويز للحل.",
    inputSchema: { type: "object", required: ["quiz_id"], properties: { quiz_id: { type: "string" } } }
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
  },
  {
    name: "get_quiz_cards",
    description: "اعرض بطاقات مراجعة من أسئلة الكويز الموثقة بالمصدر مع حالة كل بطاقة. يطلبها الطالب من تبويب البطاقات.",
    inputSchema: { type: "object", required: ["quiz_id"], properties: { quiz_id: { type: "string" } } }
  },
  {
    name: "set_quiz_card_state",
    description: "احفظ حالة بطاقة مراجعة في حساب الطالب: أعرفها أو تحتاج مراجعة.",
    inputSchema: { type: "object", required: ["quiz_id", "question_id", "state"], properties: {
      quiz_id: { type: "string" }, question_id: { type: "string" },
      state: { type: "string", enum: ["known", "review"] }
    } }
  },
  {
    name: "restart_my_quiz",
    description: "أنشئ محاولة جديدة من كويز الطالب نفسه مع الاحتفاظ بالنسخة والأسئلة الأصلية، وابدأها بلا إجابات.",
    inputSchema: { type: "object", required: ["quiz_id"], properties: { quiz_id: { type: "string" } } }
  },
  {
    name: "delete_my_quiz",
    description: "احذف كويزًا يملكه الطالب نهائيًا من حسابه، بما فيه إجابات المحاولة. استخدمها فقط عندما يطلب الطالب الحذف صراحة.",
    inputSchema: { type: "object", required: ["quiz_id"], properties: { quiz_id: { type: "string" } } }
  }
];

async function runTool(name, args, env, user, origin = "") {
  if (!env.BUCKET) throw new Error("تخزين كويزي غير مفعّل على الخادم.");
  if (name === "open_quizzy") {
    const data = await runTool("list_my_quizzes", {}, env, user, origin);
    return { title: "كويزي", ...data };
  }
  if (name === "save_source_for_generation") return await stageSource(args, env, user);
  if (name === "list_my_sources") return await listSources(env, user);
  if (name === "delete_my_source") {
    await readSource(env, user, args.source_id);
    await env.BUCKET.delete(sourceKey(user, args.source_id));
    return { deleted: true, source_id: args.source_id };
  }
  if (name === "get_source_for_generation") {
    const source = await readSource(env, user, args.source_id); const reading = readingOf(source);
    return { ...source, reading: undefined,
      reading_rules: { rules: O.ASSESSMENT_RULES,
        allowed_units: reading.units.filter((u) => u.decision === "include").map((u) => ({ page: u.page, text: u.text })),
        units_to_judge: reading.units.filter((u) => u.decision === "review").map((u) => ({ page: u.page, text: u.text, why: u.category })),
        how_to_judge: "Classify each units_to_judge item yourself: use it as evidence ONLY if it is explicit taught knowledge read with its page heading; presenter/institution credits, objectives, logistics and standalone headings are not quiz facts. Do not rewrite or complete it.",
        not_evidence: reading.counts },
      category_guides: O.STYLES, method: O.METHOD, review_before_saving: O.REVIEW_CRITERIA,
      instructions: "Write from allowed_units (and the units_to_judge you accept). Quote the evidence exactly from one of them. Vary the reasoning between questions, not only the opening words; never ask the same fact twice in other words. Check every question against review_before_saving before you save it." };
  }
  if (name === "create_quiz_from_slides") {
    const staged = args.source_id ? await readSource(env, user, args.source_id) : null;
    const pages = staged ? staged.pages : validatePages(args.pages);
    const reading = staged ? readingOf(staged) : null;
    if (reading) args.questions?.forEach?.((item, index) => ownerCheck(reading, item, index));
    const questions = validateQuestions(args.questions, pages);
    const now = new Date().toISOString();
    const quiz = {
      id: crypto.randomUUID(), title: safeText(args.title || staged?.source_name, 160),
      source_id: staged?.id ?? null,
      source_name: staged?.source_name || safeText(args.source_name, 160),
      mode: (staged?.mode || args.mode) === "exam" ? "exam" : "practice",
      pages, reading, questions, answers: {}, cards: {}, requested_count: staged?.count ?? questions.length,
      generation_status: staged && questions.length < staged.count ? "generating" : "ready",
      created_at: now, updated_at: now
    };
    if (!quiz.title || !quiz.source_name) throw new Error("اسم المصدر وعنوان الكويز مطلوبان.");
    await writeQuiz(env, user, quiz);
    return { saved: true, ...summary(quiz), quiz_url: origin ? `${origin}/?quiz=${quiz.id}` : null,
      note: "فُحص تطابق الاقتباسات مع النص المرسل للأداة. لم تُجرَ مراجعة بشرية مستقلة للملف." };
  }
  if (name === "list_my_quizzes") {
    const result = await env.BUCKET.list({ prefix: `users/${encodeURIComponent(user)}/quizzes/`, limit: 1000,
      include: ["customMetadata"] });
    const quizzes = await Promise.all(result.objects.map(async (item) => {
      if (item.customMetadata?.summary) {
        try { return JSON.parse(item.customMetadata.summary); } catch { /* Legacy object fallback below. */ }
      }
      const object = await env.BUCKET.get(item.key);
      return object ? summary(await object.json()) : null;
    }));
    const sorted = quizzes.filter(Boolean).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { quizzes: sorted.slice(0, 100), truncated: result.truncated || sorted.length > 100 };
  }
  const quiz = await readQuiz(env, user, args.quiz_id);
  if (name === "finish_quiz_generation") {
    if (quiz.generation_status === "ready") return { saved: true, ...summary(quiz) };
    quiz.generation_status = "ready";
    await writeQuiz(env, user, quiz);
    return { saved: true, ...summary(quiz) };
  }
  if (name === "get_quiz_cards") {
    return { quiz: summary(quiz), cards: quiz.questions.map((question) => ({
      id: question.id, front: question.stem,
      back: question.choices.find((choice) => choice.id === question.correct_choice_id)?.text ?? "",
      explanation: question.explanation, source_page: question.source_page,
      state: quiz.cards?.[question.id] ?? "new"
    })) };
  }
  if (name === "set_quiz_card_state") {
    if (!quiz.questions.some((question) => question.id === args.question_id)) throw new Error("البطاقة غير موجودة في كويزك.");
    if (!["known", "review"].includes(args.state)) throw new Error("حالة البطاقة غير صالحة.");
    quiz.cards ??= {};
    quiz.cards[args.question_id] = args.state;
    await writeQuiz(env, user, quiz);
    return { saved: true, quiz_id: quiz.id, question_id: args.question_id, state: args.state };
  }
  if (name === "delete_my_quiz") {
    await env.BUCKET.delete(key(user, quiz.id));
    return { deleted: true, quiz_id: quiz.id };
  }
  if (name === "restart_my_quiz") {
    const now = new Date().toISOString();
    const copy = { ...quiz, id: crypto.randomUUID(), answers: {}, attempt_of: quiz.id,
      created_at: now, updated_at: now };
    await writeQuiz(env, user, copy);
    return { saved: true, ...summary(copy), quiz_url: origin ? `${origin}/?quiz=${copy.id}` : null };
  }
  if (name === "add_quiz_questions") {
    if (Object.keys(quiz.answers).length) throw new Error("بدأ حل هذا الكويز؛ أنشئ كويزًا جديدًا للحفاظ على نسخة المحاولة.");
    if (quiz.questions.length + (args.questions?.length ?? 0) > 100) throw new Error("الحد الأقصى 100 سؤال للكويز.");
    if (quiz.reading) args.questions?.forEach?.((item, index) => ownerCheck(quiz.reading, item, index));
    quiz.questions.push(...validateQuestions(args.questions, quiz.pages, quiz.questions));
    if (quiz.questions.length >= (quiz.requested_count ?? quiz.questions.length)) quiz.generation_status = "ready";
    await writeQuiz(env, user, quiz);
    return { saved: true, ...summary(quiz) };
  }
  if (name === "get_quiz_question") {
    const index = Number(args.question_number) - 1;
    const question = quiz.questions[index];
    if (!question) throw new Error("رقم السؤال خارج الكويز.");
    const answer = quiz.answers[question.id];
    const complete = Object.keys(quiz.answers).length === quiz.questions.length;
    return {
      quiz: summary(quiz), question_number: index + 1,
      question: { id: question.id, stem: question.stem, choices: question.choices, identity: question.identity, source_page: question.source_page },
      answered: Boolean(answer), selected_choice_id: answer?.choice_id ?? null,
      ...((answer && (quiz.mode === "practice" || complete)) ? {
        feedback: { correct: answer.choice_id === question.correct_choice_id,
          correct_choice_id: question.correct_choice_id, explanation: question.explanation,
          source_page: question.source_page, evidence: question.evidence }
      } : {})
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
      selected_choice_text: question.choices.find((choice) => choice.id === answer.choice_id)?.text ?? "",
      correct_choice_id: question.correct_choice_id,
      correct_choice_text: question.choices.find((choice) => choice.id === question.correct_choice_id)?.text ?? "",
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

const BRAND_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#0F5D50"/><g transform="translate(10.27 52.75) scale(0.056 -0.056)"><path d="M40 150H556Q616 150 616 210V741H736V210Q736 102 692 51Q649 0 556 0H40Z" fill="#FBF6EA"/></g><path d="M24.2 29.2L29.4 35.6 37.2 20.2" fill="none" stroke="#FFD84A" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FAVICON = BRAND_SVG.replace('aria-hidden="true"', 'role="img" aria-label="شعار كويزي"');

// MCP Apps UI: displayed inside chatgpt.com by open_quizzy. The model is
// invoked through the host conversation, never through an API key in a widget.
const WIDGET_HTML = String.raw`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>كويزي</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;--bg:#101b19;--panel:#1a2b25;--line:#365045;--text:#f6f1e2;--muted:#b6c6bc;--mint:#70d7ba;--yellow:#f6d76b;--red:#ff9b85}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);line-height:1.6}main{max-width:760px;margin:auto;padding:20px}.head{display:flex;align-items:center;justify-content:space-between;gap:12px}.logo{font-size:25px;font-weight:850}.logo span{color:var(--mint)}.eyebrow{color:var(--mint);font-size:12px;margin:0 0 3px}.intro{color:var(--muted);font-size:14px;margin:12px 0 20px}.tabs{display:flex;gap:8px;margin:18px 0}.tabs button{flex:1}button,input,select{font:inherit}button{border:1px solid var(--line);border-radius:11px;background:var(--panel);color:var(--text);padding:10px 15px;cursor:pointer}button:hover{border-color:var(--mint)}button:disabled{opacity:.55;cursor:not-allowed}.primary{background:var(--mint);color:#10241e;font-weight:800;border-color:var(--mint)}.tab.active{border-color:var(--mint);color:var(--mint)}.panel{border:1px solid var(--line);background:var(--panel);padding:20px;border-radius:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:grid;gap:5px;color:var(--muted);font-size:13px;margin-bottom:13px}input,select{width:100%;background:#10211c;border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text)}input[type=file]{font-size:12px}.hint,.status{color:var(--muted);font-size:13px}.status{min-height:21px;margin-top:10px}.error{color:var(--red)}.list{display:grid;gap:9px}.quiz{display:grid;text-align:right;width:100%}.quiz strong{font-size:15px}.quiz small{color:var(--muted)}.question{font-size:20px;line-height:1.65;margin:17px 0}.choices{display:grid;gap:8px}.choices button{text-align:right;width:100%}.feedback{border-right:3px solid var(--mint);padding:9px 12px;background:#70d7ba12;margin:12px 0}.feedback.wrong{border-color:var(--red)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:17px}.quiet{color:var(--muted);font-size:12px}.hidden{display:none!important}@media(max-width:520px){main{padding:13px}.panel{padding:15px}.grid{grid-template-columns:1fr}}
body{background:radial-gradient(circle at 12% 0,#1d4033 0,transparent 27rem),var(--bg)}main{max-width:1080px;padding:26px 24px 36px}.head{border-bottom:1px solid var(--line);padding-bottom:16px}.account{border:1px solid var(--line);border-radius:30px;padding:5px 12px;color:var(--muted);font-size:12px}.head-actions{display:flex;align-items:center;gap:9px}.hero{padding:30px 0 17px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:18px}.hero h1{font-size:clamp(28px,5vw,48px);line-height:1.23;margin:0 0 8px}.hero h1 span{color:var(--mint)}.hero .intro{margin:0;max-width:610px}.hero-mark{width:135px;height:135px;border:1px solid var(--line);border-radius:30px;display:grid;place-items:center;background:linear-gradient(145deg,#234c3c,#14261e);font-size:62px;color:var(--yellow);transform:rotate(-5deg)}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}.metric{padding:12px 15px;border:1px solid var(--line);border-radius:14px;background:#ffffff08}.metric strong{display:block;color:var(--yellow);font-size:23px}.metric small{color:var(--muted)}.tabs{justify-content:flex-start;overflow:auto;padding-bottom:3px}.tabs button{flex:none;white-space:nowrap}.panel{background:#1a2b25e8}.panel h2{font-size:20px;margin:0 0 14px}.saved-workspace{display:grid;grid-template-columns:290px minmax(0,1fr);gap:14px}.saved-workspace #stage{border-right:1px solid var(--line);padding-right:16px;min-height:250px}.list .quiz{background:#13231d}.source-row{display:grid;gap:9px;border:1px solid var(--line);border-radius:13px;padding:13px;margin-bottom:9px;background:#12221c}.source-row strong{overflow-wrap:anywhere}.source-row small{color:var(--muted)}.source-row .actions{margin:0}.source-row .actions button{padding:7px 11px;font-size:12px}.empty{padding:24px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}.footer{border-top:1px solid var(--line);margin-top:20px;padding-top:13px;color:var(--muted);font-size:12px}.footer b{color:var(--yellow)}
@media(max-width:700px){.hero-mark{display:none}.hero{grid-template-columns:1fr}.saved-workspace{grid-template-columns:1fr}.saved-workspace #stage{border-right:0;border-top:1px solid var(--line);padding:16px 0 0}.account{display:none}}@media(max-width:520px){main{padding:13px}.panel{padding:15px}.grid{grid-template-columns:1fr}.metrics{gap:6px}.metric{padding:9px}.metric strong{font-size:19px}.metric small{font-size:11px}}
.study-card{min-height:220px;width:100%;display:grid;place-items:center;text-align:center;padding:28px;border:1px solid var(--mint);border-radius:18px;background:linear-gradient(155deg,#214436,#142820);font-size:clamp(19px,3vw,26px);line-height:1.6}.study-card small{font-size:12px;color:var(--muted);align-self:end}.card-progress{color:var(--muted);font-size:13px;margin:12px 0}.card-wrap{max-width:650px;margin:auto}.card-wrap .actions{justify-content:center}.card-wrap .actions button{min-width:100px}.card-source{color:var(--muted);font-size:12px;margin-top:9px}
</style></head><body><main><div class="head"><div><p class="eyebrow">مساحتك الدراسية بحساب ChatGPT</p><div class="logo">كويزي <span>✦</span></div></div><div class="head-actions"><span class="account">حسابك متصل</span><button id="refresh" type="button">تحديث</button></div></div>
<div class="hero"><div><p class="eyebrow">من محاضرتك إلى أسئلة موثقة</p><h1>ذاكر بوضوح.<br><span>واسأل محاضرتك.</span></h1><p class="intro">ارفع الملف واضغط إنشاء. يتولى نموذج ChatGPT صياغة الأسئلة، ثم تظهر هنا للحل والحفظ والمراجعة دون كتابة طلب.</p></div><div class="hero-mark" aria-hidden="true">✦</div></div>
<div class="metrics" aria-label="ملخص حسابك"><div class="metric"><strong id="stat-quizzes">—</strong><small>كويز محفوظ</small></div><div class="metric"><strong id="stat-answered">—</strong><small>إجابة محفوظة</small></div><div class="metric"><strong id="stat-sources">—</strong><small>ملف مقروء</small></div></div>
<div class="tabs" role="navigation" aria-label="أقسام كويزي"><button id="new-tab" class="tab active" type="button">＋ إنشاء كويز</button><button id="files-tab" class="tab" type="button">ملفاتي</button><button id="saved-tab" class="tab" type="button">كويزاتي والمراجعة</button><button id="cards-tab" class="tab" type="button">بطاقات المراجعة</button></div>
<section id="new-panel" class="panel"><form id="make-form"><label>ملف المحاضرة PDF أو PPTX<input id="file" type="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" required></label><div class="grid"><label>الصفحات المطلوبة<input id="pages" type="text" placeholder="الكل، أو 2-8, 11"></label><label>عدد الأسئلة<select id="count"><option>10</option><option selected>20</option><option>30</option><option>50</option><option>75</option><option>100</option></select></label><label>الصعوبة<select id="difficulty"><option value="mixed">متنوعة</option><option value="easy">سهلة</option><option value="medium">متوسطة</option><option value="advanced">متقدمة</option></select></label><label>النمط<select id="mode"><option value="practice">تدريب: تفسير بعد الإجابة</option><option value="exam">اختبار: مراجعة في النهاية</option></select></label></div><button id="create" class="primary" type="submit">ابدأ إنشاء الكويز</button><p class="hint">يعالج التطبيق النص المقروء فقط. ستظهر الصفحات غير المقروءة، ولن تُختلق أسئلة منها. إذا كانت المادة لا تكفي، يظهر النقص بدل الحشو.</p></form></section>
<section id="files-panel" class="panel hidden"><h2>ملفاتي المقروءة</h2><p class="hint">نص الصفحات محفوظ بحسابك ويمكن إنشاء كويز جديد منه دون رفع الملف مرة أخرى.</p><div id="sources" class="list"></div></section>
<section id="saved-panel" class="panel hidden"><h2>كويزاتي والمراجعة</h2><div class="saved-workspace"><div id="list" class="list"></div><div id="stage"><p class="empty">اختر كويزًا محفوظًا لتكمل الحل أو تراجع إجاباتك.</p></div></div></section>
<section id="cards-panel" class="panel hidden"><h2>بطاقات المراجعة</h2><p class="hint">بطاقات مستمدة من أسئلة كويزاتك. اقلب البطاقة واحفظ «أعرفها» أو «أحتاج مراجعتها».</p><div id="card-list" class="list"></div><div id="card-stage"></div></section><p id="status" class="status" role="status" aria-live="polite"></p><div class="footer">كويزي · <b>أخوكم سعد مقبل</b></div></main>
<script src="https://sasfas18-eng.github.io/quizzy/pdf.min.js"></script><script src="https://sasfas18-eng.github.io/quizzy/jszip.min.js"></script><script>
const H=window.openai, Q=(id)=>document.getElementById(id), state={quizzes:[],sources:[],selected:null,number:1,generating:false,cardQuiz:null,cards:[],cardIndex:0,flipped:false,cardReviewOnly:false};
function say(value,bad){Q('status').textContent=value;Q('status').classList.toggle('error',!!bad)}
function el(tag,text,cls){const node=document.createElement(tag);if(text!=null)node.textContent=String(text);if(cls)node.className=cls;return node}
function show(which){for(const name of ['new','files','saved','cards']){Q(name+'-panel').classList.toggle('hidden',which!==name);Q(name+'-tab').classList.toggle('active',which===name)}}
async function tool(name,args){if(!H?.callTool)throw Error('افتح كويزي من داخل ChatGPT لتشغيل أدواته.');const result=await H.callTool(name,args||{});let data=result?.structuredContent;if(!data){const block=result?.content?.find(x=>x.type==='text');if(block)try{data=JSON.parse(block.text)}catch{}}if(result?.isError||data?.error)throw Error(data?.error||'تعذرت العملية.');return data||{}}
async function refresh(){try{const data=await tool('list_my_quizzes',{});state.quizzes=data.quizzes||[];Q('stat-quizzes').textContent=state.quizzes.length;Q('stat-answered').textContent=state.quizzes.reduce((sum,q)=>sum+q.answered_count,0);const list=Q('list');list.replaceChildren();if(!state.quizzes.length)list.append(el('p','لا توجد كويزات محفوظة بعد. أنشئ أول كويز من تبويب الإنشاء.','empty'));for(const quiz of state.quizzes){const b=el('button',null,'quiz');b.type='button';b.disabled=quiz.generation_status==='generating';b.append(el('strong',quiz.title),el('small',quiz.generation_status==='generating'?'جارٍ إكمال الأسئلة · '+quiz.question_count+' محفوظ':quiz.answered_count+' من '+quiz.question_count+' إجابة · '+quiz.source_name));b.onclick=()=>openQuiz(quiz.id,Math.min(quiz.question_count,quiz.answered_count+1));list.append(b)}if(state.selected&&!state.quizzes.some(x=>x.id===state.selected)){state.selected=null;Q('stage').replaceChildren()}if(!state.generating)say('تم تحديث الكويزات المحفوظة.')}catch(e){say(e.message,true)}}
async function refreshSources(){try{const data=await tool('list_my_sources',{});state.sources=data.sources||[];Q('stat-sources').textContent=state.sources.length;const list=Q('sources');list.replaceChildren();if(!state.sources.length)list.append(el('p','لا توجد ملفات محفوظة بعد. ارفع ملفك من تبويب إنشاء كويز.','empty'));for(const source of state.sources){const row=el('div',null,'source-row');row.append(el('strong',source.source_name),el('small',source.page_count+' صفحة مقروءة · '+source.count+' سؤال مطلوب'));const actions=el('div',null,'actions'),make=el('button','إنشاء كويز جديد','primary'),remove=el('button','حذف');make.type=remove.type='button';make.onclick=()=>generateFromSource(source);remove.onclick=async()=>{if(!window.confirm('حذف النص المحفوظ لهذا الملف؟ الكويزات المنشأة منه ستبقى.'))return;try{await tool('delete_my_source',{source_id:source.source_id});await refreshSources();say('حُذف الملف المحفوظ.')}catch(e){say(e.message,true)}};actions.append(make,remove);row.append(actions);list.append(row)}}catch(e){say(e.message,true)}}
function renderCard(){
  const stage=Q('card-stage');stage.replaceChildren();
  const cards=state.cardReviewOnly?state.cards.filter(c=>c.state==='review'):state.cards;
  if(!cards.length){stage.append(el('p',state.cardReviewOnly?'لا توجد بطاقات تحتاج مراجعة.':'لا توجد بطاقات في هذا الكويز.','empty'));return}
  state.cardIndex=Math.min(state.cardIndex,cards.length-1);
  const card=cards[state.cardIndex],wrap=el('div',null,'card-wrap');
  wrap.append(el('p',(state.cardIndex+1)+' من '+cards.length+' · '+(card.state==='known'?'أعرفها':card.state==='review'?'تحتاج مراجعة':'جديدة'),'card-progress'));
  const face=el('button',null,'study-card');face.type='button';face.append(el('span',state.flipped?card.back+' — '+card.explanation:card.front),el('small',state.flipped?'اضغط للعودة إلى السؤال':'اضغط لإظهار الإجابة'));face.onclick=()=>{state.flipped=!state.flipped;renderCard()};wrap.append(face,el('p','من صفحة '+card.source_page,'card-source'));
  const actions=el('div',null,'actions');
  const previous=el('button','السابق'),next=el('button','التالي'),known=el('button','أعرفها'),review=el('button','أحتاج مراجعتها'),filter=el('button',state.cardReviewOnly?'عرض الكل':'المحتاجة فقط');
  previous.type=next.type=known.type=review.type=filter.type='button';previous.disabled=state.cardIndex===0;next.disabled=state.cardIndex>=cards.length-1;
  previous.onclick=()=>{state.cardIndex--;state.flipped=false;renderCard()};next.onclick=()=>{state.cardIndex++;state.flipped=false;renderCard()};
  for(const [button,value] of [[known,'known'],[review,'review']])button.onclick=async()=>{button.disabled=true;try{const saved=await tool('set_quiz_card_state',{quiz_id:state.cardQuiz,question_id:card.id,state:value});if(!saved.saved)throw Error('لم يؤكد الخادم حفظ البطاقة.');card.state=value;say('حُفظت حالة البطاقة.');if(state.cardReviewOnly&&value==='known')state.cardIndex=0;renderCard()}catch(e){say(e.message,true);button.disabled=false}};
  filter.onclick=()=>{state.cardReviewOnly=!state.cardReviewOnly;state.cardIndex=0;state.flipped=false;renderCard()};actions.append(previous,next,known,review,filter);wrap.append(actions);stage.append(wrap)
}
async function openCards(id){try{const data=await tool('get_quiz_cards',{quiz_id:id});state.cardQuiz=id;state.cards=data.cards||[];state.cardIndex=0;state.flipped=false;state.cardReviewOnly=false;show('cards');renderCard()}catch(e){say(e.message,true)}}
async function refreshCardsList(){await refresh();const list=Q('card-list');list.replaceChildren();if(!state.quizzes.length){list.append(el('p','أنشئ كويزًا أولًا لتظهر بطاقات مراجعته هنا.','empty'));return}for(const quiz of state.quizzes){const button=el('button',quiz.title+' · '+quiz.question_count+' بطاقة','quiz');button.type='button';button.onclick=()=>openCards(quiz.id);list.append(button)}if(state.cardQuiz&&!state.quizzes.some(q=>q.id===state.cardQuiz)){state.cardQuiz=null;Q('card-stage').replaceChildren()}}
async function openQuiz(id,number){state.selected=id;state.number=number;show('saved');try{const data=await tool('get_quiz_question',{quiz_id:id,question_number:number});const quiz=data.quiz,q=data.question,stage=Q('stage');stage.replaceChildren();stage.append(el('p','السؤال '+number+' من '+quiz.question_count+' · صفحة '+q.source_page,'eyebrow'),el('h2',q.stem,'question'));const choices=el('div',null,'choices');for(const choice of q.choices){const b=el('button',choice.text);b.type='button';b.disabled=data.answered;b.onclick=()=>answer(choice.id);choices.append(b)}stage.append(choices);if(data.feedback)stage.append(feedback(data.feedback));const actions=el('div',null,'actions');if(number>1){const prev=el('button','السابق');prev.onclick=()=>openQuiz(id,number-1);actions.append(prev)}if(number<quiz.question_count){const next=el('button','التالي');next.onclick=()=>openQuiz(id,number+1);actions.append(next)}const review=el('button','النتيجة والمراجعة');review.onclick=()=>showReview(id);actions.append(review);stage.append(actions)}catch(e){say(e.message,true)}}
function feedback(data){const box=el('div',null,'feedback'+(data.correct===false?' wrong':''));box.append(el('strong',data.correct?'إجابة صحيحة':'راجع الإجابة'),el('p',data.explanation||''),el('small','صفحة '+data.source_page+' · '+(data.evidence||'')));return box}
async function answer(choice){try{const data=await tool('submit_quiz_answer',{quiz_id:state.selected,question_number:state.number,choice_id:choice});say('حُفظت الإجابة.');await refresh();await openQuiz(state.selected,state.number);if(data.complete)await showReview(state.selected)}catch(e){say(e.message,true)}}
async function showReview(id){try{const data=await tool('get_quiz_review',{quiz_id:id});const stage=Q('stage');stage.replaceChildren();if(!data.review){stage.append(el('p','أكمل جميع الأسئلة قبل إظهار مراجعة الاختبار.','hint'));return}stage.append(el('h2','النتيجة '+data.score+' / '+data.total));for(const item of data.review){const box=el('div',null,'feedback'+(item.correct?'':' wrong'));box.append(el('strong','سؤال '+item.question_number+' · '+(item.correct?'صحيح':'خطأ')),el('p',item.stem),el('p','إجابتك: '+item.selected_choice_text),el('p','الصحيح: '+item.correct_choice_text),el('small',item.explanation+' · صفحة '+item.source_page));stage.append(box)}}catch(e){say(e.message,true)}}
function pageNumbers(spec,total){if(!spec.trim())return Array.from({length:total},(_,i)=>i+1);const out=new Set();for(const part of spec.split(/[,،;\s]+/)){if(!part)continue;const m=part.match(/^(\d+)-(\d+)$/);if(m){let a=+m[1],b=+m[2];if(a>b)[a,b]=[b,a];for(let i=a;i<=b;i++)out.add(i)}else if(/^\d+$/.test(part))out.add(+part);else throw Error('نطاق الصفحات غير صالح.')}if([...out].some(x=>x<1||x>total))throw Error('نطاق الصفحات خارج الملف.');return [...out].sort((a,b)=>a-b)}
async function extractPdf(file){if(!window.pdfjsLib)throw Error('تعذر تحميل قارئ PDF. أعد فتح التطبيق.');const lib=window.pdfjsLib;lib.GlobalWorkerOptions.workerSrc='https://sasfas18-eng.github.io/quizzy/pdf.worker.min.js';const pdf=await lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),disableWorker:true}).promise;if(pdf.numPages>100)throw Error('الملف يتجاوز 100 صفحة؛ اختر ملفًا أقصر.');const pages=[];for(let i=1;i<=pdf.numPages;i++){const pg=await pdf.getPage(i),content=await pg.getTextContent();pages.push({number:i,text:content.items.map(x=>(x.str||'')+(x.hasEOL?'\n':' ')).join('').split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n')})}return pages}
async function extractPptx(file){if(!window.JSZip)throw Error('تعذر تحميل قارئ PPTX. أعد فتح التطبيق.');const zip=await window.JSZip.loadAsync(await file.arrayBuffer());let names=Object.keys(zip.files).filter(x=>/^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b)=>+a.match(/\d+/)[0]-+b.match(/\d+/)[0]);try{const pres=await zip.files['ppt/presentation.xml'].async('string'),rels=await zip.files['ppt/_rels/presentation.xml.rels'].async('string'),targets={};rels.replace(/<Relationship\b[^>]*>/g,r=>{const id=(r.match(/\bId="([^"]+)"/)||[])[1],t=(r.match(/\bTarget="([^"]+)"/)||[])[1];if(id&&t)targets[id]='ppt/'+t.replace(/^\/?(ppt\/)?/,'');return r});const order=[...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map(m=>targets[m[1]]).filter(n=>n&&zip.files[n]);if(order.length)names=order}catch{}if(names.length>100)throw Error('الملف يتجاوز 100 شريحة؛ اختر ملفًا أقصر.');const pages=[];for(let i=0;i<names.length;i++){const doc=new DOMParser().parseFromString(await zip.files[names[i]].async('string'),'application/xml');const parts=[...doc.getElementsByTagName('a:p')].map(p=>[...p.getElementsByTagName('a:t')].map(x=>x.textContent).join('').replace(/\s+/g,' ').trim()).filter(Boolean);pages.push({number:i+1,text:parts.join('\n')})}return pages}
function pause(ms){return new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer?.unref?.()})}
async function watchNewQuiz(previous,source){
  // a long quiz takes ChatGPT more than two minutes: the wait grows with the count asked, and every new batch saved extends it - only a quiz that stopped growing is closed early
  let deadline=Date.now()+Math.max(120000,90000+6000*(+source.count||20)),seen=-1;
  let partial;
  while(Date.now()<deadline){
    await pause(2000);
    let latest;
    try{latest=await tool('list_my_quizzes',{})}catch(e){say('تعذّر التحقق من الحفظ: '+e.message,true);return}
    const quiz=(latest.quizzes||[]).find(q=>!previous.has(q.id)&&(q.source_id===source.source_id||(!q.source_id&&q.source_name===source.source_name)));
    if(quiz){partial=quiz;if(quiz.generation_status==='generating'){if(quiz.question_count>seen){seen=quiz.question_count;deadline=Math.max(deadline,Date.now()+90000)}say('حُفظ '+quiz.question_count+' سؤالًا، ويكمل ChatGPT بقية الدفعات…');continue}await refresh();await openQuiz(quiz.id,1);say('حُفظ '+quiz.question_count+' سؤالًا من ملفك'+(quiz.shortfall?'؛ المصدر لم يدعم العدد المطلوب كاملًا.':'.')+' يمكنك البدء بالحل الآن.');return}
  }
  if(partial){try{const ready=await tool('finish_quiz_generation',{quiz_id:partial.id});await refresh();await openQuiz(partial.id,1);say('انتهى الانتظار؛ حُفظ '+ready.question_count+' سؤالًا فقط. راجع العدد قبل الحل.');return}catch(e){say('تعذر اعتماد الأسئلة المحفوظة: '+e.message,true);return}}
  say('نص الملف المقروء محفوظ، لكن لم يؤكد الخادم إنشاء كويز جديد بعد. يمكنك إعادة المحاولة من «ملفاتي».',true);
}
async function generateFromSource(source){
  if(state.generating)return;
  if(!H?.sendFollowUpMessage){say('هذه النسخة من ChatGPT لا تدعم بدء التوليد من واجهة كويزي.',true);return}
  state.generating=true;Q('create').disabled=true;
  try{
    const previous=new Set((await tool('list_my_quizzes',{})).quizzes?.map(q=>q.id)||[]);
    const prompt='ابدأ إنشاء كويز كويزي من المصدر المحفوظ في حسابي ذي المعرف '+source.source_id+'. استخدم أداة get_source_for_generation أولًا، ثم create_quiz_from_slides مع source_id نفسه، وadd_quiz_questions عند الحاجة بدفعات لا تتجاوز 30. العدد المطلوب '+source.count+' سؤالًا، الصعوبة '+(source.difficulty||'mixed')+'، والنمط '+(source.mode||'practice')+'. لا تسألني عن الملف أو تطلب نسخ النص؛ هذا طلب تلقائي من زر الإنشاء. استبعد بيانات المحاضر والأهداف والترويسات، واستخرج الأسئلة من المادة العلمية وحدها. لكل سؤال أربعة خيارات ومفتاح واحد ودليل حرفي صحيح ورقم الصفحة وتفسير. نوّع أغراض الأسئلة دون تكرار أو حشو، وغطِّ من هوية كويزي العشرة ما يدعمه المصدر. إن لم يكف المصدر للعدد المطلوب، احفظ العدد الصحيح الممكن واذكر النقص. عند انتهاء جميع الدفعات استدع finish_quiz_generation بمعرّف الكويز كي يظهر للحل، ثم أخبرني بعدد الأسئلة الفعلي.';
    await H.sendFollowUpMessage({prompt,scrollToBottom:false});
    say('حُفظ نص الصفحات المقروءة في حسابك. يصوغ ChatGPT الأسئلة الآن؛ سيفتح الكويز هنا بعد تأكيد حفظه.');
    await watchNewQuiz(previous,source);
  }catch(e){say('نص الملف المقروء محفوظ، لكن لم يبدأ إنشاء الكويز: '+e.message,true)}
  finally{state.generating=false;Q('create').disabled=false}
}
Q('make-form').addEventListener('submit',async(event)=>{event.preventDefault();const file=Q('file').files[0];if(!file)return;if(file.size>40*1024*1024){say('الملف أكبر من 40 ميغابايت.',true);return}const btn=Q('create');btn.disabled=true;try{say('جارٍ قراءة الملف وترتيب صفحاته…');const pages=/\.pdf$/i.test(file.name)?await extractPdf(file):/\.pptx$/i.test(file.name)?await extractPptx(file):null;if(!pages||!pages.length)throw Error('الملف غير مدعوم أو لا يحوي صفحات.');const selected=pageNumbers(Q('pages').value,pages.length);const included=pages.filter(x=>selected.includes(x.number)&&x.text.length>=80);const unreadable=selected.filter(n=>!included.some(x=>x.number===n));if(!included.length)throw Error('الصفحات المختارة غير مقروءة نصيًا. اختر صفحات أخرى.');const source=included.map(p=>'[صفحة '+p.number+'] '+p.text).join('\n\n');if(source.length>30000)throw Error('النطاق طويل جدًا للإنشاء دفعة واحدة. اختر صفحات أقل.');const staged=await tool('save_source_for_generation',{source_name:file.name,pages:included,count:Number(Q('count').value),difficulty:Q('difficulty').value,mode:Q('mode').value,unreadable_pages:unreadable});if(!staged.saved)throw Error('لم يؤكد الخادم حفظ الملف.');await refreshSources();void generateFromSource({...staged,difficulty:Q('difficulty').value,mode:Q('mode').value})}catch(e){say(e.message,true)}finally{if(!state.generating)btn.disabled=false}});
Q('new-tab').onclick=()=>show('new');Q('files-tab').onclick=()=>{show('files');refreshSources()};Q('saved-tab').onclick=()=>{show('saved');refresh()};Q('cards-tab').onclick=()=>{show('cards');refreshCardsList()};Q('refresh').onclick=()=>{refresh();refreshSources()};refresh();refreshSources();
</script></body></html>`;

function landing() {
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0e1816"><meta name="description" content="كويزي: ارفع ملفك وأنشئ كويزًا موثقًا واحفظ تقدّمك بحسابك.">
<title>كويزي | مساحتك الدراسية</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"><script src="https://sasfas18-eng.github.io/quizzy/pdf.min.js" defer></script><script src="https://sasfas18-eng.github.io/quizzy/jszip.min.js" defer></script><script src="/app.js" defer></script></head>
<body><a class="skip" href="#main">تخطَّ إلى المحتوى</a>
<header class="topbar"><a class="brand" href="/" aria-label="كويزي، الرئيسية"><span class="brand-mark">${BRAND_SVG}</span><span>كويزي</span></a>
<div class="top-links"><span class="connection"><span class="dot"></span>مساحتك بحساب ChatGPT</span><a class="quiet-link" href="https://sasfas18-eng.github.io/quizzy/" rel="noopener">الموقع الأساسي</a></div></header>
<main id="main" class="container">
<section class="hero" aria-labelledby="hero-title"><div class="hero-content"><p class="eyebrow"><span class="line"></span> كويزك من محاضرتك</p><h1 id="hero-title">ذاكر بوضوح.<br><span class="highlight">واسأل محاضرتك.</span></h1>
<p class="hero-copy">ارفع سلايداتك هنا، واختر صفحاتك. يقرأ ChatGPT النص المحفوظ ويولّد الأسئلة داخل المحادثة؛ بعدها تجد الكويز هنا لتحلّه وتستأنفه.</p>
<div class="hero-actions"><a class="button primary" href="#new-quiz">ارفع ملفًا وأنشئ كويزًا</a><a class="button subtle" href="#library">كويزاتي المحفوظة</a></div>
<p class="microcopy">بعد رفع الملف، يفتح ChatGPT بطلب جاهز. يلزم اتصال تطبيق كويزي بحسابك. لا يحتاج مالك كويزي مفتاح API، وتسري حدود استخدام حسابك في ChatGPT.</p></div>
<div class="hero-art" aria-hidden="true"><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-paper"><span class="art-chip">من محاضرتك</span><span class="art-line wide"></span><span class="art-line"></span><span class="art-option"><b>✓</b><i></i></span><span class="art-option faint"><b>○</b><i></i></span><span class="art-option faint"><b>○</b><i></i></span></div><div class="art-spark">✦</div></div></section>
<section id="new-quiz" class="create-panel" aria-labelledby="create-title"><div><p class="eyebrow">من ملفك إلى مذاكرتك</p><h2 id="create-title">أنشئ بواسطة ChatGPT</h2><p class="notice">نحفظ النص المقروء من PDF أو PPTX بحسابك. ينتقل طلب التوليد إلى ChatGPT، ثم تعود لحل الكويز هنا. نذكر الصفحات غير المقروءة ولا نخمّن محتواها.</p><div id="pending-sources" class="pending-sources" aria-live="polite"></div></div><form id="create-form"><label>ملف المحاضرة<input id="source-file" type="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" required></label><div class="create-grid"><label>الصفحات<input id="source-pages" type="text" placeholder="الكل أو 2-8, 11"></label><label>عدد الأسئلة<select id="question-count"><option>10</option><option selected>20</option><option>30</option><option>50</option><option>75</option><option>100</option></select></label><label>الصعوبة<select id="quiz-difficulty"><option value="mixed">متنوعة</option><option value="easy">سهلة</option><option value="medium">متوسطة</option><option value="advanced">متقدمة</option></select></label><label>النمط<select id="quiz-mode"><option value="practice">تدريب</option><option value="exam">اختبار</option></select></label></div><button id="make-quiz" class="button primary" type="submit">احفظ الملف وافتح ChatGPT</button><p id="create-status" class="notice" role="status" aria-live="polite"></p><a id="open-chatgpt" class="button subtle" hidden target="_blank" rel="noopener">افتح طلب التوليد في ChatGPT</a></form></section>
<section class="stats" aria-label="إحصاءات حسابك"><div><span id="stat-quizzes">—</span><small>كويز محفوظ</small></div><div><span id="stat-answered">—</span><small>إجابة محفوظة</small></div><div><span id="stat-unfinished">—</span><small>كويز قيد الحل</small></div></section>
<section id="library" class="workspace" aria-label="الكويزات والحل"><aside class="library"><div class="section-head"><div><p class="eyebrow">مساحتك</p><h2>كويزاتي</h2></div><button id="refresh" class="icon-button" type="button" aria-label="تحديث الكويزات" title="تحديث الكويزات">↻</button></div><div id="quiz-list" class="quiz-list" aria-live="polite"><p class="loading">جارٍ تحميل كويزاتك…</p></div></aside>
<article id="stage" class="stage" aria-live="polite"><div class="stage-empty"><span class="empty-symbol">✦</span><h2>جاهز للمذاكرة؟</h2><p>ارفع ملفك بالأعلى لتبدأ، أو افتح أحد كويزاتك المحفوظة.</p></div></article></section>
</main><footer><span>أخوكم سعد مقبل</span><span>كويزي · معك خطوة بخطوة</span></footer><div id="toast" role="status" aria-live="polite"></div></body></html>`;
}

const CSS = `
:root{color-scheme:dark;--bg:#0e1816;--panel:#16251f;--panel2:#1c3028;--text:#efe9d6;--muted:#a9b8b0;--line:#2e473c;--mint:#5fd8b8;--yellow:#ffd84a;--coral:#ff8a6b;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}[hidden]{display:none!important}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% 4%,#17362c 0,transparent 28rem),var(--bg);color:var(--text);min-height:100vh;line-height:1.7}button,a{font:inherit}a{color:inherit;text-decoration:none}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}a:focus-visible,button:focus-visible{outline:3px solid var(--yellow);outline-offset:4px}.skip{position:absolute;top:-80px;right:12px;background:var(--yellow);color:#12302b;padding:8px 14px;z-index:10}.skip:focus{top:12px}
.topbar{max-width:1280px;margin:auto;padding:22px 5%;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;align-items:center;gap:10px;font-size:27px;font-weight:800;letter-spacing:-.03em}.brand-mark{display:grid;place-items:center;width:42px;height:42px}.brand-mark svg{width:100%;height:100%}.top-links{display:flex;align-items:center;gap:24px;font-size:13px;color:var(--muted)}.connection{display:flex;align-items:center;gap:9px;white-space:nowrap}.dot{width:8px;height:8px;background:var(--mint);border-radius:50%;box-shadow:0 0 0 4px #5fd8b822}.quiet-link:hover{color:var(--mint)}.container{max-width:1280px;margin:auto;padding:0 5% 64px}
.hero{min-height:485px;display:grid;grid-template-columns:1.1fr .9fr;align-items:center;gap:36px;padding:52px 0 72px;position:relative;overflow:hidden}.hero-content{position:relative;z-index:2}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.08em;color:var(--mint);margin:0 0 15px}.line{display:inline-block;width:22px;height:2px;background:var(--yellow);vertical-align:middle;margin-left:8px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(44px,5.8vw,82px);line-height:1.19;letter-spacing:-.055em;margin-bottom:23px;font-weight:850}.highlight{background:linear-gradient(transparent 70%,#ffd84a57 70%);color:#f7efdb}.hero-copy{color:var(--muted);font-size:17px;max-width:570px;line-height:1.95;margin-bottom:30px}.hero-actions{display:flex;flex-wrap:wrap;gap:12px}.button{min-height:49px;display:inline-flex;align-items:center;justify-content:center;gap:16px;padding:11px 20px;border-radius:12px;font-weight:750;border:1px solid transparent;transition:transform .15s,background .15s}.button:hover{transform:translateY(-2px)}.primary{background:var(--mint);color:#0b2420;box-shadow:0 5px 0 #378c74}.subtle{border-color:var(--line);background:#ffffff08;color:var(--text)}.microcopy{font-size:12px;color:var(--muted);margin:20px 0 0;max-width:570px}.hero-art{height:390px;position:relative;display:grid;place-items:center}.art-orbit{position:absolute;border:1px solid #5fd8b836;border-radius:50%;width:390px;height:390px}.orbit-two{width:290px;height:290px;border-color:#ffd84a29}.art-paper{width:min(320px,80%);background:#f8f3e7;color:#15352b;border-radius:20px;padding:27px 26px;box-shadow:0 32px 80px #0007,14px 17px 0 #5fd8b832;transform:rotate(-5deg);position:relative}.art-chip{display:inline-block;color:#0f5d50;background:#d9ece0;border-radius:30px;font-size:12px;font-weight:800;padding:4px 10px;margin-bottom:20px}.art-line{display:block;height:10px;width:66%;background:#cbd6cf;border-radius:10px;margin:0 0 10px}.art-line.wide{width:87%;height:13px;background:#173b30}.art-option{display:flex;align-items:center;gap:11px;border:2px solid #0f5d50;background:#e4f5e7;border-radius:10px;padding:7px 11px;margin-top:13px}.art-option b{font-style:normal;color:#0f5d50}.art-option i{height:8px;width:65%;background:#6f9880;border-radius:8px}.art-option.faint{border-color:#d9e0d8;background:transparent;margin-top:8px}.art-option.faint i{background:#bac8bc}.art-option.faint b{color:#9aada0}.art-spark{position:absolute;color:var(--yellow);font-size:44px;top:0;left:10%}
.stats{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);background:#172a22;border-radius:19px;margin-top:-8px;margin-bottom:80px;overflow:hidden}.stats>div{padding:23px 30px;display:flex;align-items:baseline;gap:12px}.stats>div+div{border-right:1px solid var(--line)}.stats span{font-size:29px;font-weight:800;color:var(--yellow)}.stats small{color:var(--muted);font-size:13px}
.workspace{display:grid;grid-template-columns:310px minmax(0,1fr);gap:20px;scroll-margin-top:25px}.library,.stage{background:var(--panel);border:1px solid var(--line);border-radius:21px;min-height:480px}.library{padding:21px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}.section-head h2{font-size:23px;margin:0}.section-head .eyebrow{margin:0 0 2px}.icon-button{width:42px;height:42px;border:1px solid var(--line);background:var(--panel2);color:var(--mint);border-radius:12px;font-size:24px;line-height:1}.quiz-list{display:grid;gap:10px}.quiz-item{width:100%;text-align:right;background:#ffffff05;border:1px solid var(--line);color:var(--text);padding:14px;border-radius:13px}.quiz-item:hover,.quiz-item.active{border-color:var(--mint);background:#5fd8b80c}.quiz-item.active{box-shadow:inset 3px 0 var(--mint)}.quiz-item strong{display:block;font-size:15px;line-height:1.45}.quiz-item small{display:block;color:var(--muted);font-size:12px;margin-top:5px}.mini-progress{height:4px;background:#ffffff18;border-radius:6px;margin-top:12px;overflow:hidden}.mini-progress span{display:block;height:100%;background:var(--mint)}.loading{color:var(--muted);font-size:14px}.stage{padding:clamp(22px,3vw,38px)}.stage-empty{min-height:390px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.stage-empty h2{font-size:26px;margin:6px 0}.stage-empty p{color:var(--muted);max-width:330px}.empty-symbol{font-size:64px;color:var(--yellow)}.stage-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.stage-header h2{font-size:25px;margin:0 0 5px}.stage-header p{font-size:13px;color:var(--muted);margin:0}.pill{display:inline-flex;align-items:center;border:1px solid var(--line);background:var(--panel2);color:var(--mint);padding:5px 11px;border-radius:30px;font-size:12px;white-space:nowrap}.progress-row{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:13px;margin:24px 0 8px}.progress-track{height:7px;border-radius:10px;background:#ffffff16;overflow:hidden}.progress-track span{display:block;height:100%;background:linear-gradient(90deg,var(--mint),var(--yellow));transition:width .3s}.question-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:31px 0 13px;color:var(--mint);font-size:13px;font-weight:750}.question-stem{font-size:clamp(19px,2.5vw,26px);line-height:1.65;margin:0 0 25px;white-space:pre-wrap}.options{display:grid;gap:10px}.choice{width:100%;display:flex;gap:15px;align-items:flex-start;text-align:right;border:1px solid var(--line);border-bottom-width:3px;background:#ffffff04;color:var(--text);padding:13px 15px;border-radius:12px;min-height:54px}.choice:hover:not(:disabled){border-color:var(--mint);background:#5fd8b80c}.choice .letter{min-width:28px;height:28px;border-radius:8px;background:#ffffff0e;display:grid;place-items:center;color:var(--muted);font-size:13px}.choice.selected{border-color:var(--yellow);background:#ffd84a13}.choice.correct{border-color:var(--mint);background:#5fd8b81c}.choice.wrong{border-color:var(--coral);background:#ff8a6b16}.choice span:last-child{flex:1}.feedback{margin-top:21px;border-right:4px solid var(--mint);background:#5fd8b80c;padding:18px;border-radius:11px}.feedback.wrong{border-color:var(--coral);background:#ff8a6b0c}.feedback strong{display:block;margin-bottom:5px}.feedback p{margin:0}.evidence{margin-top:11px;color:var(--muted);font-size:13px}.evidence mark{background:#ffd84a30;color:var(--text);padding:2px 3px;border-radius:3px}.stage-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:29px;padding-top:18px;border-top:1px solid var(--line)}.small-button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:8px 12px;font-size:13px;font-weight:700;min-height:40px}.small-button:hover{border-color:var(--mint)}.small-button.danger:hover{border-color:var(--coral);color:var(--coral)}.small-button.accent{background:var(--mint);color:#0b2420;border-color:var(--mint)}.review-score{font-size:46px;color:var(--yellow);font-weight:800;line-height:1.2}.review-card{border:1px solid var(--line);padding:17px;border-radius:13px;margin-top:12px;background:#ffffff05}.review-card h3{font-size:16px;margin:0 0 9px}.review-card p{margin:5px 0;color:var(--muted);font-size:14px}.review-card .right{color:var(--mint)}.review-card .wrong-text{color:var(--coral)}.notice{color:var(--muted);font-size:14px}.error{color:var(--coral)}.how{display:grid;grid-template-columns:.85fr 1.15fr;gap:35px;border-top:1px solid var(--line);margin-top:75px;padding-top:40px}.how h2{font-size:clamp(23px,3vw,35px);line-height:1.4}.how ol{padding:0;margin:0;list-style:none;display:grid;gap:13px}.how li{display:flex;gap:15px;align-items:center;color:var(--muted)}.how li b{flex:none;width:34px;height:34px;border-radius:10px;background:var(--panel2);color:var(--yellow);display:grid;place-items:center}footer{border-top:1px solid var(--line);max-width:1280px;margin:auto;padding:24px 5% 35px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:10px}footer span:first-child{color:var(--coral)}#toast{position:fixed;bottom:23px;left:23px;background:#254234;color:var(--text);border:1px solid var(--mint);padding:12px 17px;border-radius:10px;box-shadow:0 15px 40px #0006;max-width:320px;z-index:20;display:none}#toast.show{display:block}#toast.error{border-color:var(--coral)}
@media(max-width:850px){.hero{grid-template-columns:1fr;min-height:0;padding:35px 0 60px}.hero-art{display:none}.workspace{grid-template-columns:1fr}.library,.stage{min-height:0}.stats{margin-bottom:52px}.how{grid-template-columns:1fr}}@media(max-width:580px){.topbar{padding:17px 5%}.top-links .quiet-link{display:none}.connection{font-size:11px}.brand{font-size:22px}.brand-mark{width:35px;height:35px}.hero h1{font-size:44px}.hero-copy{font-size:15px}.hero-actions{display:grid}.stats>div{display:grid;gap:0;padding:15px 12px;text-align:center}.stats span{font-size:23px}.stats small{font-size:11px}.stage{padding:20px}.stage-header{display:block}.stage-header .pill{margin-top:10px}.question-stem{font-size:20px}footer{display:grid;text-align:center}.stage-actions .small-button{flex:1}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
.create-panel{scroll-margin-top:20px;display:grid;grid-template-columns:minmax(190px,.55fr) minmax(0,1.45fr);gap:30px;align-items:start;margin:0 0 34px;padding:26px;background:linear-gradient(135deg,#1e3b30,var(--panel));border:1px solid var(--line);border-radius:20px}.create-panel h2{font-size:25px;margin:0 0 8px}.create-panel form{min-width:0}.create-panel label{display:grid;gap:5px;color:var(--muted);font-size:13px;margin:0 0 13px}.create-panel input,.create-panel select{width:100%;min-width:0;background:#10231d;border:1px solid var(--line);border-radius:10px;padding:10px 11px;color:var(--text);font:inherit}.create-panel input[type=file]{font-size:12px}.create-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.create-panel .button{cursor:pointer}.create-panel .notice{margin:8px 0 0}.create-panel #create-status{min-height:22px}.create-panel #create-status.error{color:var(--coral)}
.pending-sources{display:grid;gap:8px;margin-top:16px}.pending-sources:empty{display:none}.pending-sources h3{font-size:14px;margin:0}.pending-source{padding:10px;border:1px solid var(--line);border-radius:10px;background:#10231d}.pending-source strong{display:block;font-size:13px;overflow-wrap:anywhere}.pending-source small{display:block;color:var(--muted)}.pending-source a,.pending-source button{font-size:12px;color:var(--mint);background:none;border:0;padding:4px 8px 0 0}.pending-source button{color:var(--coral)}
body.has-quizzes .hero{min-height:0;grid-template-columns:1fr;padding:20px 0 31px}body.has-quizzes .hero-art{display:none}body.has-quizzes h1{font-size:clamp(33px,4vw,47px);margin-bottom:9px}body.has-quizzes .hero-copy{font-size:14px;margin-bottom:15px}body.has-quizzes .microcopy{display:none}body.has-quizzes .stats{margin:0 0 32px}
@media(max-width:850px){body.has-quizzes .hero{padding:15px 0 24px}}@media(max-width:580px){body.has-quizzes h1{font-size:34px}body.has-quizzes .hero-copy{line-height:1.7}body.has-quizzes .hero-actions{grid-template-columns:1fr 1fr}body.has-quizzes .button{font-size:12px;padding:9px;min-height:44px}body.has-quizzes .stats{margin-bottom:22px}}
@media(max-width:760px){.create-panel{grid-template-columns:1fr;gap:14px;padding:20px}}@media(max-width:460px){.create-grid{grid-template-columns:1fr}}
`;

const CLIENT_JS = `
const ui = {
  list: document.getElementById("quiz-list"), stage: document.getElementById("stage"),
  quizzes: document.getElementById("stat-quizzes"), answered: document.getElementById("stat-answered"),
  unfinished: document.getElementById("stat-unfinished"), refresh: document.getElementById("refresh"),
  toast: document.getElementById("toast")
};
const state = { quizzes: [], selected: null, quiz: null, question: null, number: 1, view: "question", busy: false };
let toastTimer;
function element(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = String(value);
  return item;
}
function button(label, className, action, disabled) {
  const item = element("button", className, label);
  item.type = "button"; item.disabled = Boolean(disabled);
  if (action) item.addEventListener("click", action);
  return item;
}
function message(value, error) {
  clearTimeout(toastTimer);
  ui.toast.textContent = value;
  ui.toast.className = error ? "show error" : "show";
  toastTimer = setTimeout(() => { ui.toast.className = ""; }, 4800);
}
async function api(path, init = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });
  let data;
  try { data = await response.json(); }
  catch { throw new Error("تعذر الاتصال بحسابك. حدّث الصفحة وسجّل الدخول من جديد."); }
  if (!response.ok) throw new Error(data.error || "تعذرت العملية. حاول مرة أخرى.");
  return data;
}
function quizPath(id) { return "/api/quizzes/" + encodeURIComponent(id); }
function updateStats() {
  document.body.classList.toggle("has-quizzes", state.quizzes.length > 0);
  ui.quizzes.textContent = state.quizzes.length.toLocaleString("ar");
  ui.answered.textContent = state.quizzes.reduce((sum, quiz) => sum + quiz.answered_count, 0).toLocaleString("ar");
  ui.unfinished.textContent = state.quizzes.filter((quiz) => quiz.answered_count < quiz.question_count).length.toLocaleString("ar");
}
function renderList() {
  ui.list.replaceChildren();
  if (!state.quizzes.length) {
    ui.list.append(element("p", "notice", "لا توجد كويزات محفوظة في هذه المساحة التجريبية. أنشئ كويزك في موقع كويزي الأساسي."));
    return;
  }
  for (const quiz of state.quizzes) {
    const item = button("", "quiz-item" + (state.selected === quiz.id ? " active" : ""), () => selectQuiz(quiz.id));
    item.append(element("strong", "", quiz.title));
    item.append(element("small", "", quiz.source_name + " · " + quiz.answered_count + " من " + quiz.question_count + " إجابة"));
    const track = element("div", "mini-progress");
    const fill = element("span");
    fill.style.width = Math.min(100, Math.round(100 * quiz.answered_count / Math.max(1, quiz.question_count))) + "%";
    track.append(fill); item.append(track); ui.list.append(item);
  }
}
function emptyStage(title, description, error = false) {
  ui.stage.replaceChildren();
  const wrap = element("div", "stage-empty");
  wrap.append(element("span", "empty-symbol", error ? "!" : "✦"));
  wrap.append(element("h2", "", title));
  wrap.append(element("p", error ? "error" : "", description));
  if (error) wrap.append(button("أعد التحميل", "small-button accent", () => refresh()));
  ui.stage.append(wrap);
}
async function refresh(preferredId) {
  ui.refresh.disabled = true;
  try {
    const data = await api("/api/quizzes");
    state.quizzes = data.quizzes || [];
    updateStats(); renderList();
    const queryId = new URLSearchParams(location.search).get("quiz");
    const choice = preferredId || (state.selected && state.quizzes.some((q) => q.id === state.selected) ? state.selected : null)
      || (queryId && state.quizzes.some((q) => q.id === queryId) ? queryId : null)
      || state.quizzes[0]?.id;
    if (choice) await selectQuiz(choice);
    else { state.selected = null; emptyStage("ابدأ بأول محاضرة", "ارفع ملفك وأنشئ كويزك داخل موقع كويزي الأساسي. هذه المساحة التجريبية مستقلة عنه."); }
    if (data.truncated) message("تظهر أحدث 100 كويز فقط. قائمة إضافية قيد التطوير.", true);
  } catch (error) {
    emptyStage("تعذر تحميل كويزاتك", error.message, true);
    message(error.message, true);
  } finally { ui.refresh.disabled = false; }
}
async function selectQuiz(id) {
  state.selected = id; state.view = "question";
  const summary = state.quizzes.find((quiz) => quiz.id === id);
  state.number = summary ? Math.min(summary.question_count, Math.max(1, summary.answered_count + 1)) : 1;
  history.replaceState(null, "", "/?quiz=" + encodeURIComponent(id));
  renderList();
  await loadQuestion();
}
async function loadQuestion() {
  if (!state.selected) return;
  ui.stage.setAttribute("aria-busy", "true");
  try {
    const data = await api(quizPath(state.selected) + "/question/" + state.number);
    state.quiz = data.quiz; state.question = data; state.view = "question";
    const index = state.quizzes.findIndex((quiz) => quiz.id === state.selected);
    if (index >= 0) state.quizzes[index] = data.quiz;
    updateStats(); renderList(); renderQuestion();
  } catch (error) { emptyStage("تعذر فتح هذا الكويز", error.message, true); }
  finally { ui.stage.removeAttribute("aria-busy"); }
}
function header(title, source, mode) {
  const top = element("div", "stage-header");
  const label = element("div");
  label.append(element("h2", "", title));
  label.append(element("p", "", source));
  top.append(label, element("span", "pill", mode === "exam" ? "وضع الاختبار" : "وضع التدريب"));
  return top;
}
function renderQuestion() {
  if (!state.question) return;
  const data = state.question, quiz = data.quiz, question = data.question;
  ui.stage.replaceChildren();
  ui.stage.append(header(quiz.title, quiz.source_name, quiz.mode));
  const progress = element("div", "progress-row");
  progress.append(element("span", "", "السؤال " + data.question_number + " من " + quiz.question_count),
    element("span", "", quiz.answered_count + " إجابة محفوظة"));
  ui.stage.append(progress);
  const track = element("div", "progress-track"), fill = element("span");
  fill.style.width = Math.round(100 * quiz.answered_count / quiz.question_count) + "%";
  track.append(fill); ui.stage.append(track);
  const meta = element("div", "question-head");
  meta.append(element("span", "", "من محاضرتك"), element("span", "", "الصفحة " + question.source_page));
  ui.stage.append(meta, element("h3", "question-stem", question.stem));
  const options = element("div", "options");
  question.choices.forEach((choice, index) => {
    const selected = data.selected_choice_id === choice.id;
    let kind = selected ? " selected" : "";
    if (data.feedback) {
      if (choice.id === data.feedback.correct_choice_id) kind = " correct";
      else if (selected) kind = " wrong";
    }
    const item = button("", "choice" + kind, () => submitAnswer(choice.id), data.answered || state.busy);
    item.append(element("span", "letter", ["١", "٢", "٣", "٤"][index]));
    const text = element("span", "", choice.text); text.dir = "auto"; item.append(text);
    options.append(item);
  });
  ui.stage.append(options);
  if (data.feedback) {
    const box = element("div", "feedback" + (data.feedback.correct ? "" : " wrong"));
    box.append(element("strong", "", data.feedback.correct ? "إجابة صحيحة ✓" : "فرصة للمراجعة"));
    box.append(element("p", "", data.feedback.explanation));
    const evidence = element("div", "evidence");
    evidence.append(element("span", "", "من الصفحة " + data.feedback.source_page + " · "));
    evidence.append(element("mark", "", data.feedback.evidence));
    box.append(evidence); ui.stage.append(box);
  } else if (data.answered && quiz.mode === "exam") {
    ui.stage.append(element("p", "notice", "حُفظت إجابتك. تظهر التفسيرات بعد إكمال الاختبار."));
  }
  const actions = element("div", "stage-actions");
  actions.append(button("السابق", "small-button", () => move(-1), state.number <= 1));
  actions.append(button("التالي", "small-button", () => move(1), state.number >= quiz.question_count));
  actions.append(button("مراجعة الإجابات", "small-button accent", showReview));
  actions.append(button("محاولة جديدة", "small-button", restartQuiz));
  actions.append(button("حذف الكويز", "small-button danger", deleteQuiz));
  ui.stage.append(actions);
}
async function submitAnswer(choiceId) {
  if (state.busy || state.question?.answered) return;
  state.busy = true;
  const saveLabel = element("p", "notice", "جارٍ حفظ إجابتك…");
  ui.stage.append(saveLabel);
  try {
    const result = await api(quizPath(state.selected) + "/answer", {
      method: "POST", body: JSON.stringify({ question_number: state.number, choice_id: choiceId })
    });
    if (!result.saved) throw new Error("لم يؤكد الخادم حفظ الإجابة.");
    await loadQuestion();
    message("حُفظت إجابتك على حسابك.");
  } catch (error) { message(error.message, true); }
  finally { saveLabel.remove(); state.busy = false; }
}
function move(delta) {
  if (!state.quiz) return;
  state.number = Math.max(1, Math.min(state.quiz.question_count, state.number + delta));
  loadQuestion();
}
async function showReview() {
  if (!state.selected) return;
  ui.stage.setAttribute("aria-busy", "true");
  try {
    const data = await api(quizPath(state.selected) + "/review");
    state.view = "review";
    ui.stage.replaceChildren();
    ui.stage.append(header(state.quiz.title, state.quiz.source_name, state.quiz.mode));
    const actions = element("div", "stage-actions");
    actions.append(button("العودة للأسئلة", "small-button accent", loadQuestion));
    if (!data.complete && state.quiz.mode === "exam") {
      ui.stage.append(element("h3", "", "أكمل الاختبار أولًا"));
      ui.stage.append(element("p", "notice", "أجبت عن " + data.answered_count + " من " + data.total + ". ستظهر المراجعة بعد الإجابة عن الكل."));
      ui.stage.append(actions); return;
    }
    ui.stage.append(element("p", "eyebrow", data.complete ? "النتيجة والمراجعة" : "مراجعة ما حللته حتى الآن"));
    ui.stage.append(element("div", "review-score", data.score + " / " + (data.complete ? data.total : data.answered_count)));
    ui.stage.append(element("p", "notice", data.wrong_questions.length
      ? "هذه الأسئلة تحتاج مراجعتك. ارجع إلى السطر من المحاضرة ثم أعد المحاولة."
      : data.answered_count ? "لا توجد إجابات خاطئة ضمن ما حللته." : "لم تُجب عن أي سؤال بعد."));
    for (const item of data.wrong_questions) {
      const card = element("div", "review-card");
      card.append(element("h3", "", "السؤال " + item.question_number + " · " + item.stem));
      card.append(element("p", "wrong-text", "اخترت: " + item.selected_choice_text));
      card.append(element("p", "right", "الصواب: " + item.correct_choice_text));
      card.append(element("p", "", item.explanation));
      card.append(element("p", "evidence", "من الصفحة " + item.source_page + " · " + item.evidence));
      ui.stage.append(card);
    }
    ui.stage.append(actions);
  } catch (error) { message(error.message, true); }
  finally { ui.stage.removeAttribute("aria-busy"); }
}
async function restartQuiz() {
  if (!state.selected || state.busy) return;
  state.busy = true;
  try {
    const data = await api(quizPath(state.selected) + "/restart", { method: "POST" });
    if (!data.saved) throw new Error("لم يؤكد الخادم إنشاء المحاولة.");
    await refresh(data.id); message("بدأت محاولة جديدة؛ بقيت المحاولة السابقة محفوظة.");
  } catch (error) { message(error.message, true); }
  finally { state.busy = false; }
}
async function deleteQuiz() {
  if (!state.selected || state.busy) return;
  if (!confirm("سيُحذف هذا الكويز وإجاباته نهائيًا من حسابك. هل تريد المتابعة؟")) return;
  state.busy = true;
  try {
    const data = await api(quizPath(state.selected), { method: "DELETE" });
    if (!data.deleted) throw new Error("لم يؤكد الخادم حذف الكويز.");
    state.selected = null; history.replaceState(null, "", "/");
    await refresh(); message("حُذف الكويز من حسابك.");
  } catch (error) { message(error.message, true); }
  finally { state.busy = false; }
}
ui.refresh.addEventListener("click", () => refresh());
refresh();
`;

// The standalone Site can stage a student's source, while generation itself
// happens in ChatGPT through this Site's MCP tools. No browser-side model key.
const CLIENT_SOURCE_JS = String.raw`
function sourcePages(spec, total) {
  if (!spec.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const selected = new Set();
  for (const part of spec.split(/[,،;\s]+/)) {
    if (!part) continue;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      let start = Number(range[1]), end = Number(range[2]);
      if (start > end) [start, end] = [end, start];
      if (start < 1 || end > total) throw new Error("نطاق الصفحات خارج الملف.");
      for (let n = start; n <= end; n++) selected.add(n);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > total) throw new Error("نطاق الصفحات خارج الملف.");
      selected.add(n);
    } else throw new Error("نطاق الصفحات غير صالح.");
  }
  if (!selected.size) throw new Error("حدد صفحة واحدة على الأقل.");
  return [...selected].sort((a, b) => a - b);
}
async function pdfPages(file) {
  if (!window.pdfjsLib) throw new Error("تعذر تحميل قارئ PDF. أعد فتح الصفحة.");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://sasfas18-eng.github.io/quizzy/pdf.worker.min.js";
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableWorker: true }).promise;
  if (pdf.numPages > 100) throw new Error("الملف يتجاوز 100 صفحة؛ اختر ملفًا أقصر.");
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push({ number: i, text: content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") });
  }
  return pages;
}
async function pptxPages(file) {
  if (!window.JSZip) throw new Error("تعذر تحميل قارئ PPTX. أعد فتح الصفحة.");
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  let names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  try {
    const presentation = await zip.files["ppt/presentation.xml"].async("string");
    const relationships = await zip.files["ppt/_rels/presentation.xml.rels"].async("string");
    const targets = {};
    relationships.replace(/<Relationship\b[^>]*>/g, (row) => {
      const id = (row.match(/\bId="([^"]+)"/) || [])[1];
      const target = (row.match(/\bTarget="([^"]+)"/) || [])[1];
      if (id && target) targets[id] = "ppt/" + target.replace(/^\/?(ppt\/)?/, "");
      return row;
    });
    const order = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
      .map((match) => targets[match[1]]).filter((name) => name && zip.files[name]);
    if (order.length) names = order;
  } catch { /* Fall back to slide numbering. */ }
  if (names.length > 100) throw new Error("الملف يتجاوز 100 شريحة؛ اختر ملفًا أقصر.");
  const pages = [];
  for (let i = 0; i < names.length; i++) {
    const doc = new DOMParser().parseFromString(await zip.files[names[i]].async("string"), "application/xml");
    const parts = [...doc.getElementsByTagName("a:p")].map((para) => [...para.getElementsByTagName("a:t")].map((node) => node.textContent).join("").replace(/\s+/g, " ").trim()).filter(Boolean);
    pages.push({ number: i + 1, text: parts.join("\n") });
  }
  return pages;
}
const createForm = document.getElementById("create-form");
const createStatus = document.getElementById("create-status");
const openChat = document.getElementById("open-chatgpt");
function createMessage(value, bad) {
  createStatus.textContent = value;
  createStatus.classList.toggle("error", !!bad);
}
function chatPromptLink(data) {
  const prompt = "استخدم تطبيق كويزي المرتبط بهذه المحادثة لتوليد كويز من المصدر المحفوظ بمعرّف " + data.source_id +
    ". استدع get_source_for_generation أولًا، ثم أنشئ كويزًا عبر create_quiz_from_slides مع source_id نفسه وأضف دفعات عبر add_quiz_questions عند الحاجة. العدد المطلوب " + data.count +
    ". التزم بنص الصفحات والدليل الحرفي ورقم الصفحة، أربعة خيارات وجواب واحد، وأسئلة متنوعة لا تكرر الفكرة. استبعد بيانات المحاضر والأهداف والترويسات. إذا لم تكف المادة، اذكر العدد الممكن ولا تحشُ الأسئلة. بعد الحفظ أعطني رابط الكويز في كويزي.";
  return "https://chatgpt.com/?q=" + encodeURIComponent(prompt);
}
async function refreshSources() {
  const area = document.getElementById("pending-sources");
  try {
    const data = await api("/api/sources");
    area.replaceChildren();
    if (!data.sources.length) return;
    area.append(element("h3", "", "ملفات تنتظر التوليد"));
    for (const source of data.sources) {
      const row = element("div", "pending-source");
      row.append(element("strong", "", source.source_name));
      row.append(element("small", "", source.page_count + " صفحة · " + source.count + " سؤال مطلوب"));
      const link = element("a", "", "أكمل في ChatGPT ↗");
      link.href = chatPromptLink(source); link.target = "_blank"; link.rel = "noopener";
      row.append(link);
      const remove = button("احذف الملف", "", async () => {
        if (!confirm("حذف النص المحفوظ لهذا الملف من حسابك؟")) return;
        try { await api("/api/sources/" + encodeURIComponent(source.source_id), { method: "DELETE" }); await refreshSources(); }
        catch (error) { createMessage(error.message, true); }
      });
      row.append(remove); area.append(row);
    }
  } catch (error) { createMessage(error.message, true); }
}
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.getElementById("source-file").files[0];
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) { createMessage("الملف أكبر من 40 ميغابايت.", true); return; }
  const button = document.getElementById("make-quiz");
  button.disabled = true;
  openChat.hidden = true;
  const tab = window.open("about:blank", "_blank");
  try {
    createMessage("جارٍ قراءة الصفحات المختارة…");
    const pages = /[.]pdf$/i.test(file.name) ? await pdfPages(file) :
      /[.]pptx$/i.test(file.name) ? await pptxPages(file) : null;
    if (!pages || !pages.length) throw new Error("الملف غير مدعوم أو لا يحوي صفحات.");
    const selected = sourcePages(document.getElementById("source-pages").value, pages.length);
    const included = pages.filter((page) => selected.includes(page.number) && page.text.length >= 80);
    const unreadable = selected.filter((n) => !included.some((page) => page.number === n));
    if (!included.length) throw new Error("الصفحات المختارة غير مقروءة نصيًا. اختر صفحات أخرى.");
    if (included.reduce((sum, page) => sum + page.text.length, 0) > 30000) {
      throw new Error("النطاق طويل للتوليد في محادثة واحدة؛ اختر صفحات أقل.");
    }
    createMessage("جارٍ حفظ النص المقروء بحسابك…");
    const data = await api("/api/sources", { method: "POST", body: JSON.stringify({
      source_name: file.name, pages: included,
      count: Number(document.getElementById("question-count").value),
      difficulty: document.getElementById("quiz-difficulty").value,
      mode: document.getElementById("quiz-mode").value,
      unreadable_pages: unreadable
    }) });
    if (!data.saved || !data.source_id) throw new Error("لم يؤكد الخادم حفظ الملف.");
    const link = chatPromptLink(data);
    openChat.href = link;
    openChat.hidden = false;
    createMessage("حُفظ نص " + data.page_count + " صفحة. افتح ChatGPT لإكمال التوليد، ثم عد إلى كويزي واضغط تحديث. الصفحات غير المقروءة: " + (unreadable.join("، ") || "لا يوجد") + ". لم يُنشأ الكويز بعد.");
    await refreshSources();
    if (tab) tab.location.href = link;
  } catch (error) {
    if (tab && !tab.closed) tab.close();
    createMessage(error.message || "تعذر تجهيز الملف.", true);
  } finally { button.disabled = false; }
});
refreshSources();
`;

async function browserApi(request, env, url) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const reply = (value, status = 200) => Response.json(value, { status, headers });
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user) return reply({ error: "سجّل الدخول بحساب ChatGPT لفتح كويزاتك." }, 401);
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin) {
    return reply({ error: "الطلب ليس من صفحة كويزي." }, 403);
  }
  const path = url.pathname;
  try {
    if (path === "/api/quizzes" && request.method === "GET") {
      return reply(await runTool("list_my_quizzes", {}, env, user));
    }
    if (path === "/api/sources" && request.method === "POST") {
      const body = await request.text();
      if (body.length > 60000) return reply({ error: "المصدر كبير؛ اختر صفحات أقل." }, 413);
      return reply(await stageSource(JSON.parse(body), env, user));
    }
    if (path === "/api/sources" && request.method === "GET") {
      return reply(await listSources(env, user));
    }
    const sourceMatch = path.match(/^\/api\/sources\/([0-9a-f-]{36})$/);
    if (sourceMatch && request.method === "DELETE") {
      const source = await readSource(env, user, sourceMatch[1]);
      await env.BUCKET.delete(sourceKey(user, source.id));
      return reply({ deleted: true, source_id: source.id });
    }
    const match = path.match(/^\/api\/quizzes\/([0-9a-f-]{36})(?:\/(question\/([0-9]+)|answer|review|restart))?$/);
    if (!match) return reply({ error: "المسار غير موجود." }, 404);
    const quiz_id = match[1], action = match[2] ?? "";
    if (action.startsWith("question/") && request.method === "GET") {
      return reply(await runTool("get_quiz_question", { quiz_id, question_number: Number(match[3]) }, env, user));
    }
    if (action === "review" && request.method === "GET") {
      return reply(await runTool("get_quiz_review", { quiz_id }, env, user));
    }
    if (action === "answer" && request.method === "POST") {
      const body = await request.json();
      return reply(await runTool("submit_quiz_answer", {
        quiz_id, question_number: Number(body.question_number), choice_id: body.choice_id
      }, env, user));
    }
    if (action === "restart" && request.method === "POST") {
      return reply(await runTool("restart_my_quiz", { quiz_id }, env, user, url.origin));
    }
    if (!action && request.method === "DELETE") {
      return reply(await runTool("delete_my_quiz", { quiz_id }, env, user));
    }
    return reply({ error: "الطلب غير مدعوم." }, 405);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const known = /غير موجود|غير صالح|خارج الكويز|سابقًا|يلزم|معرّف|بدأ حل|سؤال|صفحات|عنوان|ملف|النطاق|المصدر/.test(message);
    return reply({ error: known ? message : "تعذرت العملية على الخادم. حاول مرة أخرى." },
      /غير موجود/.test(message) ? 404 : known ? 400 : 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(landing(), { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
        "content-security-policy": "default-src 'none'; script-src 'self' https://sasfas18-eng.github.io; worker-src 'self' blob: https://sasfas18-eng.github.io; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://sasfas18-eng.github.io; base-uri 'none'"
      } });
    }
    if (url.pathname === "/app.css" && request.method === "GET") {
      return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/app.js" && request.method === "GET") {
      return new Response(CLIENT_JS + CLIENT_SOURCE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/favicon.svg" && request.method === "GET") {
      return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    }
    if (url.pathname.startsWith("/api/")) return browserApi(request, env, url);
    if (url.pathname !== "/mcp" || request.method !== "POST") return new Response("Not found", { status: 404 });
    let payload;
    try { payload = await request.json(); } catch { return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
    const id = payload?.id ?? null;
    const reply = (result) => Response.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
    if (payload?.method === "server/discover") return reply({ supportedVersions: [VERSION], capabilities: { tools: {}, resources: {} } });
    if (payload?.method === "tools/list") return reply({ tools: TOOLS });
    if (payload?.method === "resources/list") return reply({ resources: [{ uri: WIDGET_URI, name: "كويزي داخل ChatGPT", mimeType: "text/html;profile=mcp-app" }] });
    if (payload?.method === "resources/read") {
      if (payload.params?.uri !== WIDGET_URI) return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown resource" } });
      return reply({ contents: [{ uri: WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML,
        _meta: { ui: { prefersBorder: true, csp: { resourceDomains: ["https://sasfas18-eng.github.io"] } } } }] });
    }
    if (payload?.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const user = request.headers.get("oai-authenticated-user-id");
    if (!user) return reply(toolResult({ error: "يلزم تسجيل الدخول إلى ChatGPT لاستخدام أدوات كويزي." }, true));
    const name = payload.params?.name;
    if (!TOOLS.some((tool) => tool.name === name)) return reply(toolResult({ error: "أداة غير معروفة." }, true));
    try {
      return reply(toolResult(await runTool(name, payload.params?.arguments ?? {}, env, user, url.origin)));
    } catch (error) {
      return reply(toolResult({ error: error instanceof Error ? error.message : "تعذرت العملية." }, true));
    }
  }
};

export { runTool, validatePages, validateQuestions, TOOLS };
