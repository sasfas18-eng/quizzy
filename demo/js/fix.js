/* The CORRECTION of a wrong (or blank) answer, shown the way a teacher corrects a paper: the student's choice crossed out, the right answer written in the highlighter, the lecture's own
 * sentence below with the right word marked - and, when an AI is available, the correction in clear, friendly ARABIC that keeps the ORIGINAL terms and the right answer exactly as the lecture has them.
 * The slip is built from what the page already has (instant, no AI). The Arabic text is asked for on demand (POST /api/attempts/:id/correction), checked by the engine, kept with the attempt. */
import { h, fill, api, dirOf, state } from './core.js?v=78c47e77aa';

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
  if (!needsFix(q)) return null;
  const id = `${attemptId}:${q.id}`; let st = FIX.get(id); if (!st) { st = { s: 'idle', ar: null, paint: null }; FIX.set(id, st); }
  const box = h('div', { class: 'fx-ar', 'aria-live': 'polite' }); const key = rightText(q);
  const paint = () => {
    box.className = 'fx-ar' + (st.s === 'load' ? ' wait' : '');
    if (st.s === 'ok') fill(box, h('span', { class: 'lbl' }, 'تصحيح ذكي'), h('p', { lang: 'ar', dir: 'rtl' }, withKey(st.ar, key)));
    else if (st.s === 'load') fill(box, h('span', { class: 'lbl' }, 'تصحيح ذكي'), h('span', { class: 'sk', 'aria-hidden': 'true' }), h('span', { class: 'vh' }, 'جارٍ تجهيز التصحيح'));
    else if (st.s === 'fail') fill(box, h('button', { class: 'btn small ghost', type: 'button', onclick: () => { st.s = 'idle'; start(); } }, '↻ جرّب التصحيح مرة أخرى'));
    else fill(box);
  };
  const start = () => {
    if (st.s !== 'idle') return; st.s = 'load'; if (st.paint) st.paint();
    queue.push(async () => {
      try { if (q._saving) await q._saving;      // practice shows the answer before it is saved: the correction is asked for once the answer is on record
        const r = await api('POST', `/api/attempts/${attemptId}/correction`, { question_id: q.id }); if (r && r.ar) { st.s = 'ok'; st.ar = r.ar; } else st.s = r && r.available && r.reason === 'failed' ? 'fail' : 'none'; }
      catch (_) { st.s = 'fail'; }
      if (st.paint) st.paint(); });
    pump();
  };
  st.paint = paint; paint(); start();
  return box;
}

/** everything that follows a revealed question: a correct answer keeps its explanation and evidence; a wrong or blank one gets the slip first, then the lecture's own explanation and sentence with the right word marked */
export function afterAnswer(q, attemptId, evidenceBlock) {
  if (!needsFix(q)) return [h('p', { dir: dirOf(q.explanation) }, q.explanation), evidenceBlock(q), tutorPanel(q, attemptId)];
  const orig = isArabicText(q.explanation) ? h('p', { dir: dirOf(q.explanation) }, q.explanation) : h('div', { class: 'orig' }, h('span', { class: 'olbl' }, 'الشرح الأصلي'), h('p', { dir: dirOf(q.explanation) }, q.explanation));
  return [fixSlip(q, arabicFix(q, attemptId)), orig, evidenceBlock(q, rightText(q)), tutorPanel(q, attemptId)];
}

/* THE TUTOR after any answered question (when the page has an AI): quick asks («ليش اختياري غلط؟», «اشرحها أبسط»), a question of one's own, and a SIMILAR QUESTION
 * on the same idea answered on the spot - all from the student's own lecture (the engine checks every answer). The conversation is kept for the visit, per question. */
