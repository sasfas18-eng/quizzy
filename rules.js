/* Quizzy — "local" generator (no key, no AI): rule-based extraction of questions from the page text. ZERO LLM calls.
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
// picture captions / alt-text / credits are not lecture content (slides often carry "Book cover for …" as the picture's text)
const NOT_CONTENT = /^(book cover|cover of|picture|image|photo|photograph|figure|fig\.|graphic|logo|icon|chart|diagram|screenshot|©|copyright|source:|image source|photo credit|صورة|شكل|رسم|مصدر الصورة)\b/i;
const NOT_HEADING = /^(objectives?|outline|agenda|summary|references?|questions?|thank|learning outcomes|contents?|الأهداف|المحاور|ملخص|المراجع|أسئلة|شكرا|المحتويات)/i;
function parseLines(text) {
  return String(text || '').split('\n').map((raw) => {
    const r = raw.replace(/ /g, ' '); let t = r.trim(); if (!t) return null;
    let bullet = false, num = null; const b = t.match(BULLET_RE);
    if (b) { bullet = true; const m = b[0].trim().match(/^\(?(\d{1,2})[.)]/); if (m) num = +m[1]; t = t.slice(b[0].length).trim(); }
    return { raw: r.trim(), text: t, bullet, num, words: wc(t), endsSentence: /[.!?؟]$/.test(t), endsColon: /[:：]$/.test(t) };
  }).filter((l) => l && l.text);
}
// split after . ! ? ؟ when a new sentence starts (no lookbehind: older Safari versions refuse to even parse it)
const splitSentences = (line) => { const out = []; const re = /[.!?؟]\s+(?=[A-Z؀-ۿ"“(])/g; let start = 0, m; while ((m = re.exec(line))) { out.push(line.slice(start, m.index + 1)); start = m.index + m[0].length; } out.push(line.slice(start)); return out.map((x) => x.trim()).filter(Boolean); };

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
  const df = docFreq(pagesList); const out = { defs: [], causal: [], nums: [], lists: [], seqs: [], cloze: [], cloze2: [], defCloze: [], terms: new Map() };
  for (const p of pagesList) {
    const lines = parseLines(p.text).filter((l) => !NOT_CONTENT.test(l.text)); const units = [];
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
      if (w >= 7 && w <= 35 && !OBJ_VERB.test(s)) { const c = candidates(s, df).sort((a, b) => b.score - a.score); if (c.length && c[0].score >= 1.6 && c[0].word.length >= 6) { out.cloze.push({ ref: p.ref, sentence: s, term: c[0].word, index: c[0].index }); addTerm(out, c[0].word, p.ref);
        c.slice(1, 3).filter((x) => x.score >= 1.2 && x.word.length >= 6).forEach((x) => out.cloze2.push({ ref: p.ref, sentence: s, term: x.word, index: x.index })); } }
    });
    mineLists(lines).forEach((l) => out.lists.push({ ref: p.ref, ...l }));
    mineSeqs(lines).forEach((items) => out.seqs.push({ ref: p.ref, items }));
  }
  out.defs.forEach((d) => { if (wc(d.term) === 1 && d.term.length >= 5) addTerm(out, d.term, d.ref); });
  out.defs.forEach((d) => { const at = d.sentence.indexOf(d.tail); if (at < 0) return; const c = candidates(d.sentence, df).filter((x) => x.index >= at).sort((a, b) => b.score - a.score)[0];
    if (c && c.score >= 1.2 && c.word.length >= 6) out.defCloze.push({ ref: d.ref, sentence: d.sentence, term: c.word, index: c.index }); });
  return out;
}
function diagnose(pagesList) {
  const m = mine(pagesList); return { pages: pagesList.length, words: pagesList.reduce((a, p) => a + wc(p.text), 0), defs: m.defs.length, causal: m.causal.length, nums: m.nums.length, lists: m.lists.length, seqs: m.seqs.length, cloze: m.cloze.length };
}

/** The STRUCTURAL reading of a lecture (no AI): how many distinct questions of each of the ten types its visible structure can sustain, and on which pages.
 *  `semantic` = also read the types that need understanding rather than structure (comparisons, critical thinking, best-answer, scenarios) from their wording cues - used beside the AI
 *  profiler; the local generator (which cannot write those) leaves them at zero. */
