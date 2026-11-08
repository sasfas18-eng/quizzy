# طلب «Sign in with ChatGPT» لكويزي

**أين يُرسل:** https://openai.com/form/sign-in-with-chatgpt-interest/

**كيف تستخدم هذا الملف:** كل فقرة بعنوان إنجليزي أدناه تقابل خانة في النموذج. انسخ النص الذي تحتها والصقه في الخانة المشابهة. إذا اختلفت أسماء الخانات في النموذج، اختر الأقرب. الخانات بين [أقواس مربعة] **املأها أنت**، لأني لا أعرف قيمتها ولا أخترع أرقامًا.

---

### Product / company name
Quizzy (كويزي)

### Website
https://sasfas18-eng.github.io/quizzy/

### Contact
[اسمك الكامل] — sasfas18@gmail.com

### Country / region
[بلدك]

### Type of product
Remotely hosted website (education). Independent developer.

### Short description (one or two sentences)
Quizzy turns a student's own lecture slides (PDF or PowerPoint) into exam-quality multiple-choice quizzes and review flashcards, where every question is grounded in an exact quote and page of the lecture. Students practice, get explanations, and track their progress.

### What do you want to use Sign in with ChatGPT for?
We want students to sign in with their ChatGPT account and generate quizzes from their own lectures on their own ChatGPT plan usage. Today the site generates questions with a local rule-based generator (free, but simpler questions) or through a student's own Claude account inside claude.ai. Many of our students already pay for ChatGPT, and they ask to use that plan inside Quizzy instead of copying text between tabs. Sign in with ChatGPT would let each student use their existing plan, with no API key and no cost passed to them or to us.

### How will the model be used? (use case details)
- Reading: classify the lecture's text into assessable content vs. metadata (lecturer, objectives, logistics, references), so no question is asked about non-content.
- Writing: generate single-best-answer multiple-choice questions in batches, each with an exact supporting quote and page number, across ten question styles (recall, understanding, mechanisms, application, critical thinking, scenarios, compare/contrast, best answer, NOT/EXCEPT, sequence).
- Checking: an independent blind-solve pass (the model answers each question without the key) and an explanation check; any question that fails, or that repeats another question in other words, is rewritten.
- Typical quiz: 10–50 questions from one lecture; roughly 15–50 requests per quiz.

### Expected users and volume
[عدد الطلاب المتوقع، مثلًا: 200 طالب في الشهر الأول] — mostly university students (health sciences and other majors), Arabic and English lectures. [كم كويز تتوقع لكل طالب أسبوعيًا، مثلًا: 3]

### Technical readiness
The OAuth flow is already implemented in Quizzy's server edition (FastAPI): authorization code with PKCE, state and nonce checks, ID token validation, the plan-usage scope required before any generation, encrypted token storage per student, refresh, and disconnect with remote revocation. Model requests are streamed and not stored (`store: false`), and the model is chosen from those available to the student's account. It has been tested against a simulated provider only; we need a client ID to test with real accounts before launch. On approval we will host the server on HTTPS at a single origin and register its exact callback URL: [https://<نطاق الخادم>/api/chatgpt/callback].

### Privacy and data handling
- Only the pages the student selects are sent, only to generate that student's quiz.
- Tokens are encrypted at rest, bound to the student's Quizzy account, never exposed to the browser, and deleted on disconnect.
- We do not read the student's ChatGPT conversations or history.
- Students can export and delete their data from their account page.

### Why it matters
Students already study with ChatGPT, but they copy slides into a chat and lose structure: no saved quizzes, no source quotes, no progress. Quizzy keeps all of that, and Sign in with ChatGPT lets students bring the plan they already pay for, without API keys or extra cost.

---

## بعد الإرسال
- أرسل لي أي رد يصلك من OpenAI.
- **إن وافقوا:** يعطونك **Client ID**. أنا أنشر الخادم، وأضبط الإعدادات، وأختبر بحسابين حقيقيين، ثم أضيف زر «سجّل الدخول بـChatGPT» في الموقع بنفس تصميمه. لا تضع الـClient ID أو أي سر في المحادثة؛ أطلبه منك بالطريقة الآمنة وقتها.
- **حسب سياسة OpenAI الحالية:** استخدام الحصة في المواقع الخارجية متاح لخطط Go وPlus وPro، والحساب المجاني يستطيع تسجيل الدخول فقط. فالطالب المجاني سيبقى على المولّد المحلي أو مسار Claude.
