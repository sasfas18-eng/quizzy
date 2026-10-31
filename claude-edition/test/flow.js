// Shared steps/assertions for the browser E2E scripts of every edition.
// The quiz flow is ONE step: pick the file + count -> "إنشاء الكويز" -> (automatic analysis + generation) -> "جاهز للحل".
const assert = require('assert');
const TYPE_LABELS = ['الاسترجاع الأساسي', 'فهم المفاهيم', 'الآليات والتفاصيل', 'تطبيق المعلومات', 'التفكير النقدي', 'سيناريو تخصصي', 'المقارنة والتمييز', 'أفضل إجابة', 'الاستثناء / غير الصحيح', 'ترتيب الخطوات'];
const HIDDEN_WORDS = [...TYPE_LABELS, 'توكن', 'طريقة التوليد', 'هوية الأسئلة', 'التركيز', 'خطة الكويز', 'حلّل المحتوى'];

/** The ten question types, the "token"/generator choice and the plan-confirmation step must never show in the learner-facing UI. */
async function assertHidden(p, where) {
  const t = ((await p.textContent('body')) || '').replace(/\s+/g, ' ');
  for (const w of HIDDEN_WORDS) assert(!t.includes(w), `"${w}" must not be visible on ${where}`);
  assert(!/\b(null|undefined|false)\b|\[object/.test(t), `stray null/false/undefined text on ${where}: ${(t.match(/.{0,20}\b(null|undefined|false)\b.{0,20}/) || [''])[0]}`);   // a raw el.append(null) renders the word "null"
}

/** On the "new quiz" page: pick the count and create. Resolves when the finished quiz is shown (wait='ready') or right after the click. */
async function createQuiz(p, { count = 10, timeout = 60000, wait = 'ready' } = {}) {
  await p.waitForSelector('text=المصدر');
  const ex = p.locator('button:has-text("استبعد")'); if (await ex.count()) await ex.first().click();
  await p.click(`.chips button:text-is("${count}")`);
  await p.click('#create-quiz');
  if (wait === 'ready') await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout });
}
module.exports = { TYPE_LABELS, HIDDEN_WORDS, assertHidden, createQuiz };