function profile(pagesList, field, opts = {}) {
  const m = mine(pagesList); const sem = !!opts.semantic; const texts = pagesList.map((p) => p.text); const heur = E.support(texts, field || 'other'); const out = {};
  const refsOf = (...lists) => [...new Set(lists.flat().map((x) => x.ref))];
  const facts = new Set(); [m.defs, m.nums, m.cloze].forEach((l) => l.forEach((d) => facts.add(d.ref + '|' + (d.sentence || '')))); const factRefs = refsOf(m.defs, m.nums, m.cloze);
  const per = pagesList.map((p) => [p.ref, E.support([p.text], field || 'other')]); const cueRefs = (c) => per.filter(([, h]) => h[c].hits > 0).map(([r]) => r);
  const put = (c, cap, pages) => { const n = Math.max(0, Math.min(40, Math.round(cap))); out[c] = { capacity: n, level: E.levelOf(n), pages: n ? pages : [] }; };
  put('basic_recall', facts.size, factRefs); put('understanding', m.defs.length + m.causal.length, refsOf(m.defs, m.causal)); put('mechanisms', m.causal.length, refsOf(m.causal));
  put('application', m.nums.length + heur.application.hits / 3, [...new Set([...refsOf(m.nums), ...cueRefs('application')])]); put('not_except', m.lists.length, refsOf(m.lists)); put('sequence', m.seqs.length, refsOf(m.seqs));
  put('compare_contrast', sem ? heur.compare_contrast.hits / 1.5 : 0, cueRefs('compare_contrast')); put('critical_thinking', sem ? heur.critical_thinking.hits / 2 : 0, cueRefs('critical_thinking'));
  put('best_answer', sem ? Math.min(8, heur.best_answer.hits) : 0, cueRefs('best_answer')); put('scenarios', sem ? heur.scenarios.hits / (field === 'health' ? 3 : 6) : 0, cueRefs('scenarios'));
  return { types: out, source: 'rules' };
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
  return { objectives, profile: profile(pagesList, null, { semantic: false }), gaps: ['التوليد المحلي (بلا ذكاء اصطناعي) يدعم: التعريفات، إكمال الفراغ، السبب والنتيجة، الأرقام، القوائم، الترتيب. الأسئلة الأعمق (تحليل ومقارنة وحالات) تحتاج الذكاء الاصطناعي.'],
    lecture_character: 'تحليل آلي بالقواعد (بدون ذكاء اصطناعي).', discipline_guess: null };
}

// ---------------------------------------------------------------- building questions
/* A source item can be asked in more than one FORM (a definition: term -> meaning, meaning -> term, which statement is true, a missing word of it...). The first form of
 * each type is the original question; the other forms exist so a thin lecture can still fill the requested count WITHOUT repeating a question. Every form is built from verbatim
 * source lines (the evidence stays exact) and rotates with the slot's `variant`. */
const FORMS = { basic_recall: ['defMeaning', 'cloze', 'defCloze'], understanding: ['defToTerm', 'statement'], mechanisms: ['causeEffect', 'effectCause'],
  application: ['numValue', 'numStatement'], not_except: ['listNot', 'listBelongs'], sequence: ['seqOrder', 'seqNext'] };
