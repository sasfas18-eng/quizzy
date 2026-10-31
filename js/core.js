// Core helpers: DOM builder, API client, toasts, save-state tracker, formatting, modal.
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
window.addEventListener('beforeunload', (e) => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });

const nf = new Intl.NumberFormat('ar-u-nu-latn');
export const num = (n) => nf.format(n);
/** "سؤال واحد" / "سؤالان" / "٣ أسئلة" / "١١ سؤالًا": correct Arabic number agreement for questions. */
export const arQ = (n) => (n === 1 ? 'سؤال واحد' : n === 2 ? 'سؤالان' : n >= 3 && n <= 10 ? `${nf.format(n)} أسئلة` : `${nf.format(n)} سؤالًا`);
export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
}
export function pct(n, d) { return d ? Math.round((100 * n) / d) + '%' : '—'; }
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60, hh = Math.floor(m / 60);
  return (hh ? hh + ':' : '') + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
export function dirOf(text) {
  const letters = [...String(text || '')].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return 'rtl';
  return letters.filter((ch) => /[\u0600-\u06ff]/.test(ch)).length / letters.length > 0.3 ? 'rtl' : 'ltr';
}
export function typeset(el) {
  if (window.renderMathInElement) {
    try { window.renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false }); } catch (_) { /* ignore */ }
  }
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
// ---- small inline icons + the hero illustration (no external assets: works offline and inside claude.ai)
const SV = (inner, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
const ICONS = {
  logo: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  upload: SV('<path d="M12 16V5"/><path d="M7.5 9.5L12 5l4.5 4.5"/><path d="M5 15.5v2A2.5 2.5 0 007.5 20h9a2.5 2.5 0 002.5-2.5v-2"/>'),
  file: SV('<path d="M7 3h7l4 4v12a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M14 3v4h4"/><path d="M8.5 12.5h7M8.5 16h5"/>'),
  quiz: SV('<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M8 9h8M8 13h5"/><path d="M14.5 16.5l1.5 1.5 3-3.2"/>'),
  card: SV('<rect x="3.5" y="6" width="14" height="11" rx="2.5"/><path d="M7 3.5h12.5A1.5 1.5 0 0121 5v10"/>'),
  sparkle: SV('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
  eye: SV('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
};
export const ico = (name, cls) => { const t = document.createElement('template'); t.innerHTML = ICONS[name].trim(); const el = t.content.firstChild; if (cls) el.setAttribute('class', cls); return el; };
export const HERO_ART = `<svg viewBox="0 0 200 170" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="gA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d6ece2"/><stop offset="1" stop-color="#9fd0bf"/></linearGradient></defs>
<ellipse cx="100" cy="152" rx="70" ry="9" fill="#2e7d6b" opacity=".12"/>
<path d="M100 52c-16-10-44-12-66-6v82c22-6 50-4 66 6z" fill="#fff" stroke="#2e7d6b" stroke-width="3" stroke-linejoin="round"/>
<path d="M100 52c16-10 44-12 66-6v82c-22-6-50-4-66 6z" fill="url(#gA)" stroke="#2e7d6b" stroke-width="3" stroke-linejoin="round"/>
<path d="M46 70c14-3 30-2 42 3M46 84c14-3 30-2 42 3M46 98c10-2 22-1 32 2" stroke="#9fd0bf" stroke-width="3" stroke-linecap="round" fill="none"/>
<path d="M112 72c12-5 28-6 42-3M112 86c12-5 28-6 42-3" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".95" fill="none"/>
<path d="M128 49v26l8-6 8 6V49z" fill="#f0b27a"/>
<path d="M158 20l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#f0b27a"/><path d="M34 26l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#b9aee6"/>
<circle cx="178" cy="76" r="4" fill="#9fd0bf"/><circle cx="20" cy="88" r="3" fill="#f0b27a"/>
<g transform="translate(140 102)"><circle r="17" fill="#2e7d6b"/><path d="M-7 0l5 5 9-10" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
export const heroArt = () => { const d = document.createElement('div'); d.className = 'art'; d.innerHTML = HERO_ART; return d; };
/** a percentage ring (SVG); `value` 0..100 */
export function ring(value, label) {
  const v = Math.max(0, Math.min(100, Math.round(value))), r = 44, c = 2 * Math.PI * r;
  const w = document.createElement('div'); w.className = 'ringwrap'; w.setAttribute('role', 'img'); w.setAttribute('aria-label', label || `${v}%`);
  w.innerHTML = `<svg viewBox="0 0 104 104"><circle class="ring-bg" cx="52" cy="52" r="${r}"/><circle class="ring-fg" cx="52" cy="52" r="${r}" stroke-dasharray="${(c * v) / 100} ${c}"/></svg><div class="v">${v}%</div>`; return w;
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
