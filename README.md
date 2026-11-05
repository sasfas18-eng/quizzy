<p align="center"><img src="docs/brand/logo-lockup.png" alt="كويزي" width="380"></p>
<p align="center"><sub>أخوكم سعد مقبل</sub></p>

# كويزي (Quizzy)

موقع تعليمي مستقل (خارج ChatGPT) يحوّل السلايدات (PDF/PPTX) إلى **كويزات موثّقة بالمصدر** و**بطاقات مراجعة**، بحسابات وقاعدة بيانات واستضافة خاصة به، ويحفظ تقدّم الطالب على الخادم.

**الرابط الرسمي والأساسي للموقع:** https://sasfas18-eng.github.io/quizzy/ — رابط واحد لكل شيء. كل تعديل يُختبر ثم يُنشر تلقائيًا من GitHub (انظر [`docs/SETUP-PAGES.md`](docs/SETUP-PAGES.md)).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sasfas18-eng/quizzy)

**الهوية:** «ورقة وقلم تمييز» — [بحث المنافسين وقراراته](docs/DESIGN-RESEARCH.md) · [نظام التصميم والشعار](docs/DESIGN-SYSTEM.md) · [لوحة الهوية](docs/brand/brand-sheet.png).

> المستودع كله هو الموقع (الجذر = المشروع). ملفات النشر في الجذر: `Dockerfile` · `render.yaml` · `fly.toml` · `docker-compose.yml`.

## تشغيل خلال دقيقة
```bash
cd backend && pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...        # أو QUIZZY_LLM_POOL لمزوّدين مجانيين (انظر .env.example)
export QUIZZY_ADMIN_EMAILS=you@example.com
python run.py                              # http://localhost:8000
```
Docker: `docker build -t quizzy . && docker run -p 8000:8000 -v quizzy-data:/data --env-file .env quizzy`
توليد مجاني بلا حدود على جهازك: `docker compose up -d` (Ollama + المشروع).

## النشر (الخطوة الوحيدة المطلوبة منك: حساب استضافة)
| الطريقة | الخطوات |
|---|---|
| **Render (تجريبي، أسرع رابط)** | زر Deploy أعلاه ← يقرأ `render.yaml` (نسخة مجانية **بلا قرص دائم**: الحسابات قد تُمسح، وتظهر لافتة بذلك) ← أدخل `ANTHROPIC_API_KEY` (أو `QUIZZY_LLM_POOL`) و`QUIZZY_ADMIN_EMAILS` ← Apply |
| **Render (دائم)** | انسخ `render.production.yaml` فوق `render.yaml` (خطة مدفوعة + قرص 5GB) أو اختر الملف كمسار للـ Blueprint |
| **صورة جاهزة** | تُبنى وتُنشر تلقائيًا إلى `ghcr.io/<owner>/<repo>:latest` عند كل دفع إلى `main` (workflow `publish-image`) فتنشرها على أي استضافة تدعم الصور |
| **Fly.io** | `fly launch --copy-config` ثم `fly volumes create quizzy_data --size 5` و`fly secrets set ANTHROPIC_API_KEY=...` |

تفاصيل وحدود التشغيل: `docs/DEPLOY.md`.

## النسخة على GitHub Pages (بلا خادم)
`static-edition/` — الواجهة نفسها تعمل في المتصفح: **ارفع ملفًا ← اختر العدد ← أنشئ كويزًا محليًا تلقائيًا**. يختار «كويزي» أنواع الأسئلة بحسب ما يدعمه المحتوى ويفحص المصدر والمفتاح والتكرار. الأسئلة المحلية أبسط من أسئلة نموذج لغوي. يمكن للطالب اختيار نقل الطلب والرد يدويًا إلى ChatGPT أو Claude إن رغب.

**الحسابات في نسخة GitHub Pages**: الموقع يطلب بريدًا وكلمة مرور؛ بلا إعداد تكون الحسابات **على الجهاز** (مساحة لكل حساب، و«ضيف» مساحة منفصلة). **لحسابات سحابية حقيقية** تنتقل بين الأجهزة فعّل Supabase بمتغيّرين عامّين في GitHub (`QZ_SUPABASE_URL`، `QZ_SUPABASE_ANON_KEY`) ثم افحصها من صفحة المشغّل: [`docs/SETUP-PAGES.md`](docs/SETUP-PAGES.md).