const TYPES = Object.keys(FORMS);
const keyOf = (x) => x.sentence || x.items.join('|');
function toolkit(slot, m, used, pages) {
  const ar = isAr(pages[slot.pages[0]] || ''); const seed = slot.slot * 7919 + 13;
  // planned (natural) slots: a sentence feeds at most one question; reinforcement slots: only the same (form, item) pair is excluded, so another form may reuse the sentence
  const xk = (form, x) => form + '|' + keyOf(x) + (x.term && x.index != null ? '#' + x.term : '');
  const here = (a, form) => a.filter((x) => slot.pages.includes(x.ref) && !used.has(slot.extra ? xk(form, x) : keyOf(x)));
  const take = (form, x) => { used.add(keyOf(x)); used.add(xk(form, x)); };
  const mk = (stem, key, wrong, ev, expl, purpose) => { const w = [...new Set(wrong.filter((x) => x && normKey(x) !== normKey(key)))].slice(0, 3); if (w.length < 3) return null;
    return { slot: slot.slot, unwritable_reason: null, stem, options: [key, ...w], correct_index: 0, explanation: expl, purpose, reasoning_pattern: slot.qtype, evidence: [{ page: ev.ref, quote: ev.sentence || ev.quote }], uses_external: false }; };
  const note = (s) => (ar ? `الإجابة الصحيحة مبنية على نص المحاضرة: «${s}». الخيارات الأخرى تصف أشياء أخرى وردت في المصدر لا تنطبق هنا.` : `The correct answer follows the lecture text: "${s}". The other options describe other items from the source that do not apply here.`);
  const byLen = (arr, f, target) => arr.slice().sort((a, b) => Math.abs(f(a).length - target) - Math.abs(f(b).length - target));
  return { ar, seed, here, take, mk, note, byLen, slot };
}
// fill-in-the-blank with look-alike distractors taken from the lecture's own key terms (primary and secondary candidates share this builder)
function clozeQ(T, m, c, tag) {
  const lt = c.term.toLowerCase(), stemOf = (w) => w.toLowerCase().replace(/(ies|es|s|ing|ed)$/, ''), inSent = new Set((c.sentence.toLowerCase().match(WORD_RE) || []).map(stemOf)); const ltStem = stemOf(c.term); const capCls = (w) => (/^[A-Z]{2,6}$/.test(w) ? 'a' : /^[A-Z]/.test(w) ? 'c' : 'l'); const sufCls = (w) => { const x = w.toLowerCase(); return /(tion|sion|ment|ness|ity|ance|ence)$/.test(x) ? 'n' : /ing$/.test(x) ? 'g' : /ed$/.test(x) ? 'd' : /(es|s)$/.test(x) && !/(ss|us|is)$/.test(x) ? 'p' : /(ic|al|ive|ous|ary|ar)$/.test(x) ? 'j' : 'o'; };
  const pool = [...m.terms.values()].filter((t) => t.word.toLowerCase() !== lt && !antonym(t.word, c.term) && !inSent.has(stemOf(t.word)) && stemOf(t.word) !== ltStem && !lt.includes(t.word.toLowerCase()) && !t.word.toLowerCase().includes(lt) && (/[؀-ۿ]/.test(t.word) === /[؀-ۿ]/.test(c.term)) && capCls(t.word) === capCls(c.term) && (!/^ال/.test(c.term) || /^ال/.test(t.word)) && Math.abs(t.word.length - c.term.length) <= Math.max(3, Math.round(c.term.length * 0.4)));
  const rank = (t) => (sufCls(t.word) === sufCls(c.term) ? 0 : 2) + (t.refs.has(c.ref) ? 0 : 1); const ordered = pick(pool, pool.length, T.seed).sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((t) => t.word);
  if (ordered.length < 3) return null;    // not enough look-alike terms: better no question than a bad one
  const stem = c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length);
  if (wc(stem.replace('____', '')) < 5) return null;
  return T.mk((T.ar ? 'أكمل العبارة حسب المحاضرة: ' : 'Complete the statement from the lecture: ') + stem, c.term, ordered, c, T.note(c.sentence), `مصطلح أساسي في: ${clip(c.sentence, 50)}${tag ? ' (' + c.term + ')' : ''}`);
}
const foreignItems = (m, l, pages) => { const listTok = new Set(E.toks([l.lead, ...l.items].join(' ')));
  return [...new Set(m.lists.filter((x) => x !== l).flatMap((x) => x.items))].filter((it) => !l.items.some((z) => normKey(z) === normKey(it)) && !normKey(pages[l.ref] || '').includes(normKey(it)) && !E.toks(it).some((t) => listTok.has(t)) && !OBJ_VERB.test(it)); };
