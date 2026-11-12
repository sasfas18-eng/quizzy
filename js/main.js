import { h, $, api, state, fill, toast, spinner, errorBox, emptyState, num, fmtDate, pct, confirmDialog, icon, logoMark } from './core.js?v=8295f203d4';
import { filesPage, fileDetail } from './pages_files.js?v=8295f203d4';
import { newQuizPage, quizPage, quizzesPage } from './pages_quiz.js?v=8295f203d4';
import { attemptPage, resultPage } from './pages_solve.js?v=8295f203d4';
import { cardsPage, studyPage } from './pages_cards.js?v=8295f203d4';
import { adminPage } from './pages_admin.js?v=8295f203d4';
import { operatorPage } from './pages_settings.js?v=8295f203d4';
import { printPage } from './pages_print.js?v=8295f203d4';
import { devPage } from './pages_dev.js?v=8295f203d4';
import { lang, setLang, ready as langReady } from './i18n.js?v=8295f203d4';

let cleanup = null;
export function onLeave(fn) { cleanup = fn; }

const routes = [
  [/^#?\/?$/, () => (state.user ? dashboard() : landing()), false],
  [/^#\/login$/, () => authPage('login'), false],
  [/^#\/register$/, () => authPage('register'), false],
  [/^#\/guest$/, () => guestRoute(), false],
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
  [/^#\/smart$/, () => smartPage(), false],      // smart generation: each path signed in with the student's OWN account at that service (no key in this site)
  [/^#\/operator$/, operatorPage, false],      // the operator's page needs no account: it is how the operator finds out WHY accounts do not work yet
  [/^#\/print\/(\w+)$/, printPage, true],
  [/^#\/account$/, accountPage, true],
  [/^#\/admin$/, adminPage, true],
  [/^#\/dev$/, devPage, true],      // the development track: the owner's only (the API refuses everyone else)
];

let renderSeq = 0;      // every render takes a number: a page that finishes loading AFTER the student has already moved on must not replace the page they are on now
async function render() {
  const seq = ++renderSeq;
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
      if (seq !== renderSeq) return;      // stale: a newer navigation owns the page now
      if (node) main.replaceChildren(node);
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } catch (e) {
      if (seq !== renderSeq) return;
      main.replaceChildren(errorBox(e, render));
    }
    return;
  }
  main.replaceChildren(emptyState('🧭', 'الصفحة غير موجودة', 'تحقق من الرابط أو عد إلى الرئيسية.', h('a', { class: 'btn primary', href: '#/' }, 'الرئيسية')));
}

const THEME_KEY = 'quizzy_theme';
const curTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function themeToggle() {
  return h('button', { class: 'iconbtn themebtn', type: 'button', id: 'theme-toggle', 'aria-label': 'تبديل الوضع الليلي/النهاري', title: 'تبديل الوضع الليلي/النهاري',
    onclick: () => { const next = curTheme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* storage blocked */ } } }, icon('moon'), icon('sun'), h('span', { class: 'lbl moon' }, 'الوضع الليلي'), h('span', { class: 'lbl sun' }, 'الوضع النهاري'));      // the label says what a click does, like the icon
}
// the site's language: a two-way switch, «English | العربية» in that order in both directions, so its highlighter marker slides across and nothing else moves;
// each name is written in its own language and never translated. On a phone there is also a small button in the top bar (the other language, one tap).
const LANGS = [['en', 'English'], ['ar', 'العربية']];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let switching = false;
async function switchLang(l, group) {
  if (switching || l === lang()) return; switching = true;
  if (group) { group.dataset.on = l; group.querySelectorAll('[role=radio]').forEach((b) => { const on = b.lang === l; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); }
  if (group && !reducedMotion()) await new Promise((r) => setTimeout(r, 260));      // the marker reaches the other name first
  const go = async () => { await setLang(l); await render(); };
  try { if (document.startViewTransition && !reducedMotion()) await document.startViewTransition(go).finished; else await go(); }
  catch (_) { /* the page is drawn either way */ }
  finally { switching = false; const b = document.querySelector(`.langsw [lang=${l}]`); if (b && group) b.focus({ preventScroll: true }); }
}
function langSwitch() {
  const g = h('div', { class: 'langsw', id: 'lang-switch', role: 'radiogroup', 'aria-label': 'لغة الموقع', 'data-on': lang(),
    onkeydown: (e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); switchLang(lang() === 'en' ? 'ar' : 'en', g); } } },
  icon('globe'), h('span', { class: 'thumb', 'aria-hidden': 'true' }),
  LANGS.map(([l, name]) => h('button', { type: 'button', role: 'radio', lang: l, translate: 'no', 'aria-checked': String(lang() === l), tabindex: lang() === l ? 0 : -1, onclick: () => switchLang(l, g) }, name)));
  return g;
}
const langButton = () => { const other = lang() === 'en' ? 'ar' : 'en';
  return h('button', { class: 'iconbtn langbtn', type: 'button', id: 'lang-quick', lang: other, translate: 'no', 'aria-label': other === 'en' ? 'Switch to English' : 'التبديل إلى العربية', onclick: () => switchLang(other) },
    icon('globe'), h('span', {}, other === 'en' ? 'EN' : 'ع')); };
// the side menu is always open on a wide screen; on a phone it is a drawer: button, scrim, Esc, links close it, Tab stays inside while it is open
function closeMenu(refocus) {
  const t = $('#top'); if (!t || !t.classList.contains('open')) return;
  t.classList.remove('open'); document.body.classList.remove('menu-open'); const b = $('#menu-btn'); if (b) { b.setAttribute('aria-expanded', 'false'); if (refocus) b.focus(); }
}
function toggleMenu() {
  const t = $('#top'); const open = !t.classList.contains('open'); t.classList.toggle('open', open); document.body.classList.toggle('menu-open', open); $('#menu-btn').setAttribute('aria-expanded', String(open));
  if (open) { const first = t.querySelector('.drawer-close'); if (first) first.focus(); } else $('#menu-btn').focus();
}
document.addEventListener('keydown', (e) => {
  const t = $('#top'); if (!t || !t.classList.contains('open')) return;
  if (e.key === 'Escape') { closeMenu(true); return; }
  if (e.key === 'Tab') { const f = [...t.querySelectorAll('.drawer a, .drawer button')].filter((x) => x.offsetParent !== null); if (!f.length) return; const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } }
});
function drawHeader() {
  closeMenu();      // every navigation (a link, logout, sign-in...) leaves the drawer closed
  const hash = location.hash;
  const isOn = (href) => (href === '#/' ? (hash === '' || hash === '#/') : hash.startsWith(href));
  const link = (href, label, ico) => h('a', { href, class: isOn(href) ? 'on' : '', ...(isOn(href) ? { 'aria-current': 'page' } : {}), onclick: () => closeMenu() }, icon(ico), h('span', {}, label));
  const chatLink = (compact = false) => h('a', { href: '#/smart', class: (compact ? 'iconbtn chatgpt-jump' : 'chatgpt-jump') + (isOn('#/smart') ? ' on' : ''), title: 'أنشئ بالذكاء الاصطناعي بحسابك', 'aria-label': compact ? 'أنشئ بالذكاء الاصطناعي بحسابك' : null, onclick: () => closeMenu() }, icon('spark'), compact ? null : h('span', {}, 'التوليد الذكي'));
  const u = state.user;
  const trial = state.caps?.trial ? h('div', { class: 'trial', role: 'note' }, 'نسخة تجريبية: قد تُمسح الحسابات والملفات عند إعادة تشغيل الخادم. للاستخدام الدائم فعّل القرص الدائم (انظر docs/DEPLOY.md).') : null;
  fill($('#notice'), trial);
  fill($('#top'),
    h('div', { class: 'topbar' },
      h('button', { class: 'iconbtn menu-btn', type: 'button', id: 'menu-btn', 'aria-label': 'القائمة', 'aria-expanded': 'false', 'aria-controls': 'drawer', onclick: toggleMenu }, icon('menu')),
      h('a', { class: 'logo', href: '#/', 'aria-label': 'كويزي — الرئيسية', onclick: () => closeMenu() }, logoMark(), h('span', { class: 'wm' }, h('b', {}, 'كويزي'))),
      h('span', { id: 'savestate', role: 'status', 'aria-live': 'polite' }), state.caps?.edition === 'web' && chatLink(true), langButton()),
    h('div', { class: 'drawer', id: 'drawer' },
      h('button', { class: 'iconbtn drawer-close', type: 'button', 'aria-label': 'إغلاق القائمة', onclick: () => closeMenu(true) }, icon('close')),
      h('nav', { class: 'links', 'aria-label': 'التنقل' }, link('#/', 'الرئيسية', 'home'), state.caps?.edition === 'web' && chatLink(), !u && state.caps?.guest && link('#/guest', 'الدخول كضيف', 'user'),
        u && [link('#/files', 'ملفاتي', 'files'), link('#/quizzes', 'كويزاتي', 'quiz'), link('#/cards', 'بطاقات المراجعة', 'cards'), state.caps?.operator && link('#/operator', 'وضع المشغل', 'gear'), state.caps?.dev && link('#/dev', 'مسار التطوير', 'spark'), u.role === 'admin' && link('#/admin', 'الإدارة', 'shield')]),
      h('div', { class: 'acts' }, langSwitch(), themeToggle(),
        u ? [h('a', { class: 'muted small bidi acct', href: '#/account', title: 'حسابي', 'aria-label': 'حسابي: ' + u.name, onclick: () => closeMenu() }, icon('user'), h('span', { class: 'nm' }, u.name)), u.guest && canRegister() ? h('a', { class: 'btn small primary', href: '#/register', onclick: () => closeMenu() }, 'إنشاء حساب') : null, h('button', { class: 'btn small', onclick: logout }, 'خروج')]
          : [h('a', { class: 'btn small', href: '#/login', onclick: () => closeMenu() }, 'دخول'), h('a', { class: 'btn small primary', href: '#/register', onclick: () => closeMenu() }, 'إنشاء حساب')])),
    h('div', { class: 'scrim', 'aria-hidden': 'true', onclick: () => closeMenu(true) }));
}

const isGuest = () => !!state.user?.guest;
/** the accounts of this site live on THIS device only (there is no cloud yet): said where it matters (the forms, the account page), never as a bar above the site */
const deviceAccounts = () => state.caps?.edition === 'web' && !state.caps?.cloud_accounts;
const canRegister = () => (state.caps?.can_register != null ? !!state.caps.can_register : state.caps?.registration !== 'closed');
async function refreshCaps() { try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep the old ones */ } }
/** "Guest": no registration; the work is kept on this device (the server edition: in a temporary account) and nothing is guaranteed. */
async function enterGuest() {
  try { state.user = await api('POST', '/api/auth/guest', undefined, { noRedirect: true }); await refreshCaps(); location.hash = '#/'; render(); }
  catch (ex) { toast(ex.message, 'bad'); location.hash = '#/login'; }
}
function guestRoute() { if (state.user) { location.hash = '#/'; return spinner('جارٍ التحميل…'); } if (!state.caps?.guest) { location.hash = '#/login'; return spinner('جارٍ التحميل…'); } enterGuest(); return spinner('جارٍ الدخول كضيف…'); }
const guestPitch = (id = 'guest-enter') => (state.caps?.guest ? h('div', { class: 'guest-cta' },
  h('a', { class: 'btn', id, href: '#/guest' }, h('span', {}, 'جرّب كضيف — بلا تسجيل')),
  h('p', { class: 'muted small' }, 'لا حساب ولا بريد. يُحفظ ما تصنعه في هذا المتصفح فقط، ولا ضمان لبقائه (قد يضيع بمسح بيانات المتصفح أو بتغيير الجهاز).')) : null);
async function logout() {
  if (isGuest() && !state.caps?.edition && !(await confirmDialog('الخروج من وضع الضيف؟', 'حساب الضيف مؤقت: إن خرجتَ لا يمكنك العودة إلى ملفاتك وكويزاتك. أنشئ حسابًا أولًا إن أردت الاحتفاظ بها.', 'اخرج', true))) return;
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
  state.user = null; await refreshCaps(); location.hash = '#/'; render();
}

// ---- smart paths (#/smart): links only; ChatGPT generation needs its separate in-chat plugin to be available to the student.
// Nothing is sent from this site and no key is in it.
const SMART = {
  chatgpt: 'https://chatgpt.com/?q=%D8%A7%D9%81%D8%AA%D8%AD%20%D9%83%D9%88%D9%8A%D8%B2%D9%8A', // opens a ChatGPT conversation with «افتح كويزي» ready; the in-chat plugin handles generation
  claude: 'https://claude.ai/artifact/DdmX7Yx3yuqH9gZChPVmNN',
};
function smartPage() {
  const path = (id, ico, name, who, steps, href, cta, note, status = '') => h('section', { class: 'card smart-path', id, 'aria-labelledby': id + '-t' },
    h('div', { class: 'smart-head' }, h('span', { class: 'smart-ico' }, icon(ico)), h('div', {}, h('div', { class: 'smart-title' }, h('h2', { id: id + '-t' }, name), status ? h('span', { class: 'smart-status' }, status) : null), h('p', { class: 'muted small' }, who))),
    h('ol', { class: 'steps plain smart-steps' }, steps.map((x) => h('li', {}, x))),
    h('a', { class: 'btn primary', href, target: '_blank', rel: 'noopener', id: id + '-go' }, h('span', {}, cta)),
    h('p', { class: 'muted small smart-note' }, note));
  return h('div', {},
    h('h1', {}, 'أنشئ بالذكاء الاصطناعي بحسابك'),
    h('p', { class: 'lead' }, 'اختر كويزي داخل Claude أو ChatGPT. في ChatGPT ارفع الملف من واجهة الإضافة داخل المحادثة، وسيطلب الكويز من نموذج حسابك دون نسخ ولصق.'),
    h('div', { class: 'grid g2 smart-grid' },
      path('smart-claude', 'spark', 'Claude', 'نسخة كويزي داخل claude.ai — يعمل من حصة حسابك في Claude.',
        ['سجّل الدخول بحسابك في claude.ai.', 'افتح نسخة كويزي، واسمح لها باستخدام Claude عند السؤال.', 'ارفع المحاضرة وأنشئ الكويز: يحلّل Claude المحاضرة ويكتب الأسئلة ويراجعها، ثم تحلّها في الصفحة نفسها.'],
        SMART.claude, 'افتح كويزي مع Claude', 'كويزاتك تُحفظ في حسابك هناك، ولا يرى غيرُك ملفاتك.'),
      path('smart-chatgpt', 'chat', 'ChatGPT', 'إضافة كويزي داخل محادثة ChatGPT، بحساب المالك الذي ثبّتها.',
        ['افتح ChatGPT بالحساب الذي ثبّت إضافة كويزي.', 'افتح كويزي داخل المحادثة لتظهر واجهة رفع الملف والحل.', 'ارفع المحاضرة واضغط «إنشاء الكويز»؛ تطلب الواجهة التوليد من نموذج المحادثة تلقائيًا.'],
        SMART.chatgpt, 'افتح كويزي داخل ChatGPT', 'إذا فتح ChatGPT دون الواجهة، اختر إضافة كويزي من تطبيقاتك داخل المحادثة.', 'داخل ChatGPT')),
    h('div', { class: 'card smart-foot' },
      h('h3', {}, 'التوليد في كويزي الآن'),
      h('p', { class: 'muted' }, 'الموقع العام يتيح إنشاء كويز محليًا. نسخة Claude تعمل داخل claude.ai. توليد ChatGPT يتم داخل محادثة حساب المالك عبر إضافة كويزي؛ رابط الموقع العام لا يمنح الإضافة تلقائيًا لحسابات أخرى.'),
      h('a', { class: 'btn', href: '#/new' }, 'أو أنشئ كويزًا محليًا هنا')));
}

function landing() {
  const need = (t, d) => h('li', {}, h('div', {}, h('strong', {}, t), h('div', { class: 'muted small' }, d)));
  return h('div', {},
    h('section', { class: 'hero' },
      h('div', {},
        h('h1', {}, 'حوّل سلايداتك إلى ', h('span', { class: 'mk swipe' }, 'كويزات دقيقة'), ' وبطاقات مراجعة'),
        h('p', { class: 'lead' }, 'ارفع ملف PDF أو PowerPoint، اختر الصفحات، ويبني «كويزي» أسئلة موثّقة بصفحة المصدر ودليله، مع تفسير لكل إجابة. ', deviceAccounts() ? 'تقدّمك محفوظ على حسابك في هذا الجهاز.' : 'تقدّمك محفوظ على حسابك وتكمل من أي جهاز.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/register' }, 'ابدأ مجانًا'), h('a', { class: 'btn', href: '#/login' }, 'لدي حساب')), guestPitch()),
      h('div', { class: 'card' }, h('h3', {}, 'كيف يعمل؟'),
        h('ol', { class: 'steps plain' },
          need('ارفع السلايدات', 'PDF أو PowerPoint، ونخبرك بصراحة عن أي صفحة غير مقروءة.'),
          need('اختر الملف والعدد', 'الصفحات، عدد الأسئلة، الصعوبة، اللغة.'),
          need('اترك الباقي علينا', 'نقرأ اللكتشر ونختار تلقائيًا أنواع الأسئلة التي يدعمها محتواك فعلًا، دون حشو أو اختلاق.'),
          need('حلّ أو نزّل PDF', 'تفسير بعد الإجابة، مراجعة، وبطاقات للمراجعة.')))),
    h('section', { class: 'chatgpt-app-callout', 'aria-labelledby': 'chatgpt-app-title' },
      h('div', {}, h('span', { class: 'chatgpt-app-tag' }, 'بحسابك الشخصي'),
        h('h2', { id: 'chatgpt-app-title' }, 'مسارا كويزي: Claude وChatGPT'),
        h('p', { class: 'muted' }, 'افتح نسخة Claude أو كويزي داخل محادثة ChatGPT. في مسار ChatGPT، ارفع الملف وأنشئ الكويز من واجهة الإضافة نفسها.')),
      h('div', { class: 'chatgpt-app-steps' }, h('a', { class: 'btn primary', href: '#/smart', id: 'smart-cta' }, icon('spark'), h('span', {}, 'اختر المسار')))),
    h('section', { class: 'grid g3' },
      h('div', { class: 'card' }, h('h3', {}, 'جودة قبل الكمية'), h('p', { class: 'muted' }, 'كل سؤال يمرّ بتحقق من الدليل في صفحة المصدر، وحلّ مستقل أعمى، وكشف للتكرار والتسريب. لا نسلّم سؤالًا فيه عيب حاسم.')),
      h('div', { class: 'card' }, h('h3', {}, 'أسئلة متنوعة بحسب ملفك'), h('p', { class: 'muted' }, 'لا تختار أنواع الأسئلة بنفسك: يقرأ «كويزي» اللكتشر ويضيف تلقائيًا ما يدعمه محتواه من مستويات وصيغ مختلفة، ويتجنب ما لا يدعمه.')),
      h('div', { class: 'card' }, h('h3', {}, 'خصوصيتك'), h('p', { class: 'muted' }, 'ملفاتك وإجاباتك مرتبطة بحسابك فقط. لا حساب ChatGPT مطلوب.'))));
}

function authPage(mode) {
  const reg = mode === 'register';
  const regMode = state.caps?.registration || 'open';
  if (reg && regMode === 'closed') return h('div', { class: 'card', style: 'max-width:440px;margin:1.5rem auto' }, h('h2', {}, 'التسجيل مغلق حاليًا'), h('p', { class: 'muted' }, 'لا يقبل الموقع حسابات جديدة الآن.'), h('a', { class: 'btn', href: '#/login' }, 'تسجيل الدخول'), guestPitch());
  const err = h('div', { role: 'alert' });
  const f = (id, label, type, extra = {}) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name: id, type, required: !extra.optional, autocomplete: extra.ac, minlength: extra.min, dir: type === 'email' ? 'ltr' : null }));
  const form = h('form', { class: 'card', style: 'max-width:440px;margin:1.5rem auto', onsubmit: async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    err.replaceChildren();
    btn.disabled = true;
    try {
      const res = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', reg ? { email: v.email, name: String(v.name || '').trim() || String(v.email || '').split('@')[0], password: v.password, invite_code: v.invite_code || null } : { email: v.email, password: v.password }, { noRedirect: true });
      if (res && res.pending_confirmation) { err.replaceChildren(h('div', { class: 'alert ok' }, res.message)); btn.disabled = false; return; }
      state.user = res; await refreshCaps(); location.hash = '#/'; render();
    } catch (ex) { err.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); btn.disabled = false; }
  } },
    h('h2', {}, reg ? 'إنشاء حساب جديد' : 'تسجيل الدخول'),
    deviceAccounts() && h('div', { class: 'alert info', id: 'device-accounts' }, 'لا توجد حسابات سحابية في هذا الموقع بعد: حسابك (بريدك وكلمة مرورك) يُحفظ على هذا الجهاز فقط، فلا يعمل من جهاز آخر ولا يمكن استعادة كلمة المرور إن نُسيت.'),
    isGuest() && canRegister() && reg && h('div', { class: 'alert info', id: 'guest-upgrade' }, state.caps?.edition ? 'ما صنعتَه كضيف يبقى على هذا الجهاز ولا ينتقل تلقائيًا إلى الحساب الجديد.' : 'سيتحول حساب الضيف هذا إلى حسابك الدائم بكل ما فيه من ملفات وكويزات.'),
    f('email', 'البريد الإلكتروني', 'email', { ac: 'email' }),
    reg && f('name', 'الاسم (اختياري)', 'text', { ac: 'name', optional: true }),
    f('password', 'كلمة المرور', 'password', { ac: reg ? 'new-password' : 'current-password', min: reg ? 8 : null }),
    reg && regMode === 'invite' && h('div', { class: 'field' }, h('label', { for: 'invite_code' }, 'رمز الدعوة'), h('input', { id: 'invite_code', name: 'invite_code', type: 'text', required: true, dir: 'ltr', autocomplete: 'off' })),
    reg && h('p', { class: 'hint' }, '٨ أحرف على الأقل.'), err,
    h('button', { class: 'btn primary', id: 'go', type: 'submit' }, reg ? 'إنشاء الحساب' : 'دخول'),
    h('p', { class: 'small', style: 'margin-top:1rem' }, reg ? h('span', {}, 'لديك حساب؟ ', h('a', { href: '#/login' }, 'سجّل الدخول')) : h('span', {}, 'ليس لديك حساب؟ ', h('a', { href: '#/register' }, 'أنشئ حسابًا'), ' · ', h('a', { href: '#/forgot' }, 'نسيت كلمة المرور؟'))));
  const btn = form.querySelector('#go');
  return h('div', {}, form, state.user ? null : h('div', { style: 'max-width:440px;margin:0 auto 1.5rem' }, guestPitch('guest-enter-auth')));
}

