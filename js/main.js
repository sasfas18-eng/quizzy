import { h, $, api, state, fill, toast, spinner, errorBox, emptyState, num, fmtDate, pct, confirmDialog, ico, heroArt } from './core.js';
import { startCard } from './start.js';
import { filesPage, fileDetail } from './pages_files.js';
import { newQuizPage, quizPage, quizzesPage } from './pages_quiz.js';
import { attemptPage, resultPage } from './pages_solve.js';
import { cardsPage, studyPage } from './pages_cards.js';
import { adminPage } from './pages_admin.js';
import { settingsPage } from './pages_settings.js';
import { printPage } from './pages_print.js';

let cleanup = null;
export function onLeave(fn) { cleanup = fn; }

const routes = [
  [/^#?\/?$/, () => (state.user ? dashboard() : landing()), false],
  [/^#\/login$/, () => authPage('login'), false],
  [/^#\/register$/, () => authPage('register'), false],
  [/^#\/forgot$/, () => forgotPage(), false],
  [/^#\/reset/, () => resetPage(), false],
  [/^#\/files$/, filesPage, true],
  [/^#\/files\/(\w+)$/, fileDetail, true],
  [/^#\/new$/, newQuizPage, true],
  [/^#\/quizzes$/, quizzesPage, true],
  [/^#\/quiz\/(\w+)$/, quizPage, true],
  [/^#\/attempt\/(\w+)$/, attemptPage, true],
  [/^#\/attempt\/(\w+)\/result$/, resultPage, true],
  [/^#\/cards$/, cardsPage, true],
  [/^#\/cards\/study$/, studyPage, true],
  [/^#\/settings$/, settingsPage, true],
  [/^#\/print\/(\w+)$/, printPage, true],
  [/^#\/account$/, accountPage, true],
  [/^#\/admin$/, adminPage, true],
];

async function render() {
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
  const hash = location.hash.split('?')[0] || '#/';
  const main = $('#main');
  for (const [rx, fn, needAuth] of routes) {
    const m = hash.match(rx);
    if (!m) continue;
    if (needAuth && !state.user) { location.hash = '#/login'; return; }
    main.replaceChildren(spinner('جارٍ التحميل…'));
    drawHeader();
    try {
      const node = await fn(...m.slice(1));
      if (node) main.replaceChildren(node);
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } catch (e) {
      main.replaceChildren(errorBox(e, render));
    }
    return;
  }
  main.replaceChildren(emptyState('🧭', 'الصفحة غير موجودة', 'تحقق من الرابط أو عد إلى الرئيسية.', h('a', { class: 'btn primary', href: '#/' }, 'الرئيسية')));
}

function drawHeader() {
  const hash = location.hash, caps = state.caps || {}, u = state.user;
  const link = (href, label) => h('a', { href, class: (href === '#/' ? (hash === '' || hash === '#/') : hash.startsWith(href)) ? 'on' : '' }, label);
  const trial = caps.trial ? h('div', { class: 'trial', role: 'note' }, 'نسخة تجريبية: قد تُمسح الحسابات والملفات عند إعادة تشغيل الخادم. للاستخدام الدائم فعّل القرص الدائم (انظر docs/DEPLOY.md).') : null;
  const canLogout = !caps.edition || caps.accounts === 'supabase';          // device / Claude editions have no sign-out: the account IS the device / Claude login
  const menu = u ? h('details', { class: 'menu' }, h('summary', {}, h('span', { class: 'avatar', 'aria-hidden': 'true' }, (u.name || '؟').trim().charAt(0)), h('span', { class: 'bidi' }, u.name)),
    h('div', { class: 'pop' }, h('a', { href: '#/files' }, 'ملفاتي'), caps.byok && !caps.shared_ai ? h('a', { href: '#/settings' }, 'ربط الذكاء الاصطناعي') : null, h('a', { href: '#/account' }, 'حسابي'),
      u.role === 'admin' ? h('a', { href: '#/admin' }, 'الإدارة') : null, canLogout ? h('hr') : null, canLogout ? h('button', { onclick: logout }, 'تسجيل الخروج') : null)) : null;
  fill($('#top'), trial, h('div', { class: 'bar' },
    h('a', { class: 'logo', href: '#/' }, h('i', {}, ico('logo')), 'كويزي'),
    u ? h('nav', { class: 'links', 'aria-label': 'التنقل' }, link('#/', 'الرئيسية'), link('#/quizzes', 'كويزاتي'), link('#/cards', 'المراجعة')) : h('span', { class: 'spacer' }),
    h('span', { id: 'savestate', role: 'status', 'aria-live': 'polite' }),
    u ? menu : h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/login' }, 'دخول'), h('a', { class: 'btn small primary', href: '#/register' }, 'إنشاء حساب'))));
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
  state.user = null; location.hash = '#/'; render();
}

const STEPS = () => h('div', { class: 'steps3' },
  h('div', { class: 'step' }, h('b', {}, '١'), h('div', {}, h('strong', {}, 'ارفع اللكتشر'), h('span', {}, 'PDF أو PowerPoint، بنصه وجداوله وصوره.'))),
  h('div', { class: 'step' }, h('b', {}, '٢'), h('div', {}, h('strong', {}, 'نكتب لك الأسئلة'), h('span', {}, 'تغطي المحاضرة كلها، وكل سؤال له دليله من صفحة المصدر.'))),
  h('div', { class: 'step' }, h('b', {}, '٣'), h('div', {}, h('strong', {}, 'تدرّب وراجع'), h('span', {}, 'حلّ بتفسير فوري، وبطاقات مراجعة، ونتيجة تدلّك على ما تراجعه.'))));
function landing() {
  return h('div', {},
    h('section', { class: 'hero2' }, h('div', { class: 'txt' }, h('span', { class: 'kicker' }, '✦ مجاني للبدء'), h('h1', {}, 'حوّل لكتشرك إلى كويز في دقائق'),
      h('p', { class: 'lead' }, 'ارفع الملف ونحن نقرأ نصوصه وجداوله وصوره، ونكتب أسئلة تغطي المحاضرة كلها. تقدّمك محفوظ على حسابك وتكمل من أي جهاز.'),
      h('div', { class: 'row', style: 'margin-top:1.3rem' }, h('a', { class: 'btn primary big', href: '#/register' }, 'ابدأ مجانًا'), h('a', { class: 'btn big', href: '#/login' }, 'لدي حساب'))), heroArt()),
    STEPS(),
    h('section', { class: 'grid g3' },
      h('div', { class: 'card' }, h('h3', {}, 'جودة قبل الكمية'), h('p', { class: 'muted' }, 'كل سؤال يمرّ بتحقق من الدليل في صفحة المصدر وحلّ مستقل وكشف للتكرار. لا نسلّم سؤالًا فيه عيب حاسم.')),
      h('div', { class: 'card' }, h('h3', {}, 'أسئلة متنوعة بحسب ملفك'), h('p', { class: 'muted' }, 'لا تختار أنواع الأسئلة بنفسك: نقرأ اللكتشر ونضيف تلقائيًا ما يدعمه محتواه من مستويات وصيغ مختلفة.')),
      h('div', { class: 'card' }, h('h3', {}, 'خصوصيتك'), h('p', { class: 'muted' }, 'ملفاتك وإجاباتك مرتبطة بحسابك فقط. لا حساب ChatGPT مطلوب.'))));
}

function authPage(mode) {
  const reg = mode === 'register';
  const regMode = state.caps?.registration || 'open';
  if (reg && regMode === 'closed') return h('div', { class: 'card', style: 'max-width:440px;margin:1.5rem auto' }, h('h2', {}, 'التسجيل مغلق حاليًا'), h('p', { class: 'muted' }, 'لا يقبل الموقع حسابات جديدة الآن.'), h('a', { class: 'btn', href: '#/login' }, 'تسجيل الدخول'));
  const err = h('div', { role: 'alert' });
  const f = (id, label, type, extra = {}) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name: id, type, required: true, autocomplete: extra.ac, minlength: extra.min, dir: type === 'email' ? 'ltr' : null }));
  const form = h('form', { class: 'card', style: 'max-width:440px;margin:1.5rem auto', onsubmit: async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    err.replaceChildren();
    btn.disabled = true;
    try {
      const res = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', reg ? { email: v.email, name: v.name, password: v.password, invite_code: v.invite_code || null } : { email: v.email, password: v.password }, { noRedirect: true });
      if (res && res.pending_confirmation) { err.replaceChildren(h('div', { class: 'alert ok' }, res.message)); btn.disabled = false; return; }
      state.user = res; location.hash = '#/'; render();
    } catch (ex) { err.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); btn.disabled = false; }
  } },
    h('h2', {}, reg ? 'إنشاء حساب جديد' : 'تسجيل الدخول'),
    reg && f('name', 'الاسم', 'text', { ac: 'name' }),
    f('email', 'البريد الإلكتروني', 'email', { ac: 'email' }),
    f('password', 'كلمة المرور', 'password', { ac: reg ? 'new-password' : 'current-password', min: reg ? 8 : null }),
    reg && regMode === 'invite' && h('div', { class: 'field' }, h('label', { for: 'invite_code' }, 'رمز الدعوة'), h('input', { id: 'invite_code', name: 'invite_code', type: 'text', required: true, dir: 'ltr', autocomplete: 'off' })),
    reg && h('p', { class: 'hint' }, '٨ أحرف على الأقل.'), err,
    h('button', { class: 'btn primary', id: 'go', type: 'submit' }, reg ? 'إنشاء الحساب' : 'دخول'),
    h('p', { class: 'small', style: 'margin-top:1rem' }, reg ? h('span', {}, 'لديك حساب؟ ', h('a', { href: '#/login' }, 'سجّل الدخول')) : h('span', {}, 'ليس لديك حساب؟ ', h('a', { href: '#/register' }, 'أنشئ حسابًا'), ' · ', h('a', { href: '#/forgot' }, 'نسيت كلمة المرور؟'))));
  const btn = form.querySelector('#go');
  return form;
}

function forgotPage() {
  const out = h('div', {});
  const form = h('form', { class: 'card', style: 'max-width:440px;margin:1.5rem auto', onsubmit: async (e) => {
    e.preventDefault();
    out.replaceChildren();
    try { const r = await api('POST', '/api/auth/forgot', { email: new FormData(form).get('email') }, { noRedirect: true }); out.replaceChildren(h('div', { class: 'alert ok' }, r.message)); }
    catch (ex) { out.replaceChildren(h('div', { class: 'alert warn' }, ex.message)); }
  } }, h('h2', {}, 'استعادة كلمة المرور'),
    !state.caps?.password_reset && h('div', { class: 'alert warn' }, 'خدمة البريد غير مجهزة على هذا الخادم بعد، لذا لن تصل رسائل الاستعادة. تواصل مع مسؤول الموقع.'),
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'البريد الإلكتروني'), h('input', { id: 'email', name: 'email', type: 'email', dir: 'ltr', required: true })),
    out, h('button', { class: 'btn primary', type: 'submit' }, 'أرسل الرابط'), h('p', { class: 'small' }, h('a', { href: '#/login' }, 'عودة')));
  return form;
}

function resetPage() {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
  const out = h('div', {});
  const form = h('form', { class: 'card', style: 'max-width:440px;margin:1.5rem auto', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/auth/reset', { token, password: new FormData(form).get('password') }, { noRedirect: true }); toast('تم تغيير كلمة المرور. سجّل الدخول.', 'ok'); location.hash = '#/login'; }
    catch (ex) { out.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); }
  } }, h('h2', {}, 'كلمة مرور جديدة'),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'كلمة المرور الجديدة'), h('input', { id: 'password', name: 'password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
    out, h('button', { class: 'btn primary', type: 'submit' }, 'حفظ'));
  return form;
}

async function accountPage() {
  const msg = h('div', { role: 'status' });
  const pw = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(pw)); msg.replaceChildren();
    try { await api('POST', '/api/auth/password', { current_password: v.current, new_password: v.next }); pw.reset(); msg.replaceChildren(h('div', { class: 'alert ok' }, 'تم تغيير كلمة المرور وخروج بقية الأجهزة.')); }
    catch (ex) { msg.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); }
  } }, h('h2', {}, 'تغيير كلمة المرور'),
    h('div', { class: 'field' }, h('label', { for: 'current' }, 'كلمة المرور الحالية'), h('input', { id: 'current', name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('div', { class: 'field' }, h('label', { for: 'next' }, 'كلمة المرور الجديدة'), h('input', { id: 'next', name: 'next', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' })),
    msg, h('button', { class: 'btn primary', type: 'submit' }, 'حفظ'));
  const del = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); const pass = new FormData(del).get('pass');
    if (!(await confirmDialog('حذف الحساب نهائيًا؟', 'سيُحذف حسابك وكل ملفاتك وكويزاتك ومحاولاتك وبطاقاتك. لا يمكن التراجع.', 'احذف حسابي', true))) return;
    try { await api('POST', '/api/auth/delete', { password: pass }); state.user = null; location.hash = '#/'; render(); toast('حُذف حسابك وبياناتك'); }
    catch (ex) { toast(ex.message, 'bad'); }
  } }, h('h2', {}, 'حذف الحساب'), h('p', { class: 'muted' }, 'حقك في محو بياناتك بالكامل.'),
    h('div', { class: 'field' }, h('label', { for: 'pass' }, 'كلمة المرور للتأكيد'), h('input', { id: 'pass', name: 'pass', type: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'btn danger', type: 'submit' }, 'حذف حسابي وبياناتي'));
  const deviceOnly = state.caps?.accounts === 'device';
  const wipe = h('div', { class: 'card' }, h('h2', {}, 'مسح بياناتي من هذا الجهاز'), h('p', { class: 'muted' }, 'يحذف ملفاتك وكويزاتك ومحاولاتك وبطاقاتك المحفوظة في هذا المتصفح. لا يمكن التراجع.'),
    h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('مسح كل البيانات؟', 'سيُمسح كل ما في هذا المتصفح من ملفات وكويزات.', 'امسح', true)) { await api('POST', '/api/auth/delete', { password: '' }); toast('مُسحت البيانات'); location.hash = '#/'; render(); } } }, 'مسح بياناتي'));
  return h('div', { style: 'max-width:640px;margin:auto' }, h('h1', {}, 'حسابي'),
    h('div', { class: 'card' }, h('div', { class: 'bidi' }, h('strong', {}, state.user.name), h('div', { class: 'muted small ltr' }, state.user.email)),
      h('p', { class: 'muted' }, 'تصدير كل بياناتك (ملفاتك وكويزاتك ومحاولاتك وبطاقاتك) في ملف JSON واحد:'),
      h('a', { class: 'btn', href: '/api/auth/export', download: 'quizzy-export.json' }, '⬇ تصدير بياناتي')), ...(deviceOnly ? [wipe] : [pw, del]));
}

async function dashboard() {
  const [docs, quizzes, attempts, cardStats] = await Promise.all([api('GET', '/api/documents'), api('GET', '/api/quizzes'), api('GET', '/api/attempts?status=in_progress'), api('GET', '/api/cards/stats')]);
  const needReview = cardStats.reduce((a, c) => a + (c.due || 0), 0), totalCards = cardStats.reduce((a, c) => a + c.total, 0);
  const root = h('div', {}, h('section', { class: 'hero2' }, h('div', { class: 'txt' }, h('span', { class: 'kicker' }, `أهلًا ${state.user.name}`), h('h1', {}, 'حوّل لكتشرك إلى كويز في دقائق'),
    h('p', { class: 'lead' }, 'ارفع الملف ونحن نقرأ نصوصه وجداوله وصوره، ونكتب أسئلة تغطي المحاضرة كلها — لكل سؤال دليله من صفحة المصدر.')), heroArt(), startCard()));
  if (!quizzes.length) root.append(STEPS());
  if (attempts.length) {
    root.append(h('div', { class: 'card' }, h('h2', {}, 'أكمل من حيث توقفت'),
      attempts.slice(0, 3).map((a) => h('div', { class: 'row between', style: 'padding:.6rem 0;border-top:1px solid var(--line)' },
        h('div', {}, h('strong', { class: 'bidi' }, a.quiz_title), h('div', { class: 'muted small' }, `${a.mode === 'exam' ? 'اختبار' : 'تدريب'} · أجبت ${num(a.answered)} من ${num(a.total)} · ${fmtDate(a.updated_at)}`)),
        h('a', { class: 'btn primary small', href: `#/attempt/${a.id}` }, 'متابعة')))));
  }
  if (quizzes.length) root.append(h('div', { class: 'pagehead', style: 'margin-top:1.4rem' }, h('h2', { style: 'margin:0' }, 'كويزاتك'), h('a', { href: '#/quizzes' }, 'عرض الكل')), quizList(quizzes.slice(0, 4)));
  if (totalCards) root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('div', { class: 'row between' }, h('div', {}, h('strong', {}, needReview ? `${num(needReview)} بطاقة مستحقة للمراجعة اليوم` : 'لا بطاقات مستحقة اليوم'), h('div', { class: 'muted small' }, `من ${num(totalCards)} بطاقة`)),
    needReview ? h('a', { class: 'btn primary small', href: '#/cards/study?due=1' }, 'راجعها الآن') : h('a', { class: 'btn small', href: '#/cards' }, 'البطاقات'))));
  return root;
}
const QSTATUS = { draft: ['مسودة', 'info'], analyzing: ['يُجهَّز…', 'info'], planned: ['يُجهَّز…', 'info'], generating: ['تُكتب الأسئلة…', 'info'], ready: ['جاهز', 'ok'], failed: ['تعذّر', 'bad'], insufficient: ['المصدر لا يكفي', 'warn'] };
export function quizList(list) {
  return h('div', { class: 'recent' }, list.map((q) => h('a', { class: 'item', href: `#/quiz/${q.id}` }, h('span', { class: 'ficon' }, ico('quiz')),
    h('div', { class: 'meta' }, h('strong', { class: 'fname' }, q.title, q.generator === 'test-generator' && h('span', { class: 'badge test', style: 'margin-inline-start:.4rem' }, 'محتوى اختباري')), h('span', { class: 'muted small' }, `${q.question_count != null ? num(q.question_count) + ' سؤال · ' : ''}${fmtDate(q.created_at)}`)),
    h('span', { class: 'badge ' + QSTATUS[q.status][1] }, QSTATUS[q.status][0]))));
}

async function boot() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { state.caps = { llm: false }; }
  try { state.user = await api('GET', '/api/auth/me', undefined, { noRedirect: true }); } catch (_) { state.user = null; }
  window.addEventListener('hashchange', render);
  render();
}
boot();
