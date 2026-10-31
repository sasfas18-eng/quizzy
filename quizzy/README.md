# كويزي (Quizzy)

موقع مستقل (خارج ChatGPT) يحوّل السلايدات (PDF/PPTX) إلى كويزات موثّقة بالمصدر وبطاقات مراجعة، ويحفظ تقدّم الطالب على الخادم.

**الحالة:** مسار كامل يعمل ومُختبر (حساب ← رفع ← معالجة ← خطة ← توليد/تحقق ← حل واستئناف ← نتيجة ومراجعة ← بطاقات ← PDF ← بلاغات وإدارة).
**لم يُختبر بعد:** التوليد بنموذج حقيقي (لا مفتاح API في بيئة التطوير) — انظر `docs/STATUS.md`.

## التشغيل
```bash
cd quizzy/backend
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # بدونه: الرفع والاستخراج والحسابات تعمل، والتوليد معطّل بوضوح
export QUIZZY_ADMIN_EMAILS=you@example.com
python -m uvicorn app.main:app --port 8000   # ثم افتح http://localhost:8000
```
أو Docker: `docker build -t quizzy . && docker run -p 8000:8000 -v quizzy-data:/data --env-file .env quizzy`

الاختبارات: `cd backend && python -m pytest -q`

## الوثائق
- `docs/ARCHITECTURE.md` — البنية ومسار الجودة.
- `docs/DEPLOY.md` — النشر والخدمات والمفاتيح المطلوبة وحدود التشغيل.
- `docs/STATUS.md` — ما نُفّذ، ما اختُبر فعلًا، وما بقي.
