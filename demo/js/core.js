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
