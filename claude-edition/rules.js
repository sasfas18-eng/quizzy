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
const NOT_TERM = /^(lecture|chapter|unit|week|part|section|module|slide|figure|table|note|notes|example|examples|e\.g|i\.e|summary|objectives?|outline|agenda|references?|result|results|conclusions?|definition|key points?|tip|tips|remember|important|answer|question|step|stage|case|overview|introduction|background|abstract|motivation|discussion|related work|future work|acknowledg\w*|appendix|keywords?|general terms|categories|contents|evaluation|methods?|materials|bibliography|المحاضرة|الفصل|الوحدة|الأسبوع|ملاحظة|مثال|أمثلة|ملخص|الأهداف|المراجع|النتيجة|الخلاصة|تعريف|مهم|تذكر|الإجابة|السؤال|الخطوة|المرحلة)\b/i;
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
// a paper's / handout's apparatus is not lecture content: citations ("[12] Gal, A. …"), the references section, copyright and publication lines, addresses, links
const CITE = /^(\[\d{1,3}\]|\d{1,3}\.\s+[A-Z][a-z]+,\s+[A-Z]\.|[A-Z][a-z]+,\s+[A-Z]\.(\s?[A-Z]\.)?,?\s)/;
const REFS_HEAD = /^(references|bibliography|works cited|literature cited|further reading|المراجع|المصادر|قائمة المراجع)\s*:?$/i;
const APPARATUS = /(^(categories and subject descriptors|general terms|keywords|key words|index terms|ccs concepts|received|accepted|published online|corresponding author)\b|permission to make digital|all rights reserved|copyright ©|©\s?\d{4}|proceedings of|isbn|issn|doi:|https?:\/\/|www\.|@[a-z0-9-]+\.(com|edu|org|net)|\{[a-z0-9,.\s]+\}@)/i;
// course logistics (a reading list, office hours, a competition's instructions...) are not lecture content: a page headed like that gives no question
const ADMIN_HEAD = /^(reading assignments?|readings?|homework|assignments?|announcements?|office hours|syllabus|grading|logistics|course (information|info|overview|logistics)|about this course|(.{0,40}\s)?instructions|deadlines?|exam dates?|schedule|القراءات|الواجبات?|الإعلانات|الساعات المكتبية|توزيع الدرجات|تعليمات)\b/i;
// a page whose font was mapped to the wrong letters ("Zith", "anal\sis", "Organi]ed"): letters swapped inside words; its words are not the lecture's words
const scrambled = (text) => { const w = String(text).match(/\S+/g) || []; if (w.length < 30) return false; return w.filter((x) => /\p{Ll}[\\\[\]]|[\\\[\]]\p{Ll}|\p{Ll}[A-Z]\p{Ll}/u.test(x)).length / w.length > 0.06; };
function contentLines(text) {
  const all = parseLines(text); const out = []; let refs = false;
  if (all.length && (ADMIN_HEAD.test(all[0].text) || scrambled(text))) return [];
  for (const l of all) { if (REFS_HEAD.test(l.text)) { refs = true; continue; } if (refs) continue; if (NOT_CONTENT.test(l.text) || CITE.test(l.raw) || APPARATUS.test(l.text)) continue; out.push(l); }
  for (let i = 1; i < out.length; i++) { const l = out[i], prev = out[i - 1], next = out[i + 1];
    const nextItem = [out[i + 1], out[i + 2], out[i + 3]].some((x) => x && (x.bullet || x.num != null)); const cont = !l.bullet && l.num == null && (prev.bullet || prev.num != null) && (/^[a-z(]/.test(l.text) || (nextItem && !l.endsColon && l.words <= 14));
    if (cont) { prev.text = prev.text + ' ' + l.text; prev.raw = prev.raw + ' ' + l.raw; prev.words += l.words; prev.endsSentence = l.endsSentence; prev.endsColon = l.endsColon; out.splice(i, 1); i--; } }
  return all.length >= 4 && all.filter((l) => CITE.test(l.raw)).length >= all.length * 0.4 ? [] : out;      // a page that is mostly citations
}
// not a statement to learn from: a question the slide asks the class ("Q: Why does …?"), or a formula whose symbols the PDF lost ("pruning: , where is an impurity measure")
// talk about the course rather than the subject ("more on other metrics in future lectures", "the picture is like this:")
const META = /\b(future lectures?|next (lecture|class|week|time)|later in (the|this) (course|lecture|class)|more on (this|that|other)|like this\s*:|as follows\s*:|see (below|above)|in this (lecture|class|course)|today we)\b/i;
const sound = (s) => !/[?؟]\s*$/.test(s) && !/^\s*(q|a)\s*[:.)]/i.test(s) && !/\s[,.;:](\s|$)|:\s*,|\(\s*\)/.test(s) && !/\bwhere\s+is\s+(an?|the)\b|,\s*and\s+is\s+the\b/i.test(s) && !/\((19|20)\d{2}[a-z]?\)/.test(s) && !META.test(s);      // nor a reference ("… (1992).")
// a sentence that starts in lower case or with a closing bracket is the second half of something; symbols are not a sentence
const fragment = (s) => /^[a-z)\]},;:.]/.test(s) || /-$/.test(s) || lettersShare(s) < 0.6 || (s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length || /\/\/|[{};=<>]|\b(mov|jmp|ret|int|var|let|const|def|return)\b.*[;(]/.test(s);      // also a line of code
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
const VERB_START = /^(is|are|was|were|be|been|has|have|had|can|could|will|would|may|might|must|should|do|does|did|which|that|who|where|when|while|because|since|so|but|although|though|to|in order|allow|allows|make|makes|provide|provides)\b/i;
const splitList = (s) => { const raw = strip(s).split(/\s*(?:,|،|;|؛|\band\b|\bor\b| و(?=\S))\s*/i).map((x) => x.replace(/^(and|or|و)\s+/i, '').trim()).filter(Boolean); const out = [];
  for (const x of raw) { if (VERB_START.test(x)) break; if (x.length >= 3 && wc(x) <= 6 && /^[\p{L}\p{N}]/u.test(x) && !/[\[\]{}=_;$\/\\]|-$/.test(x) && lettersShare(x) >= 0.6) out.push(x); }
  return out; };

// what is NOT a term to be defined: a pronoun or a clause ("This is…", "They are…", "Since no type information is available…", "After recording is finished…"), a pointer to the
// document itself ("Section 3 is…", "The remainder of this paper is…"), a generic word ("The result is…", "The first step is…"), a citation or a symbol soup
const NOT_TERM_START = /^(this|that|these|those|it|its|there|here|they|them|their|we|our|us|you|your|he|she|his|her|i|one|each|such|which|what|who|whom|whose|another|other|both|all|some|many|most|any|every|none|no|since|after|before|when|whenever|while|if|because|although|though|as|once|until|unless|whether|so|thus|hence|then|also|however|but|and|or|nor|yet|for|in|on|at|by|with|from|to|of|now|today|later|finally|first|second|third|next|last|lastly|meanwhile|instead)\b/i;
const NOT_TERM_ANY = /\b(this|that|these|those|our|its|their|can|could|will|would|may|might|must|should|shall|be|been|being|has|have|had|do|does|did|is|are|was|were|such as|e\.g|i\.e|etc)\b/i;
const DOC_REF = /^(section|chapter|figure|fig|table|equation|eq|appendix|part|page|slide|lecture|paper|article|study|remainder|rest)\b/i;
const GENERIC_HEAD = /\b(step|thing|idea|point|reason|problem|goal|aim|way|part|result|rest|remainder|answer|question|example|case|fact|issue|purpose|key|main|focus|topic|subject|aim)s?$/i;
const PREDICATE_TAIL = /^(described|discussed|shown|presented|given|listed|explained|illustrated|summari[sz]ed|covered|introduced|organi[sz]ed|located|found|considered|available|important|possible|impossible|necessary|required|needed|able|unable|likely|unlikely|true|false|similar|different|due|also|not|still|only|then|now|already|often|usually|always|never|very|too|more|less|much|so|being|done|made|taken|seen|used to|going|about to|driven|given|known|held|kept|left|lost|built|brought|thought|told|written|grown|drawn|chosen|broken|bound|caught|fed|felt|led|met|paid|put|read|said|sent|set|sold|spent|taught|understood|hidden|split|spread|run|won|worn|shut)\b/i;
const lettersShare = (t) => { const s = String(t).replace(/\s+/g, ''); return s.length ? [...s].filter((c) => /\p{L}/u.test(c)).length / s.length : 0; };
function badTerm(term) {
  if (/["“”«»]/.test(term) || /^[A-Z][a-z]+,\s+[A-Z]/.test(term)) return true;      // a reference ("Breiman, Leo. \"Statistical modeling") is not a term
  const t = String(term).trim(); if (!t || t.length < 2) return true;
  if (!/^[\p{L}\p{N}]/u.test(t) || /[\[\]{}<>=|\\@#$^*_~]/.test(t) || /-$/.test(t) || lettersShare(t) < 0.7) return true;      // "guages]", "[2] Mozilla", "{i5, i7}"
  if (/[\u0600-\u06FF]/.test(t)) return wc(t) > 6 || /^(هذا|هذه|ذلك|تلك|هو|هي|هم|هن|نحن|إذا|عندما|لأن|بعد|قبل|ثم)\b/.test(t);
  if (NOT_TERM_START.test(t) || DOC_REF.test(t) || NOT_TERM_ANY.test(t) || wc(t) > 5) return true;
  if (wc(t) === 1 && (E.STOP.has(t.toLowerCase()) || COMMON.has(t.toLowerCase()))) return true;
  if ((GENERIC_HEAD.test(t) && wc(t) <= 3) || /^(goal|aim|purpose|key|main|idea|point|reason|problem|insight|advantage|benefit|drawback|disadvantage|limitation|challenge|difficulty|trick|lesson|observation|contribution|novelty|intuition|catch|downside|upside)\b/i.test(t)) return true;
  if (/^[a-z]/.test(t) && wc(t) > 3) return true;      // a lower-case phrase of four words or more before the colon is a piece of a sentence, not a term
  return false;
}
// "patched so that…" / "necessarily…" / "that if each loop…": a predicate or a clause, not a definition; "Example Tracing Run": a heading
function badTail(tail) {
  const t = String(tail).trim(); const words = (t.match(/[\p{L}]{2,}/gu) || []).length;
  if (words < 3 || lettersShare(t) < 0.6 || /-$/.test(t)) return true;      // symbols, a cut line
  if (!/[\u0600-\u06FF]/.test(t)) { if (PREDICATE_TAIL.test(t) || /^[a-z]+(ed|ly)\b/.test(t) || /^(that|which|who|whom|whose|if|whether|to|because|when|where|how|why|what|so|but|and|or|then|thus)\b/i.test(t)) return true; const ws = t.split(/\s+/); if (ws.length <= 6 && ws.every((w) => /^[A-Z0-9]/.test(w))) return true; }      // "described in Section 6"; a Title Case heading ("Example Tracing Run")
  return false;
}
function defFromLine(l) {
  if (l.endsSentence && l.words > 25) return null;
  if (OBJ_VERB.test(l.text) || !sound(l.text)) return null;
  const m = l.text.match(SEP_DEF) || l.text.match(DASH_DEF); if (!m) return null;
  const term = m[1].trim(), tail = strip(m[2]);
  if (wc(term) > 6 || wc(tail) < 3 || NOT_TERM.test(term) || /^\d+$/.test(term) || /[.!?؟]$/.test(term) || /\d\s*$/.test(term) || badTerm(term) || badTail(tail)) return null;
  return { term, tail, sentence: l.raw, unit: l.text };
}
// the evidence of a list: its heading and the items right under it, stopping at a reference line, so the quote stays word-for-word what the page shows
const citeLine = (x) => /\b(19|20)\d{2}\b|\bet al\b/.test(x.raw);
const listQuote = (h, items) => { const run = []; let i = 0; while (i < items.length && citeLine(items[i])) i++; for (; i < items.length && run.length < 3 && !citeLine(items[i]); i++) run.push(items[i].raw);
  return (citeLine(items[0] || { raw: '' }) ? run : [h.raw, ...run]).join(' '); };      // a reference right under the heading: the quote is the items after it
function mineLists(lines) {
  // a slide whose title came out last (some exporters write it after the bullets): bullets only, then one short plain line -> that line leads
  const last = lines[lines.length - 1];
  if (lines.length >= 4 && last && !last.bullet && last.num == null && last.words <= 8 && !last.endsSentence && lines.slice(0, -1).every((l) => l.bullet)) lines = [last, ...lines.slice(0, -1)];
  const out = []; const prose = lines.filter((l) => l.words >= 14).length >= 3;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i];
    if (h.bullet || h.words > 10 || h.endsSentence || h.words < 1 || NOT_HEADING.test(h.text) || NOT_TERM.test(h.text) || defFromLine(h)) continue;
    const items = []; let j = i + 1;
    while (j < lines.length && items.length < 10) {
      const l = lines[j]; const itemLike = l.num == null && !NOT_HEADING.test(l.text) && (l.bullet || (l.words <= 10 && !l.endsSentence && !l.endsColon));
      if (!itemLike) break; items.push(l); j++;
    }
    const titleLike = i === 0 && !prose;     // slide title followed by short lines: PPTX paragraphs carry no bullet characters (a page of running text is not a slide: its first line may be a figure label)
    if (items.length >= 3 && (items.some((x) => x.bullet) || h.endsColon || titleLike) && !items.some((x) => defFromLine(x)) && items.filter((x) => OBJ_VERB.test(x.text)).length < Math.ceil(items.length / 2)) {
      const clean = items.map((x) => { const t = strip(x.text); const m = t.match(/^(.{3,40}?)\s*[:：–—-]\s+/); return clip(m && wc(m[1]) <= 5 ? m[1] : t, 80); }).filter((t) => t.length >= 3 && wc(t) <= 9);
      const tidy = clean.filter((t) => !/[\[\]{}=_;$\\]|-$|(?<!\p{L})\/|\/(?!\p{L})/u.test(t) && lettersShare(t) >= 0.7 && /\p{L}{3}/u.test(t) && !fragment(t.replace(/^[a-z]/, (c) => c.toUpperCase())) && (t.match(/\(/g) || []).length === (t.match(/\)/g) || []).length && !/[\u{1D400}-\u{1D7FF}∑∫√≤≥]/u.test(t) && !/\b(19|20)\d{2}\b|\bet al\b|\bpp?\.\s*\d/.test(t) && !/\b(with|and|or|of|the|to|for|in|by|from|a|an)$/i.test(t.replace(/[.,;:…]+$/, '')));      // no reference, table row, formula or cut-off fragment
      if (tidy.length >= 3 && !/[_{}=<>\/\\$]/.test(h.text) && (lettersShare(h.text) >= 0.6 || /^\p{L}[\p{L}\p{N}.\-]{1,15}$/u.test(h.text))) out.push({ lead: strip(h.text), items: tidy.slice(0, 8), sentence: listQuote(h, items) });
      i = j - 1;
    }
  }
  return out;
}
function mineSeqs(lines) {
  const out = []; let run = [];
  const flush = () => { if (run.length >= 3) out.push(run.slice(0, 5)); run = []; };
  lines.forEach((l) => { if (l.num != null && l.words >= 2 && (run.length === 0 ? l.num === 1 : l.num === run.length + 1)) run.push(l.text); else flush(); });
  flush(); return out;
}

// ---------------------------------------------------------------- key terms (for fill-in-the-blank)
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
function docFreq(pagesList) { const df = new Map(); pagesList.forEach((p) => new Set((p.text.toLowerCase().match(WORD_RE) || [])).forEach((w) => df.set(w, (df.get(w) || 0) + 1))); return df; }
function termScore(w, idx, df) {
  const lw = w.toLowerCase(); if (E.STOP.has(lw) || COMMON.has(lw) || /^(complete|statement|lecture|according)$/.test(lw) || /^\d+$/.test(w) || (/ly$/.test(lw) && lw.length > 5)) return -1;
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
// ---------------------------------------------------------------- the lecture's OWN language model (no AI, built from the lecture only)
// What a good question needs and a rule list cannot give: which phrases are the lecture's key concepts, how important each sentence is, and which OTHER phrases of the lecture
// are close enough to a concept to make a plausible wrong option (another organelle, another pressure, another enzyme - not a random word). Built per lecture in ~1 s:
//  1) key phrases (RAKE-style: runs of content words between function words/punctuation, scored by word degree/frequency, repetition, capitalisation, position in a definition)
//  2) each phrase gets a context vector (the content words around its occurrences, the words right before/after it, its page) - the lecture's own distributional meaning
//  3) sentence importance = its best phrases + definition/number/cause cues + position - used to ask about the important sentences first
const FUNC_EN = new Set(('the a an of in on to and or is are was were be been being by for with as at from that this these those it its which what how why when where who whom whose can may will would should could might must shall has have had do does did not no nor but if then than so such also more most other another each both either neither into onto between among during through over under about above below after before their them they we our us you your he she his her there here one two three using used use because however while whether per via within without across along upon toward towards against around among sometimes often usually typically generally normally currently finally mostly rarely frequently occasionally although though despite however whereas while since minus plus versus via upon onto beyond except toward near inside outside throughout regarding together whereas unless until once thus hence therefore very much many some any all only just even still yet already often usually always never really mainly mostly highly directly several various certain general specific different similar following important increase increases decrease decreases require requires required produce produces produced create creates created allow allows allowed cause causes caused make makes made take takes taken give gives given help helps helped need needs needed show shows shown include includes included involve involves involved occur occurs occurred lead leads led result results resulted provide provides provided contain contains contained known called based well both able like get gets got let see seen').split(' '));
const FUNC_AR = new Set('في من على إلى عن مع هو هي هم هن هذا هذه ذلك تلك التي الذي الذين ما ماذا كيف لماذا متى أين من أو و ثم قد كان كانت يكون تكون هنا هناك كل بعض أي بين خلال بعد قبل عند عندما لأن إن أن لا لم لن لكن بل حتى إذا إذ كما أيضا فقط جدا يتم تتم يمكن لا ليس غير عدة نحو حول ضمن عبر لدى لها له به بها فيه فيها منه منها إليه إليها'.split(' '));
const isFunc = (w) => FUNC_EN.has(w) || FUNC_AR.has(w) || E.STOP.has(w);
const isArW = (w) => /[؀-ۿ]/.test(w);
const VERBS = new Set(('depend pump cause lead contain consist occur produce provide allow require involve include move flow carry control regulate increase decrease form help make give show use become remain create convert transport store release bind activate inhibit stimulate reduce raise enter leave pass cross generate maintain support prevent protect determine represent describe define explain affect change keep hold send receive exist appear happen begin start stop end follow connect separate combine divide split transfer travel enable ensure perform apply select compare measure detect respond react transform proceed present exhibit display suggest indicate report observe note mean imply pass close fall offer sense adjust constrict dilate preserve filter deliver excrete secrete absorb diffuse transmit conduct emit propagate fire relax contract bind dissociate synthesize degrade metabolize digest oxidize reduce phosphorylate express encode replicate transcribe translate infect invade attack destroy repair heal grow divide mutate evolve adapt survive spread influence trigger signal sustain depend decrease drop climb rise decline remain stay shift swap hide expose cover fill empty open close build develop grow reach contribute depend rely vary differ equal exceed contain surround attach bring take put get set run work read write record compile execute call return store load map match check test fail succeed run').split(' '));
const verbForm = (lw) => VERBS.has(lw) || VERBS.has(lw.replace(/(es|s|ed|ing)$/, '')) || VERBS.has(lw.replace(/ies$/, 'y')) || VERBS.has(lw.replace(/(ed|ing)$/, 'e')) || (/(ed|ly)$/.test(lw) && lw.length > 5);
const MODAL = new Set('can could may might will would shall should must do does did to not'.split(' '));
const GENERIC_PHRASE = /^(?:\d+|complete|completes|statement|lecture|according|first|second|third|new|good|bad|high|low|large|small|long|short|same|different|main|key|basic|simple|common|major|possible|available|important|total|full|certain|particular|special|real|actual|whole|entire|number|type|types|kind|way|ways|case|cases|time|times|part|parts|level|levels|form|forms|set|sets|group|groups|area|areas|process|system|systems|example|examples|result|results|use|value|values|problem|work|thing|things|fact|point|order|rate|amount|figure|section|paper|work|approach|method|idea)$/i;
function tokensOf(sentence) { const out = []; let m; WORD_RE.lastIndex = 0; while ((m = WORD_RE.exec(sentence))) { const raw = m[0].replace(/['’-]+$/, ''); out.push({ w: raw, lw: raw.toLowerCase(), i: m.index, e: m.index + raw.length }); } return out; }
/** key-phrase candidates of one sentence: [{ text, lw, i, e, toks }] (runs of content words, at most 4 words, no punctuation inside) */
function phraseCandidates(sentence) {
  const toks = tokensOf(sentence), out = []; let run = [];
  const DET = new Set('the a an its their this that these those both all each every some any no'.split(' '));
  const verbS = (t) => !isArW(t.w) && t.w.length > 4 && /[^s]s$/.test(t.lw) && !/(ss|us|is|ics|ous|ness|sis)$/.test(t.lw) && !/^[A-Z]/.test(t.w);      // "offers", "senses", "adjusts": a 3rd-person verb in a run of nouns
  const flush = (next) => {
    if (!run.length) return; let subs = [[]];
    run.forEach((t, k) => { if (k < run.length - 1 && verbS(t)) subs.push([]); else subs[subs.length - 1].push(t); });      // a verb inside the run splits it (and is dropped)
    const last = subs[subs.length - 1]; if (last.length && verbS(last[last.length - 1]) && next && DET.has(next.lw)) last.pop();      // "... densa senses the ..." : the run ends before its verb
    subs.filter((r) => r.length).forEach((r0) => { const parts = r0.length <= 4 ? [r0] : r0.reduce((a, _, k) => (k + 3 <= r0.length ? [...a, r0.slice(k, k + 3)] : a), []); parts.forEach((r) => out.push({ toks: r, text: sentence.slice(r[0].i, r[r.length - 1].e), lw: r.map((t) => t.lw).join(' '), i: r[0].i, e: r[r.length - 1].e })); });
    run = [];
  };
  toks.forEach((t, k) => {
    const prev = toks[k - 1]; const gap = prev ? sentence.slice(prev.e, t.i) : '';
    const letters = [...t.w].filter((c) => /\p{L}/u.test(c)).length;
    const isV = !isArW(t.w) && (verbForm(t.lw) && !/^[A-Z]/.test(t.w) || (prev && MODAL.has(prev.lw)));      // a verb (or what follows "can/to/does…") ends the run: phrases are nouns and adjectives
    const bad = isFunc(t.lw) || isV || /^\d/.test(t.w) || letters < 3 || /^[A-Z]$/.test(t.w);
    if (bad || (prev && /[,;:.()!?؟،؛—–"“”«»]/.test(gap))) flush(bad ? t : null);
    if (!bad) run.push(t);
  });
  flush(null); return out.filter((c) => !GENERIC_PHRASE.test(c.lw) && c.toks.every((t) => !/_/.test(t.w)) && !GENERIC_PHRASE.test(c.toks[c.toks.length - 1].lw));
}
function buildModel(units0, defs) {
  const seenS = new Set(), units = units0.filter((u) => { const k = u.s.toLowerCase(); if (seenS.has(k)) return false; seenS.add(k); return true; });      // the same sentence on many pages is a template line, not a fact
  const pageCount = new Set(units.map((u) => u.ref)).size;
  const sents = units.map((u, idx) => ({ ...u, idx, cands: phraseCandidates(u.s), toks: tokensOf(u.s) }));
  // RAKE word scores: degree / frequency over all candidate phrases of the lecture
  const freq = new Map(), deg = new Map();
  sents.forEach((st) => st.cands.forEach((c) => c.toks.forEach((t) => { freq.set(t.lw, (freq.get(t.lw) || 0) + 1); deg.set(t.lw, (deg.get(t.lw) || 0) + c.toks.length); })));
  const wscore = (lw) => (deg.get(lw) || 1) / (freq.get(lw) || 1);
  const termSet = new Set(defs.map((d) => d.term.toLowerCase()));
  // phrase table (merged by lower-case text)
  const table = new Map();
  sents.forEach((st) => st.cands.forEach((c) => {
    let e = table.get(c.lw); if (!e) { e = { lw: c.lw, text: c.text, n: 0, refs: new Set(), ctx: new Map(), cap: 0, words: c.toks.length, sents: new Set() }; table.set(c.lw, e); }
    e.n++; e.refs.add(st.ref); e.sents.add(st.idx); if (/^[A-Z]/.test(c.text) && c.i > 0) e.cap++; if (/^[A-Z]/.test(c.text) && c.text === c.text.toUpperCase()) e.cap += 1;
    const bump = (k, w = 1) => e.ctx.set(k, (e.ctx.get(k) || 0) + w);
    const inside = new Set(c.toks.map((t) => t.lw)); st.toks.forEach((t) => { if (!isFunc(t.lw) && !inside.has(t.lw) && t.w.length > 2) bump('w:' + t.lw); });
    const before = st.toks.filter((t) => t.e <= c.i).pop(), after = st.toks.find((t) => t.i >= c.e); if (before) bump('L:' + before.lw, 2); if (after) bump('R:' + after.lw, 2); bump('p:' + st.ref, 1.5);
  }));
  const allWords = new Set(); sents.forEach((st) => st.toks.forEach((t) => allWords.add(t.lw)));
  const plural = (w) => !isArW(w) && /[^s]s$/.test(w) && !/(ss|us|is|ics|ous|ness|sis)$/.test(w);
  const unattested = (e) => { const last = e.lw.split(' ').pop(); return plural(last) && !allWords.has(last.replace(/(ie)?s$/, (m) => (m === 'ies' ? 'y' : ''))) && !allWords.has(last.replace(/es$/, '')) && e.n < 2; };
  // a concept is a short phrase the lecture RETURNS to (RAKE alone prefers long one-off strings)
  table.forEach((e) => { e.verbish = unattested(e); e.score = e.lw.split(' ').reduce((a, w) => a + wscore(w), 0) / Math.sqrt(e.words) * (1 + 0.6 * Math.log(e.n)) * (e.words >= 2 && e.words <= 3 ? 1.2 : e.words > 3 ? 0.75 : 1) * (e.cap ? 1.25 : 1) * (termSet.has(e.lw) ? 1.4 : 1) * (e.words >= 2 ? 1.15 : 1) * (pageCount >= 4 && e.refs.size > pageCount * 0.5 ? 0.3 : 1) * (e.verbish ? 0.55 : 1); let nn = 0;      // a phrase on most pages of the file is the subject of the whole course, not a concept to ask about
   e.ctx.forEach((v) => { nn += v * v; }); e.norm = Math.sqrt(nn) || 1; });
  const maxScore = Math.max(1, ...[...table.values()].map((e) => e.score));
  const cos = (a, b) => { let dot = 0; const [small, big] = a.ctx.size <= b.ctx.size ? [a, b] : [b, a]; small.ctx.forEach((v, k) => { const o = big.ctx.get(k); if (o) dot += v * o; }); return dot / (a.norm * b.norm); };
  const bigrams = new Set(); sents.forEach((st) => st.toks.forEach((t, k) => { if (k) bigrams.add(st.toks[k - 1].lw + ' ' + t.lw); }));
  return { sents, table, cos, maxScore, wscore, bigrams };
}
/** how important a sentence is for the lecture, 0..~3: its best phrases + the cues of a fact (definition, number, cause) + its place on the page */
function sentenceImportance(M, st, extra) {
  const sc = st.cands.map((c) => (M.table.get(c.lw) || { score: 0 }).score).sort((a, b) => b - a); const top = ((sc[0] || 0) + 0.6 * (sc[1] || 0) + 0.3 * (sc[2] || 0)) / M.maxScore;
  const w = st.toks.length; const lenOk = w >= 9 && w <= 28 ? 0.3 : w < 7 || w > 40 ? -0.4 : 0;
  return top + lenOk + (extra || 0);
}
/** wrong options for a blank: the lecture's OTHER phrases that behave like the answer (similar surroundings) and look like it (length, words, capitalisation, a/an), never in the sentence itself */
function phraseDistractors(M, ans, sentence, ref, used) {
  const A = M.table.get(ans.toLowerCase()); if (!A) return null;
  const stemWords = new Set(tokensOf(sentence).map((t) => t.lw)); const ansToks = ans.toLowerCase().split(' '); const ansStem = (w) => w.replace(/(ies|es|s|ing|ed)$/, '');
  const cap = (t) => (/^[A-Z]{2,6}$/.test(t) ? 'a' : /^[A-Z]/.test(t) ? 'c' : 'l');
  const before = sentence.slice(0, Math.max(0, sentence.toLowerCase().indexOf(ans.toLowerCase()))).trim().split(/\s+/).pop() || '';
  const afterTxt = (sentence.slice(sentence.toLowerCase().indexOf(ans.toLowerCase()) + ans.length).trim().split(/\s+/)[0] || '').toLowerCase();
  const agree = /^(is|was|has|does)$/.test(afterTxt) || (/[^s]s$/.test(afterTxt) && !/(ss|us|is|ics|ous)$/.test(afterTxt) && afterTxt.length > 4 && !isFunc(afterTxt)) ? 'sg' : /^(are|were|have|do)$/.test(afterTxt) ? 'pl' : ''; const ansLast = ans.toLowerCase().split(' ').pop(); const ansPlural = /[^s]s$/.test(ansLast) && !/(ss|us|is|ics|ous)$/.test(ansLast);
  const at = sentence.toLowerCase().indexOf(ans.toLowerCase()); const lw0 = (tokensOf(sentence.slice(0, at)).pop() || {}).lw || '', rw0 = (tokensOf(sentence.slice(at + ans.length))[0] || {}).lw || '';
  const need = /^an?$/i.test(before) ? (before.toLowerCase() === 'an' ? 'v' : 'c') : '';
  const list = [];
  M.table.forEach((e) => {
    if (e === A || e.words > A.words + 1 || e.words < Math.max(1, A.words - 1)) return; if (isArW(e.text) !== isArW(ans)) return;
    const toks = e.lw.split(' '); if (toks.some((w) => stemWords.has(w)) || toks.some((w) => ansToks.some((a) => ansStem(a) === ansStem(w))) || e.lw.includes(A.lw) || A.lw.includes(e.lw)) return;
    if (/^[A-Z]/.test(ans) && !/^[A-Z]/.test(e.text) && A.words === 1) { /* a capitalised answer: prefer capitalised ones (ranked below) */ }
    if (need && ((need === 'v') !== /^[aeiou]/i.test(e.text))) return; if (antonym(e.text, ans)) return;
    const lenR = Math.min(e.text.length, ans.length) / Math.max(e.text.length, ans.length); if (lenR < 0.45) return;
    if ((lw0 && M.bigrams.has(lw0 + ' ' + toks[0])) || (rw0 && M.bigrams.has(toks[toks.length - 1] + ' ' + rw0))) return;      // if the lecture itself says "<word before the blank> <this option>" or "<this option> <word after>", it may be a correct completion too
    const lastW = e.lw.split(' ').pop(), plu = /[^s]s$/.test(lastW) && !/(ss|us|is|ics|ous)$/.test(lastW);
    if (agree === 'sg' && plu && !ansPlural) return; if (agree === 'pl' && !plu && ansPlural) return;      // "The ____ is …": no plural option; "The ____ are …": no singular one
    const suf = (w) => (/(tion|sion|ment|ness|ity|ance|ence)$/.test(w) ? 'n' : /ing$/.test(w) ? 'g' : /ed$/.test(w) ? 'd' : /(ic|al|ive|ous|ary|ar)$/.test(w) ? 'j' : 'o');
    const sim = M.cos(A, e) + (suf(lastW) === suf(ansToks[ansToks.length - 1]) ? 0.12 : 0); const same = e.refs.has(ref) ? 0.05 : 0; const capOk = cap(e.text.split(' ')[0]) === cap(ans.split(' ')[0]) ? 0.12 : 0;
    list.push({ e, rank: sim + 0.25 * lenR + same + capOk + 0.04 * Math.min(3, Math.log(1 + e.n)) });
  });
  list.sort((a, b) => b.rank - a.rank);
  const out = []; for (const { e } of list) { if (out.length >= 3) break; if (out.some((o) => o.lw.split(' ').some((w) => e.lw.split(' ').includes(w)))) continue; if (used && used.has(e.lw) && list.length > 8) continue; out.push(e); }
  return out.length >= 3 ? out.map((e) => e.text) : null;
}
// ---------------------------------------------------------------- the four types that need more than a definition: contrast, best answer, scenario, critical reading
// Each is mined from sentences that VISIBLY have the shape (a contrast between two subjects, a superlative, a condition and its result, a caution) - the same miners
// feed the analysis ("does this section support the type, and how many questions?") and the questions, so what is announced is exactly what can be asked.
const CONTRAST_EN = /^(.{14,170}?),?\s+(whereas|while|unlike|but|in contrast(?: to| with)?)\s+(.{14,170})$/i;
const CONTRAST_AR = /^(.{10,150}?)،?\s+(بينما|في حين|على عكس|بخلاف)\s+(.{10,150})$/;
function parseContrast(s) {
  const mm = s.match(CONTRAST_EN) || s.match(CONTRAST_AR); if (!mm) return null; const left = mm[1], conn = mm[2], right = mm[3].replace(/[.؟!]+$/, '');
  const subj = (clause) => phraseCandidates(clause).find((c) => c.i <= 14 && !/^(this|that|it|they)$/i.test(c.lw)) || null; const a = subj(left), b = subj(right); if (!a || !b) return null;
  if (a.lw === b.lw || a.lw.includes(b.lw) || b.lw.includes(a.lw)) return null;
  const predL = left.slice(a.e).trim(), predR = right.slice(b.e).trim(); if (wc(predL) < 3 || wc(predR) < 3 || E.jac(E.toks(predL), E.toks(predR)) > 0.6 || /^[,;:]/.test(predL + predR)) return null;
  const content = (t) => new Set(tokensOf(t).map((x) => x.lw).filter((w) => !isFunc(w) && w.length > 3)); const cl = content(predL), cr = content(predR); const shared = [...cl].filter((w) => cr.has(w)).length;      // two parallel clauses share words (has/wall/pumps/blood...), two unrelated clauses do not
  if (a.toks.length > 3 || b.toks.length > 3 || shared < (/^but$/i.test(conn) ? 3 : /^while$/i.test(conn) ? 2 : 0)) return null;      // "while"/"but" also join unrelated clauses: those need a shared skeleton; "unlike"/"whereas"/"بينما" are contrast markers by themselves
  return { a: a.text, b: b.text, preL: left.slice(0, a.i), preR: right.slice(0, b.i), predL, predR, conn, text: s.replace(/[.؟!]+$/, '') };
}
const BEST_CUE = /\b(most (?:common|important|appropriate|likely|effective|significant|useful)|main (?:cause|reason|site|function|role|source|type|mechanism|treatment|determinant|regulator)s?|primary|principal|first[- ]line|preferred|predominant|الأهم|الأكثر|الرئيسي|الأنسب)\b/i;
const COND_EN = /^(?:if|when|whenever|once|in (?:patients?|cases?|people|individuals|those)(?: with| who| where| of)?|patients? (?:with|who))\s+(.{8,130}?),\s*(?:then\s+)?(.{10,160})$/i;
const COND_AR = /^(?:إذا|عندما|عند|في حالة|لدى)\s+(.{8,120}?)،\s*(.{10,150})$/;
const CRIT_CUE = /\b(limitations?|drawbacks?|disadvantages?|caveats?|trade-?offs?|however|but not|at the cost of|only if|unless|risks? of|side effects?|contraindicat\w*|عيوب|عيب|قيد|محدودية|تحفظ|غير أن|إلا أن)\b/i;
function mineSpecial(s, ref, out) {
  let m;
  const c = parseContrast(s); if (c) out.contrasts.push({ ref, sentence: s, ...c });
  if ((m = s.match(COND_EN) || s.match(COND_AR))) { const cond = strip(m[1]), res = strip(m[2]); if (wc(cond) >= 3 && wc(res) >= 3 && !/^(it|this|that|there|both|these|those|such|they|the same|the call|the system|the latter|the former)\b/i.test(cond) && tokensOf(cond).filter((t) => !isFunc(t.lw) && t.w.length > 3).length >= 2 && !fragment(res.replace(/^[a-z]/, (x) => x.toUpperCase()))) out.conds.push({ ref, sentence: s, cond, res }); }
  const w = wc(s);
  if (CRIT_CUE.test(s) && w >= 9 && w <= 40 && !OBJ_VERB.test(s) && !c && !/^(it|this|these|those|they|thus|hence|therefore|since|although|that|there|here|then|also|but|and|so|we|our)\b/i.test(s)) { const top = phraseCandidates(s).filter((p) => p.toks.length <= 3)[0]; if (top) out.critics.push({ ref, sentence: s, claim: strip(s), topic: top.text }); }
}
// distractor pool = the best key term of each sentence (+ one-word definition terms): content words, not verbs/adverbs
function addTerm(out, word, ref) { const k = word.toLowerCase(); if (!out.terms.has(k)) out.terms.set(k, { word, refs: new Set() }); out.terms.get(k).refs.add(ref); }
function mine(pagesList) {
  const df = docFreq(pagesList); const out = { defs: [], causal: [], nums: [], lists: [], seqs: [], cloze: [], cloze2: [], defCloze: [], terms: new Map(), contrasts: [], bests: [], conds: [], critics: [] }; const allUnits = [];
  for (const p of pagesList) {
    const lines = contentLines(p.text); const units = [];
    lines.forEach((l) => {
      const d = defFromLine(l); if (d) out.defs.push({ ref: p.ref, ...d });
      splitSentences(l.text).forEach((s) => { if (wc(s) >= 5 && !fragment(s) && sound(s)) { units.push(s); if (l.num == null && tokensOf(s).some((t) => isFunc(t.lw) || /ing$|ed$/.test(t.lw))) allUnits.push({ ref: p.ref, s }); } });      // a numbered step is a procedure (a sequence), not a fact to blank
    });
    units.forEach((s) => { let m;
      if (!out.defs.some((d) => d.unit === s || d.sentence === s) && !OBJ_VERB.test(s) && (m = s.match(DEF_EN) || s.match(DEF_AR))) { const term = m[1].trim().replace(/^(The|A|An)\s+/i, ''), tail = strip(m[3]); if (!badTerm(term) && !badTail(tail)) out.defs.push({ ref: p.ref, term, tail, sentence: s, unit: s }); }
      if ((m = s.match(CAUSE)) && !/\b(that|which|who|to|can|could|may|might|will|would|not|also|often|and|or)$/i.test(m[1].trim()) && !NOT_TERM_START.test(m[1].trim()) && !DOC_REF.test(m[1].trim()) && wc(m[1]) <= 16 && !/^(of|for|in|on|to|and|or|that|which|by|with|as|from|at|between|among|the same)\b/i.test(strip(m[3])) && !/\b(common|main|major|primary|principal|leading|root|underlying|possible|likely|known|only|other|another|one|first|second|third)$/i.test(m[1].trim())) out.causal.push({ ref: p.ref, head: m[1].trim(), conn: m[2], tail: strip(m[3]), sentence: s });      // "…the conditions that cause…" is a relative clause, not a cause
      if ((m = s.match(NUM)) && !/[\p{L}\d.]/u.test(s[m.index - 1] || '') && !/\p{L}/u.test(s[m.index + m[0].length] || '')) out.nums.push({ ref: p.ref, val: m[1], unit: m[2], sentence: s });
      if ((m = s.match(LIST_EN) || s.match(LIST_AR))) { const items = splitList(m[2]), lead = strip(m[1].trim()); if (items.length >= 3 && wc(lead) >= 1 && !NOT_TERM_START.test(lead) && !VERB_START.test(lead) && /^[\p{L}\p{N}]/u.test(lead)) out.lists.push({ ref: p.ref, lead, items, sentence: s }); }
      mineSpecial(s, p.ref, out);
      const w = wc(s);
      if (w >= 7 && w <= 35 && !OBJ_VERB.test(s)) { const c = candidates(s, df).sort((a, b) => b.score - a.score); if (c.length && c[0].score >= 1.6 && c[0].word.length >= 6) { out.cloze.push({ ref: p.ref, sentence: s, term: c[0].word, index: c[0].index }); addTerm(out, c[0].word, p.ref);
        c.slice(1, 3).filter((x) => x.score >= 1.2 && x.word.length >= 6).forEach((x) => out.cloze2.push({ ref: p.ref, sentence: s, term: x.word, index: x.index })); } }
    });
    mineLists(lines).forEach((l) => out.lists.push({ ref: p.ref, ...l }));
    mineSeqs(lines).forEach((items) => out.seqs.push({ ref: p.ref, items }));
  }
  // the lecture's own language model: key phrases for the blanks (instead of one lone word), plausible distractors, and the important sentences first
  if (allUnits.length >= 4) {
    const M = buildModel(allUnits, out.defs); out.model = M; const imp = new Map(M.sents.map((st) => [st.s, sentenceImportance(M, st, 0)]));
    const phraseOf = (st, skip) => { const best = st.cands.filter((c) => { const e = M.table.get(c.lw); return e && e.score >= 0.18 * M.maxScore && (e.words >= 2 || c.lw.length >= 6) && !/^[A-Z]{1,2}$/.test(c.text) && !skip.has(c.lw); })
        .filter((c) => { const rest = st.s.slice(0, c.i) + ' ' + st.s.slice(c.e); const restW = new Set(tokensOf(rest).map((t) => t.lw.replace(/(ies|es|s)$/, ''))); return wc(rest) >= 5 && st.s.toLowerCase().split(c.lw).length === 2 && c.toks.every((t) => !restW.has(t.lw.replace(/(ies|es|s)$/, ''))); })
        .sort((a, b) => M.table.get(b.lw).score - M.table.get(a.lw).score); return best; };
    const ph1 = [], ph2 = [];
    M.sents.forEach((st) => { const w = st.toks.length; if (w < 7 || w > 35 || OBJ_VERB.test(st.s)) return; const c = phraseOf(st, new Set());
      if (c.length) { ph1.push({ ref: st.ref, sentence: st.s, term: c[0].text, index: c[0].i, phrase: true, imp: imp.get(st.s) }); addTerm(out, c[0].text, st.ref);
        c.slice(1).filter((x) => !x.lw.split(' ').some((w2) => c[0].lw.split(' ').includes(w2))).slice(0, 2).forEach((x) => ph2.push({ ref: st.ref, sentence: st.s, term: x.text, index: x.i, phrase: true, imp: imp.get(st.s) - 0.3 })); } });
    M.sents.forEach((st) => { const cue = st.s.match(BEST_CUE); if (!cue || st.toks.length < 8 || st.toks.length > 35 || OBJ_VERB.test(st.s)) return; const after = phraseOf(st, new Set()).filter((c) => c.i >= cue.index + cue[0].length - 1);
      const pick1 = after[0] || null; if (pick1) out.bests.push({ ref: st.ref, sentence: st.s, term: pick1.text, index: pick1.i, phrase: true, cue: cue[0], imp: imp.get(st.s) }); });
    if (ph1.length >= 4) { const have = new Set(ph1.map((c) => c.sentence)); out.cloze.filter((c) => !have.has(c.sentence)).forEach((c) => ph1.push({ ...c, imp: (imp.get(c.sentence) || 0) - 0.2 })); out.cloze = ph1; out.cloze2 = [...ph2, ...out.cloze2.map((c) => ({ ...c, imp: (imp.get(c.sentence) || 0) - 0.5 }))]; }
    out.critics.forEach((c) => { const best = phraseCandidates(c.sentence).filter((x) => x.toks.length <= 3 && M.table.get(x.lw)).sort((a, b) => M.table.get(b.lw).score - M.table.get(a.lw).score)[0]; if (best) c.topic = best.text; });
    // the important sentences first: the builders take the first unused item of a page, so the order IS the priority
    const byImp = (a, b) => (b.imp || 0) - (a.imp || 0); const tag = (arr, extra) => arr.forEach((x) => { x.imp = (imp.get(x.sentence) ?? 0) + extra; });
    out.keyConcepts = new Set([...M.table.values()].filter((e) => e.score >= 0.3 * M.maxScore).sort((a, b) => b.score - a.score).slice(0, 60).map((e) => e.lw));
    const special = new Set([...out.contrasts, ...out.conds, ...out.critics, ...out.bests].map((x) => x.sentence)); out.cloze.forEach((c) => { if (special.has(c.sentence)) c.imp = (c.imp || 0) - 0.7; }); out.cloze2.forEach((c) => { if (special.has(c.sentence)) c.imp = (c.imp || 0) - 0.7; });
    tag(out.defs, 0.9); tag(out.causal, 0.5); tag(out.nums, 0.4); tag(out.lists, 0.3); out.defs.sort(byImp); out.causal.sort(byImp); out.nums.sort(byImp); out.lists.sort(byImp); out.cloze.sort(byImp); out.cloze2.sort(byImp);
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
  // the other four types: counted from the sentences that have their shape (the same ones the questions are made of); beside the AI profiler (`semantic`) the wording cues may add to that
  const distinct = (l) => new Set(l.map((x) => x.sentence)).size; const bestN = m.model ? distinct(m.bests) : 0, condN = (distinct(m.conds) + m.causal.length >= 4) ? distinct(m.conds) : 0, critN = (distinct(m.critics) + m.defs.length >= 4) ? distinct(m.critics) : 0;
  const pairsN = matchPairs(m).length >= 3 ? matchPairs(m).length : 0;
  put('compare_contrast', Math.max(distinct(m.contrasts) + pairsN, sem ? heur.compare_contrast.hits / 1.5 : 0), [...new Set([...refsOf(m.contrasts), ...(pairsN ? matchPairs(m).map((x) => x.ref) : []), ...(sem ? cueRefs('compare_contrast') : [])])]); put('critical_thinking', Math.max(critN, sem ? heur.critical_thinking.hits / 2 : 0), [...new Set([...(critN ? refsOf(m.critics) : []), ...(sem ? cueRefs('critical_thinking') : [])])]);
  put('best_answer', Math.max(bestN, sem ? Math.min(8, heur.best_answer.hits) : 0), [...new Set([...(bestN ? refsOf(m.bests) : []), ...(sem ? cueRefs('best_answer') : [])])]); put('scenarios', Math.max(condN, sem ? heur.scenarios.hits / (field === 'health' ? 3 : 6) : 0), [...new Set([...(condN ? refsOf(m.conds) : []), ...(sem ? cueRefs('scenarios') : [])])]);

  return { types: out, source: 'rules' };
}

function analyse(pagesList) {
  const m = mine(pagesList); const objectives = []; const poolOk = m.terms.size >= 6;
  pagesList.forEach((p) => {
    const on = (a) => a.filter((x) => x.ref === p.ref).length; const n = { defs: on(m.defs), causal: on(m.causal), nums: on(m.nums), lists: on(m.lists), seqs: on(m.seqs), cloze: on(m.cloze) }; const sup = {};
    if (n.defs && m.defs.length >= 4) { sup.basic_recall = { pages: [p.ref] }; sup.understanding = { pages: [p.ref] }; } else if (n.cloze && poolOk) sup.basic_recall = { pages: [p.ref] };
    if (!sup.understanding && m.model && m.cloze.filter((x) => x.ref === p.ref && x.phrase).length >= 2) sup.understanding = { pages: [p.ref] };      // a statement with a key phrase: «which statement is accurate»
    if (n.causal && m.causal.length >= 4) sup.mechanisms = { pages: [p.ref] };
    if (n.nums) sup.application = { pages: [p.ref] };
    if (n.lists && m.lists.length >= 2) sup.not_except = { pages: [p.ref] };
    if (n.seqs) sup.sequence = { pages: [p.ref] };
    if (on(m.contrasts) || (matchPairs(m).length >= 3 && matchPairs(m).some((x) => x.ref === p.ref))) sup.compare_contrast = { pages: [p.ref] };
    if (m.model && on(m.bests)) sup.best_answer = { pages: [p.ref] };
    if (on(m.conds) && m.conds.length + m.causal.length >= 4) sup.scenarios = { pages: [p.ref] };
    if (on(m.critics) && m.critics.length + m.defs.length >= 4) sup.critical_thinking = { pages: [p.ref] };
    if (Object.keys(sup).length) { const items = n.defs + n.causal + n.nums + n.lists + n.seqs + n.cloze + on(m.contrasts) + on(m.conds) + on(m.critics) + on(m.bests); const title = (parseLines(p.text)[0] || {}).text || p.ref;
      objectives.push({ id: 'o' + (objectives.length + 1), statement: clip(title, 120), pages: [p.ref], key_terms: [], capacity: Math.max(1, Math.min(4, items)), supports: sup }); }
  });
  return { objectives, profile: profile(pagesList, null, { semantic: false }), gaps: ['التوليد المحلي (بلا ذكاء اصطناعي) يدعم: التعريفات، إكمال الفراغ، السبب والنتيجة، الأرقام، القوائم، الترتيب. الأسئلة الأعمق (تحليل ومقارنة وحالات) تحتاج الذكاء الاصطناعي.'],
    lecture_character: 'تحليل آلي بالقواعد (بدون ذكاء اصطناعي).', discipline_guess: null };
}

// ---------------------------------------------------------------- building questions
/* A source item can be asked in more than one FORM (a definition: term -> meaning, meaning -> term, which statement is true, a missing word of it...). The first form of
 * each type is the original question; the other forms exist so a thin lecture can still fill the requested count WITHOUT repeating a question. Every form is built from verbatim
 * source lines (the evidence stays exact) and rotates with the slot's `variant`. */
const FORMS = { basic_recall: ['defMeaning', 'cloze', 'defCloze', 'listBelongs'], understanding: ['defToTerm', 'statement', 'truePhrase'], mechanisms: ['causeEffect', 'effectCause'],
  application: ['numValue', 'numStatement'], not_except: ['listNot'], sequence: ['seqOrder', 'seqNext'],
  compare_contrast: ['contrast', 'matchRow'], best_answer: ['bestOf'], scenarios: ['scenario'], critical_thinking: ['caution'] };
const TYPES = Object.keys(FORMS);
const keyOf = (x) => x.sentence || x.items.join('|');
function toolkit(slot, m, used, pages, lang) {
  const ar = isAr(pages[slot.pages[0]] || ''); const seed = slot.slot * 7919 + 13;
  const arx = ar || lang !== 'en';      // the explanation is written in Arabic unless English was asked for; the lecture's own sentence stays in ITS language, quoted
  const iso = (t) => (ar || !/[A-Za-z]/.test(t) ? t : `\u2066${t}\u2069`);      // a Latin quotation inside an Arabic sentence keeps its own direction
  // planned (natural) slots: a sentence feeds at most one question; reinforcement slots: only the same (form, item) pair is excluded, so another form may reuse the sentence
  const xk = (form, x) => form + '|' + keyOf(x) + (x.term && x.index != null ? '#' + x.term : '');
  const covered = used.__concepts || (used.__concepts = new Set()); const conceptsOf = (x) => (x.__c || (x.__c = m.keyConcepts && x.sentence ? phraseCandidates(x.sentence).map((c) => c.lw).filter((k) => m.keyConcepts.has(k)) : []));
  const fresh = (x) => conceptsOf(x).filter((k) => !covered.has(k)).length;
  // within a page: the item that brings key concepts not asked about yet comes first (then the more important sentence), so the quiz covers the lecture's topics, not one topic many times
  const sentN = used.__sent || (used.__sent = new Map());      // the finishing pass may ask a sentence again with another blank, but not more than twice (three times for a long one, which holds more facts)
  const here = (a, form) => a.filter((x) => slot.pages.includes(x.ref) && !used.has(slot.extra ? xk(form, x) : keyOf(x)) && (slot.loose || !x.sentence || (sentN.get(x.sentence) || 0) < (wc(x.sentence) >= 18 ? 3 : 2))).map((x, i) => [x, i]).sort((p1, p2) => (fresh(p2[0]) > 0) - (fresh(p1[0]) > 0) || fresh(p2[0]) - fresh(p1[0]) || p1[1] - p2[1]).map(([x]) => x);
  const take = (form, x) => { used.add(keyOf(x)); used.add(xk(form, x)); if (x.sentence) sentN.set(x.sentence, (sentN.get(x.sentence) || 0) + 1); conceptsOf(x).forEach((k) => covered.add(k)); };
  const mk = (stem, key, wrong, ev, expl, purpose) => { const w = [...new Set(wrong.filter((x) => x && normKey(x) !== normKey(key)))].slice(0, 3); if (w.length < 3) return null;
    return { slot: slot.slot, unwritable_reason: null, stem, options: [key, ...w], correct_index: 0, explanation: expl, purpose, reasoning_pattern: slot.qtype, evidence: [{ page: ev.ref, quote: ev.sentence || ev.quote }], uses_external: false }; };
  const note = (s) => (arx ? `الإجابة الصحيحة مبنية على نص المحاضرة${ar ? '' : ' الأصلي'}: «${iso(s)}». الخيارات الأخرى تصف أشياء أخرى وردت في المصدر لا تنطبق هنا.` : `The correct answer follows the lecture text: "${s}". The other options describe other items from the source that do not apply here.`);
  const byLen = (arr, f, target) => arr.slice().sort((a, b) => Math.abs(f(a).length - target) - Math.abs(f(b).length - target));
  // the explanation of a local question says WHY the key is right and where each wrong option comes from - the lecture sentence itself is already shown under it ("من محاضرتك")
  const qt = (x) => (arx ? `«${iso(clip(strip(x), 70))}»` : `"${clip(strip(x), 70)}"`), qts = (arr) => arr.filter(Boolean).slice(0, 3).map(qt).join(arx ? '، ' : ', ');
  const ex = (a, e) => (arx ? a : e);
  return { ar, arx, iso, seed, here, take, mk, note, byLen, slot, qt, qts, ex, used, usedDistractors: used.__dis || (used.__dis = new Set()) };
}
// fill-in-the-blank with look-alike distractors taken from the lecture's own key terms (primary and secondary candidates share this builder)
function clozeQ(T, m, c, tag) {
  const lt = c.term.toLowerCase(), stemOf = (w) => w.toLowerCase().replace(/(ies|es|s|ing|ed)$/, ''), inSent = new Set((c.sentence.toLowerCase().match(WORD_RE) || []).map(stemOf)); const ltStem = stemOf(c.term); const capCls = (w) => (/^[A-Z]{2,6}$/.test(w) ? 'a' : /^[A-Z]/.test(w) ? 'c' : 'l'); const sufCls = (w) => { const x = w.toLowerCase(); return /(tion|sion|ment|ness|ity|ance|ence)$/.test(x) ? 'n' : /ing$/.test(x) ? 'g' : /ed$/.test(x) ? 'd' : /(es|s)$/.test(x) && !/(ss|us|is)$/.test(x) ? 'p' : /(ic|al|ive|ous|ary|ar)$/.test(x) ? 'j' : 'o'; };
  if (c.phrase && m.model) { const d = phraseDistractors(m.model, c.term, c.sentence, c.ref, T.usedDistractors); if (d) { d.forEach((x) => T.usedDistractors.add(x.toLowerCase())); return finishCloze(T, c, d, tag); } }
  const pool = [...m.terms.values()].filter((t) => t.word.toLowerCase() !== lt && !antonym(t.word, c.term) && !inSent.has(stemOf(t.word)) && stemOf(t.word) !== ltStem && !lt.includes(t.word.toLowerCase()) && !t.word.toLowerCase().includes(lt) && (/[؀-ۿ]/.test(t.word) === /[؀-ۿ]/.test(c.term)) && capCls(t.word) === capCls(c.term) && (!/^ال/.test(c.term) || /^ال/.test(t.word)) && Math.abs(t.word.length - c.term.length) <= Math.max(3, Math.round(c.term.length * 0.4)));
  const rank = (t) => (sufCls(t.word) === sufCls(c.term) ? 0 : 2) + (t.refs.has(c.ref) ? 0 : 1); const ordered = pick(pool, pool.length, T.seed).sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((t) => t.word);
  if (ordered.length < 3) return null;    // not enough look-alike terms: better no question than a bad one
  return finishCloze(T, c, ordered, tag);
}
function finishCloze(T, c, ordered, tag) {
  const stem = c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length);
  if (wc(stem.replace('____', '')) < 5) return null;
  return T.mk((T.ar ? 'أكمل العبارة حسب المحاضرة: ' : 'Complete the statement from the lecture: ') + stem, c.term, ordered, c,
    T.ex(`الكلمة الناقصة في جملة المحاضرة هي ${T.qt(c.term)}. الخيارات الأخرى (${T.qts(ordered)}) كلمات من المحاضرة نفسها، لكنها لا تُكمل هذه الجملة.`, `The missing word in the lecture's sentence is ${T.qt(c.term)}. The other options (${T.qts(ordered)}) are words from the same lecture that do not complete this sentence.`),
    `مصطلح أساسي في: ${clip(c.sentence, 50)}${tag ? ' (' + c.term + ')' : ''}`);
}
// items of OTHER lists as distractors: those of a sibling list come first (a list headed the same way, e.g. «ID3» / «C4.5» / «CART», on a page near this one), so a wrong option
// looks like it could belong; an item sharing a word with this list, or found on its page, is never used (it might be true here)
const foreignItems = (m, l, pages) => { const listTok = new Set(E.toks([l.lead, ...l.items].join(' ')).filter((t) => !/^(features?|trees?|model|data|method|algorithms?)$/.test(t) || true)); const short = (x) => { const n = x.lead.split(/\s[-–—]+\s|[:(]/)[0].trim(); return wc(n) === 1 || /\d/.test(n) || /^[A-Z]{2,}\b/.test(n) ? 'name' : wc(n) <= 3 ? 'short' : 'long'; }; const pn = (r) => +String(r).split('p').pop() || 0;      // «ID3 -- Iterative Dichotomizer 3» is named «ID3» const pn = (r) => +String(r).split('p').pop() || 0;
  const seen = new Set(); const out = [];
  m.lists.filter((x) => x !== l).map((x) => [x, (short(x) === short(l) ? 0 : 6) + Math.min(6, Math.abs(pn(x.ref) - pn(l.ref)))]).sort((a, b) => a[1] - b[1]).forEach(([x, rank]) => x.items.forEach((it) => {
    const k = normKey(it); if (seen.has(k)) return; seen.add(k);
    if (!l.items.some((z) => normKey(z) === k) && !normKey(pages[l.ref] || '').includes(k) && E.toks(it).filter((t) => listTok.has(t)).length * 2 < Math.max(1, E.toks(it).length) && !OBJ_VERB.test(it)) out.push([it, rank]); }));
  return out; };
// «which row correctly matches…» (the shape of the teachers' quizzes): three things of the lecture, each with its short meaning (a definition's head, or the one point a
// sibling list - «ID3» / «C4.5» / «CART» - has and the others do not); wrong rows are the same pairs mixed up
const shortMeaning = (d) => { const t = strip(d.tail).replace(/[.;:]+$/, '').trim(); return wc(t) >= 2 && wc(t) <= 8 && lettersShare(t) >= 0.7 && !/^[a-z]/.test(t) === !/^[a-z]/.test(t) && !/^(in|by|for|on|at|with|from|to|of|using|and|or|but|the|this|that)\b/i.test(t) && !/[,]/.test(d.term) && !/^[a-z]\s/i.test(d.term) && !/^(remark|note|notes|example|hint|tip|caution|warning)s?$/i.test(d.term) ? t : null; };      // the WHOLE meaning, short (a cut-off clause is not a meaning)
const listNameKind = (l) => { const n = l.lead.split(/\s[-–—]+\s|[:(]/)[0].trim(); return wc(n) <= 2 && (/\d/.test(n) || /^[A-Z]{2,}\b/.test(n)) && l.items.filter((it) => wc(it) >= 2).length >= 3; };      // a named method («ID3», «C4.5», «CART») with real points under it
function matchPairs(m) {
  if (m.__pairs) return m.__pairs; const out = [];
  const defs = m.defs.filter((d) => shortMeaning(d) && wc(d.term) <= 4); const seen = new Set();
  defs.forEach((d) => { const k = normKey(d.term); if (seen.has(k)) return; seen.add(k); out.push({ term: d.term, mean: shortMeaning(d), ref: d.ref, x: d, kind: 'def' }); });
  const named = m.lists.filter(listNameKind);
  named.forEach((l) => { const others = new Set(named.filter((o) => o !== l).flatMap((o) => o.items.map(normKey))); const own = l.items.find((it) => !others.has(normKey(it)) && wc(it) >= 2 && wc(it) <= 7);
    if (own) out.push({ term: l.lead.split(/\s[-–—]+\s/)[0].trim(), mean: own, ref: l.ref, x: l, kind: 'list' }); });
  return (m.__pairs = out);
}
const FORM = {
  defMeaning(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'defMeaning')[0]; if (!cand) return null; T.take('defMeaning', cand);
    const others = T.byLen(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)), (d) => d.tail, cand.tail.length).slice(0, 8);
    const ws = pick(others, 3, T.seed);
    return T.mk(T.ar ? `ما المقصود بـ «${cand.term}» حسب المحاضرة؟` : `According to the lecture, what is "${cand.term}"?`, clip(cand.tail), ws.map((d) => clip(d.tail)), cand,
      T.ex(`هذا هو تعريف ${T.qt(cand.term)} في المحاضرة. الخيارات الأخرى تعريفات المحاضرة لمصطلحات أخرى: ${T.qts(ws.map((d) => d.term))}.`, `This is how the lecture defines ${T.qt(cand.term)}. The other options are the lecture's definitions of other terms: ${T.qts(ws.map((d) => d.term))}.`), `تعريف ${cand.term}`); },
  defToTerm(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'defToTerm')[0]; if (!cand) return null; T.take('defToTerm', cand);
    const w = pick(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)).map((d) => d.term), 3, T.seed);
    return T.mk(T.ar ? `أي مصطلح يوافق هذا التعريف: «${clip(cand.tail, 140)}»؟` : `Which term matches this definition: "${clip(cand.tail, 140)}"?`, cand.term, w, cand,
      T.ex(`المحاضرة تعرّف ${T.qt(cand.term)} بهذا التعريف. ${T.qts(w)} مصطلحات أخرى من المحاضرة، ولكلٍّ منها تعريف مختلف.`, `The lecture gives this definition for ${T.qt(cand.term)}. ${T.qts(w)} are other terms of the lecture, each with a different definition.`), `تمييز مصطلح ${cand.term} من تعريفه`); },
  statement(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'statement')[0]; if (!cand) return null; T.take('statement', cand); const ct = E.toks(cand.tail);
    const others = m.defs.filter((d) => normKey(d.term) !== normKey(cand.term) && normKey(d.tail) !== normKey(cand.tail) && E.jac(E.toks(d.tail), ct) < .5);      // swapped definitions: false, yet taken from the same lecture
    const src = pick(T.byLen(others, (d) => d.tail, cand.tail.length).slice(0, 8), 3, T.seed); const wrong = src.map((d) => `${cand.term}: ${clip(d.tail, 140)}`);
    return T.mk(T.ar ? `أي العبارات التالية صحيحة عن «${cand.term}» حسب المحاضرة؟` : `Which statement about "${cand.term}" is correct according to the lecture?`, `${cand.term}: ${clip(cand.tail, 140)}`, wrong, cand,
      T.ex(`العبارة الصحيحة تنسب إلى ${T.qt(cand.term)} تعريفه كما في المحاضرة. العبارات الأخرى تنسب إليه تعريفات مصطلحات أخرى: ${T.qts(src.map((d) => d.term))}.`, `The correct statement gives ${T.qt(cand.term)} its own definition from the lecture. The others give it the definitions of other terms: ${T.qts(src.map((d) => d.term))}.`), `عبارة صحيحة عن ${cand.term}`); },
  cloze(T, slot, m) { const c = T.here(m.cloze, 'cloze')[0]; if (c) { T.take('cloze', c); return clozeQ(T, m, c, false); }
    const c2 = T.here(m.cloze2, 'cloze2')[0]; if (!c2) return null; T.take('cloze2', c2); return clozeQ(T, m, c2, true); },
  // the lecture's sentence among copies of it where its key phrase was swapped for a look-alike phrase of the same lecture: which one is accurate? The stem names the
  // sentence's topic (another key phrase of it, never the swapped one), so two such questions never read the same
  truePhrase(T, slot, m) { if (!m.model) return null;
    for (const c of T.here(m.cloze.filter((x) => x.phrase && m.keyConcepts && m.keyConcepts.has(x.term.toLowerCase())), 'truePhrase')) {      // only a key concept of the lecture is worth swapping
      const topic = phraseCandidates(c.sentence).filter((x) => m.model.table.get(x.lw) && (x.e <= c.index || x.i >= c.index + c.term.length) && !x.lw.split(' ').some((w) => c.term.toLowerCase().split(' ').includes(w))).sort((a, b) => m.model.table.get(b.lw).score - m.model.table.get(a.lw).score)[0];
      if (!topic || /["“”«»:]/.test(c.sentence) || !/[.!؟]$/.test(c.sentence.trim()) && wc(c.sentence) < 10) continue;      // a quotation or an attribution is not a statement to alter
      const plural = (x) => /[^s'’]s$/i.test(x.split(' ').pop()); const capC = (x) => (/^[A-Z]{2,6}$/.test(x) ? 'a' : /^[A-Z]/.test(x) ? 'c' : 'l');
      const d0 = phraseDistractors(m.model, c.term, c.sentence, c.ref, new Set()); const d = d0 && d0.filter((x) => capC(x) === capC(c.term) && wc(x) >= Math.min(2, wc(c.term)) && !/["“”’']/.test(x) && plural(x) === plural(c.term)); if (!d || d.length < 3) continue; T.take('truePhrase', c);
      const put = (w) => clip(c.sentence.slice(0, c.index) + w + c.sentence.slice(c.index + c.term.length), 240);
      return T.mk(T.ar ? `أي العبارات التالية صحيحة عن «${topic.text}» حسب المحاضرة؟` : `Which statement about "${topic.text}" is accurate according to the lecture?`, put(c.term), d.map(put), c,
        T.ex(`العبارة الصحيحة هي جملة المحاضرة كما وردت، وفيها ${T.qt(c.term)}. في العبارات الأخرى استُبدل بها ${T.qts(d)} — وهي مصطلحات من المحاضرة نفسها لكنها لا تصح في هذا الموضع.`, `The accurate statement is the lecture's own sentence, with ${T.qt(c.term)}. In the others it was replaced by ${T.qts(d)}: terms from the same lecture that do not fit here.`), `عبارة صحيحة عن ${topic.text}`); }
    return null; },
  matchRow(T, slot, m) { const pairs = matchPairs(m); const pn = (r) => +String(r).split('p').pop() || 0;
    for (const a of pairs.filter((p) => slot.pages.includes(p.ref))) {
      const key = 'mr|' + normKey(a.term); if (T.used.has(key) && !slot.loose) continue;
      const near = pairs.filter((p) => p !== a && p.kind === a.kind && normKey(p.term) !== normKey(a.term) && normKey(p.mean) !== normKey(a.mean)).sort((x, y) => Math.abs(pn(x.ref) - pn(a.ref)) - Math.abs(pn(y.ref) - pn(a.ref)));
      const trio = [a]; near.forEach((p) => { if (trio.length < 3 && !trio.some((t) => normKey(t.term) === normKey(p.term) || normKey(t.mean) === normKey(p.mean))) trio.push(p); }); if (trio.length < 3) continue;
      const setKey = 'mrset|' + trio.map((t) => normKey(t.term)).sort().join('|'); if (T.used.has(setKey) && !slot.loose) continue;      // the same three things in another order is the same question
      T.used.add(key); T.used.add(setKey); T.take('matchRow', a.x);
      const terms = trio.map((t) => t.term), means = trio.map((t) => t.mean); const row = (perm) => terms.map((t, i) => `${t}: ${means[perm[i]]}`).join('; ');
      const swaps = [[0, 2, 1], [1, 0, 2], [2, 1, 0]]; const wrong = [row([1, 2, 0]), row([2, 0, 1]), row(swaps[T.seed % 3])];
      const names = terms.map((t) => (T.ar ? `«${t}»` : t)).join(T.ar ? '، ' : ', ');
      const stem = a.kind === 'def' ? (T.ar ? `أي صف يطابق ${names} بمعانيها حسب المحاضرة؟` : `Which row correctly matches ${names} to their meanings in the lecture?`) : (T.ar ? `أي صف يطابق ${names} بما تذكره المحاضرة عن كلٍّ منها؟` : `Which row correctly matches ${names} to what the lecture lists for each?`);
      return T.mk(stem, row([0, 1, 2]), wrong, a.x,
        T.ex(`في المحاضرة: ${trio.map((t) => `${T.qt(t.term)} ← ${T.qt(t.mean)}`).join('، ')}. الصفوف الأخرى تخلط بينها.`, `In the lecture: ${trio.map((t) => `${T.qt(t.term)} - ${T.qt(t.mean)}`).join('; ')}. The other rows mix them up.`), `مطابقة: ${terms.join(' / ')}`); }
    return null; },
  defCloze(T, slot, m) { const c = T.here(m.defCloze, 'defCloze')[0]; if (!c) return null; T.take('defCloze', c); return clozeQ(T, m, c, true); },
  causeEffect(T, slot, m) { const c = T.here(m.causal, 'causeEffect')[0]; if (!c || m.causal.length < 4) return null; T.take('causeEffect', c);
    const src = pick(T.byLen(m.causal.filter((x) => x.tail !== c.tail), (x) => x.tail, c.tail.length).slice(0, 8), 3, T.seed); const w = src.map((x) => clip(x.tail, 120));
    return T.mk(T.ar ? `أكمل حسب المحاضرة: ${c.head} ${c.conn} ____` : `Complete according to the lecture: ${c.head} ${c.conn} ____`, clip(c.tail, 120), w, c,
      T.ex(`هذه هي النتيجة التي تربطها المحاضرة بـ ${T.qt(c.head)}. الخيارات الأخرى نتائج تذكرها المحاضرة لأسباب أخرى، مثل ${T.qt(src[0] && src[0].head)}.`, `This is the effect the lecture links to ${T.qt(c.head)}. The other options are effects the lecture gives for other causes, such as ${T.qt(src[0] && src[0].head)}.`), `الأثر الناتج عن: ${clip(c.head, 50)}`); },
  effectCause(T, slot, m) { const c = T.here(m.causal, 'effectCause')[0]; if (!c || m.causal.length < 4) return null; T.take('effectCause', c);
    const src = pick(T.byLen(m.causal.filter((x) => x.head !== c.head), (x) => x.head, c.head.length).slice(0, 8), 3, T.seed); const w = src.map((x) => clip(x.head, 120));
    return T.mk(T.ar ? `أكمل حسب المحاضرة: ____ ${c.conn} ${c.tail}` : `Complete according to the lecture: ____ ${c.conn} ${c.tail}`, clip(c.head, 120), w, c,
      T.ex(`هذا هو السبب الذي تذكره المحاضرة لـ ${T.qt(c.tail)}. الخيارات الأخرى أسباب تذكرها المحاضرة لنتائج أخرى، مثل ${T.qt(src[0] && src[0].tail)}.`, `This is the cause the lecture gives for ${T.qt(c.tail)}. The other options are causes the lecture gives for other effects, such as ${T.qt(src[0] && src[0].tail)}.`), `السبب أو المقدّمة وراء: ${clip(c.tail, 50)}`); },
  numValue(T, slot, m) { const n = T.here(m.nums, 'numValue')[0]; if (!n) return null; T.take('numValue', n); const v = parseFloat(n.val.replace(',', '.')); const same = [...new Set(m.nums.filter((x) => x.unit === n.unit && x.val !== n.val).map((x) => x.val))];
    const fake = [v * 2, v / 2, v * 1.25, v * 0.75, v + 10].map((x) => (Number.isInteger(v) ? String(Math.round(x)) : String(+x.toFixed(1)))).filter((x) => x !== n.val); const picked = pick([...same, ...fake], 3, T.seed); const w = picked.map((x) => `${x} ${n.unit}`);
    const fromLecture = picked.filter((x) => same.includes(x)).length;
    return T.mk((T.ar ? 'أكمل بالقيمة الصحيحة حسب المحاضرة: ' : 'Select the correct value according to the lecture: ') + n.sentence.replace(n.val, '____'), `${n.val} ${n.unit}`, w, n,
      T.ex(`القيمة الواردة في المحاضرة هنا هي ${T.qt(n.val + ' ' + n.unit)}.${fromLecture ? ' بعض الأرقام الأخرى قيمٌ تذكرها المحاضرة لأشياء أخرى، والباقي مغيَّر عن القيمة الصحيحة.' : ' الأرقام الأخرى مغيَّرة عنها.'}`, `The value the lecture gives here is ${T.qt(n.val + ' ' + n.unit)}.${fromLecture ? ' Some of the other numbers are values the lecture gives for other things; the rest are altered.' : ' The other numbers are altered.'}`), `قيمة رقمية: ${clip(n.sentence, 50)}`); },
  numStatement(T, slot, m) { const n = T.here(m.nums, 'numStatement')[0]; if (!n) return null; T.take('numStatement', n); const v = parseFloat(n.val.replace(',', '.')); const same = [...new Set(m.nums.filter((x) => x.unit === n.unit && x.val !== n.val).map((x) => x.val))];
    const fake = [v * 2, v / 2, v * 1.25, v * 0.75, v + 10].map((x) => (Number.isInteger(v) ? String(Math.round(x)) : String(+x.toFixed(1)))).filter((x) => x !== n.val); const alts = pick([...same, ...fake], 3, T.seed);
    const topic = n.sentence.split(/\s+/).slice(0, 5).join(' ');
    return T.mk(T.ar ? `أي صياغة صحيحة حسب المحاضرة للعبارة التي تبدأ بـ «${topic}»؟` : `Which version of the lecture statement beginning "${topic}" is correct?`, clip(n.sentence, 240), alts.map((x) => clip(n.sentence.replace(n.val, x), 240)), n,
      T.ex(`الصياغة الصحيحة هي التي فيها ${T.qt(n.val + ' ' + n.unit)} كما في المحاضرة؛ في الصياغات الأخرى غُيِّر الرقم.`, `The correct version is the one with ${T.qt(n.val + ' ' + n.unit)}, as in the lecture; the number was changed in the others.`), `صياغة صحيحة لعبارة رقمية: ${clip(n.sentence, 50)}`); },
  // a list gives one question per item (which of these belongs to it) and one per outside item (which of these does not): each (list, item) pair is asked once.
  // A planned slot takes a list not asked about yet; the finishing pass may come back to the same list for its other items.
  listNot(T, slot, m, pages) { if (m.lists.length < 2) return null;
    for (const l of m.lists.filter((x) => slot.pages.includes(x.ref) && (slot.extra || !T.used.has(keyOf(x))))) {
      const asked = [...T.used].filter((k) => k.startsWith('ln|' + keyOf(l) + '|')).length; if (asked >= 3 && !slot.loose) continue;      // at most three 'which is NOT' questions per list
      const med = l.items.map((x) => wc(x)).sort((a, b) => a - b)[Math.floor(l.items.length / 2)]; const foreign = foreignItems(m, l, pages).sort((a, b) => a[1] - b[1] || Math.abs(wc(a[0]) - med) - Math.abs(wc(b[0]) - med)).map((x) => x[0]);
      const key = foreign.find((f) => !T.used.has('ln|' + keyOf(l) + '|' + f)); if (!key) continue; T.used.add('ln|' + keyOf(l) + '|' + key); T.take('listNot', l);
      const true3 = pick(l.items, 3, T.seed); const lead = clip(strip(l.lead), 80);
      return T.mk(T.ar ? `أي مما يلي لا تذكره المحاضرة تحت «${lead}»؟` : `Which of the following is NOT listed in the lecture under "${lead}"?`, key, true3, l,
        T.ex(`${T.qt(key)} ليس مما تذكره المحاضرة تحت ${T.qt(l.lead)}، بل من موضع آخر. المذكور هناك: ${l.items.slice(0, 5).map(T.qt).join('، ')}.`, `${T.qt(key)} is not among what the lecture lists under ${T.qt(l.lead)}; it comes from elsewhere. The lecture lists: ${l.items.slice(0, 5).map(T.qt).join(', ')}.`), `الاستثناء من قائمة: ${clip(l.lead, 50)}`); }
    return null; },
  listBelongs(T, slot, m, pages) { if (m.lists.length < 2) return null;
    for (const l of m.lists.filter((x) => slot.pages.includes(x.ref) && (slot.extra || !T.used.has(keyOf(x))))) {
      if ([...T.used].filter((k) => k.startsWith('lb|' + keyOf(l) + '|')).length >= 6 && !slot.loose) continue;      // at most six per list
      const n = l.items.length, start = (slot.variant || 0) % n; let key = null; for (let k = 0; k < n && !key; k++) { const it = l.items[(start + k) % n]; if (!T.used.has('lb|' + keyOf(l) + '|' + it)) key = it; } if (!key) continue;
      const foreign = foreignItems(m, l, pages).sort((a, b) => a[1] - b[1] || Math.abs(wc(a[0]) - wc(key)) - Math.abs(wc(b[0]) - wc(key))).map((x) => x[0]).slice(0, 6); if (foreign.length < 3) continue; T.used.add('lb|' + keyOf(l) + '|' + key); T.take('listBelongs', l);
      const lead = clip(strip(l.lead), 80), group = /(s|ies)$|\b(types?|kinds?|steps?|choices|categories|advantages|disadvantages|features|properties|pros|cons|أنواع|خطوات|مزايا|عيوب|خصائص)\b/i.test(lead.replace(/[:：]$/, ''));
      const stem = T.ar ? (group ? `أي مما يلي تذكره المحاضرة ضمن «${lead}»؟` : `أي مما يلي تذكره المحاضرة عن «${lead}»؟`) : (group ? `Which of the following does the lecture list under "${lead}"?` : `Which of the following does the lecture state about "${lead}"?`);
      const w3 = pick(foreign, 3, T.seed); return T.mk(stem, key, w3, l,
        T.ex(`${T.qt(key)} مما تذكره المحاضرة تحت ${T.qt(l.lead)} (${l.items.slice(0, 5).map(T.qt).join('، ')}). الخيارات الأخرى مأخوذة من مواضع أخرى في المحاضرة.`, `${T.qt(key)} is one of the points the lecture gives under ${T.qt(l.lead)} (${l.items.slice(0, 5).map(T.qt).join(', ')}). The other options come from other parts of the lecture.`), `عنصر من قائمة: ${clip(l.lead, 50)}`); }
    return null; },
  seqOrder(T, slot, m, pages) { const q = T.here(m.seqs.map((s) => ({ ...s, sentence: s.items.join('|') })), 'seqOrder')[0]; if (!q) return null; T.take('seqOrder', q); const items = q.items.slice(0, 4); const idx = items.map((_, i) => i);
    if (items.every((x) => wc(x) <= 6)) {      // short steps: the options ARE the orders («Lag → log → stationary → death»), as in the teachers' quizzes
      const chain = (ord) => ord.map((k) => strip(items[k])).join(' → '); const seen = new Set([chain(idx)]); const wrong = [];
      for (let t = 1; wrong.length < 3 && t < 80; t++) { const c = chain(pick(idx, idx.length, T.seed + t)); if (!seen.has(c)) { seen.add(c); wrong.push(c); } } if (wrong.length < 3) return null;
      const line0 = pages[q.ref].split('\n').find((l) => l.includes(items[0]));
      return { slot: slot.slot, unwritable_reason: null, stem: T.ar ? 'أي ترتيب يطابق ما ورد في المحاضرة؟' : 'Which order matches the one given in the lecture?', options: [chain(idx), ...wrong], correct_index: 0,
        explanation: T.arx ? `الترتيب في المحاضرة: ${items.map((x) => T.qt(x)).join(' ← ')}.` : `The order in the lecture: ${items.map((x) => T.qt(x)).join(' → ')}.`, purpose: `ترتيب يبدأ بـ ${clip(items[0], 40)}`, reasoning_pattern: 'sequence',
        evidence: [{ page: q.ref, quote: (line0 || items[0]).trim() }], uses_external: false }; }
    const shuf = pick(idx, idx.length, T.seed); if (shuf.every((v, i) => v === i)) shuf.push(shuf.shift()); const correct = idx.map((k) => shuf.indexOf(k) + 1); const set = new Set([correct.join(' → ')]);
    for (let t = 1; set.size < 4 && t < 60; t++) set.add(pick(idx.map((i) => i + 1), idx.length, T.seed + t).join(' → ')); if (set.size < 4) return null;
    const first = items[0]; const line = pages[q.ref].split('\n').find((l) => l.includes(first));
    return { slot: slot.slot, unwritable_reason: null, stem: (T.ar ? 'رتّب الخطوات التالية كما وردت في المحاضرة:\n' : 'Put the following steps in the order given in the lecture:\n') + shuf.map((k, n) => `${n + 1}. ${items[k]}`).join('\n'), options: [...set], correct_index: 0,
      explanation: T.arx ? `الترتيب في المحاضرة: ${items.map((x, i) => `${i + 1}) ${T.qt(x)}`).join(' ← ')}.` : `The order in the lecture: ${items.map((x, i) => `${i + 1}) ${T.qt(x)}`).join(' → ')}.`, purpose: `ترتيب خطوات تبدأ بـ ${clip(first, 40)}`, reasoning_pattern: 'sequence',
      evidence: [{ page: q.ref, quote: (line || first).trim() }], uses_external: false }; },
  contrast(T, slot, m) { const c = T.here(m.contrasts, 'contrast')[0]; if (!c) return null; T.take('contrast', c);
    const cap1 = (t) => t.replace(/^\s*[a-z]/, (x) => x.toUpperCase()); const decap = (t) => (/^[A-Z][a-z]/.test(t) && !/^[A-Z][a-z]+\s+[A-Z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
    const initial = (pre) => !pre.trim(); const place = (t, pre) => (initial(pre) ? cap1(t) : decap(t));
    const mkS = (x, y, pl, pr) => cap1(`${c.preL}${place(x, c.preL)} ${pl}, ${c.conn} ${c.preR}${decap(y)} ${pr}`.replace(/\s+/g, ' ').trim());
    const right = cap1(c.text), swapped = mkS(c.b, c.a, c.predL, c.predR); const share = (pred) => (T.ar ? `«${c.a}» و«${c.b}» يشتركان في هذه الخاصية: «${pred}»` : `"${c.a}" and "${c.b}" share this property: "${pred}"`); const bothL = share(c.predL), bothR = share(c.predR);
    return T.mk(T.ar ? `أي العبارات التالية تميّز بين «${c.a}» و«${c.b}» تمييزًا صحيحًا حسب المحاضرة؟` : `Which statement correctly distinguishes "${c.a}" from "${c.b}" according to the lecture?`, clip(right, 230), [swapped, bothL, bothR].map((x) => clip(x, 230)), c,
      T.ex(`الصحيح أن المحاضرة تفرّق بينهما هكذا: ${T.qt(c.a)} ${T.qt(clip(c.predL, 60))}، بينما ${T.qt(c.b)} ${T.qt(clip(c.predR, 60))}. الخيارات الأخرى تبدّل الخاصيتين بينهما، أو تنسب الخاصية نفسها إليهما معًا.`, `The lecture separates them like this: ${T.qt(c.a)} ${T.qt(clip(c.predL, 60))}, whereas ${T.qt(c.b)} ${T.qt(clip(c.predR, 60))}. The other options swap the two properties, or give the same property to both.`), `تمييز ${c.a} عن ${c.b}`); },
  bestOf(T, slot, m) { const c = T.here(m.bests, 'bestOf')[0]; if (!c || !m.model) return null; T.take('bestOf', c); const d = phraseDistractors(m.model, c.term, c.sentence, c.ref, T.usedDistractors); if (!d) return null; d.forEach((x) => T.usedDistractors.add(x.toLowerCase()));
    const stem = c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length); if (wc(stem.replace('____', '')) < 5) return null;
    return T.mk((T.ar ? 'اختر أنسب إكمال لعبارة المحاضرة: ' : 'Choose the BEST completion of the lecture statement: ') + stem, c.term, d, c,
      T.ex(`المحاضرة تخصّ ${T.qt(c.term)} بوصفه ${T.qt(c.cue)} في هذه العبارة. الخيارات الأخرى (${T.qts(d)}) من المحاضرة نفسها وقد تبدو مقبولة، لكنها ليست ما تقوله هنا.`, `The lecture names ${T.qt(c.term)} as the ${T.qt(c.cue)} one here. The other options (${T.qts(d)}) come from the same lecture and may look acceptable, but they are not what it says.`), `الأنسب في: ${clip(c.sentence, 50)}`); },
  scenario(T, slot, m) { const c = T.here(m.conds, 'scenario')[0]; if (!c) return null; T.take('scenario', c);
    const cw = new Set(tokensOf(c.cond).filter((t) => !isFunc(t.lw) && t.w.length > 3).map((t) => t.lw.replace(/(es|s)$/, ''))); const related = (txt) => tokensOf(txt).filter((t) => !isFunc(t.lw) && t.w.length > 3 && cw.has(t.lw.replace(/(es|s)$/, ''))).length >= 2;
    const others = T.byLen([...m.conds.filter((x) => x.res !== c.res && !related(x.cond)).map((x) => x.res), ...m.causal.filter((x) => x.tail !== c.res && !related(x.head)).map((x) => x.tail)].filter((t, i, a) => a.indexOf(t) === i && normKey(t) !== normKey(c.res)), (x) => x, c.res.length).slice(0, 8);
    const w = pick(others, 3, T.seed).map((x) => clip(x, 130)); if (w.length < 3) return null;
    return T.mk(T.ar ? `سيناريو: في حالةٍ ${c.cond}. ما النتيجة المتوقعة حسب المحاضرة؟` : `Scenario: in a case where ${c.cond}, which outcome does the lecture say follows?`, clip(c.res, 130), w, c,
      T.ex(`المحاضرة تربط هذه الحالة بهذه النتيجة: ${T.qt(c.res)}. الخيارات الأخرى نتائج تذكرها المحاضرة لحالات أخرى، لا لهذه.`, `The lecture links this case to this outcome: ${T.qt(c.res)}. The other options are outcomes it gives for other cases.`), `نتيجة حالة: ${clip(c.cond, 50)}`); },
  caution(T, slot, m) { const c = T.here(m.critics, 'caution')[0]; if (!c) return null; T.take('caution', c);
    const pool = [...m.critics.filter((x) => x.sentence !== c.sentence && !x.sentence.toLowerCase().includes(c.topic.toLowerCase())).map((x) => x.claim), ...m.defs.map((d) => strip(d.sentence))].filter((t, i, a) => a.indexOf(t) === i);
    const w = pick(T.byLen(pool, (x) => x, c.claim.length).slice(0, 9), 3, T.seed).map((x) => clip(x, 150)); if (w.length < 3) return null;
    return T.mk(T.ar ? `أي العبارات التالية تحذير أو قيد تذكره المحاضرة عن «${c.topic}»؟` : `Which of these statements is the caution or limitation the lecture states about "${c.topic}"?`, clip(c.claim, 150), w, c,
      T.ex(`هذه العبارة هي ما تقوله المحاضرة عن ${T.qt(c.topic)} مع تحفّظها أو قيدها. الخيارات الأخرى عبارات عن موضوعات أخرى في المحاضرة.`, `This is what the lecture says about ${T.qt(c.topic)}, with its caution or limit. The other options are statements about other topics of the lecture.`), `تحفّظ حول ${c.topic}`); },
  seqNext(T, slot, m, pages) { const q = T.here(m.seqs.map((s) => ({ ...s, sentence: s.items.join('|') })), 'seqNext')[0]; if (!q || q.items.length < 3) return null; T.take('seqNext', q); const items = q.items;
    const i = (slot.variant || 0) % (items.length - 1); const key = items[i + 1]; const foreign = m.seqs.filter((x) => x !== q && x.ref !== undefined).flatMap((x) => x.items);
    const wrong = [...items.filter((_, k) => k !== i && k !== i + 1), ...foreign].filter((x) => normKey(x) !== normKey(key) && normKey(x) !== normKey(items[i])); const w = [...new Set(wrong.map((x) => clip(x, 120)))].slice(0, 3); if (w.length < 3) return null;
    const lines = String(pages[q.ref] || '').split('\n').map((x) => x.trim()); const a = lines.find((l) => l.includes(items[i])), b = lines.find((l) => l.includes(key)); if (!a || !b) return null;
    return { slot: slot.slot, unwritable_reason: null, stem: T.ar ? `حسب ترتيب المحاضرة، ما الخطوة التي تأتي مباشرة بعد: «${clip(items[i], 100)}»؟` : `In the order given in the lecture, which step comes right after: "${clip(items[i], 100)}"?`, options: [clip(key, 120), ...w], correct_index: 0,
      explanation: T.arx ? `في القائمة المرقمة بالمحاضرة تأتي «${T.iso(clip(key, 80))}» مباشرة بعد «${T.iso(clip(items[i], 80))}».` : `In the lecture's numbered list "${clip(key, 80)}" comes right after "${clip(items[i], 80)}".`, purpose: `الخطوة التالية بعد ${clip(items[i], 40)}`, reasoning_pattern: 'sequence',
      evidence: [{ page: q.ref, quote: a === b ? a : `${a} ${b}` }], uses_external: false }; },
};
/** a question for `slot`, trying the type's forms starting from the slot's variant (variant 0 = the original form) */
function build(slot, m, used, pages, lang) {
  const forms = FORMS[slot.qtype]; if (!forms) return null; const T = toolkit(slot, m, used, pages, lang); const start = (slot.variant || 0) % forms.length;
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
    const same = (a) => E.norm(a.stem) === E.norm(c.stem) && E.norm(a.options[a.correct_index]) === E.norm(c.options[c.correct_index]);      // round 2: only an identical question is a copy
    if (s.loose ? (d = (known.find(same) || {}).slot) !== undefined : (d = E.dupOf(c, known, relaxed)) != null) { stats.rejected_duplicate++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [`مكرر للسؤال ${d}.`] }); return false; }
    if (!s.loose && (d = E.leaks(c, known, relaxed)) != null) { stats.rejected_leak++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [`يكشف إجابة سؤال آخر (${d}).`] }); return false; }
    c.issues = v.concat([{ code: 'rules_mode', message: 'وُلّد بالقواعد بلا حل مستقل: المشتتات من المصدر نفسه وليست من استدلال نموذج.', severity: 'minor' }]); acc.push(c); return true; };
  return { pages, m, used, acc, dropped, stats, take, base, lang: st.language || 'source' };
}
/* The finishing pass: the requested count is ALWAYS delivered (a student who asks for 100 questions gets 100 - asking the same lecture again in other ways is how one studies).
 * Round 1: the page with the FEWEST questions so far gives one more question (any type, any unused form), so the lecture stays evenly covered.
 * Round 2 (the lecture is thin for this count): the limits that keep a quiz varied are lifted - a sentence may be blanked again, a list asked for all its items -
 *   only a question identical to one already in the quiz is refused.
 * Round 3 (still short): review copies - questions already in the quiz asked again later, marked «مراجعة», their options in another order. */
function finish(S, pagesList, want, startNo, pool, st) {
  const refs = pagesList.map((p) => p.ref); const total = () => S.base.length + S.acc.length; let no = startNo;
  const cnt = (ref) => S.base.concat(S.acc).filter((c) => (c.evidence || []).some((e) => e.page === ref)).length; const obj = (ref) => (pool || []).find((o) => o.pages.includes(ref)) || {};
  for (const level of [1, 2]) { if (total() >= want) break; S.used.__level = level; const dead = new Set(); let v = level === 2 ? 1000 : 0;
    for (let guard = 0; total() < want && guard < 6000; guard++) {
      const ref = refs.filter((r) => !dead.has(r)).sort((a, b) => cnt(a) - cnt(b) || E.pn(a) - E.pn(b))[0]; if (!ref) break; let built = false, anyRaw = false;
      for (let k = 0; k < TYPES.length && !built; k++) { const qtype = TYPES[(v + k) % TYPES.length]; const o = obj(ref);
        const s = { slot: no, qtype, pages: [ref], extra: true, loose: level === 2, variant: v, objective: o.statement || '', objective_id: o.id || '', difficulty: E.difficultyFor(st, qtype), angle: null };
        const raw = build(s, S.m, S.used, S.pages, S.lang); if (!raw) continue; anyRaw = true; if (S.take(s, raw)) { built = true; no++; } }
      v++; if (!built && !anyRaw) dead.add(ref);
    } }
  S.used.__level = 1;
  const src = S.base.concat(S.acc); for (let i = 0; total() < want && src.length; i++) {      // round 3
    const c = src[i % src.length], round = Math.floor(i / src.length) + 1; const order = c.options.map((_, k) => k); for (let k = 0; k < round; k++) order.push(order.shift());
    const ar = /[\u0600-\u06FF]/.test(c.stem); S.acc.push({ ...c, slot: no++, stem: (ar ? 'مراجعة: ' : 'Review: ') + c.stem.replace(/^(مراجعة|Review): /, ''), options: order.map((k) => c.options[k]), correct_index: order.indexOf(c.correct_index), extra: true, review: true });
  }
}

/* same contract as E.generate, no LLM. Planned slots first (reinforcement slots use other forms of the same material), then a finishing pass so the requested count is met. */
async function generate(plan, pagesList, st, progress) {
  const S = session(pagesList, st, plan, []); const want = plan.requested || plan.slots.length;
  for (const s of plan.slots) { progress('drafting', Math.round(100 * S.acc.length / Math.max(1, want)));
    const raw = build(s, S.m, S.used, S.pages, S.lang); if (!raw) { S.stats.unwritable++; S.dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: ['المصدر لا يحوي نمطًا مناسبًا لهذا النوع في الصفحات المحددة (التوليد المحلي).'] }); continue; }
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
