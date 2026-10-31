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

/** The new-quiz card (start card): wait until the lecture has been read, optionally pick a count, create. Resolves when the finished quiz is shown. */
async function createQuiz(p, { count = null, timeout = 90000, wait = 'ready' } = {}) {
  await p.waitForSelector('#create-quiz', { timeout });
  if (count != null) await setCount(p, count);
  await p.click('#create-quiz');
  if (wait === 'ready') await p.waitForSelector('#start-solve', { timeout });
}
/** options are folded away by default: open them and pick the number of questions ("تلقائي" or 10/20/30/40) */
async function setCount(p, count) {
  const open = await p.locator('details.opts-panel').evaluate((e) => e.open);
  if (!open) await p.click('details.opts-panel summary');
  await p.click(`.chips button:text-is("${count}")`);
}
/** Home (or #/new) -> choose a file -> wait for it to be read -> create */
async function uploadAndCreate(p, base, file, opts = {}) {
  await p.goto(base + '/' + (opts.route || '#/')); await p.waitForSelector('#dropzone'); await p.setInputFiles('#file', file);
  await createQuiz(p, opts);
}
/** the sign-out button lives in the account menu */
async function logout(p) { await p.click('header details.menu summary'); await p.click('button:has-text("تسجيل الخروج")'); }

module.exports = { TYPE_LABELS, HIDDEN_WORDS, assertHidden, createQuiz, setCount, uploadAndCreate, logout };
