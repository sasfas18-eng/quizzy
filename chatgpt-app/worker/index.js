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
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { summary: JSON.stringify(summary(quiz)) }
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
    created_at: quiz.created_at, updated_at: quiz.updated_at,
    attempt_of: quiz.attempt_of ?? null
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
    quiz.questions.push(...validateQuestions(args.questions, quiz.pages, quiz.questions));
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

function landing() {
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0e1816"><meta name="description" content="كويزي: كويزات من محاضرتك داخل ChatGPT، محفوظة لتكملها وقتما تشاء.">
<title>كويزي | مساحتك الدراسية</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><a class="skip" href="#main">تخطَّ إلى المحتوى</a>
<header class="topbar"><a class="brand" href="/" aria-label="كويزي، الرئيسية"><span class="brand-mark">${BRAND_SVG}</span><span>كويزي</span></a>
<div class="top-links"><span class="connection"><span class="dot"></span>مساحتك في ChatGPT</span><a class="quiet-link" href="https://sasfas18-eng.github.io/quizzy/" target="_blank" rel="noopener">الموقع الأساسي</a></div></header>
<main id="main" class="container">
<section class="hero" aria-labelledby="hero-title"><div class="hero-content"><p class="eyebrow"><span class="line"></span> كويزك من محاضرتك</p><h1 id="hero-title">ذاكر بوضوح.<br><span class="highlight">واسأل محاضرتك.</span></h1>
<p class="hero-copy">ارفع السلايدات في محادثة ChatGPT مع تطبيق كويزي. ستجد الكويز هنا محفوظًا، جاهزًا للحل والمراجعة من أي جهاز تدخل منه بحسابك.</p>
<div class="hero-actions"><a class="button primary" href="https://chatgpt.com/" target="_blank" rel="noopener">افتح ChatGPT لإنشاء كويز</a><a class="button subtle" href="#library">كويزاتي المحفوظة</a></div>
<p class="microcopy">داخل المحادثة، اختر تطبيق «كويزي داخل ChatGPT»، أرفق PDF أو PPTX، واطلب إنشاء الكويز. لا تحتاج إلى نسخ الأسئلة.</p></div>
<div class="hero-art" aria-hidden="true"><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-paper"><span class="art-chip">من محاضرتك</span><span class="art-line wide"></span><span class="art-line"></span><span class="art-option"><b>✓</b><i></i></span><span class="art-option faint"><b>○</b><i></i></span><span class="art-option faint"><b>○</b><i></i></span></div><div class="art-spark">✦</div></div></section>
<section class="stats" aria-label="إحصاءات حسابك"><div><span id="stat-quizzes">—</span><small>كويز محفوظ</small></div><div><span id="stat-answered">—</span><small>إجابة محفوظة</small></div><div><span id="stat-unfinished">—</span><small>كويز قيد الحل</small></div></section>
<section id="library" class="workspace" aria-label="الكويزات والحل"><aside class="library"><div class="section-head"><div><p class="eyebrow">مساحتك</p><h2>كويزاتي</h2></div><button id="refresh" class="icon-button" type="button" aria-label="تحديث الكويزات" title="تحديث الكويزات">↻</button></div><div id="quiz-list" class="quiz-list" aria-live="polite"><p class="loading">جارٍ تحميل كويزاتك…</p></div></aside>
<article id="stage" class="stage" aria-live="polite"><div class="stage-empty"><span class="empty-symbol">✦</span><h2>جاهز للمذاكرة؟</h2><p>عندما تنشئ كويزًا في ChatGPT سيظهر هنا تلقائيًا.</p></div></article></section>
</main><footer><span>أخوكم سعد مقبل</span><span>كويزي · معك خطوة بخطوة</span></footer><div id="toast" role="status" aria-live="polite"></div></body></html>`;
}

const CSS = `
:root{color-scheme:dark;--bg:#0e1816;--panel:#16251f;--panel2:#1c3028;--text:#efe9d6;--muted:#a9b8b0;--line:#2e473c;--mint:#5fd8b8;--yellow:#ffd84a;--coral:#ff8a6b;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% 4%,#17362c 0,transparent 28rem),var(--bg);color:var(--text);min-height:100vh;line-height:1.7}button,a{font:inherit}a{color:inherit;text-decoration:none}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}a:focus-visible,button:focus-visible{outline:3px solid var(--yellow);outline-offset:4px}.skip{position:absolute;top:-80px;right:12px;background:var(--yellow);color:#12302b;padding:8px 14px;z-index:10}.skip:focus{top:12px}
.topbar{max-width:1280px;margin:auto;padding:22px 5%;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;align-items:center;gap:10px;font-size:27px;font-weight:800;letter-spacing:-.03em}.brand-mark{display:grid;place-items:center;width:42px;height:42px}.brand-mark svg{width:100%;height:100%}.top-links{display:flex;align-items:center;gap:24px;font-size:13px;color:var(--muted)}.connection{display:flex;align-items:center;gap:9px;white-space:nowrap}.dot{width:8px;height:8px;background:var(--mint);border-radius:50%;box-shadow:0 0 0 4px #5fd8b822}.quiet-link:hover{color:var(--mint)}.container{max-width:1280px;margin:auto;padding:0 5% 64px}
.hero{min-height:485px;display:grid;grid-template-columns:1.1fr .9fr;align-items:center;gap:36px;padding:52px 0 72px;position:relative;overflow:hidden}.hero-content{position:relative;z-index:2}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.08em;color:var(--mint);margin:0 0 15px}.line{display:inline-block;width:22px;height:2px;background:var(--yellow);vertical-align:middle;margin-left:8px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(44px,5.8vw,82px);line-height:1.19;letter-spacing:-.055em;margin-bottom:23px;font-weight:850}.highlight{background:linear-gradient(transparent 70%,#ffd84a57 70%);color:#f7efdb}.hero-copy{color:var(--muted);font-size:17px;max-width:570px;line-height:1.95;margin-bottom:30px}.hero-actions{display:flex;flex-wrap:wrap;gap:12px}.button{min-height:49px;display:inline-flex;align-items:center;justify-content:center;gap:16px;padding:11px 20px;border-radius:12px;font-weight:750;border:1px solid transparent;transition:transform .15s,background .15s}.button:hover{transform:translateY(-2px)}.primary{background:var(--mint);color:#0b2420;box-shadow:0 5px 0 #378c74}.subtle{border-color:var(--line);background:#ffffff08;color:var(--text)}.microcopy{font-size:12px;color:var(--muted);margin:20px 0 0;max-width:570px}.hero-art{height:390px;position:relative;display:grid;place-items:center}.art-orbit{position:absolute;border:1px solid #5fd8b836;border-radius:50%;width:390px;height:390px}.orbit-two{width:290px;height:290px;border-color:#ffd84a29}.art-paper{width:min(320px,80%);background:#f8f3e7;color:#15352b;border-radius:20px;padding:27px 26px;box-shadow:0 32px 80px #0007,14px 17px 0 #5fd8b832;transform:rotate(-5deg);position:relative}.art-chip{display:inline-block;color:#0f5d50;background:#d9ece0;border-radius:30px;font-size:12px;font-weight:800;padding:4px 10px;margin-bottom:20px}.art-line{display:block;height:10px;width:66%;background:#cbd6cf;border-radius:10px;margin:0 0 10px}.art-line.wide{width:87%;height:13px;background:#173b30}.art-option{display:flex;align-items:center;gap:11px;border:2px solid #0f5d50;background:#e4f5e7;border-radius:10px;padding:7px 11px;margin-top:13px}.art-option b{font-style:normal;color:#0f5d50}.art-option i{height:8px;width:65%;background:#6f9880;border-radius:8px}.art-option.faint{border-color:#d9e0d8;background:transparent;margin-top:8px}.art-option.faint i{background:#bac8bc}.art-option.faint b{color:#9aada0}.art-spark{position:absolute;color:var(--yellow);font-size:44px;top:0;left:10%}
.stats{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);background:#172a22;border-radius:19px;margin-top:-8px;margin-bottom:80px;overflow:hidden}.stats>div{padding:23px 30px;display:flex;align-items:baseline;gap:12px}.stats>div+div{border-right:1px solid var(--line)}.stats span{font-size:29px;font-weight:800;color:var(--yellow)}.stats small{color:var(--muted);font-size:13px}
.workspace{display:grid;grid-template-columns:310px minmax(0,1fr);gap:20px;scroll-margin-top:25px}.library,.stage{background:var(--panel);border:1px solid var(--line);border-radius:21px;min-height:480px}.library{padding:21px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}.section-head h2{font-size:23px;margin:0}.section-head .eyebrow{margin:0 0 2px}.icon-button{width:42px;height:42px;border:1px solid var(--line);background:var(--panel2);color:var(--mint);border-radius:12px;font-size:24px;line-height:1}.quiz-list{display:grid;gap:10px}.quiz-item{width:100%;text-align:right;background:#ffffff05;border:1px solid var(--line);color:var(--text);padding:14px;border-radius:13px}.quiz-item:hover,.quiz-item.active{border-color:var(--mint);background:#5fd8b80c}.quiz-item.active{box-shadow:inset 3px 0 var(--mint)}.quiz-item strong{display:block;font-size:15px;line-height:1.45}.quiz-item small{display:block;color:var(--muted);font-size:12px;margin-top:5px}.mini-progress{height:4px;background:#ffffff18;border-radius:6px;margin-top:12px;overflow:hidden}.mini-progress span{display:block;height:100%;background:var(--mint)}.loading{color:var(--muted);font-size:14px}.stage{padding:clamp(22px,3vw,38px)}.stage-empty{min-height:390px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.stage-empty h2{font-size:26px;margin:6px 0}.stage-empty p{color:var(--muted);max-width:330px}.empty-symbol{font-size:64px;color:var(--yellow)}.stage-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.stage-header h2{font-size:25px;margin:0 0 5px}.stage-header p{font-size:13px;color:var(--muted);margin:0}.pill{display:inline-flex;align-items:center;border:1px solid var(--line);background:var(--panel2);color:var(--mint);padding:5px 11px;border-radius:30px;font-size:12px;white-space:nowrap}.progress-row{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:13px;margin:24px 0 8px}.progress-track{height:7px;border-radius:10px;background:#ffffff16;overflow:hidden}.progress-track span{display:block;height:100%;background:linear-gradient(90deg,var(--mint),var(--yellow));transition:width .3s}.question-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:31px 0 13px;color:var(--mint);font-size:13px;font-weight:750}.question-stem{font-size:clamp(19px,2.5vw,26px);line-height:1.65;margin:0 0 25px;white-space:pre-wrap}.options{display:grid;gap:10px}.choice{width:100%;display:flex;gap:15px;align-items:flex-start;text-align:right;border:1px solid var(--line);border-bottom-width:3px;background:#ffffff04;color:var(--text);padding:13px 15px;border-radius:12px;min-height:54px}.choice:hover:not(:disabled){border-color:var(--mint);background:#5fd8b80c}.choice .letter{min-width:28px;height:28px;border-radius:8px;background:#ffffff0e;display:grid;place-items:center;color:var(--muted);font-size:13px}.choice.selected{border-color:var(--yellow);background:#ffd84a13}.choice.correct{border-color:var(--mint);background:#5fd8b81c}.choice.wrong{border-color:var(--coral);background:#ff8a6b16}.choice span:last-child{flex:1}.feedback{margin-top:21px;border-right:4px solid var(--mint);background:#5fd8b80c;padding:18px;border-radius:11px}.feedback.wrong{border-color:var(--coral);background:#ff8a6b0c}.feedback strong{display:block;margin-bottom:5px}.feedback p{margin:0}.evidence{margin-top:11px;color:var(--muted);font-size:13px}.evidence mark{background:#ffd84a30;color:var(--text);padding:2px 3px;border-radius:3px}.stage-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:29px;padding-top:18px;border-top:1px solid var(--line)}.small-button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:8px 12px;font-size:13px;font-weight:700;min-height:40px}.small-button:hover{border-color:var(--mint)}.small-button.danger:hover{border-color:var(--coral);color:var(--coral)}.small-button.accent{background:var(--mint);color:#0b2420;border-color:var(--mint)}.review-score{font-size:46px;color:var(--yellow);font-weight:800;line-height:1.2}.review-card{border:1px solid var(--line);padding:17px;border-radius:13px;margin-top:12px;background:#ffffff05}.review-card h3{font-size:16px;margin:0 0 9px}.review-card p{margin:5px 0;color:var(--muted);font-size:14px}.review-card .right{color:var(--mint)}.review-card .wrong-text{color:var(--coral)}.notice{color:var(--muted);font-size:14px}.error{color:var(--coral)}.how{display:grid;grid-template-columns:.85fr 1.15fr;gap:35px;border-top:1px solid var(--line);margin-top:75px;padding-top:40px}.how h2{font-size:clamp(23px,3vw,35px);line-height:1.4}.how ol{padding:0;margin:0;list-style:none;display:grid;gap:13px}.how li{display:flex;gap:15px;align-items:center;color:var(--muted)}.how li b{flex:none;width:34px;height:34px;border-radius:10px;background:var(--panel2);color:var(--yellow);display:grid;place-items:center}footer{border-top:1px solid var(--line);max-width:1280px;margin:auto;padding:24px 5% 35px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:10px}footer span:first-child{color:var(--coral)}#toast{position:fixed;bottom:23px;left:23px;background:#254234;color:var(--text);border:1px solid var(--mint);padding:12px 17px;border-radius:10px;box-shadow:0 15px 40px #0006;max-width:320px;z-index:20;display:none}#toast.show{display:block}#toast.error{border-color:var(--coral)}
@media(max-width:850px){.hero{grid-template-columns:1fr;min-height:0;padding:35px 0 60px}.hero-art{display:none}.workspace{grid-template-columns:1fr}.library,.stage{min-height:0}.stats{margin-bottom:52px}.how{grid-template-columns:1fr}}@media(max-width:580px){.topbar{padding:17px 5%}.top-links .quiet-link{display:none}.connection{font-size:11px}.brand{font-size:22px}.brand-mark{width:35px;height:35px}.hero h1{font-size:44px}.hero-copy{font-size:15px}.hero-actions{display:grid}.stats>div{display:grid;gap:0;padding:15px 12px;text-align:center}.stats span{font-size:23px}.stats small{font-size:11px}.stage{padding:20px}.stage-header{display:block}.stage-header .pill{margin-top:10px}.question-stem{font-size:20px}footer{display:grid;text-align:center}.stage-actions .small-button{flex:1}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
body.has-quizzes .hero{min-height:0;grid-template-columns:1fr;padding:20px 0 31px}body.has-quizzes .hero-art{display:none}body.has-quizzes h1{font-size:clamp(33px,4vw,47px);margin-bottom:9px}body.has-quizzes .hero-copy{font-size:14px;margin-bottom:15px}body.has-quizzes .microcopy{display:none}body.has-quizzes .stats{margin:0 0 32px}
@media(max-width:850px){body.has-quizzes .hero{padding:15px 0 24px}}@media(max-width:580px){body.has-quizzes h1{font-size:34px}body.has-quizzes .hero-copy{line-height:1.7}body.has-quizzes .hero-actions{grid-template-columns:1fr 1fr}body.has-quizzes .button{font-size:12px;padding:9px;min-height:44px}body.has-quizzes .stats{margin-bottom:22px}}
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
    ui.list.append(element("p", "notice", "لا توجد كويزات محفوظة بعد. أنشئ أول كويز من محادثة ChatGPT وسيظهر هنا."));
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
    else { state.selected = null; emptyStage("ابدأ بأول محاضرة", "ارفع ملفك داخل ChatGPT واطلب من تطبيق كويزي إنشاء الأسئلة. سيظهر كويزك هنا بعد حفظه."); }
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
    const known = /غير موجود|غير صالح|خارج الكويز|سابقًا|يلزم|معرّف|بدأ حل/.test(message);
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
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'"
      } });
    }
    if (url.pathname === "/app.css" && request.method === "GET") {
      return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/app.js" && request.method === "GET") {
      return new Response(CLIENT_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
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
    if (payload?.method === "server/discover") return reply({ supportedVersions: [VERSION], capabilities: { tools: {} } });
    if (payload?.method === "tools/list") return reply({ tools: TOOLS });
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