const FORM = {
  defMeaning(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'defMeaning')[0]; if (!cand) return null; T.take('defMeaning', cand);
    const others = T.byLen(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)), (d) => d.tail, cand.tail.length).slice(0, 8);
    return T.mk(T.ar ? `ما المقصود بـ «${cand.term}» حسب المحاضرة؟` : `According to the lecture, what is "${cand.term}"?`, clip(cand.tail), pick(others, 3, T.seed).map((d) => clip(d.tail)), cand, T.note(cand.sentence), `تعريف ${cand.term}`); },
  defToTerm(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'defToTerm')[0]; if (!cand) return null; T.take('defToTerm', cand);
    const w = pick(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)).map((d) => d.term), 3, T.seed);
    return T.mk(T.ar ? `أي مصطلح يوافق هذا التعريف: «${clip(cand.tail, 140)}»؟` : `Which term matches this definition: "${clip(cand.tail, 140)}"?`, cand.term, w, cand, T.note(cand.sentence), `تمييز مصطلح ${cand.term} من تعريفه`); },
  statement(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'statement')[0]; if (!cand) return null; T.take('statement', cand); const ct = E.toks(cand.tail);
    const others = m.defs.filter((d) => normKey(d.term) !== normKey(cand.term) && normKey(d.tail) !== normKey(cand.tail) && E.jac(E.toks(d.tail), ct) < .5);      // swapped definitions: false, yet taken from the same lecture
    const wrong = pick(T.byLen(others, (d) => d.tail, cand.tail.length).slice(0, 8), 3, T.seed).map((d) => `${cand.term}: ${clip(d.tail, 140)}`);
    return T.mk(T.ar ? `أي العبارات التالية صحيحة عن «${cand.term}» حسب المحاضرة؟` : `Which statement about "${cand.term}" is correct according to the lecture?`, `${cand.term}: ${clip(cand.tail, 140)}`, wrong, cand, T.note(cand.sentence), `عبارة صحيحة عن ${cand.term}`); },
  cloze(T, slot, m) { const c = T.here(m.cloze, 'cloze')[0]; if (c) { T.take('cloze', c); return clozeQ(T, m, c, false); }
    const c2 = T.here(m.cloze2, 'cloze2')[0]; if (!c2) return null; T.take('cloze2', c2); return clozeQ(T, m, c2, true); },
  defCloze(T, slot, m) { const c = T.here(m.defCloze, 'defCloze')[0]; if (!c) return null; T.take('defCloze', c); return clozeQ(T, m, c, true); },
  causeEffect(T, slot, m) { const c = T.here(m.causal, 'causeEffect')[0]; if (!c || m.causal.length < 4) return null; T.take('causeEffect', c);
    const w = pick(T.byLen(m.causal.filter((x) => x.tail !== c.tail), (x) => x.tail, c.tail.length).slice(0, 8), 3, T.seed).map((x) => clip(x.tail, 120));
    return T.mk(T.ar ? `أكمل حسب المحاضرة: ${c.head} ${c.conn} ____` : `Complete according to the lecture: ${c.head} ${c.conn} ____`, clip(c.tail, 120), w, c, T.note(c.sentence), `الأثر الناتج عن: ${clip(c.head, 50)}`); },
  effectCause(T, slot, m) { const c = T.here(m.causal, 'effectCause')[0]; if (!c || m.causal.length < 4) return null; T.take('effectCause', c);
    const w = pick(T.byLen(m.causal.filter((x) => x.head !== c.head), (x) => x.head, c.head.length).slice(0, 8), 3, T.seed).map((x) => clip(x.head, 120));
    return T.mk(T.ar ? `أكمل حسب المحاضرة: ____ ${c.conn} ${c.tail}` : `Complete according to the lecture: ____ ${c.conn} ${c.tail}`, clip(c.head, 120), w, c, T.note(c.sentence), `السبب أو المقدّمة وراء: ${clip(c.tail, 50)}`); },
  numValue(T, slot, m) { const n = T.here(m.nums, 'numValue')[0]; if (!n) return null; T.take('numValue', n); const v = parseFloat(n.val.replace(',', '.')); const same = [...new Set(m.nums.filter((x) => x.unit === n.unit && x.val !== n.val).map((x) => x.val))];
    const fake = [v * 2, v / 2, v * 1.25, v * 0.75, v + 10].map((x) => (Number.isInteger(v) ? String(Math.round(x)) : String(+x.toFixed(1)))).filter((x) => x !== n.val); const w = pick([...same, ...fake], 3, T.seed).map((x) => `${x} ${n.unit}`);
    return T.mk((T.ar ? 'أكمل بالقيمة الصحيحة حسب المحاضرة: ' : 'Select the correct value according to the lecture: ') + n.sentence.replace(n.val, '____'), `${n.val} ${n.unit}`, w, n, T.note(n.sentence), `قيمة رقمية: ${clip(n.sentence, 50)}`); },
  numStatement(T, slot, m) { const n = T.here(m.nums, 'numStatement')[0]; if (!n) return null; T.take('numStatement', n); const v = parseFloat(n.val.replace(',', '.')); const same = [...new Set(m.nums.filter((x) => x.unit === n.unit && x.val !== n.val).map((x) => x.val))];
    const fake = [v * 2, v / 2, v * 1.25, v * 0.75, v + 10].map((x) => (Number.isInteger(v) ? String(Math.round(x)) : String(+x.toFixed(1)))).filter((x) => x !== n.val); const alts = pick([...same, ...fake], 3, T.seed);
    const topic = n.sentence.split(/\s+/).slice(0, 5).join(' ');
    return T.mk(T.ar ? `أي صياغة صحيحة حسب المحاضرة للعبارة التي تبدأ بـ «${topic}»؟` : `Which version of the lecture statement beginning "${topic}" is correct?`, clip(n.sentence, 240), alts.map((x) => clip(n.sentence.replace(n.val, x), 240)), n, T.note(n.sentence), `صياغة صحيحة لعبارة رقمية: ${clip(n.sentence, 50)}`); },
  listNot(T, slot, m, pages) { const l = T.here(m.lists, 'listNot')[0]; if (!l || m.lists.length < 2) return null; T.take('listNot', l);
    const med = l.items.map((x) => wc(x)).sort((a, b) => a - b)[Math.floor(l.items.length / 2)]; const foreign = foreignItems(m, l, pages).sort((a, b) => Math.abs(wc(a) - med) - Math.abs(wc(b) - med));
    if (!foreign.length) return null; const true3 = pick(l.items, 3, T.seed); const key = foreign[0];
    return T.mk(T.ar ? `أي مما يلي ليس من «${clip(strip(l.lead), 80)}»؟` : `Which of the following is NOT among "${clip(strip(l.lead), 80)}"?`, key, true3, l, T.note(l.sentence), `الاستثناء من قائمة: ${clip(l.lead, 50)}`); },
  listBelongs(T, slot, m, pages) { const l = T.here(m.lists, 'listBelongs')[0]; if (!l || m.lists.length < 2) return null; T.take('listBelongs', l);
    const key = l.items[(slot.variant || 0) % l.items.length]; const foreign = foreignItems(m, l, pages).sort((a, b) => Math.abs(wc(a) - wc(key)) - Math.abs(wc(b) - wc(key))); if (foreign.length < 3) return null;
    return T.mk(T.ar ? `أي مما يلي من «${clip(strip(l.lead), 80)}»؟` : `Which of the following is one of "${clip(strip(l.lead), 80)}"?`, key, foreign.slice(0, 3), l, T.note(l.sentence), `عنصر من قائمة: ${clip(l.lead, 50)}`); },
  seqOrder(T, slot, m, pages) { const q = T.here(m.seqs.map((s) => ({ ...s, sentence: s.items.join('|') })), 'seqOrder')[0]; if (!q) return null; T.take('seqOrder', q); const items = q.items.slice(0, 4); const idx = items.map((_, i) => i);
    const shuf = pick(idx, idx.length, T.seed); if (shuf.every((v, i) => v === i)) shuf.push(shuf.shift()); const correct = idx.map((k) => shuf.indexOf(k) + 1); const set = new Set([correct.join(' → ')]);
    for (let t = 1; set.size < 4 && t < 60; t++) set.add(pick(idx.map((i) => i + 1), idx.length, T.seed + t).join(' → ')); if (set.size < 4) return null;
    const first = items[0]; const line = pages[q.ref].split('\n').find((l) => l.includes(first));
    return { slot: slot.slot, unwritable_reason: null, stem: (T.ar ? 'رتّب الخطوات التالية كما وردت في المحاضرة:\n' : 'Put the following steps in the order given in the lecture:\n') + shuf.map((k, n) => `${n + 1}. ${items[k]}`).join('\n'), options: [...set], correct_index: 0,
      explanation: T.ar ? `الترتيب الصحيح هو الوارد في قائمة المحاضرة المرقمة التي تبدأ بـ «${first}».` : `The correct order is the numbered list in the lecture, starting with "${first}".`, purpose: `ترتيب خطوات تبدأ بـ ${clip(first, 40)}`, reasoning_pattern: 'sequence',
      evidence: [{ page: q.ref, quote: (line || first).trim() }], uses_external: false }; },
  seqNext(T, slot, m, pages) { const q = T.here(m.seqs.map((s) => ({ ...s, sentence: s.items.join('|') })), 'seqNext')[0]; if (!q || q.items.length < 3) return null; T.take('seqNext', q); const items = q.items;
    const i = (slot.variant || 0) % (items.length - 1); const key = items[i + 1]; const foreign = m.seqs.filter((x) => x !== q && x.ref !== undefined).flatMap((x) => x.items);
    const wrong = [...items.filter((_, k) => k !== i && k !== i + 1), ...foreign].filter((x) => normKey(x) !== normKey(key) && normKey(x) !== normKey(items[i])); const w = [...new Set(wrong.map((x) => clip(x, 120)))].slice(0, 3); if (w.length < 3) return null;
    const lines = String(pages[q.ref] || '').split('\n').map((x) => x.trim()); const a = lines.find((l) => l.includes(items[i])), b = lines.find((l) => l.includes(key)); if (!a || !b) return null;
    return { slot: slot.slot, unwritable_reason: null, stem: T.ar ? `حسب ترتيب المحاضرة، ما الخطوة التي تأتي مباشرة بعد: «${clip(items[i], 100)}»؟` : `In the order given in the lecture, which step comes right after: "${clip(items[i], 100)}"?`, options: [clip(key, 120), ...w], correct_index: 0,
      explanation: T.ar ? `في القائمة المرقمة بالمحاضرة تأتي «${clip(key, 80)}» مباشرة بعد «${clip(items[i], 80)}».` : `In the lecture's numbered list "${clip(key, 80)}" comes right after "${clip(items[i], 80)}".`, purpose: `الخطوة التالية بعد ${clip(items[i], 40)}`, reasoning_pattern: 'sequence',
      evidence: [{ page: q.ref, quote: a === b ? a : `${a} ${b}` }], uses_external: false }; },
};
/** a question for `slot`, trying the type's forms starting from the slot's variant (variant 0 = the original form) */
function build(slot, m, used, pages) {
  const forms = FORMS[slot.qtype]; if (!forms) return null; const T = toolkit(slot, m, used, pages); const start = (slot.variant || 0) % forms.length;
  for (let k = 0; k < forms.length; k++) { const r = FORM[forms[(start + k) % forms.length]](T, slot, m, pages); if (r) return r; }
  return null;
}

