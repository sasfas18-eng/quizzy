/* Quizzy — "no-token" generator: rule-based extraction of questions from the page text. ZERO LLM calls.
 * Understands how slides are really written: "Term: definition" lines, a heading followed by bullets, running sentences
 * ("X is …", "A leads to B", numbers with units), numbered steps — and falls back to fill-in-the-blank on any informative sentence.
 * Supported types: basic_recall, understanding, mechanisms, application, not_except, sequence.
 * Every question is built from verbatim lines, so evidence quotes are exact by construction. It is simpler than the AI mode:
 * distractors come from the same lecture (other terms/definitions/items), not from reasoning. */
(() => {
const E = window.QZE;
const isAr = (t) => E.arRatio(t) > 0.4;
const wc = (s) => (String(s).trim().match(/\S+/g) || []).length;
const strip = (s) => String(s).replace(/[.؟?!؛;,،:：]+$/, '').trim();
const clip = (s, n = 170) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const pick = (arr, n, seed) => { const a = arr.slice(); let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor(s / 233280 * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const normKey = (s) => E.norm(s);

// ---------------------------------------------------------------- line parsing
const BULLET_RE = /^[\s ]*(?:[•●▪◦○■□▫‣⁃·*]+|[-–—](?=\s)|\(?\d{1,2}[.)]|\(?[a-zA-Z][.)](?=\s)|[٠-٩]{1,2}[.)])\s+/;
const NOT_TERM = /^(lecture|chapter|unit|week|part|section|module|slide|figure|table|note|notes|example|examples|e\.g|i\.e|summary|objectives?|outline|agenda|references?|result|results|conclusion|definition|key points?|tip|tips|remember|important|answer|question|step|stage|case|المحاضرة|الفصل|الوحدة|الأسبوع|ملاحظة|مثال|أمثلة|ملخص|الأهداف|المراجع|النتيجة|الخلاصة|تعريف|مهم|تذكر|الإجابة|السؤال|الخطوة|المرحلة)\b/i;
// learning-objective lines ("Describe the structure of…") are about the course, not lecture content: never examine them
const OBJ_VERB = /^(describe|explain|compare|define|identify|discuss|list|outline|understand|recognize|recognise|state|summari[sz]e|differentiate|distinguish|apply|analy[sz]e|evaluate|illustrate|demonstrate|name|calculate|appreciate|know|learn|be able|اشرح|صف|قارن|عرّف|عرف|حدد|ناقش|اذكر|وضح|فسر|لخص|ميز|يصف|يشرح|يقارن|يعرّف|يحدد|يناقش)\b/i;
const ANTONYMS = [['inside', 'outside'], ['increase', 'decrease'], ['increases', 'decreases'], ['increased', 'decreased'], ['high', 'low'], ['higher', 'lower'], ['positive', 'negative'], ['active', 'passive'], ['hypotonic', 'hypertonic'], ['isotonic', 'hypotonic'], ['isotonic', 'hypertonic'],
  ['anterior', 'posterior'], ['superior', 'inferior'], ['proximal', 'distal'], ['dorsal', 'ventral'], ['afferent', 'efferent'], ['excitatory', 'inhibitory'], ['aerobic', 'anaerobic'], ['internal', 'external'], ['intracellular', 'extracellular'], ['maximum', 'minimum'], ['rapid', 'slow'],
  ['acid', 'base'], ['anabolism', 'catabolism'], ['sympathetic', 'parasympathetic'], ['systole', 'diastole'], ['inspiration', 'expiration'], ['depolarization', 'hyperpolarization'], ['داخل', 'خارج'], ['زيادة', 'نقصان'], ['مرتفع', 'منخفض'], ['علوي', 'سفلي'], ['إيجابي', 'سلبي'], ['انقباض', 'انبساط']].map(([a, b]) => [a, b]);
const antonym = (a, b) => { a = a.toLowerCase(); b = b.toLowerCase(); return ANTONYMS.some(([x, y]) => (a === x && b === y) || (a === y && b === x)); };
// common words that make poor fill-in-the-blank answers or distractors
const COMMON = new Set(('across within between through during using uses used allow allows allowed called known based because however therefore should would could which their these those about after before other another among against around along under over above below since until while where whether either neither often usually always never really mainly mostly highly directly slowly quickly several various certain general specific different similar following important increase increases decrease decreases require requires required produce produces produced create creates created change changes changed form forms formed provide provides provided contain contains contained include includes included involve involves involved depend depends depended occur occurs occurred result results resulted cause causes caused show shows shown make makes made take takes taken give gives given help helps helped need needs needed move moves moved bind binds bound release releases released describe explain compare define identify discuss summarize outline understand function functions process processes system systems structure structures example examples type types part parts level levels number numbers amount amounts group groups ').split(' ').filter(Boolean));
const NOT_HEADING = /^(objectives?|outline|agenda|summary|references?|questions?|thank|learning outcomes|contents?|الأهداف|المحاور|ملخص|المراجع|أسئلة|شكرا|المحتويات)/i;
function parseLines(text) {
  return String(text || '').split('\n').map((raw) => {
    const r = raw.replace(/ /g, ' '); let t = r.trim(); if (!t) return null;
    let bullet = false, num = null; const b = t.match(BULLET_RE);
    if (b) { bullet = true; const m = b[0].trim().match(/^\(?(\d{1,2})[.)]/); if (m) num = +m[1]; t = t.slice(b[0].length).trim(); }
    return { raw: r.trim(), text: t, bullet, num, words: wc(t), endsSentence: /[.!?؟]$/.test(t), endsColon: /[:：]$/.test(t) };
  }).filter((l) => l && l.text);
}
const splitSentences = (line) => line.split(/(?<=[.!?؟])\s+(?=[A-Z؀-ۿ"“(])/).map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- patterns
const DEF_EN = /^(?:The |A |An )?([A-Z][A-Za-z0-9\- ]{2,40}?) (is|are|refers to|means) ((?:the |a |an )?.{18,200})$/;
const DEF_AR = /^(.{3,40}?) (هو|هي|هم|يُعرَّف بأنه|تعني|يعني) (.{14,200})$/;
const SEP_DEF = /^(.{2,60}?)\s*[:：]\s+(.{12,260})$/;
const DASH_DEF = /^(.{2,50}?)\s+[–—-]\s+(.{12,260})$/;
const CAUSE = /^(.{6,140}?) (leads? to|results? in|causes?|because|لأن|يؤدي إلى|تؤدي إلى|ينتج عنه|يسبب|تسبب) (.{8,140})$/i;
const NUM = /(\d+(?:[.,]\d+)?)\s?(mmHg|mL|ml|mg|kg|g|L|bpm|Hz|%|°C|mV|V|A|m|cm|mm|s|min|h|ms|mol|kPa|دورة|ملغ|مل|كجم|%)/;
const LIST_EN = /^(.{10,120}?)(?:include|includes|including|such as|consists? of|comprises?)[: ]\s*(.+)$/i;
const LIST_AR = /^(.{6,120}?)(?:تشمل|تتضمن|تتكون من|مثل)[: ]\s*(.+)$/;
const splitList = (s) => strip(s).split(/\s*(?:,|،|;|؛|\band\b|\bor\b| و(?=\S))\s*/i).map((x) => x.replace(/^(and|or|و)\s+/i, '').trim()).filter((x) => x.length >= 3 && wc(x) <= 6);

function defFromLine(l) {
  if (l.endsSentence && l.words > 25) return null;
  if (OBJ_VERB.test(l.text)) return null;
  const m = l.text.match(SEP_DEF) || l.text.match(DASH_DEF); if (!m) return null;
  const term = m[1].trim(), tail = strip(m[2]);
  if (wc(term) > 6 || wc(tail) < 3 || NOT_TERM.test(term) || /^\d+$/.test(term) || /[.!?؟]$/.test(term) || /\d\s*$/.test(term)) return null;
  return { term, tail, sentence: l.raw, unit: l.text };
}
function mineLists(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i];
    if (h.bullet || h.words > 10 || h.endsSentence || h.words < 1 || NOT_HEADING.test(h.text) || NOT_TERM.test(h.text) || defFromLine(h)) continue;
    const items = []; let j = i + 1;
    while (j < lines.length && items.length < 10) {
      const l = lines[j]; const itemLike = l.num == null && !NOT_HEADING.test(l.text) && (l.bullet || (l.words <= 10 && !l.endsSentence && !l.endsColon));
      if (!itemLike) break; items.push(l); j++;
    }
    const titleLike = i === 0;     // slide title followed by short lines: PPTX paragraphs carry no bullet characters
    if (items.length >= 3 && (items.some((x) => x.bullet) || h.endsColon || titleLike) && !items.some((x) => defFromLine(x)) && items.filter((x) => OBJ_VERB.test(x.text)).length < Math.ceil(items.length / 2)) {
      const clean = items.map((x) => { const t = strip(x.text); const m = t.match(/^(.{3,40}?)\s*[:：–—-]\s+/); return clip(m && wc(m[1]) <= 5 ? m[1] : t, 80); }).filter((t) => t.length >= 3 && wc(t) <= 9);
      if (clean.length >= 3) out.push({ lead: strip(h.text), items: clean.slice(0, 8), sentence: [h.raw, ...items.slice(0, 3).map((x) => x.raw)].join(' ') });
      i = j - 1;
    }
  }
  return out;
}
function mineSeqs(lines) {
  const out = []; let run = [];
  const flush = () => { if (run.length >= 3) out.push(run.slice(0, 5)); run = []; };
  lines.forEach((l) => { if (l.num != null && l.words >= 3 && (run.length === 0 ? l.num === 1 : l.num === run.length + 1)) run.push(l.text); else flush(); });
  flush(); return out;
}

// ---------------------------------------------------------------- key terms (for fill-in-the-blank)
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
function docFreq(pagesList) { const df = new Map(); pagesList.forEach((p) => new Set((p.text.toLowerCase().match(WORD_RE) || [])).forEach((w) => df.set(w, (df.get(w) || 0) + 1))); return df; }
function termScore(w, idx, df) {
  const lw = w.toLowerCase(); if (E.STOP.has(lw) || COMMON.has(lw) || /^\d+$/.test(w) || (/ly$/.test(lw) && lw.length > 5)) return -1;
  const letters = [...w].filter((c) => /\p{L}/u.test(c)).length, ar = /[؀-ۿ]/.test(w), acr = /^[A-Z]{2,6}$/.test(w);
  if (letters < (ar ? 4 : acr ? 2 : 6)) return -1;
  const cap = !ar && ((idx > 0 && /^[A-Z][a-z]/.test(w)) || acr); const d = df.get(lw) || 1;
  return Math.min(letters, 12) / 12 + (cap ? 1.2 : 0) + (d <= 1 ? 1.5 : d <= 2 ? 1 : d <= 4 ? 0.4 : 0);
}
function candidates(sentence, df) {
  const out = []; let m; WORD_RE.lastIndex = 0; let k = 0; const low = sentence.toLowerCase();
  const count = (w) => { let n = 0, i = -1; while ((i = low.indexOf(w, i + 1)) >= 0) n++; return n; };
  while ((m = WORD_RE.exec(sentence))) {
    const w = m[0].replace(/['’-]+$/, ''); const s = termScore(w, k++, df); if (s <= 0) continue;
    // the answer (or any part of a hyphenated answer) must not be given away elsewhere in the same sentence
    const parts = w.toLowerCase().split('-').filter((x) => x.length >= 4);
    if (count(w.toLowerCase()) > 1 || (parts.length > 1 && parts.some((x) => count(x) > 1))) continue;
    out.push({ word: w, index: m.index, score: s });
  }
  return out;
}

// ---------------------------------------------------------------- mining
// distractor pool = the best key term of each sentence (+ one-word definition terms): content words, not verbs/adverbs
function addTerm(out, word, ref) { const k = word.toLowerCase(); if (!out.terms.has(k)) out.terms.set(k, { word, refs: new Set() }); out.terms.get(k).refs.add(ref); }
function mine(pagesList) {
  const df = docFreq(pagesList); const out = { defs: [], causal: [], nums: [], lists: [], seqs: [], cloze: [], terms: new Map() };
  for (const p of pagesList) {
    const lines = parseLines(p.text); const units = [];
    lines.forEach((l) => {
      const d = defFromLine(l); if (d) out.defs.push({ ref: p.ref, ...d });
      splitSentences(l.text).forEach((s) => { if (wc(s) >= 5) units.push(s); });
    });
    units.forEach((s) => { let m;
      if (!out.defs.some((d) => d.unit === s || d.sentence === s) && !OBJ_VERB.test(s) && (m = s.match(DEF_EN) || s.match(DEF_AR))) out.defs.push({ ref: p.ref, term: m[1].trim().replace(/^(The|A|An)\s+/i, ''), tail: strip(m[3]), sentence: s, unit: s });
      if ((m = s.match(CAUSE))) out.causal.push({ ref: p.ref, head: m[1].trim(), conn: m[2], tail: strip(m[3]), sentence: s });
      if ((m = s.match(NUM))) out.nums.push({ ref: p.ref, val: m[1], unit: m[2], sentence: s });
      if ((m = s.match(LIST_EN) || s.match(LIST_AR))) { const items = splitList(m[2]); if (items.length >= 3) out.lists.push({ ref: p.ref, lead: m[1].trim(), items, sentence: s }); }
      const w = wc(s);
      if (w >= 7 && w <= 35 && !OBJ_VERB.test(s)) { const c = candidates(s, df).sort((a, b) => b.score - a.score); if (c.length && c[0].score >= 1.6 && c[0].word.length >= 6) { out.cloze.push({ ref: p.ref, sentence: s, term: c[0].word, index: c[0].index }); addTerm(out, c[0].word, p.ref); } }
    });
    mineLists(lines).forEach((l) => out.lists.push({ ref: p.ref, ...l }));
    mineSeqs(lines).forEach((items) => out.seqs.push({ ref: p.ref, items }));
  }
  out.defs.forEach((d) => { if (wc(d.term) === 1 && d.term.length >= 5) addTerm(out, d.term, d.ref); });
  return out;
}
function diagnose(pagesList) {
  const m = mine(pagesList); return { pages: pagesList.length, words: pagesList.reduce((a, p) => a + wc(p.text), 0), defs: m.defs.length, causal: m.causal.length, nums: m.nums.length, lists: m.lists.length, seqs: m.seqs.length, cloze: m.cloze.length };
}

function analyse(pagesList) {
  const m = mine(pagesList); const objectives = []; const poolOk = m.terms.size >= 6;
  pagesList.forEach((p) => {
    const on = (a) => a.filter((x) => x.ref === p.ref).length; const n = { defs: on(m.defs), causal: on(m.causal), nums: on(m.nums), lists: on(m.lists), seqs: on(m.seqs), cloze: on(m.cloze) }; const sup = {};
    if (n.defs && m.defs.length >= 4) { sup.basic_recall = { pages: [p.ref] }; sup.understanding = { pages: [p.ref] }; } else if (n.cloze && poolOk) sup.basic_recall = { pages: [p.ref] };
    if (n.causal && m.causal.length >= 4) sup.mechanisms = { pages: [p.ref] };
    if (n.nums) sup.application = { pages: [p.ref] };
    if (n.lists && m.lists.length >= 2) sup.not_except = { pages: [p.ref] };
    if (n.seqs) sup.sequence = { pages: [p.ref] };
    if (Object.keys(sup).length) { const items = n.defs + n.causal + n.nums + n.lists + n.seqs + n.cloze; const title = (parseLines(p.text)[0] || {}).text || p.ref;
      objectives.push({ id: 'o' + (objectives.length + 1), statement: clip(title, 120), pages: [p.ref], key_terms: [], capacity: Math.max(1, Math.min(4, items)), supports: sup }); }
  });
  return { objectives, gaps: ['وضع «بدون توكن» يدعم: التعريفات، ملء الفراغ، السبب والنتيجة، الأرقام، القوائم، الترتيب. التفكير النقدي وأفضل إجابة والسيناريوهات والمقارنة تحتاج الذكاء الاصطناعي.'],
    lecture_character: 'تحليل آلي بالقواعد (بدون ذكاء اصطناعي).', discipline_guess: null };
}

// ---------------------------------------------------------------- building questions
function build(slot, m, used, pages) {
  const ar = isAr(pages[slot.pages[0]] || ''); const seed = slot.slot * 7919 + 13; const here = (a) => a.filter((x) => slot.pages.includes(x.ref) && !used.has(x.sentence || x.items.join('|')));
  const mk = (stem, key, wrong, ev, expl, purpose) => { const w = [...new Set(wrong.filter((x) => x && normKey(x) !== normKey(key)))].slice(0, 3); if (w.length < 3) return null;
    return { slot: slot.slot, unwritable_reason: null, stem, options: [key, ...w], correct_index: 0, explanation: expl, purpose, reasoning_pattern: slot.qtype, evidence: [{ page: ev.ref, quote: ev.sentence || ev.quote }], uses_external: false }; };
  const note = (s) => (ar ? `الإجابة الصحيحة مبنية على نص المحاضرة: «${s}». الخيارات الأخرى تصف أشياء أخرى وردت في المصدر لا تنطبق هنا.` : `The correct answer follows the lecture text: "${s}". The other options describe other items from the source that do not apply here.`);
  const byLen = (arr, f, target) => arr.slice().sort((a, b) => Math.abs(f(a).length - target) - Math.abs(f(b).length - target));
  if (slot.qtype === 'basic_recall' || slot.qtype === 'understanding') {
    const cand = m.defs.length >= 4 ? here(m.defs)[0] : null;
    if (cand && slot.qtype === 'understanding') { used.add(cand.sentence); const w = pick(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)).map((d) => d.term), 3, seed);
      return mk(ar ? `أي مصطلح يوافق هذا التعريف: «${clip(cand.tail, 140)}»؟` : `Which term matches this definition: "${clip(cand.tail, 140)}"?`, cand.term, w, cand, note(cand.sentence), `تمييز مصطلح ${cand.term} من تعريفه`); }
    if (cand) { used.add(cand.sentence); const others = byLen(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)), (d) => d.tail, cand.tail.length).slice(0, 8);
      return mk(ar ? `ما المقصود بـ «${cand.term}» حسب المحاضرة؟` : `According to the lecture, what is "${cand.term}"?`, clip(cand.tail), pick(others, 3, seed).map((d) => clip(d.tail)), cand, note(cand.sentence), `تعريف ${cand.term}`); }
    if (slot.qtype === 'understanding') return null;
    const c = here(m.cloze)[0]; if (!c) return null; used.add(c.sentence);
    const lt = c.term.toLowerCase(), inSent = new Set((c.sentence.toLowerCase().match(WORD_RE) || [])); const capCls = (w) => (/^[A-Z]{2,6}$/.test(w) ? 'a' : /^[A-Z]/.test(w) ? 'c' : 'l'); const sufCls = (w) => { const x = w.toLowerCase(); return /(tion|sion|ment|ness|ity|ance|ence)$/.test(x) ? 'n' : /ing$/.test(x) ? 'g' : /ed$/.test(x) ? 'd' : /(es|s)$/.test(x) && !/(ss|us|is)$/.test(x) ? 'p' : /(ic|al|ive|ous|ary|ar)$/.test(x) ? 'j' : 'o'; };
    const pool = [...m.terms.values()].filter((t) => t.word.toLowerCase() !== lt && !antonym(t.word, c.term) && !inSent.has(t.word.toLowerCase()) && (/[؀-ۿ]/.test(t.word) === /[؀-ۿ]/.test(c.term)) && capCls(t.word) === capCls(c.term) && (!/^ال/.test(c.term) || /^ال/.test(t.word)) && Math.abs(t.word.length - c.term.length) <= Math.max(3, Math.round(c.term.length * 0.4)));
    const rank = (t) => (sufCls(t.word) === sufCls(c.term) ? 0 : 2) + (t.refs.has(c.ref) ? 0 : 1); const ordered = pick(pool, pool.length, seed).sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((t) => t.word);
    if (ordered.length < 3) return null;    // not enough look-alike terms: better no question than a bad one
    const stem = c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length);
    if (wc(stem.replace('____', '')) < 5) return null;
    return mk((ar ? 'أكمل العبارة حسب المحاضرة: ' : 'Complete the statement from the lecture: ') + stem, c.term, ordered, c, note(c.sentence), `مصطلح أساسي في: ${clip(c.sentence, 50)}`); }
  if (slot.qtype === 'mechanisms') { const c = here(m.causal)[0]; if (!c || m.causal.length < 4) return null; used.add(c.sentence); const w = pick(byLen(m.causal.filter((x) => x.tail !== c.tail), (x) => x.tail, c.tail.length).slice(0, 8), 3, seed).map((x) => clip(x.tail, 120));
    return mk(ar ? `أكمل حسب المحاضرة: ${c.head} ${c.conn} ____` : `Complete according to the lecture: ${c.head} ${c.conn} ____`, clip(c.tail, 120), w, c, note(c.sentence), `الأثر الناتج عن: ${clip(c.head, 50)}`); }
  if (slot.qtype === 'application') { const n = here(m.nums)[0]; if (!n) return null; used.add(n.sentence); const v = parseFloat(n.val.replace(',', '.')); const same = [...new Set(m.nums.filter((x) => x.unit === n.unit && x.val !== n.val).map((x) => x.val))];
    const fake = [v * 2, v / 2, v * 1.25, v * 0.75, v + 10].map((x) => (Number.isInteger(v) ? String(Math.round(x)) : String(+x.toFixed(1)))).filter((x) => x !== n.val); const w = pick([...same, ...fake], 3, seed).map((x) => `${x} ${n.unit}`);
    return mk((ar ? 'أكمل بالقيمة الصحيحة حسب المحاضرة: ' : 'Select the correct value according to the lecture: ') + n.sentence.replace(n.val, '____'), `${n.val} ${n.unit}`, w, n, note(n.sentence), `قيمة رقمية: ${clip(n.sentence, 50)}`); }
  if (slot.qtype === 'not_except') { const l = here(m.lists)[0]; if (!l || m.lists.length < 2) return null; used.add(l.sentence);
    const med = l.items.map((x) => wc(x)).sort((a, b) => a - b)[Math.floor(l.items.length / 2)];
    const listTok = new Set(E.toks([l.lead, ...l.items].join(' ')));
    const foreign = [...new Set(m.lists.filter((x) => x !== l).flatMap((x) => x.items))].filter((it) => !l.items.some((z) => normKey(z) === normKey(it)) && !normKey(pages[l.ref] || '').includes(normKey(it)) && !E.toks(it).some((t) => listTok.has(t)) && !OBJ_VERB.test(it)).sort((a, b) => Math.abs(wc(a) - med) - Math.abs(wc(b) - med));
    if (!foreign.length) return null; const true3 = pick(l.items, 3, seed); const key = foreign[0];
    return mk(ar ? `أي مما يلي ليس من «${clip(strip(l.lead), 80)}»؟` : `Which of the following is NOT among "${clip(strip(l.lead), 80)}"?`, key, true3, l, note(l.sentence), `الاستثناء من قائمة: ${clip(l.lead, 50)}`); }
  if (slot.qtype === 'sequence') { const q = here(m.seqs.map((s) => ({ ...s, sentence: s.items.join('|') })))[0]; if (!q) return null; used.add(q.sentence); const items = q.items.slice(0, 4); const idx = items.map((_, i) => i);
    const shuf = pick(idx, idx.length, seed); if (shuf.every((v, i) => v === i)) shuf.push(shuf.shift()); const correct = idx.map((k) => shuf.indexOf(k) + 1); const set = new Set([correct.join(' → ')]);
    for (let t = 1; set.size < 4 && t < 60; t++) set.add(pick(idx.map((i) => i + 1), idx.length, seed + t).join(' → ')); if (set.size < 4) return null;
    const first = items[0]; const line = pages[q.ref].split('\n').find((l) => l.includes(first));
    return { slot: slot.slot, unwritable_reason: null, stem: (ar ? 'رتّب الخطوات التالية كما وردت في المحاضرة:\n' : 'Put the following steps in the order given in the lecture:\n') + shuf.map((k, n) => `${n + 1}. ${items[k]}`).join('\n'), options: [...set], correct_index: 0,
      explanation: ar ? `الترتيب الصحيح هو الوارد في قائمة المحاضرة المرقمة التي تبدأ بـ «${first}».` : `The correct order is the numbered list in the lecture, starting with "${first}".`, purpose: `ترتيب خطوات تبدأ بـ ${clip(first, 40)}`, reasoning_pattern: 'sequence',
      evidence: [{ page: q.ref, quote: (line || first).trim() }], uses_external: false }; }
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
  if (out.length < n) m.cloze.forEach((c) => out.push({ front: (isAr(c.sentence) ? 'أكمل: ' : 'Complete: ') + c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length), back: c.term, page: c.ref, quote: c.sentence }));
  return out.slice(0, n);
}
window.QZE.rules = { mine, analyse, generate, cards, diagnose };
})();
