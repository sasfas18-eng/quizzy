/* Quizzy · Claude edition — "no-token" generator: rule-based extraction of questions from the page text. ZERO LLM calls.
 * Supported types: basic_recall, understanding, mechanisms, application (numbers), not_except, sequence.
 * Everything is derived from verbatim sentences, so evidence quotes are exact by construction. It is simpler than the
 * Claude mode: distractors come from the same source (other definitions/terms/values), not from reasoning. */
(() => {
const E = window.QZE;
const isAr = (t) => E.arRatio(t) > 0.4;
const sentences = (text) => { const out = []; text.split('\n').forEach((line) => { const l = line.trim(); if (!l) return; l.split(/(?<=[.!?؟])\s+(?=[A-Z؀-ۿA-Z0-9"“(])/).forEach((s) => { s = s.trim(); if (s.split(/\s+/).length >= 5) out.push(s); }); }); return out; };
const clip = (s, n = 170) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const strip = (s) => s.replace(/[.؟?!]+$/, '').trim();
const DEF_EN = /^(?:The |A |An )?([A-Z][A-Za-z0-9\- ]{2,40}?) (is|are|refers to|means) ((?:the |a |an )?.{18,200})$/;
const DEF_AR = /^(.{3,40}?) (هو|هي|هم|يُعرَّف بأنه|تعني|يعني) (.{14,200})$/;
const CAUSE = /^(.{6,140}?) (leads? to|results? in|causes?|لأن|يؤدي إلى|تؤدي إلى|ينتج عنه|يسبب|تسبب) (.{8,140})$/i;
const NUM = /(\d+(?:[.,]\d+)?)\s?(mmHg|mL|ml|mg|kg|g|L|bpm|Hz|%|°C|mV|V|A|m|cm|mm|s|min|h|ms|mol|kPa|دورة|ملغ|مل|كجم|%)/;
const LIST_EN = /^(.{10,120}?)(?:include|includes|including|such as|consists? of|comprises?)[: ]\s*(.+)$/i;
const LIST_AR = /^(.{6,120}?)(?:تشمل|تتضمن|تتكون من|مثل)[: ]\s*(.+)$/;
const splitList = (s) => strip(s).split(/\s*(?:,|،|;|؛|\band\b|\bor\b| و(?=\S))\s*/i).map((x) => x.replace(/^(and|or|و)\s+/i, '').trim()).filter((x) => x.length >= 3 && x.split(/\s+/).length <= 6);

function mine(pagesList) {
  const out = { defs: [], causal: [], nums: [], lists: [], seqs: [] };
  for (const p of pagesList) {
    const ss = sentences(p.text);
    ss.forEach((s) => { let m;
      if ((m = s.match(DEF_EN) || s.match(DEF_AR))) out.defs.push({ ref: p.ref, term: m[1].trim().replace(/^(The|A|An)\s+/i, ''), tail: strip(m[3]), sentence: s });
      if ((m = s.match(CAUSE))) out.causal.push({ ref: p.ref, head: m[1].trim(), conn: m[2], tail: strip(m[3]), sentence: s });
      if ((m = s.match(NUM))) out.nums.push({ ref: p.ref, val: m[1], unit: m[2], sentence: s });
      if ((m = s.match(LIST_EN) || s.match(LIST_AR))) { const items = splitList(m[2]); if (items.length >= 3) out.lists.push({ ref: p.ref, lead: m[1].trim(), items, sentence: s }); } });
    const lines = p.text.split('\n').map((l) => l.trim()); const num = lines.map((l) => l.match(/^(\d+)[.)]\s+(.{6,})$/)); const run = [];
    num.forEach((m) => { if (m) run.push(m[2]); else { if (run.length >= 3) out.seqs.push({ ref: p.ref, items: run.slice(0, 5) }); run.length = 0; } }); if (run.length >= 3) out.seqs.push({ ref: p.ref, items: run.slice(0, 5) });
  }
  return out;
}
const pick = (arr, n, seed) => { const a = arr.slice(); let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor(s / 233280 * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

function analyse(pagesList) {
  const m = mine(pagesList); const objectives = [];
  pagesList.forEach((p, i) => { if (p.text.length < 80) return; const on = (a) => a.filter((x) => x.ref === p.ref).length; const sup = {}; let cap = 0;
    if (on(m.defs) && m.defs.length >= 4) { sup.basic_recall = { pages: [p.ref] }; sup.understanding = { pages: [p.ref] }; cap += Math.min(2, on(m.defs)); }
    if (on(m.causal) && m.causal.length >= 4) { sup.mechanisms = { pages: [p.ref] }; cap += 1; }
    if (on(m.nums) >= 1) { sup.application = { pages: [p.ref] }; cap += 1; }
    if (on(m.lists) && m.lists.length >= 2) { sup.not_except = { pages: [p.ref] }; cap += 1; }
    if (on(m.seqs)) { sup.sequence = { pages: [p.ref] }; cap += 1; }
    if (Object.keys(sup).length) objectives.push({ id: 'o' + (objectives.length + 1), statement: p.text.split('\n')[0].slice(0, 120), pages: [p.ref], key_terms: [], capacity: Math.min(4, cap), supports: sup }); });
  return { objectives, gaps: ['وضع «بدون توكن» يدعم: التعريفات، السبب والنتيجة، الأرقام، القوائم، الترتيب فقط. التفكير النقدي وأفضل إجابة والسيناريوهات والمقارنة تحتاج Claude.'],
    lecture_character: 'تحليل آلي بالقواعد (بدون ذكاء اصطناعي).', discipline_guess: null };
}

function build(slot, m, used, pages) {
  const ar = isAr(pages[slot.pages[0]] || ''); const seed = slot.slot * 7919 + 13; const here = (a) => a.filter((x) => slot.pages.includes(x.ref) && !used.has(x.sentence || x.items.join('|')));
  const mk = (stem, key, wrong, ev, expl, purpose) => { const w = [...new Set(wrong.filter((x) => x && E.norm(x) !== E.norm(key)))].slice(0, 3); if (w.length < 3) return null;
    return { slot: slot.slot, unwritable_reason: null, stem, options: [key, ...w], correct_index: 0, explanation: expl, purpose, reasoning_pattern: slot.qtype, evidence: [{ page: ev.ref, quote: ev.sentence || ev.quote }], uses_external: false }; };
  const note = (s) => (ar ? `الإجابة الصحيحة مبنية على نص المحاضرة: «${s}». الخيارات الأخرى تصف أشياء أخرى وردت في المصدر لا تنطبق هنا.` : `The correct answer follows the lecture text: "${s}". The other options describe other items from the source that do not apply here.`);
  if (slot.qtype === 'basic_recall' || slot.qtype === 'understanding') {
    const cand = here(m.defs)[0]; if (!cand) return null; used.add(cand.sentence); const others = m.defs.filter((d) => d.term !== cand.term);
    if (slot.qtype === 'basic_recall') { const w = pick(others.sort((a, b) => Math.abs(a.tail.length - cand.tail.length) - Math.abs(b.tail.length - cand.tail.length)).slice(0, 8), 3, seed).map((d) => clip(d.tail));
      return mk(ar ? `ما المقصود بـ «${cand.term}» حسب المحاضرة؟` : `According to the lecture, what is "${cand.term}"?`, clip(cand.tail), w, cand, note(cand.sentence), `تعريف ${cand.term}`); }
    const w = pick(others.map((d) => d.term), 3, seed); return mk(ar ? `أي مصطلح يوافق هذا التعريف: «${clip(cand.tail, 140)}»؟` : `Which term matches this definition: "${clip(cand.tail, 140)}"?`, cand.term, w, cand, note(cand.sentence), `تمييز مصطلح ${cand.term} من تعريفه`); }
  if (slot.qtype === 'mechanisms') { const c = here(m.causal)[0]; if (!c) return null; used.add(c.sentence); const w = pick(m.causal.filter((x) => x.tail !== c.tail).sort((a, b) => Math.abs(a.tail.length - c.tail.length) - Math.abs(b.tail.length - c.tail.length)).slice(0, 8), 3, seed).map((x) => clip(x.tail, 120));
    return mk(ar ? `أكمل حسب المحاضرة: ${c.head} ${c.conn} ____` : `Complete according to the lecture: ${c.head} ${c.conn} ____`, clip(c.tail, 120), w, c, note(c.sentence), `الأثر الناتج عن: ${clip(c.head, 50)}`); }
  if (slot.qtype === 'application') { const n = here(m.nums)[0]; if (!n) return null; used.add(n.sentence); const v = parseFloat(n.val.replace(',', '.')); const same = [...new Set(m.nums.filter((x) => x.unit === n.unit && x.val !== n.val).map((x) => x.val))];
    const fake = [v * 2, v / 2, v * 1.25, v * 0.75, v + 10].map((x) => (Number.isInteger(v) ? String(Math.round(x)) : String(+x.toFixed(1)))).filter((x) => x !== n.val); const w = pick([...same, ...fake], 3, seed).map((x) => `${x} ${n.unit}`);
    return mk((ar ? 'أكمل بالقيمة الصحيحة حسب المحاضرة: ' : 'Select the correct value according to the lecture: ') + n.sentence.replace(n.val, '____'), `${n.val} ${n.unit}`, w, n, note(n.sentence), `قيمة رقمية: ${clip(n.sentence, 50)}`); }
  if (slot.qtype === 'not_except') { const l = here(m.lists)[0]; if (!l) return null; used.add(l.sentence); const foreign = [...new Set(m.lists.filter((x) => x !== l).flatMap((x) => x.items))].filter((it) => !l.items.some((z) => E.norm(z) === E.norm(it)) && !E.norm(pages[l.ref] || '').includes(E.norm(it)));
    if (!foreign.length) return null; const true3 = pick(l.items, 3, seed); const key = pick(foreign, 1, seed)[0];
    const q = mk(ar ? `أي مما يلي ليس من ${clip(strip(l.lead), 80)}؟` : `Which of the following is NOT among ${clip(strip(l.lead), 80)}?`, key, true3, l, note(l.sentence), `الاستثناء من قائمة: ${clip(l.lead, 50)}`); return q; }
  if (slot.qtype === 'sequence') { const q = here(m.seqs.map((s) => ({ ...s, sentence: s.items.join('|') })))[0]; if (!q) return null; used.add(q.sentence); const items = q.items.slice(0, 4); const idx = items.map((_, i) => i);
    const shuf = pick(idx, idx.length, seed); const same = shuf.every((v, i) => v === i); if (same) shuf.push(shuf.shift()); const correct = idx.map((k) => shuf.indexOf(k) + 1); const set = new Set([correct.join(' → ')]);
    for (let t = 1; set.size < 4 && t < 60; t++) set.add(pick(idx.map((i) => i + 1), idx.length, seed + t).join(' → ')); if (set.size < 4) return null;
    const opts = [...set]; const first = items[0];
    return { slot: slot.slot, unwritable_reason: null, stem: (ar ? 'رتّب الخطوات التالية كما وردت في المحاضرة:\n' : 'Put the following steps in the order given in the lecture:\n') + shuf.map((k, n) => `${n + 1}. ${items[k]}`).join('\n'), options: opts, correct_index: 0,
      explanation: ar ? `الترتيب الصحيح هو الوارد في قائمة المحاضرة المرقمة التي تبدأ بـ «${first}».` : `The correct order is the numbered list in the lecture, starting with "${first}".`, purpose: `ترتيب خطوات تبدأ بـ ${clip(first, 40)}`, reasoning_pattern: 'sequence',
      evidence: [{ page: q.ref, quote: pages[q.ref].split('\n').find((l) => l.includes(first)).trim() }], uses_external: false }; }
  return null;
}

/* same contract as E.generate, no LLM */
async function generate(plan, pagesList, st, progress) {
  const pages = Object.fromEntries(pagesList.map((p) => [p.ref, p.text])); const m = mine(pagesList); const used = new Set(); const acc = [], dropped = [];
  const ctx = { pages, field: st.field, language: 'source', allowExternal: false, sourceAr: E.arRatio(pagesList.slice(0, 10).map((p) => p.text).join(' ')) > .4 };
  const stats = { drafted: 0, rejected_validation: 0, rejected_verifier: 0, rejected_duplicate: 0, rejected_leak: 0, unwritable: 0, retries: 0 };
  for (const s of plan.slots) { progress('drafting', Math.round(100 * acc.length / Math.max(1, plan.slots.length)));
    const raw = build(s, m, used, pages); if (!raw) { stats.unwritable++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: ['المصدر لا يحوي نمطًا مناسبًا لهذا النوع في الصفحات المحددة (وضع بدون توكن).'] }); continue; }
    stats.drafted++; const c = { slot: s.slot, qtype: s.qtype, task: null, objective: s.objective, objective_id: s.objective_id, difficulty: s.difficulty, stem: raw.stem, options: raw.options, correct_index: raw.correct_index, explanation: raw.explanation,
      purpose: raw.purpose, reasoning_pattern: raw.reasoning_pattern, evidence: raw.evidence, uses_external: false };
    const v = E.validateQ(c, ctx); let d;
    if (v.some((x) => x.severity === 'decisive')) { stats.rejected_validation++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: v.filter((x) => x.severity === 'decisive').map((x) => x.message) }); continue; }
    if ((d = E.dupOf(c, acc)) != null) { stats.rejected_duplicate++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [`مكرر للسؤال ${d}.`] }); continue; }
    if ((d = E.leaks(c, acc)) != null) { stats.rejected_leak++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [`يكشف إجابة سؤال آخر (${d}).`] }); continue; }
    c.issues = v.concat([{ code: 'rules_mode', message: 'وُلّد بالقواعد بلا حل مستقل: المشتتات من المصدر نفسه وليست من استدلال نموذج.', severity: 'minor' }]); acc.push(c); }
  return { accepted: acc, dropped, stats };
}
function cards(pagesList, n) {
  const m = mine(pagesList); const out = [];
  m.defs.forEach((d) => out.push({ front: isAr(d.sentence) ? `ما المقصود بـ «${d.term}»؟` : `What is "${d.term}"?`, back: clip(d.tail, 200), page: d.ref, quote: d.sentence }));
  m.causal.forEach((c) => out.push({ front: isAr(c.sentence) ? `ماذا يحدث عندما: ${c.head}؟` : `What follows when: ${c.head}?`, back: `${c.conn} ${clip(c.tail, 160)}`, page: c.ref, quote: c.sentence }));
  m.lists.forEach((l) => out.push({ front: isAr(l.sentence) ? `اذكر ما يندرج تحت: ${clip(strip(l.lead), 80)}` : `List: ${clip(strip(l.lead), 80)}`, back: l.items.join('، '), page: l.ref, quote: l.sentence }));
  return out.slice(0, n);
}
window.QZE.rules = { mine, analyse, generate, cards };
})();