**ChatGPT وClaude في موقع Pages الحالي:** لا يوجد ربط حساب ولا توليد تلقائي عبرهما. المسار المتاح ينقل الطلب والرد يدويًا، ثم يفحص «كويزي» الأسئلة قبل اعتمادها. أُضيف إلى نسخة الخادم مسار ربط ChatGPT والتوليد التلقائي بحساب الطالب، لكنه ينتظر قبول OpenAI ومعرّف عميل وخادم HTTPS دائمًا، ولم يُختبر بعد بحساب حقيقي. اشتراك Claude الشخصي لا يتيح هذا النوع من ربط موقع خارجي. [حالة الربط ومتطلبات إطلاقه](docs/CHATGPT-CONNECTION.md) · [قدرات النسخة الثابتة](docs/CHAT-BRIDGE.md).

**كويزي داخل ChatGPT:** أُنشئ تطبيق خاص في [`chatgpt-app/`](chatgpt-app/) يتيح لنموذج ChatGPT تكوين كويز من ملف المحادثة وحفظه بلا مفتاح API لمالك كويزي. رابط التطبيق الخاص يعرض مساحة حقيقية للحل والاستئناف والمراجعة. اختُبر حفظ كويز من ملف PDF تجريبي عبر أدوات الإضافة، وما زال اختبار ملف طالب حقيقي وتوزيع التطبيق على الطلاب مطلوبين. [حالة التطبيق وحدوده](docs/CHATGPT-APP.md).

## الإصدارات
- **النسخة ذات الخادم** (هذا المشروع): حسابات مستقلة، PDF، إدارة، توليد قوي وسريع.
- **`static-edition/`**: نسخة GitHub Pages أعلاه (مشاركة الكود الأساسي مع `shared/`).
- **`claude-edition/`**: نفس الواجهة كصفحة داخل claude.ai: التوليد عبر Claude بحسابك مباشرة (بلا مفاتيح ولا إعداد)، والحفظ في قاعدة بيانات الصفحة؛ يتطلب فتحها وأنت مسجّل الدخول في claude.ai.
- **`chatgpt-app/`**: تطبيق خاص داخل ChatGPT بأدوات حفظ كويزات ومحاولات؛ منفصل عن رابط Pages الرسمي.
- **`demo/`**: عرض ثابت بلا خادم لأغراض المعاينة فقط (`scripts/build_demo.py`).

## الجودة والسرعة
- كل سؤال مع اقتباس من صفحة المصدر وكشف حتمي للمفتاح والتكرار والتسريب؛ مسار الخادم يضيف حلًا أعمى مستقلًا، أما استيراد المحادثة فيوسم صراحةً بأنه لم يجتز حلًا أعمى مستقلًا. العيب الحاسم = لا يُسلَّم.
- **الإجابة الغلط تُصحَّح كما يصحّح المعلّم ورقتك**: ما اخترتَه مشطوب والصواب بقلم التمييز وجملة المحاضرة وقد وُسمت فيها كلمة التصحيح؛ ومع الذكاء الاصطناعي يُضاف **تصحيح بالعربية** واضح ودافئ يحتفظ بالمصطلحات والإجابة الصحيحة بلغتها الأصلية (يُفحص: عربي، يحوي الأصل، بلا رقم من خارج المحاضرة). يُطلب عند الحاجة فلا يكلّف توليد الكويز شيئًا.
- خط توليد متوازٍ: صياغة موجات متوازية، تحقق مجمّع (استدعاءان لكل ٣ أسئلة)، كاش للتحليل. قياس بزمن استجابة محاكى: ٢٧٫٦s ← ٩٫٦s و٤١ ← ٣٠ استدعاء لـ ٢٠ سؤالًا (`scripts/bench_generation.py`).
- أوضاع التسجيل: `QUIZZY_REGISTRATION=open|invite|closed` ورموز دعوة ونطاقات بريد مسموحة. حذف الحساب وتصدير البيانات من «حسابي».

## الاختبار
`cd backend && python -m pytest -q` · اختبار شامل ضد خادم يعمل: `python scripts/smoke.py http://127.0.0.1:8000 phase1` · CI (`.github/workflows/ci.yml`) يبني صورة Docker ويشغّلها ويُجري المسار كاملًا ثم يعيد التشغيل ويتحقق من بقاء البيانات.

## الوثائق
ابدأ من `docs/PROJECT_STATE.md` لمعرفة ما هو منفّذ ومتحقق الآن، ثم: `docs/CHATGPT-APP.md` · `docs/CHATGPT-CONNECTION.md` · `docs/CHAT-BRIDGE.md` · `docs/ARCHITECTURE.md` · `docs/DEPLOY.md` · `docs/STATUS.md` · `docs/COMPETITORS.md`
