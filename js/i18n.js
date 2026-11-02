// The site's language: Arabic (as written in the code, right to left) or English (left to right).
// English is a dictionary (i18n_en.js, loaded only when chosen) applied to the page AS IT IS DRAWN: every text and label the interface adds - pages, the menu,
// toasts, dialogs, errors, progress - is looked up there. The lecture's own content is never translated: anything inside an element that sets its own
// writing direction (questions, options, quotes, explanations, page text: they are drawn with dir=...), a text field, or an element marked translate="no"
// - except a piece of the interface inside such an element, marked data-ui (a card's «tap to flip» under the card's own text).
const KEY = 'qz_lang';
const AR = /[\u0600-\u06FF]/;
const LETTER = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF]/;      // Arabic letters (not its comma, semicolon, question mark)
const PUNCT = (v) => v.replace(/\u060C/g, ',').replace(/\u061B/g, ';').replace(/\u061F/g, '?');
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'data-label'];      // data-label: a table's column name over each cell on a phone
const WITH = ATTRS.map((a) => `[${a}]`).join(',');
let cur = 'ar';
try { if (localStorage.getItem(KEY) === 'en') cur = 'en'; } catch (_) { /* storage blocked: Arabic */ }
export const lang = () => cur;

let EN = null, TPL = [], LONG = [];
const cache = new Map();
async function load() {
  if (EN) return;
  const dict = (await import('./i18n_en.js?v=53e7d4257f')).default;
  EN = new Map(Object.entries(dict));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a phrase with values in it («{0} questions») is matched as a pattern; the most specific (most fixed Arabic) first
  TPL = [...EN.keys()].filter((k) => /\{\d\}/.test(k) && AR.test(k.replace(/\{\d\}/g, ''))).map((k) => {
    const order = []; const rx = new RegExp('^' + k.split(/(\{\d\})/).map((p) => { const m = p.match(/^\{(\d)\}$/); if (m) { order.push(+m[1]); return '([\\s\\S]*?)'; } return esc(p); }).join('') + '$');
    return { rx, order, en: EN.get(k), weight: k.replace(/\{\d\}/g, '').length };
  }).sort((a, b) => b.weight - a.weight);
  // a sentence glued together from several phrases in the code: each known phrase is replaced, longest first
  LONG = [...EN.keys()].filter((k) => !/\{\d\}/.test(k) && k.length >= 3).sort((a, b) => b.length - a.length);
}
function tr(core, depth) {
  const e = EN.get(core); if (e != null) return e;
  if (depth > 3) return null;
  let partial = null;      // a pattern whose value stays Arabic (a quiz title, a file name): used only if nothing translates the whole line
  for (const T of TPL) {
    const m = core.match(T.rx); if (!m) continue;
    const r = T.en.replace(/\{(\d)\}/g, (_, i) => sub(m[1 + T.order.indexOf(+i)] || '', depth));
    if (!AR.test(r)) return r; if (partial == null) partial = r;
  }
  let out = core;
  for (const k of LONG) if (out.includes(k)) out = out.split(k).join(EN.get(k));
  return AR.test(out) ? partial : out;      // glued phrases count only when the whole sentence was made of them: never a half-translated line (or a lecture's line touched)
}
function sub(v, depth) {
  if (!LETTER.test(v)) return PUNCT(v);      // a value inside a phrase: «3، 4» -> «3, 4»
  const lead = v.match(/^\s*/)[0], core = v.trim(), trail = v.slice(lead.length + core.length);
  const r = tr(core, depth + 1); return r == null ? v : lead + r + trail;      // a value that is not a phrase (a quiz title, a file name) stays as it is
}
/** the English of one Arabic interface string (the same string while the site is in Arabic, or when it is not a known phrase) */
export function t(s) {
  if (cur !== 'en' || !EN || typeof s !== 'string' || !AR.test(s)) return s;
  if (cache.has(s)) return cache.get(s);
  const lead = s.match(/^\s*/)[0], core = s.trim(), trail = s.slice(lead.length + core.length);
  const r = tr(core, 0); const out = r == null ? s : lead + r + trail;
  cache.set(s, out); return out;
}

// ---- the page: translated as it is drawn, put back exactly when Arabic is chosen again
const ORIG = new WeakMap();      // text node -> { ar, en }
const AORIG = new WeakMap();     // element -> { attr: { ar, en } }
const CONTENT = '[dir]:not(html), [translate=no], textarea, script, style, pre, code';
const isContent = (el) => { const c = el.closest(CONTENT); if (!c) return false; const u = el.closest('[data-ui]'); return !(u && (u === c || c.contains(u))); };
function doText(n) {
  if (!AR.test(n.data)) return;
  const el = n.parentElement; if (!el || isContent(el)) return;
  const out = t(n.data); if (out === n.data) return;
  ORIG.set(n, { ar: n.data, en: out }); n.data = out;
}
function doAttr(el, a) {
  const v = el.getAttribute(a); if (!v || !AR.test(v) || el.closest('[translate=no]')) return;
  const out = t(v); if (out === v) return;
  const o = AORIG.get(el) || {}; o[a] = { ar: v, en: out }; AORIG.set(el, o); el.setAttribute(a, out);
}
function doTree(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1) return;
  for (const a of ATTRS) if (root.hasAttribute(a)) doAttr(root, a);
  root.querySelectorAll(WITH).forEach((el) => { for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a); });
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) doText(n);
}
const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver((list) => {
  for (const m of list) {
    if (m.type === 'childList') m.addedNodes.forEach(doTree);
    else if (m.type === 'characterData') doText(m.target);
    else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
  }
}) : null;
function restore(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const o = ORIG.get(n); if (o && n.data === o.en) n.data = o.ar; ORIG.delete(n); }
  root.querySelectorAll(WITH).forEach((el) => { const o = AORIG.get(el); if (!o) return; for (const a in o) if (el.getAttribute(a) === o[a].en) el.setAttribute(a, o[a].ar); AORIG.delete(el); });
}
const META = { ar: 'كويزي: ارفع محاضرتك PDF أو PowerPoint واحصل على كويز وبطاقات مراجعة، وكل سؤال معه السطر الذي أُخذ منه من محاضرتك. مجاني، يعمل حتى بلا ذكاء اصطناعي.',
  en: 'Quizzy: upload your lecture as a PDF or PowerPoint and get a quiz and review cards, every question with the line of your lecture it came from. Free, and works even without AI.' };
function frame() {
  const d = document.documentElement; d.lang = cur; d.dir = cur === 'en' ? 'ltr' : 'rtl';
  const m = document.querySelector('meta[name=description]'); if (m) m.setAttribute('content', META[cur]);
}
async function apply() {
  frame();
  if (cur === 'en') { await load(); doTree(document.documentElement); if (mo) mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS }); }
  else { if (mo) mo.disconnect(); restore(document.documentElement); }
}
/** resolves once the chosen language is in place (the first page waits for it, so an English visitor never sees the Arabic first) */
export const ready = (cur === 'en' ? apply() : Promise.resolve(frame())).catch(() => { cur = 'ar'; frame(); });
/** switch the site's language; the caller draws the page again */
export async function setLang(l) {
  l = l === 'en' ? 'en' : 'ar'; if (l === cur) return;
  try { localStorage.setItem(KEY, l); } catch (_) { /* remembered for this visit only */ }
  cur = l; cache.clear();
  try { await apply(); } catch (_) { cur = 'ar'; await apply(); }
}