/* The accept step shared by planned slots and the finishing pass: static validation, duplicates, leaks. `base` = questions accepted elsewhere (the AI's), for duplicate context only. */
function session(pagesList, st, plan, base) {
  const pages = Object.fromEntries(pagesList.map((p) => [p.ref, p.text])); const m = mine(pagesList); const used = new Set(); const acc = [], dropped = [];
  const ctx = { pages, field: st.field, language: 'source', allowExternal: false, sourceAr: E.arRatio(pagesList.slice(0, 10).map((p) => p.text).join(' ')) > .4 };
  const stats = { drafted: 0, rejected_validation: 0, rejected_verifier: 0, rejected_duplicate: 0, rejected_leak: 0, unwritable: 0, retries: 0 };
  const take = (s, raw) => { stats.drafted++; const relaxed = !!s.extra;
    const c = { slot: s.slot, qtype: s.qtype, task: null, objective: s.objective, objective_id: s.objective_id, difficulty: s.difficulty, stem: raw.stem, options: raw.options, correct_index: raw.correct_index, explanation: raw.explanation,
      purpose: raw.purpose, reasoning_pattern: raw.reasoning_pattern, evidence: raw.evidence, uses_external: false, extra: relaxed, variant: s.variant || 0, angle: s.angle || null, pk: E.pageKey(s.pages), local: true };
    const v = E.validateQ(c, ctx); let d; const known = base.concat(acc);
    if (v.some((x) => x.severity === 'decisive')) { stats.rejected_validation++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: v.filter((x) => x.severity === 'decisive').map((x) => x.message) }); return false; }
    if ((d = E.dupOf(c, known, relaxed)) != null) { stats.rejected_duplicate++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [`مكرر للسؤال ${d}.`] }); return false; }
    if ((d = E.leaks(c, known, relaxed)) != null) { stats.rejected_leak++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [`يكشف إجابة سؤال آخر (${d}).`] }); return false; }
    c.issues = v.concat([{ code: 'rules_mode', message: 'وُلّد بالقواعد بلا حل مستقل: المشتتات من المصدر نفسه وليست من استدلال نموذج.', severity: 'minor' }]); acc.push(c); return true; };
  return { pages, m, used, acc, dropped, stats, take, base };
}
/* The finishing pass: until `want` is reached, take the page with the FEWEST questions so far and build one more question from it (any type, any unused form), so the lecture stays evenly covered.
 * It stops only when no page can give another question without repeating one. */
