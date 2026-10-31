import { h, $, api, state, toast, spinner, errorBox, emptyState, num, fmtDate, pct } from './core.js';
import { filesPage, fileDetail } from './pages_files.js';
import { newQuizPage, quizPage, quizzesPage } from './pages_quiz.js';
import { attemptPage, resultPage } from './pages_solve.js';
import { cardsPage, studyPage } from './pages_cards.js';
import { adminPage } from './pages_admin.js';

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
  const hash = location.hash;
  const link = (href, label) => h('a', { href, class: hash.startsWith(href) && href !== '#/' ? 'on' : (href === '#/' && (hash === '' || hash === '#/') ? 'on' : '') }, label);
  const u = state.user;
  $('#top').replaceChildren(h('div', { class: 'bar' },
    h('a', { class: 'logo', href: '#/' }, h('i', {}, '✓'), 'كويزي'),
    u ? h('nav', { class: 'links', 'aria-label': 'التنقل' }, link('#/', 'الرئيسية'), link('#/files', 'ملفاتي'), link('#/quizzes', 'كويزاتي'), link('#/cards', 'بطاقات المراجعة'),
      u.role === 'admin' && link('#/admin', 'الإدارة')) : h('span', { class: 'spacer' }),
    h('span', { id: 'savestate', role: 'status', 'aria-live': 'polite' }),
    u ? h('div', { class: 'row' }, h('span', { class: 'muted small bidi' }, u.name), h('button', { class: 'btn small', onclick: logout }, 'خروج'))
      : h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/login' }, 'دخول'), h('a', { class: 'btn small primary', href: '#/register' }, 'إنشاء حساب'))));
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
  state.user = null; location.hash = '#/'; render();
}

function landing() {
  const need = (t, d) => h('li', {}, h('div', {}, h('strong', {}, t), h('div', { class: 'muted small' }, d)));
  return h('div', {},
    h('section', { class: 'hero' },
      h('div', {},
        h('h1', {}, 'حوّل سلايداتك إلى كويزات دقيقة وبطاقات مراجعة'),
        h('p', { class: 'lead' }, 'ارفع ملف PDF أو PPTX، اختر الصفحات، ويبني «كويزي» أسئلة موثّقة بصفحة المصدر ودليله، مع تفسير لكل إجابة. تقدّمك محفوظ على حسابك وتكمل من أي جهاز.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/register' }, 'ابدأ مجانًا'), h('a', { class: 'btn', href: '#/login' }, 'لدي حساب'))),
      h('div', { class: 'card' }, h('h3', {}, 'كيف يعمل؟'),
        h('ol', { class: 'steps plain' },
          need('ارفع السلايدات', 'PDF أو PPTX، ونخبرك بصراحة عن أي صفحة غير مقروءة.'),
          need('حدّد النطاق والإعدادات', 'الصفحات، العدد، الصعوبة، اللغة، التركيز، التدريب أو الاختبار.'),
          need('راجع الخطة قبل التوليد', 'نُظهر ما يدعمه محتواك وما لا يدعمه، دون حشو.'),
          need('حلّ أو نزّل PDF', 'تفسير بعد الإجابة، مراجعة، وبطاقات للمراجعة.')))),
    h('section', { class: 'grid g3' },
      h('div', { class: 'card' }, h('h3', {}, 'جودة قبل الكمية'), h('p', { class: 'muted' }, 'كل سؤال يمرّ بتحقق من الدليل في صفحة المصدر، وحلّ مستقل أعمى، وكشف للتكرار والتسريب. لا نسلّم سؤالًا فيه عيب حاسم.')),
      h('div', { class: 'card' }, h('h3', {}, 'هوية الأسئلة العشرة'), h('p', { class: 'muted' }, 'استرجاع، فهم، آليات، تطبيق، تفكير نقدي، سيناريوهات تخصصية، مقارنة، أفضل إجابة، الاستثناء، والترتيب — بحسب ما يدعمه ملفك فعلًا.')),
      h('div', { class: 'card' }, h('h3', {}, 'خصوصيتك'), h('p', { class: 'muted' }, 'ملفاتك وإجاباتك مرتبطة بحسابك فقط. لا حساب ChatGPT مطلوب.'))));
}

function authPage(mode) {
  const reg = mode === 'register';
  const err = h('div', { role: 'alert' });
  const f = (id, label, type, extra = {}) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name: id, type, required: true, autocomplete: extra.ac, minlength: extra.min, dir: type === 'email' ? 'ltr' : null }));
  const form = h('form', { class: 'card', style: 'max-width:440px;margin:1.5rem auto', onsubmit: async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    err.replaceChildren();
    btn.disabled = true;
    try {
      state.user = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', reg ? { email: v.email, name: v.name, password: v.password, field: v.field || null } : { email: v.email, password: v.password }, { noRedirect: true });
      location.hash = '#/'; render();
    } catch (ex) { err.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); btn.disabled = false; }
  } },
    h('h2', {}, reg ? 'إنشاء حساب جديد' : 'تسجيل الدخول'),
    reg && f('name', 'الاسم', 'text', { ac: 'name' }),
    f('email', 'البريد الإلكتروني', 'email', { ac: 'email' }),
    f('password', 'كلمة المرور', 'password', { ac: reg ? 'new-password' : 'current-password', min: reg ? 8 : null }),
    reg && h('div', { class: 'field' }, h('label', { for: 'field' }, 'تخصصك (يحدد صياغة السيناريوهات)'),
      h('select', { id: 'field', name: 'field' }, Object.entries(state.caps?.fields || {}).map(([k, v]) => h('option', { value: k }, v)))),
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

