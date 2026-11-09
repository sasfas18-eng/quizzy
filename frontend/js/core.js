// Core helpers: DOM builder, API client, toasts, save-state tracker, formatting, modal.
import { lang } from './i18n.js';
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  appendKids(el, kids);
  return el;
}
function appendKids(el, kids) {
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
}
/** replaceChildren that tolerates null/false/arrays like h() does (a raw el.replaceChildren(null) would insert the text "null") */
export function fill(el, ...kids) { el.replaceChildren(); appendKids(el, kids); return el; }
export const $ = (s, r = document) => r.querySelector(s);

/** Parse a TRUSTED inline-SVG string (icons / logo below: constants in this file, never user data) into an element. */
export function svg(markup) { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstElementChild; }
const ic = (body, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = {
  home: ic('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V10"/>'),
  files: ic('<path d="M7 3h7l5 5v12.2a.8.8 0 0 1-.8.8H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9.5 13h6M9.5 16.5h4"/>'),
  quiz: ic('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.2 12.3 2.6 2.6 5-5.6"/>'),
  cards: ic('<rect x="3" y="7" width="14" height="12" rx="2.5"/><path d="M7 4.2h11.5A2.5 2.5 0 0 1 21 6.7V15"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18"/>'),
  shield: ic('<path d="M12 3 4.5 6v5.5c0 4.5 3.2 7.8 7.5 9.5 4.3-1.7 7.5-5 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>'),
  moon: ic('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>', 'ico moon'),
  sun: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>', 'ico sun'),
  free: ic('<path d="M12 3v18M16.5 7.5C15.7 6.4 14.1 5.7 12 5.7c-2.5 0-4 1.1-4 2.8 0 4 8.2 2.1 8.2 6.2 0 1.7-1.7 2.9-4.2 2.9-2.1 0-3.9-.8-4.8-2.1"/>'),
  noai: ic('<rect x="5" y="6" width="14" height="12" rx="3"/><path d="M9 11h.01M15 11h.01M9.5 15h5"/><path d="M12 3v3"/>'),
  lock: ic('<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  target: ic('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>'),
  quote: ic('<path d="M7 7h4v4c0 3-1.6 5-4 5.5M14 7h4v4c0 3-1.6 5-4 5.5"/>'),
  menu: ic('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: ic('<path d="M6 6l12 12M18 6 6 18"/>'),
  user: ic('<circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c.6-3.7 3.6-5.6 7.2-5.6s6.6 1.9 7.2 5.6"/>'),
  globe: ic('<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8M12 3.4c2.3 2.4 3.5 5.3 3.5 8.6s-1.2 6.2-3.5 8.6c-2.3-2.4-3.5-5.3-3.5-8.6S9.7 5.8 12 3.4z"/>'),
  spark: ic('<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18"/>'),
  chat: ic('<path d="M4 5.5h16v10.7a2 2 0 0 1-2 2H9l-5 3V5.5z"/><path d="m12 8 1 2.2 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z"/>'),
  upload: ic('<path d="M12 16V5m0 0-4 4m4-4 4 4"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
  arrow: '<svg class="arrow" viewBox="0 0 90 70" aria-hidden="true"><path d="M6 8C46 4 78 22 70 58"/><path d="M58 47l12 12 12-12"/></svg>',
};
export const icon = (name) => svg(ICONS[name]);
/** The brand mark: the letter ك (outline from IBM Plex Sans Arabic Bold, SIL OFL) on an emerald badge; its small inner tick — the stroke that makes a kaf a kaf — is a highlighter-yellow CHECK = "verified". */
const LOGO = `<svg class="mark" viewBox="0 0 64 64" role="img" aria-label="شعار كويزي: حرف الكاف وعلامة صح"><rect width="64" height="64" rx="16" fill="#0F5D50"/><g transform="translate(10.27 52.75) scale(0.056 -0.056)"><path d="M40 150H556Q616 150 616 210V741H736V210Q736 102 692 51Q649 0 556 0H40Z" fill="#FBF6EA"/></g><path d="M24.2 29.2L29.4 35.6 37.2 20.2" fill="none" stroke="#FFD84A" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const logoMark = () => svg(LOGO);

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || 'خطأ غير متوقع'); this.status = status; this.code = body?.code; this.body = body; }
}
export async function api(method, url, body, opts = {}) {
  let res;
  try {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(0, { code: 'network', message: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت.' });
  }
  if (opts.raw) return res;
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (!res.ok) {
    const e = new ApiError(res.status, data || {});
    if (res.status === 401 && !opts.noRedirect && !location.hash.startsWith('#/login')) { state.user = null; location.hash = '#/login'; }
    throw e;
  }
  return data;
}
export const state = { user: null, caps: null };

export function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3000);
}

// ---- save-state: "saved" is shown only AFTER the server confirmed; failures are queued and retried.
const pending = new Map();
let retryTimer = null;
export const saveUI = {
  set(kind, text) {
    const el = $('#savestate');
    if (!el) return;
    el.className = kind ? 'show ' + kind : '';
    el.textContent = text || '';
    el.onclick = kind === 'error' ? () => flush() : null;
  },
};
let hideTimer = null;
async function flush() {
  if (!pending.size) return;
  saveUI.set('saving', 'جارٍ الحفظ…');
  for (const [key, job] of [...pending]) {
    try { await job(); pending.delete(key); report(true); }
    catch (e) { report(false); if (e.status === 409 || e.status === 404 || e.status === 422) pending.delete(key); }
  }
  if (!pending.size) {
    saveUI.set('saved', 'تم الحفظ ✓');
    clearTimeout(hideTimer); hideTimer = setTimeout(() => saveUI.set('', ''), 2500);
  } else {
    saveUI.set('error', `لم يُحفظ ${pending.size} تغيير — اضغط لإعادة المحاولة`);
    clearTimeout(retryTimer); retryTimer = setTimeout(flush, 6000);
  }
}
function report(ok) { api('POST', '/api/events', { kind: 'save', ok }, { noRedirect: true }).catch(() => {}); }
/** Persist something on the server. key de-duplicates (latest write wins). Resolves with the server response when saved. */
export async function saveRemote(key, job) {
  pending.set(key, job);
  saveUI.set('saving', 'جارٍ الحفظ…');
  try {
    const r = await job();
    pending.delete(key);
    report(true);
    if (!pending.size) {
      saveUI.set('saved', 'تم الحفظ ✓');
      clearTimeout(hideTimer); hideTimer = setTimeout(() => saveUI.set('', ''), 2500);
    }
    return r;
  } catch (e) {
    report(false);
    if ([404, 409, 422].includes(e.status)) { pending.delete(key); saveUI.set('', ''); throw e; }
    saveUI.set('error', 'تعذّر الحفظ — اضغط لإعادة المحاولة');
    clearTimeout(retryTimer); retryTimer = setTimeout(flush, 6000);
    throw e;
  }
}
window.addEventListener('online', flush);
/** work the page finishes behind the screen (a delete the list already shows done): leaving the page while it runs asks first, as an unsaved answer does */
const inflight = new Set();
export function keepOpen(p) { inflight.add(p); const done = () => inflight.delete(p); p.then(done, done); return p; }
window.addEventListener('beforeunload', (e) => { if (pending.size || inflight.size) { e.preventDefault(); e.returnValue = ''; } });

const NF = { ar: new Intl.NumberFormat('ar-u-nu-latn'), en: new Intl.NumberFormat('en') };
const nf = { format: (n) => NF[lang()].format(n) };
export const num = (n) => nf.format(n);
/** "سؤال واحد" / "سؤالان" / "٣ أسئلة" / "١١ سؤالًا": correct Arabic number agreement for questions. */
/** the same for pages and cards (tens 3-10 take the plural, 11+ the singular accusative-free form used in counts) */
const arCount = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? `${nf.format(n)} ${few}` : `${nf.format(n)} ${many}`);
const enCount = (n, word) => `${nf.format(n)} ${word}${n === 1 ? '' : 's'}`;      // English: «1 page», «2 pages»
export const arP = (n) => (lang() === 'en' ? enCount(n, 'page') : arCount(n, 'صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة'));
export const arF = (n) => (lang() === 'en' ? enCount(n, 'file') : arCount(n, 'ملف واحد', 'ملفان', 'ملفات', 'ملفًا'));
export const arC = (n) => (lang() === 'en' ? enCount(n, 'card') : arCount(n, 'بطاقة واحدة', 'بطاقتان', 'بطاقات', 'بطاقة'));
export const arQ = (n) => (lang() === 'en' ? enCount(n, 'question') : n === 1 ? 'سؤال واحد' : n === 2 ? 'سؤالان' : n >= 3 && n <= 10 ? `${nf.format(n)} أسئلة` : `${nf.format(n)} سؤالًا`);
export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(lang() === 'en' ? 'en' : 'ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
}
export function pct(n, d) { return d ? Math.round((100 * n) / d) + '%' : '—'; }
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60, hh = Math.floor(m / 60);
  return (hh ? hh + ':' : '') + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
export function dirOf(text) {
  const letters = [...String(text || '')].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return lang() === 'en' ? 'ltr' : 'rtl';
  return letters.filter((ch) => /[\u0600-\u06ff]/.test(ch)).length / letters.length > 0.3 ? 'rtl' : 'ltr';
}
// equations are typeset by KaTeX; where the page does not load it up front (the web edition: ~270 KB on every visit for the few questions that have math)
// it is loaded the first time a text with $…$ is shown, from the folder of its stylesheet
let mathLoading = null;
function loadMath() {
  if (!mathLoading) mathLoading = new Promise((ok, bad) => { const css = document.querySelector('link[href*="katex.min.css"]'); const base = css ? css.href.replace(/katex\.min\.css.*$/, '') : new URL('vendor/katex/', document.baseURI).href;
    const add = (f) => new Promise((r, j) => { const s = document.createElement('script'); s.src = base + f; s.onload = r; s.onerror = j; document.head.appendChild(s); });
    add('katex.min.js').then(() => add('auto-render.min.js')).then(ok, bad); });
  return mathLoading;
}
export function typeset(el) {
  const run = () => { try { window.renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false }); } catch (_) { /* ignore */ } };
  if (window.renderMathInElement) run();
  else if (/\$[^$\n]+\$/.test(el.textContent || '')) loadMath().then(run).catch(() => { mathLoading = null; });
  return el;
}
export function modal(content, { wide = false } = {}) {
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, typeof content === 'function' ? content(close) : content);
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, box);
  root.replaceChildren(bg);
  document.addEventListener('keydown', esc);
  const first = box.querySelector('input,select,textarea,button');
  if (first) first.focus();
  return close;
}
export function confirmDialog(title, text, okLabel = 'تأكيد', danger = false) {
  return new Promise((res) => {
    modal((close) => h('div', {}, h('h2', {}, title), h('p', { class: 'muted' }, text),
      h('div', { class: 'row', style: 'margin-top:1rem' },
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { close(); res(true); } }, okLabel),
        h('button', { class: 'btn', onclick: () => { close(); res(false); } }, 'إلغاء'))));
  });
}
export const spinner = (text) => h('div', { class: 'row', role: 'status' }, h('span', { class: 'spin' }), text && h('span', { class: 'muted' }, text));
export const emptyState = (icon, title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'ico' }, icon), h('h3', {}, title), h('p', {}, text), action);
export const errorBox = (e, retry) => h('div', { class: 'alert bad', role: 'alert' }, h('strong', {}, 'حدث خطأ: '), e.message || String(e),
  retry && h('div', { style: 'margin-top:.5rem' }, h('button', { class: 'btn small', onclick: retry }, 'إعادة المحاولة')));
export const TYPE_AR = {
  basic_recall: 'الاسترجاع الأساسي', understanding: 'فهم المفاهيم', mechanisms: 'الآليات والتفاصيل', application: 'تطبيق المعلومات',
  critical_thinking: 'التفكير النقدي', scenarios: 'سيناريو تخصصي', compare_contrast: 'المقارنة والتمييز', best_answer: 'أفضل إجابة',
  not_except: 'الاستثناء / غير الصحيح', sequence: 'ترتيب الخطوات',
};
export const REVIEW_AR = { machine_verified: 'تحقق آلي', flagged: 'تحقق آلي مع ملاحظات', human_reviewed: 'راجعه مختص', edited_pending_review: 'عُدّل — بانتظار المراجعة', rejected: 'مرفوض' };