function finish(S, pagesList, want, startNo, pool, st) {
  const refs = pagesList.map((p) => p.ref); const dead = new Set(); const total = () => S.base.length + S.acc.length; let no = startNo, v = 0;
  const cnt = (ref) => S.base.concat(S.acc).filter((c) => (c.evidence || []).some((e) => e.page === ref)).length; const obj = (ref) => (pool || []).find((o) => o.pages.includes(ref)) || {};
  for (let guard = 0; total() < want && guard < 6000; guard++) {
    const ref = refs.filter((r) => !dead.has(r)).sort((a, b) => cnt(a) - cnt(b) || E.pn(a) - E.pn(b))[0]; if (!ref) break; let built = false, anyRaw = false;
    for (let k = 0; k < TYPES.length && !built; k++) { const qtype = TYPES[(v + k) % TYPES.length]; const o = obj(ref);
      const s = { slot: no, qtype, pages: [ref], extra: true, variant: v, objective: o.statement || '', objective_id: o.id || '', difficulty: E.difficultyFor(st, qtype), angle: null };
      const raw = build(s, S.m, S.used, S.pages); if (!raw) continue; anyRaw = true; if (S.take(s, raw)) { built = true; no++; } }
    v++; if (!built && !anyRaw) dead.add(ref);
  }
}