function forgotPage() {
  const out = h('div', {});
  const form = h('form', { class: 'card', style: 'max-width:440px;margin:1.5rem auto', onsubmit: async (e) => {
    e.preventDefault();
    out.replaceChildren();
    try { const r = await api('POST', '/api/auth/forgot', { email: new FormData(form).get('email') }, { noRedirect: true }); out.replaceChildren(h('div', { class: 'alert ok' }, r.message)); }
    catch (ex) { out.replaceChildren(h('div', { class: 'alert warn' }, ex.message)); }
  } }, h('h2', {}, 'استعادة كلمة المرور'),
    !state.caps?.password_reset && h('div', { class: 'alert warn', id: 'no-reset' }, deviceAccounts() ? 'حسابات هذا الجهاز لا تُستعاد كلمة مرورها: لا يوجد خادم بريد. إن نسيتها فأنشئ حسابًا جديدًا ببريد آخر (أو ادخل كضيف)، وتُفعَّل الاستعادة حين يُفعَّل الموقع بالحسابات السحابية.' : 'خدمة البريد غير مجهزة على هذا الخادم بعد، لذا لن تصل رسائل الاستعادة. تواصل مع مسؤول الموقع.'),
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
  let chatgptCard = null;
  if (state.caps?.chatgpt_connect_available && !state.caps?.edition && !isGuest()) {
    const info = h('div', { class: 'card', id: 'chatgpt-connection' }, spinner('جارٍ فحص ربط ChatGPT…'));
    chatgptCard = info;
    api('GET', '/api/chatgpt/status').then((st) => {
      const outcome = new URLSearchParams(location.hash.split('?')[1] || '').get('chatgpt');
      info.replaceChildren(h('h2', {}, 'توليد الكويز بحساب ChatGPT'),
        ...(outcome === 'connected' && st.connected ? [h('div', { class: 'alert ok' }, 'اكتمل ربط حساب ChatGPT. سيستخدمه كويزي تلقائيًا في الكويز الجديد.')] :
          outcome === 'denied' ? [h('div', { class: 'alert warn' }, 'لم تمنح صلاحية استخدام ChatGPT؛ لم يُربط الحساب.')] : []),
        h('p', { class: 'muted' }, st.connected && st.plan_usage ? `متصل: ${st.email || 'حساب ChatGPT'} — إنشاء الكويز الجديد يتم من حصة حسابك.` : 'اربط حساب ChatGPT المؤهل مرة واحدة، ثم أنشئ كويزًا داخل الموقع بلا نسخ أو لصق. تخضع الطلبات لحدود حسابك.'),
        h('p', { class: 'small muted' }, 'عند إنشاء الكويز سيُرسل نص الصفحات المختارة إلى OpenAI لصياغة الأسئلة؛ لا يطّلع كويزي على محادثاتك الشخصية.'),
        st.connected ? h('button', { class: 'btn', id: 'chatgpt-disconnect', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { const result = await api('POST', '/api/chatgpt/disconnect'); toast(result.remote_revocation_confirmed ? 'فُصل حساب ChatGPT' : 'فُصل الحساب من كويزي؛ تحقّق من صفحة الاتصالات في ChatGPT لإلغاء الصلاحية هناك.'); location.hash = '#/account'; render(); }
          catch (ex) { toast(ex.message, 'bad'); e.currentTarget.disabled = false; }
        } }, 'فصل حساب ChatGPT') : h('a', { class: 'btn primary', id: 'chatgpt-connect', href: '/api/chatgpt/connect' }, 'اربط حساب ChatGPT'));
    }).catch((ex) => info.replaceChildren(h('h2', {}, 'توليد الكويز بحساب ChatGPT'), errorBox(ex)));
  }
  const msg = h('div', { role: 'status' });
  const pw = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(pw)); msg.replaceChildren();
    try { await api('POST', '/api/auth/password', { current_password: v.current, new_password: v.next }); pw.reset(); msg.replaceChildren(h('div', { class: 'alert ok' }, deviceAccounts() ? 'تم تغيير كلمة المرور.' : 'تم تغيير كلمة المرور وخروج بقية الأجهزة.')); }
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
  const localOnly = isGuest();
  const wipe = h('div', { class: 'card' }, h('h2', {}, state.caps?.edition ? 'مسح بياناتي من هذا الجهاز' : 'مسح بياناتي'), h('p', { class: 'muted' }, state.caps?.edition ? 'يحذف ملفاتك وكويزاتك ومحاولاتك وبطاقاتك المحفوظة في هذا المتصفح. لا يمكن التراجع.' : 'يحذف حساب الضيف المؤقت بكل ما فيه. لا يمكن التراجع.'),
    h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('مسح كل البيانات؟', 'سيُمسح كل ما في هذا المتصفح من ملفات وكويزات.', 'امسح', true)) { await api('POST', '/api/auth/delete', { password: '' }); toast('مُسحت البيانات'); if (!state.caps?.edition) { state.user = null; await refreshCaps(); } location.hash = '#/'; render(); } } }, 'مسح بياناتي'));      // the server erases the guest's temporary account with it
  return h('div', { style: 'max-width:640px;margin:auto' }, h('h1', {}, 'حسابي'),
    isGuest() && h('div', { class: 'alert info', id: 'guest-account' }, h('strong', {}, 'أنت ضيف. '), 'لا حساب لك ولا ضمان لحفظ تقدّمك: ما صنعتَه محفوظ ', state.caps?.edition ? 'في هذا المتصفح فقط' : ['في حساب ضيف مؤقت', state.caps?.guest_days ? ` يُحذف بعد ${num(state.caps.guest_days)} يومًا من إنشائه` : ''], '، وقد يضيع. ', canRegister() ? h('a', { href: '#/register' }, 'أنشئ حسابًا لحفظه') : null),
    !isGuest() && deviceAccounts() && h('div', { class: 'alert info', id: 'device-account-note' }, 'حسابك محفوظ على هذا الجهاز فقط (لا توجد حسابات سحابية في الموقع بعد): لا يعمل من جهاز آخر، ولا تُستعاد كلمة المرور إن نُسيت.'),
    h('div', { class: 'card' }, h('div', { class: 'bidi' }, h('strong', {}, state.user.name), h('div', { class: 'muted small ltr' }, state.user.email)),
      h('p', { class: 'muted small' }, 'تصدير كل بياناتك (ملفاتك وكويزاتك ومحاولاتك وبطاقاتك) في ملف JSON واحد:'),
      h('a', { class: 'btn', href: '/api/auth/export', download: 'quizzy-export.json' }, '⬇ تصدير بياناتي')), chatgptCard, ...(localOnly ? [wipe] : [pw, del]));
}

