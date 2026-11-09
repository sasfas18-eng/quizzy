// Shared steps/assertions for the browser E2E scripts of every edition.
// The quiz flow is ONE step: pick the file + count -> "إنشاء الكويز" -> (automatic analysis + generation) -> "جاهز للحل".
const assert = require('assert');
const TYPE_LABELS = ['الاسترجاع الأساسي', 'فهم المفاهيم', 'الآليات والتفاصيل', 'تطبيق المعلومات', 'التفكير النقدي', 'سيناريو تخصصي', 'المقارنة والتمييز', 'أفضل إجابة', 'الاستثناء / غير الصحيح', 'ترتيب الخطوات'];
// the pipeline's own statistics and verdicts are internal: never on a learner-facing page
const HIDDEN_WORDS = [...TYPE_LABELS, 'توكن', 'طريقة التوليد', 'هوية الأسئلة', 'التركيز', 'خطة الكويز', 'حلّل المحتوى', 'تقرير الجودة', 'مرشحًا', 'بفحص الدليل', 'تغطية أهداف المصدر', 'ملاحظات بسيطة', 'نسخة التعليمات', 'تحقق آلي',
  'جودة الاستخراج', 'غير مقروءة', 'صورة بلا نص', 'قُرئ الملف', 'قُرئت', 'تُستبعد تلقائيًا', 'الصفحات المصوّرة', 'نص الصفحة', 'مقتطف'];

/** The ten question types, the "token"/generator choice and the plan-confirmation step must never show in the learner-facing UI. */
async function assertHidden(p, where) {
  const t = ((await p.textContent('body')) || '').replace(/\s+/g, ' ');
  for (const w of HIDDEN_WORDS) assert(!t.includes(w), `"${w}" must not be visible on ${where}`);
  assert(!/\b(null|undefined|false)\b|\[object/.test(t), `stray null/false/undefined text on ${where}: ${(t.match(/.{0,20}\b(null|undefined|false)\b.{0,20}/) || [''])[0]}`);   // a raw el.append(null) renders the word "null"
}

/** On the "new quiz" page: pick the count and create. Resolves when the finished quiz is shown (wait='ready') or right after the click. */
async function createQuiz(p, { count = 10, timeout = 60000, wait = 'ready' } = {}) {
  await p.waitForSelector('#create-quiz');
  await p.click(`.chips button:text-is("${count}")`);
  await p.click('#create-quiz');
  if (wait === 'ready') await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout });
}
/** The facts the (now removed) "quality report" card used to show, read from the API of the quiz on screen - tests may know them, learners are not shown them. */
async function reportOf(p) {
  const id = ((await p.evaluate(() => location.hash)).match(/#\/quiz\/(\w+)/) || [])[1]; assert(id, 'reportOf: a quiz page must be on screen');
  const q = await p.evaluate(async (i) => (await fetch('/api/quizzes/' + i)).json(), id); const r = q.report || {};
  return `تقرير الجودة ${r.delivered} / ${r.requested} أسئلة سُلّمت / مطلوبة المولّد: ${r.generator || q.generator}`.replace(/\s+/g, ' ');
}
module.exports = { TYPE_LABELS, HIDDEN_WORDS, assertHidden, createQuiz, reportOf };