/* same contract as E.generate, no LLM. Planned slots first (reinforcement slots use other forms of the same material), then a finishing pass so the requested count is met. */
async function generate(plan, pagesList, st, progress) {
  const S = session(pagesList, st, plan, []); const want = plan.requested || plan.slots.length;
  for (const s of plan.slots) { progress('drafting', Math.round(100 * S.acc.length / Math.max(1, want)));
    const raw = build(s, S.m, S.used, S.pages); if (!raw) { S.stats.unwritable++; S.dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: ['المصدر لا يحوي نمطًا مناسبًا لهذا النوع في الصفحات المحددة (التوليد المحلي).'] }); continue; }
    S.take(s, raw); }
  if (S.acc.length < want) { progress('retrying', Math.round(100 * S.acc.length / Math.max(1, want))); finish(S, pagesList, want, Math.max(0, ...plan.slots.map((s) => s.slot)) + 1, plan.pool, st); }
  if (S.acc.length > want) S.acc.length = want;
  if (S.acc.length >= want) S.dropped.forEach((d) => { d.replaced = true; });      // whatever a planned slot could not give was made up by another question
  return { accepted: S.acc, dropped: S.dropped, stats: S.stats };
}
/* The AI path's last resort: `known` = what the AI delivered; build `missing` more questions locally from any page (never a copy of a known one). */
async function fill(plan, known, missing, pagesList, st, progress) {
  const S = session(pagesList, st, plan, known); const want = known.length + missing; progress('retrying', Math.round(100 * known.length / Math.max(1, want)));
  finish(S, pagesList, want, Math.max(0, ...known.map((c) => c.slot || 0), ...plan.slots.map((s) => s.slot)) + 1, plan.pool, st); return { accepted: S.acc, dropped: S.dropped, stats: S.stats };
}
function cards(pagesList, n) {
  const m = mine(pagesList); const out = [];
  m.defs.forEach((d) => out.push({ front: isAr(d.sentence) ? `ما المقصود بـ «${d.term}»؟` : `What is "${d.term}"?`, back: clip(d.tail, 200), page: d.ref, quote: d.sentence }));
  m.causal.forEach((c) => out.push({ front: isAr(c.sentence) ? `ماذا يحدث عندما: ${c.head}؟` : `What follows when: ${c.head}?`, back: `${c.conn} ${clip(c.tail, 160)}`, page: c.ref, quote: c.sentence }));
  m.lists.forEach((l) => out.push({ front: isAr(l.sentence) ? `اذكر ما يندرج تحت: ${clip(strip(l.lead), 80)}` : `List: ${clip(strip(l.lead), 80)}`, back: l.items.join('، '), page: l.ref, quote: l.sentence }));
  if (out.length < n) m.cloze.forEach((c) => out.push({ front: (isAr(c.sentence) ? 'أكمل: ' : 'Complete: ') + c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length), back: c.term, page: c.ref, quote: c.sentence }));
  return out.slice(0, n);
}
window.QZE.rules = { mine, analyse, profile, generate, fill, cards, diagnose };
})();