async function dashboard() {
  const [docs, quizzes, attempts, cardStats] = await Promise.all([api('GET', '/api/documents'), api('GET', '/api/quizzes'), api('GET', '/api/attempts?status=in_progress'), api('GET', '/api/cards/stats')]);
  const needReview = cardStats.reduce((a, c) => a + (c.due || 0), 0);
  const totalCards = cardStats.reduce((a, c) => a + c.total, 0);
  const root = h('div', {}, h('div', { class: 'row between' }, h('h1', {}, isGuest() ? 'أهلًا بك' : `أهلًا ${state.user.name}`), h('a', { class: 'btn primary', href: '#/new' }, '＋ كويز جديد')));
  if (!docs.length) {
    root.append(h('div', { class: 'card' }, emptyState('📄', 'ابدأ برفع أول ملف', 'ارفع سلايدات PDF أو PowerPoint لتحويلها إلى كويز وبطاقات مراجعة.', h('a', { class: 'btn primary', href: '#/new', id: 'first-upload' }, 'ارفع ملفًا وأنشئ كويزًا'))));
    return root;
  }
  if (attempts.length) {
    root.append(h('div', { class: 'card' }, h('h2', {}, 'أكمل من حيث توقفت'),
      attempts.slice(0, 4).map((a) => h('div', { class: 'row between', style: 'padding:.5rem 0;border-top:1px solid var(--line)' },
        h('div', {}, h('strong', { class: 'bidi' }, a.quiz_title), h('div', { class: 'muted small' }, `${a.mode === 'exam' ? 'اختبار' : 'تدريب'} · أجبت ${num(a.answered)} من ${num(a.total)} · آخر نشاط ${fmtDate(a.updated_at)}`)),
        h('a', { class: 'btn primary small', href: `#/attempt/${a.id}` }, 'متابعة')))));
  }
  root.append(h('div', { class: 'grid g3' },
    h('div', { class: 'card statcard' }, h('div', { class: 'stat' }, num(docs.length)), h('div', { class: 'stat-l' }, 'ملفاتك'), h('a', { href: '#/files' }, 'إدارة الملفات')),
    h('div', { class: 'card statcard' }, h('div', { class: 'stat' }, num(quizzes.filter((q) => q.status === 'ready').length)), h('div', { class: 'stat-l' }, 'كويزات جاهزة'), h('a', { href: '#/quizzes' }, 'عرض الكويزات')),
    h('div', { class: 'card statcard' }, h('div', { class: 'stat' }, num(needReview)), h('div', { class: 'stat-l' }, `بطاقات مستحقة للمراجعة اليوم (من ${num(totalCards)})`),
      needReview ? h('a', { href: '#/cards/study?due=1' }, 'راجعها الآن') : h('a', { href: '#/cards' }, 'البطاقات')),
  ));
  const recent = quizzes.slice(0, 5);
  if (recent.length) root.append(h('div', { class: 'card' }, h('h2', {}, 'آخر الكويزات'), quizTable(recent)));
  return root;
}
/** the quizzes table; with `sel` ({ set, onChange, all }) each row gets a checkbox and the header a «select all» box (the «كويزاتي» page's deleting) */
export function quizTable(list, sel) {
  const st = { draft: ['مسودة', 'info'], analyzing: ['يُحلَّل…', 'info'], planned: ['يُجهَّز…', 'info'], generating: ['يُولَّد…', 'info'], ready: ['جاهز', 'ok'], failed: ['فشل', 'bad'], insufficient: ['المصدر لا يكفي', 'warn'] };
  const box = (q) => h('td', { class: 'selcell', 'data-label': 'تحديد' }, h('input', { type: 'checkbox', class: 'qsel', 'aria-label': 'تحديد «' + q.title + '»', checked: sel.set.has(q.id), onchange: (e) => { if (e.target.checked) sel.set.add(q.id); else sel.set.delete(q.id); sel.onChange(); } }));
  const allBox = sel && h('th', { class: 'selcell' }, h('input', { type: 'checkbox', id: 'sel-all', 'aria-label': 'تحديد كل الكويزات', checked: sel.all.length > 0 && sel.all.every((id) => sel.set.has(id)), onchange: (e) => { sel.all.forEach((id) => (e.target.checked ? sel.set.add(id) : sel.set.delete(id))); sel.onChange(true); } }));
  return h('div', { class: 'tablewrap' }, h('table', { class: 'stack' }, h('thead', {}, h('tr', {}, allBox, ['العنوان', 'الحالة', 'الأسئلة', 'أُنشئ', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, list.map((q) => h('tr', { class: sel && sel.set.has(q.id) ? 'selected' : '' }, sel && box(q), h('td', { class: 'bidi' }, h('a', { href: `#/quiz/${q.id}` }, q.title), q.generator === 'test-generator' && h('span', { class: 'badge test', style: 'margin-inline-start:.4rem' }, 'محتوى اختباري')),
      h('td', { 'data-label': 'الحالة' }, h('span', { class: 'badge ' + st[q.status][1] }, st[q.status][0])), h('td', { 'data-label': 'الأسئلة' }, q.question_count != null ? num(q.question_count) : '—'), h('td', { class: 'muted small', 'data-label': 'أُنشئ' }, fmtDate(q.created_at)),
      h('td', {}, h('a', { class: 'btn small', href: `#/quiz/${q.id}` }, 'فتح')))))));
}

/* A QUIZ BEING MADE, SEEN FROM EVERY PAGE (the browser editions write it inside this page, so it goes on while the student does something else here): a small bar
 * that links to it on every other page, and a notice with a link the moment it is ready - the student never has to wait on the progress screen */
const jobTitles = new Map(); let jobsTimer = null;
function jobsBar() { let b = document.getElementById('jobs-bar'); if (!b) { b = h('div', { id: 'jobs-bar', role: 'status', 'aria-live': 'polite' }); const n = $('#notice'); if (n) n.after(b); else document.body.prepend(b); } return b; }
async function watchJobs() {
  clearTimeout(jobsTimer); jobsTimer = null; if (!state.caps?.edition) return;
  let list = []; try { list = await api('GET', '/api/jobs', undefined, { noRedirect: true }); } catch (_) { /* tried again below */ }
  list.forEach((j) => jobTitles.set(j.id, j.title));
  const here = (location.hash.match(/^#\/quiz\/(\w+)/) || [])[1];
  fill(jobsBar(), list.filter((j) => j.id !== here).map((j) => h('a', { class: 'jobpill', href: `#/quiz/${j.id}` }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, 'يُنشأ كويز ', h('bdi', { translate: 'no' }, '«' + (j.title || '') + '»'), ` … ${num(j.pct)}%`))));      /* (the title isolated with its marks: an English title and the percent never run together) */
  jobsTimer = setTimeout(watchJobs, list.length ? 2000 : 15000);
}
function readyNotice(id, status) {
  if ((location.hash.match(/^#\/quiz\/(\w+)/) || [])[1] === id) return;      // its own page shows it already
  const ok = status === 'ready'; const title = jobTitles.get(id) || '';
  const t = h('div', { class: 'toast ' + (ok ? 'ok' : 'bad'), role: 'status' }, h('span', {}, ok ? 'جاهز: كويز ' : 'تعذّر إنشاء الكويز ', h('bdi', { translate: 'no' }, '«' + title + '»')), ' ', h('a', { href: `#/quiz/${id}`, onclick: () => t.remove() }, ok ? 'افتحه' : 'التفاصيل'));
  ($('#toasts') || document.body).append(t); setTimeout(() => t.remove(), 12000); watchJobs();
}
window.addEventListener('qz-progress', (ev) => { const d = ev.detail || {}; if (d.stage === 'quiz' && d.id && jobTitles.has(d.id) && ['ready', 'failed', 'insufficient'].includes(d.status)) readyNotice(d.id, d.status); });
async function boot() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { state.caps = { llm: false }; }
  try { state.user = await api('GET', '/api/auth/me', undefined, { noRedirect: true }); } catch (_) { state.user = null; }
  window.addEventListener('hashchange', render); window.addEventListener('hashchange', () => watchJobs());
  await langReady;      // an English visitor's first page is drawn in English
  render(); watchJobs();
}
boot();
