/* The CORRECTION of a wrong (or blank) answer, shown the way a teacher corrects a paper: the student's choice crossed out, the right answer written in the highlighter, the lecture's own
 * sentence below with the right word marked - and, when an AI is available, the correction in clear, friendly ARABIC that keeps the ORIGINAL terms and the right answer exactly as the lecture has them.
 * The slip is built from what the page already has (instant, no AI). The Arabic text is asked for on demand (POST /api/attempts/:id/correction), checked by the engine, kept with the attempt. */
import { h, fill, api, dirOf } from './core.js?v=a4e9c400ec';

const letters = (t) => [...String(t == null ? '' : t)].filter((c) => /\p{L}/u.test(c));
const unquoted = (t) => String(t == null ? '' : t).replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ').replace(/“[^”]*”/g, ' ');
/** is the explanation written in Arabic? (then it needs no translation). What it QUOTES from the lecture does not count: an Arabic sentence around an English quotation is Arabic, an English sentence around one is not. */
export function isArabicText(t) { let L = letters(unquoted(t)); if (!L.length) L = letters(t); return L.length > 0 && L.filter((c) => /[؀-ۿ]/.test(c)).length / L.length > 0.5; }

const rightOption = (q) => (q.options || []).find((o) => o.id === q.correct_option_id) || null;
export const rightText = (q) => { const o = rightOption(q); return o ? String(o.text || '').trim() : ''; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` as nodes with every place of `key` wrapped in the highlighter (case does not matter, the text keeps its own spelling; a short Latin key matches whole words only) */
export function withKey(text, key) {
  const t = String(text == null ? '' : text), k = String(key == null ? '' : key).trim();
  if (k.length < 2 || k.length > 120) return [t];
  let re; try { re = new RegExp(/[A-Za-z0-9]$/.test(k) && /^[A-Za-z0-9]/.test(k) ? `(?<![\\p{L}\\p{N}])${esc(k)}(?![\\p{L}\\p{N}])` : esc(k), 'giu'); } catch (_) { re = new RegExp(esc(k), 'gi'); }      // no look-behind in an old browser: plain search
  const out = []; let from = 0, m;
  while ((m = re.exec(t))) { if (m.index > from) out.push(t.slice(from, m.index)); out.push(h('mark', { class: 'key', dir: dirOf(m[0]) }, m[0])); from = m.index + m[0].length; if (m[0].length === 0) re.lastIndex++; }
  if (from < t.length) out.push(t.slice(from));
  return out.length ? out : [t];
}

/** a wrong or blank answer that deserves a correction slip */
export const needsFix = (q) => !q.is_correct && !!rightOption(q);

/** the slip: "you chose" (crossed out) / "the right answer" (highlighted); `extra` goes inside it (the Arabic correction) */
export function fixSlip(q, extra) {
  const right = rightOption(q); if (!right) return null;
  const mine = q.selected_option_id && q.selected_option_id !== q.correct_option_id ? (q.options || []).find((o) => o.id === q.selected_option_id) : null;
  return h('div', { class: 'fix', role: 'group', 'aria-label': 'تصحيح الإجابة' },
    h('span', { class: 'stamp', 'aria-hidden': 'true' }, 'تصحيح'),
    mine ? h('div', { class: 'fx-row' }, h('span', { class: 'fx-l' }, 'اخترتَ'), h('del', { class: 'fx-wrong', dir: dirOf(mine.text) }, mine.text))
      : h('div', { class: 'fx-row' }, h('span', { class: 'fx-l' }, 'لم تُجب عن هذا السؤال')),
    h('div', { class: 'fx-row' }, h('span', { class: 'fx-l' }, 'الصواب'), h('strong', { class: 'fx-right', dir: dirOf(right.text) }, right.text)),
    extra || null);
}

/* The Arabic correction is asked for one question at a time, two at once at most (the review of a quiz with many mistakes must not flood the provider); the answer is remembered for the attempt. */
const FIX = new Map();      // `${attempt}:${question}` -> { s: 'idle' | 'load' | 'ok' | 'none' | 'fail', ar, paint }
const queue = []; let running = 0; const LIMIT = 2;
const pump = () => { while (running < LIMIT && queue.length) { const job = queue.shift(); running++; job().then(() => { running--; pump(); }, () => { running--; pump(); }); } };

/** the Arabic correction of `q` (a block that fills in when it arrives, or nothing when there is none: already Arabic, no AI, or the checks were not met) */
export function arabicFix(q, attemptId) {
  if (!needsFix(q) || isArabicText(q.explanation)) return null;
  const id = `${attemptId}:${q.id}`; let st = FIX.get(id); if (!st) { st = { s: 'idle', ar: null, paint: null }; FIX.set(id, st); }
  const box = h('div', { class: 'fx-ar', 'aria-live': 'polite' }); const key = rightText(q);
  const paint = () => {
    box.className = 'fx-ar' + (st.s === 'load' ? ' wait' : '');
    if (st.s === 'ok') fill(box, h('span', { class: 'lbl' }, 'بالعربي'), h('p', { lang: 'ar', dir: 'rtl' }, withKey(st.ar, key)));
    else if (st.s === 'load') fill(box, h('span', { class: 'lbl' }, 'بالعربي'), h('span', { class: 'sk', 'aria-hidden': 'true' }), h('span', { class: 'vh' }, 'جارٍ تجهيز التصحيح بالعربية'));
    else if (st.s === 'fail') fill(box, h('button', { class: 'btn small ghost', type: 'button', onclick: () => { st.s = 'idle'; start(); } }, '↻ صحّحها بالعربي مرة أخرى'));
    else fill(box);
  };
  const start = () => {
    if (st.s !== 'idle') return; st.s = 'load'; if (st.paint) st.paint();
    queue.push(async () => {
      try { const r = await api('POST', `/api/attempts/${attemptId}/correction`, { question_id: q.id }); if (r && r.ar) { st.s = 'ok'; st.ar = r.ar; } else st.s = r && r.available && r.reason === 'failed' ? 'fail' : 'none'; }
      catch (_) { st.s = 'fail'; }
      if (st.paint) st.paint(); });
    pump();
  };
  st.paint = paint; paint(); start();
  return box;
}

/** everything that follows a revealed question: a correct answer keeps its explanation and evidence; a wrong or blank one gets the slip first, then the lecture's own explanation and sentence with the right word marked */
export function afterAnswer(q, attemptId, evidenceBlock) {
  if (!needsFix(q)) return [h('p', { dir: dirOf(q.explanation) }, q.explanation), evidenceBlock(q)];
  const orig = isArabicText(q.explanation) ? h('p', { dir: dirOf(q.explanation) }, q.explanation) : h('div', { class: 'orig' }, h('span', { class: 'olbl' }, 'الشرح الأصلي'), h('p', { dir: dirOf(q.explanation) }, q.explanation));
  return [fixSlip(q, arabicFix(q, attemptId)), orig, evidenceBlock(q, rightText(q))];
}
