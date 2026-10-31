# كويزي (Quizzy)

موقع تعليمي مستقل (خارج ChatGPT) يحوّل السلايدات (PDF/PPTX) إلى **كويزات موثّقة بالمصدر** و**بطاقات مراجعة**، بحسابات وقاعدة بيانات واستضافة خاصة به، ويحفظ تقدّم الطالب على الخادم.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sasfas18-eng/https-github.com-composio-community-awesome-claude-plugins)

> المستودع كله هو الموقع (الجذر = المشروع). ملفات النشر في الجذر: `Dockerfile` · `render.yaml` · `fly.toml` · `docker-compose.yml`.

## تشغيل خلال دقيقة
```bash
cd backend && pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...        # أو QUIZZY_LLM_POOL لمزوّدين مجانيين (انظر .env.example)
export QUIZZY_ADMIN_EMAILS=you@example.com
python run.py                              # http://localhost:8000
```
Docker: `docker build -t quizzy . && docker run -p 8000:8000 -v quizzy-data:/data --env-file .env quizzy`
توليد بلا توكن وبلا حد (على جهازك): `docker compose up -d` (Ollama + المشروع).

## النشر (الخطوة الوحيدة المطلوبة منك: حساب استضافة)
| الطريقة | الخطوات |
|---|---|
| **Render** | زر Deploy أعلاه ← يقرأ `render.yaml` ← أدخل `ANTHROPIC_API_KEY` (أو `QUIZZY_LLM_POOL`) و`QUIZZY_ADMIN_EMAILS` ← Apply |
| **صورة جاهزة** | تُبنى وتُنشر تلقائيًا إلى `ghcr.io/<owner>/<repo>:latest` عند كل دفع إلى `main` (workflow `publish-image`) فتنشرها على أي استضافة تدعم الصور |
| **Fly.io** | `fly launch --copy-config` ثم `fly volumes create quizzy_data --size 5` و`fly secrets set ANTHROPIC_API_KEY=...` |

تفاصيل وحدود التشغيل: `docs/DEPLOY.md`.

## الإصدارات
- **النسخة ذات الخادم** (هذا المشروع): حسابات مستقلة، PDF، إدارة، توليد قوي وسريع.
- **`claude-edition/`**: نفس الواجهة كصفحة داخل claude.ai (التوليد عبر Claude، الحفظ في قاعدة بيانات الصفحة، يتطلب تسجيل claude.ai).
- **`demo/`**: عرض ثابت بلا خادم لأغراض المعاينة فقط (`scripts/build_demo.py`).

## الجودة والسرعة
- كل سؤال: اقتباس حرفي من صفحة المصدر + حل أعمى مستقل + كشف تكرار وتسريب. العيب الحاسم = لا يُسلَّم.
- خط توليد متوازٍ: صياغة موجات متوازية، تحقق مجمّع (استدعاءان لكل ٣ أسئلة)، كاش للتحليل. قياس بزمن استجابة محاكى: ٢٧٫٦s ← ٩٫٦s و٤١ ← ٣٠ استدعاء لـ ٢٠ سؤالًا (`scripts/bench_generation.py`).
- أوضاع التسجيل: `QUIZZY_REGISTRATION=open|invite|closed` ورموز دعوة ونطاقات بريد مسموحة. حذف الحساب وتصدير البيانات من «حسابي».

## الاختبار
`cd backend && python -m pytest -q` · اختبار شامل ضد خادم يعمل: `python scripts/smoke.py http://127.0.0.1:8000 phase1` · CI (`.github/workflows/ci.yml`) يبني صورة Docker ويشغّلها ويُجري المسار كاملًا ثم يعيد التشغيل ويتحقق من بقاء البيانات.

## الوثائق
`docs/ARCHITECTURE.md` · `docs/DEPLOY.md` · `docs/STATUS.md` · `docs/COMPETITORS.md`