const TUTOR = new Map();      // `${attempt}:${question}` -> { turns: [{q, a}], busy, sims: [] }
const MAX_TURNS = 6;
export function tutorPanel(q, attemptId) {
  if (!state.caps || !state.caps.tutor || !rightOption(q)) return null;
  const id = `${attemptId}:${q.id}`; let st = TUTOR.get(id); if (!st) { st = { turns: [], busy: false, sims: [], open: false }; TUTOR.set(id, st); }
  const wrong = needsFix(q), chosen = !!(q.selected_option_id && q.selected_option_id !== q.correct_option_id);
  const box = h('section', { class: 'tutor', 'aria-label': 'اسأل عن هذا السؤال' }); const log = h('div', { class: 'tlog', 'aria-live': 'polite' }); const err = h('div', {});
  const input = h('input', { type: 'text', class: 'tin', maxlength: 300, placeholder: 'اسأل عن هذا السؤال…', 'aria-label': 'سؤالك عن هذا السؤال',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); send(input.value); } } });
  const bubble = (who, text, key) => h('div', { class: 'tb ' + who }, h('span', { class: 'tw' }, who === 'me' ? 'أنت' : 'المعلّم'), h('p', { dir: dirOf(text) }, key ? withKey(text, key) : text));
  const simView = (sq, k) => { let done = false; const fb = h('div', {});
    const opts = sq.options.map((o, i) => h('button', { type: 'button', class: 'opt sim-opt', dir: dirOf(o), onclick: (e) => { if (done) return; done = true;
      opts[sq.correct_index].classList.add('right'); if (i !== sq.correct_index) e.currentTarget.classList.add('wrong'); sq.picked = i;
      fill(fb, h('p', { class: i === sq.correct_index ? 'sim-ok' : 'sim-no' }, i === sq.correct_index ? 'صح، أحسنت!' : 'ليست هذه، الصواب مُعلَّم بالأخضر.'), h('p', { dir: dirOf(sq.explanation) }, sq.explanation),
        h('blockquote', { dir: dirOf(sq.quote) }, '«', withKey(sq.quote, sq.options[sq.correct_index]), '»')); } }, o));
    if (sq.picked != null) setTimeout(() => opts[sq.picked].click(), 0);
    return h('div', { class: 'sim', 'data-k': k }, h('span', { class: 'tw' }, 'سؤال مشابه'), h('p', { class: 'sim-stem', dir: dirOf(sq.stem) }, sq.stem), h('div', { class: 'sim-opts' }, opts), fb); };
  const paint = () => { fill(log, st.turns.map((t) => [bubble('me', t.q), t.a ? bubble('ai', t.a, rightText(q)) : null]), st.sims.map(simView), st.busy ? h('div', { class: 'tb ai wait' }, h('span', { class: 'sk', 'aria-hidden': 'true' }), h('span', { class: 'vh' }, 'جارٍ التفكير')) : null); };
  const fail = (m) => fill(err, h('p', { class: 'small terr' }, m));
  async function send(text) {
    const ask = String(text || '').trim(); if (!ask || st.busy) return; if (st.turns.length >= MAX_TURNS) { fail('وصلت حدّ الأسئلة عن هذا السؤال. انتقل للسؤال التالي.'); return; }
    st.busy = true; err.replaceChildren(); input.value = ''; const turn = { q: ask, a: null }; st.turns.push(turn); paint();
    try { if (q._saving) await q._saving; const r = await api('POST', `/api/attempts/${attemptId}/tutor`, { question_id: q.id, ask, history: st.turns.filter((t) => t.a).map((t) => ({ q: t.q, a: t.a })) });
      if (r && r.ar) turn.a = r.ar; else { st.turns.pop(); fail(r && r.available === false ? 'المساعد غير متاح الآن.' : 'لم يتيسّر جواب سليم من محاضرتك على هذا. جرّب صياغة أخرى.'); } }
    catch (_) { st.turns.pop(); fail('تعذّر الوصول إلى المساعد الآن. حاول بعد قليل.'); }
    st.busy = false; paint(); }
  async function similar() {
    if (st.busy) return; if (st.sims.length >= 3) { fail('يكفي ثلاثة أسئلة مشابهة لهذا السؤال.'); return; } st.busy = true; err.replaceChildren(); paint();
    try { if (q._saving) await q._saving; const r = await api('POST', `/api/attempts/${attemptId}/similar`, { question_id: q.id }); if (r && r.question) st.sims.push(r.question); else fail('لم يتيسّر سؤال مشابه سليم من محاضرتك الآن. حاول مرة أخرى.'); }
    catch (_) { fail('تعذّر الوصول إلى المساعد الآن. حاول بعد قليل.'); }
    st.busy = false; paint(); }
  const chip = (label, act) => h('button', { type: 'button', class: 'btn small tchip', onclick: act }, label);
  const chips = h('div', { class: 'tchips' },
    wrong && chosen ? chip('ليش اختياري غلط؟', () => send('ليش اختياري غلط؟')) : chip('ليش الخيارات الثانية غلط؟', () => send('ليش الخيارات الثانية غلط؟')),
    chip('اشرحها أبسط', () => send('اشرح لي الفكرة بأبسط طريقة')),
    chip('سؤال مشابه أتأكد فيه', similar));
  fill(box, h('div', { class: 'thead' }, h('span', { class: 'lbl' }, 'اسأل المعلّم'), h('span', { class: 'small muted' }, 'من محاضرتك فقط')), chips, log, err,
    h('div', { class: 'trow' }, input, h('button', { type: 'button', class: 'btn small primary', onclick: () => send(input.value) }, 'أرسل')));
  paint();
  return box;
}