async function dashboard() {
  const [docs, quizzes, attempts, cardStats] = await Promise.all([api('GET', '/api/documents'), api('GET', '/api/quizzes'), api('GET', '/api/attempts?status=in_progress'), api('GET', '/api/cards/stats')]);
  const needReview = cardStats.reduce((a, c) => a + (c.review || 0), 0);
  const totalCards = cardStats.reduce((a, c) => a + c.total, 0);
  const root = h('div', {}, h('div', { class: 'row between' }, h('h1', {}, `أهلًا ${state.user.name}`), h('a', { class: 'btn primary', href: '#/new' }, '＋ كويز جديد')));
  if (!docs.length) {
    root.append(h('div', { class: 'card' }, emptyState('📄', 'ابدأ برفع أول ملف', 'ارفع سلايدات PDF أو PPTX لتحويلها إلى كويز وبطاقات مراجعة.', h('a', { class: 'btn primary', href: '#/files' }, 'رفع ملف'))));
    return root;
  }
  if (attempts.length) {
    root.append(h('div', { class: 'card' }, h('h2', {}, 'أكمل من حيث توقفت'),
      attempts.slice(0, 4).map((a) => h('div', { class: 'row between', style: 'padding:.5rem 0;border-top:1px solid var(--line)' },
        h('div', {}, h('strong', { class: 'bidi' }, a.quiz_title), h('div', { class: 'muted small' }, `${a.mode === 'exam' ? 'اختبار' : 'تدريب'} · أجبت ${num(a.answered)} من ${num(a.total)} · آخر نشاط ${fmtDate(a.updated_at)}`)),
        h('a', { class: 'btn primary small', href: `#/attempt/${a.id}` }, 'متابعة')))));
  }
  root.append(h('div', { class: 'grid g3' },
    h('div', { class: 'card' }, h('div', { class: 'stat' }, num(docs.length)), h('div', { class: 'stat-l' }, 'ملفاتك'), h('a', { href: '#/files' }, 'إدارة الملفات')),
    h('div', { class: 'card' }, h('div', { class: 'stat' }, num(quizzes.filter((q) => q.status === 'ready').length)), h('div', { class: 'stat-l' }, 'كويزات جاهزة'), h('a', { href: '#/quizzes' }, 'عرض الكويزات')),
    h('div', { class: 'card' }, h('div', { class: 'stat' }, num(needReview)), h('div', { class: 'stat-l' }, `بطاقات تحتاج مراجعة (من ${num(totalCards)})`),
      needReview ? h('a', { href: '#/cards/study?state=review' }, 'راجعها الآن') : h('a', { href: '#/cards' }, 'البطاقات')),
  ));
  const recent = quizzes.slice(0, 5);
  if (recent.length) root.append(h('div', { class: 'card' }, h('h2', {}, 'آخر الكويزات'), quizTable(recent)));
  return root;
}
export function quizTable(list) {
  const st = { draft: ['مسودة', 'info'], analyzing: ['يُحلَّل…', 'info'], planned: ['بانتظار تأكيد الخطة', 'warn'], generating: ['يُولَّد…', 'info'], ready: ['جاهز', 'ok'], failed: ['فشل', 'bad'], insufficient: ['المصدر لا يكفي', 'warn'] };
  return h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['العنوان', 'الحالة', 'الأسئلة', 'أُنشئ', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, list.map((q) => h('tr', {}, h('td', { class: 'bidi' }, h('a', { href: `#/quiz/${q.id}` }, q.title), q.generator === 'test-generator' && h('span', { class: 'badge test', style: 'margin-inline-start:.4rem' }, 'محتوى اختباري')),
      h('td', {}, h('span', { class: 'badge ' + st[q.status][1] }, st[q.status][0])), h('td', {}, q.question_count != null ? num(q.question_count) : '—'), h('td', { class: 'muted small' }, fmtDate(q.created_at)),
      h('td', {}, h('a', { class: 'btn small', href: `#/quiz/${q.id}` }, 'فتح')))))));
}

async function boot() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { state.caps = { fields: {}, llm: false }; }
  try { state.user = await api('GET', '/api/auth/me', undefined, { noRedirect: true }); } catch (_) { state.user = null; }
  window.addEventListener('hashchange', render);
  render();
}
boot();
