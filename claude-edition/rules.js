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
const BULLET_RE = /^[\s ]*(?:[•●▪◦○■□▫‣⁃·*✓✔➢❑◼]+\s*(?:\d{1,2}\s?-(?=\s?[A-Za-z]))?|[-–—](?=\s|[A-Z][a-z])|\(?\d{1,2}[.)](?=\s|[A-Za-z])|\d{1,2}\s?-(?=\s?[A-Za-z])|\(?[a-zA-Z][.)](?=\s)|[A-Ha-h]\s?-(?=\s)|(?:I{1,3}|IV|VI{0,3}|IX|X|i{1,3}|iv|vi{0,3}|ix|x)\s?[.:](?=\s?[A-Za-z])|[٠-٩]{1,2}[.)])\s*/;
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
const NOT_HEADING = /^(objectives?|out ?line|agenda|summary|references?|questions?|thank|learning outcomes|contents?|الأهداف|المحاور|ملخص|المراجع|أسئلة|شكرا|المحتويات)/i;
// a paper's / handout's apparatus is not lecture content: citations ("[12] Gal, A. …"), the references section, copyright and publication lines, addresses, links
const CITE = /^(\[\d{1,3}\]|\d{1,3}\.\s+[A-Z][a-z]+,\s+[A-Z]\.|[A-Z][a-z]+,\s+[A-Z]\.(\s?[A-Z]\.)?,?\s)/;
const REFS_HEAD = /^(references|bibliography|works cited|literature cited|further reading|المراجع|المصادر|قائمة المراجع)\s*:?$/i;
const APPARATUS = /(^(categories and subject descriptors|general terms|keywords|key words|index terms|ccs concepts|received|accepted|published online|corresponding author)\b|permission to make digital|all rights reserved|copyright ©|©\s?\d{4}|proceedings of|isbn|issn|doi:|https?:\/\/|www\.|@[a-z0-9-]+\.(com|edu|org|net)|\{[a-z0-9,.\s]+\}@)/i;
// course logistics (a reading list, office hours, a competition's instructions...) are not lecture content: a page headed like that gives no question
const ADMIN_HEAD = /^(reading assignments?|readings?|homework|assignments?|announcements?|office hours|syllabus|grading|logistics|course (information|info|overview|logistics)|about this course|(.{0,40}\s)?instructions|deadlines?|exam dates?|schedule|القراءات|الواجبات?|الإعلانات|الساعات المكتبية|توزيع الدرجات|تعليمات)\b/i;
// a page whose font was mapped to the wrong letters ("Zith", "anal\sis", "Organi]ed"): letters swapped inside words; its words are not the lecture's words
const scrambled = (text) => { const w = String(text).match(/\S+/g) || []; if (w.length < 30) return false; return w.filter((x) => /\p{Ll}[\\\[\]]|[\\\[\]]\p{Ll}|\p{Ll}[A-Z]\p{Ll}/u.test(x)).length / w.length > 0.06; };
function contentLines(text) {
  const all = parseLines(text); const out = []; let refs = false; const outline = all.some((l) => l.depth >= 2);
  if (all.length && (ADMIN_HEAD.test(all[0].text) || scrambled(text))) return [];
  for (const l of all) { if (REFS_HEAD.test(l.text)) { refs = true; continue; } if (refs) continue; if (NOT_CONTENT.test(l.text) || CITE.test(l.raw) || APPARATUS.test(l.text) || (soup(l.text) && !l.bullet)) continue; out.push(l); }
  for (let i = 1; i < out.length; i++) { const l = out[i], prev = out[i - 1], next = out[i + 1];
    const nextItem = [out[i + 1], out[i + 2], out[i + 3]].some((x) => x && (x.bullet || x.num != null)); const cont = (!l.bullet && l.num == null && (prev.bullet || prev.num != null) && ((/^[a-z(]/.test(l.text) && !(/^[^a-z]{4,}$/.test(prev.text) && prev.words <= 6)) || (!outline && nextItem && !l.endsColon && l.words <= 14 && !(prev.words <= 5 && !prev.endsSentence)))) ||      // a full sentence after a short heading is the heading's first point, not its second line
      (l.bullet && l.num == null && l.words <= 2 && /^[a-z]/.test(l.text) && !prev.endsSentence && !prev.endsColon && (prev.depth || 0) >= (l.depth || 0));      // «• pressure.» ends the line before it
    const wrapEnd = (/\b(the|of|to|a|an|and|or|in|with|from|by|for|at|on|via)$/i.test(prev.text) && !l.bullet && l.num == null && !prev.endsColon) || (/^[&+]/.test(l.text) && !l.bullet) || (/^[a-z]/.test(l.text) && !l.bullet && l.num == null && !prev.endsSentence && !prev.endsColon && prev.words <= 8 && l.words <= 6 && /^[&+a-z]/.test(prev.text));      // «& Stimulated by small» / «dose of nicotine»
    if (cont || wrapEnd) { prev.text = prev.text + ' ' + l.text; prev.raw = prev.raw + ' ' + l.raw; prev.words += l.words; prev.endsSentence = l.endsSentence; prev.endsColon = l.endsColon; out.splice(i, 1); i--; } }
  if (out.length >= 4 && out.filter((l) => soup(l.text)).length >= out.length * 0.35) return [];      // a table or diagram read as text («Veins Variable depending on the No innervation bladder 30»)
  return all.length >= 4 && all.filter((l) => CITE.test(l.raw)).length >= all.length * 0.4 ? [] : out;      // a page that is mostly citations
}
// not a statement to learn from: a question the slide asks the class ("Q: Why does …?"), or a formula whose symbols the PDF lost ("pruning: , where is an impurity measure")
// talk about the course rather than the subject ("more on other metrics in future lectures", "the picture is like this:")
const META = /\b(future lectures?|next (lecture|class|week|time)|later in (the|this) (course|lecture|class)|more on (this|that|other)|like this\s*:|as follows\s*:|see (below|above)|in this (lecture|class|course)|today we)\b/i;
const soup = (s) => { const t = String(s); let n = 0; t.replace(/\b([a-z]{3,})\s+([A-Z][a-z]{2,})\b/g, (x, a, w) => { if (!/^(the|and|for|with|from|such|like|than|that|this|these|those|include|includes|including|called|named|termed|via|into|onto|upon|are|was|were|has|have|see|use|by|any|all|its|their|our|your|his|her)$/.test(a) && !/^(I|The|A|An|In|On|At|Of|For|And|Or|But|Which|That|This|These|Those|It|They|We|E)$/.test(w)) n++; return x; });
  if (/\|/.test(t)) n += 2; if (/[\u0600-\u06FF]/.test(t) && /[A-Za-z]{3}/.test(t)) n += 2; if (/\b[a-z]{3,}\s+\d{1,3}\b(?!\s*(%|mg|ml|mL|g|kg|°|h|hours|days|min|years|cm|mm))/.test(t) && !/[.!?:]/.test(t)) n++; return (n >= 2 || (n >= 1 && !/[.,;:!?()]/.test(t) && wc(t) >= 6)) && !/[.!?]$/.test(t.trim()); };
const sound = (s) => !soup(s) && !/\b(the|of|to|a|an|and|or|in|with|from|by|for|at|on|as|than|via|is|are|when|which|that|where|while|if|because|whose)\s*,?\s*$/i.test(String(s).trim()) && !/[?؟]\s*$/.test(s) && !/^\s*(q|a)\s*[:.)]/i.test(s) && !/\s[,.;:](\s|$)|:\s*,|\(\s*\)/.test(s) && !/\bwhere\s+is\s+(an?|the)\b|,\s*and\s+is\s+the\b/i.test(s) && !/\((19|20)\d{2}[a-z]?\)/.test(s) && !META.test(s);      // nor a reference ("… (1992).")
// a sentence that starts in lower case or with a closing bracket is the second half of something; symbols are not a sentence
const fragment = (s) => /^[a-z)\]},;:.]/.test(s) || /-$/.test(s) || lettersShare(s) < 0.6 || (s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length || /\/\/|[{};=<>]|\b(mov|jmp|ret|int|var|let|const|def|return)\b.*[;(]/.test(s);      // also a line of code
function parseLines(text) {
  return String(text || '').split('\n').map((raw) => {
    const r = raw.replace(/ /g, ' '); let t = r.trim(); if (!t) return null;
    let bullet = false, num = null; const b = t.match(BULLET_RE); const g = (r.match(/^\s*([•●▪◦○■□▫‣⁃·*✓✔➢❑◼])/) || [])[1]; const depth = !g ? 0 : g === '◦' ? 2 : g === '▪' ? 3 : g === '‣' ? 4 : 1;      // the outline level a PowerPoint paragraph had (see extractPptx)
    if (b && t.length > b[0].length) { bullet = true; const m = b[0].replace(/^[\s•●▪◦○■□▫‣⁃·*✓✔➢❑◼]+/, '').match(/^\(?(\d{1,2})\s?[.)-]/); if (m) num = +m[1]; t = t.slice(b[0].length).trim(); }
    return { raw: r.trim(), text: t, bullet, num, depth, words: wc(t), endsSentence: /[.!?؟]$/.test(t), endsColon: /[:：]$/.test(t) };
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
  if (wc(t) === 1 && (E.STOP.has(t.toLowerCase()) || COMMON.has(t.toLowerCase()) || (/s$/i.test(t) && VERBS.has(t.toLowerCase().replace(/e?s$/, ''))) || VERBS.has(t.toLowerCase()))) return true;
  if (/^(common types?|types?|kinds?|examples?|e\.?g|sugar|disadvantages?|advantages?|note|remember)$/i.test(t)) return true;
  if ((GENERIC_HEAD.test(t) && wc(t) <= 3) || /^(goal|aim|purpose|key|main|idea|point|reason|problem|insight|advantage|benefit|drawback|disadvantage|limitation|challenge|difficulty|trick|lesson|observation|contribution|novelty|intuition|catch|downside|upside)\b/i.test(t)) return true;
  if (/^[a-z]/.test(t) && wc(t) > 3) return true;      // a lower-case phrase of four words or more before the colon is a piece of a sentence, not a term
  return false;
}
// "patched so that…" / "necessarily…" / "that if each loop…": a predicate or a clause, not a definition; "Example Tracing Run": a heading
function badTail(tail) {
  const t = String(tail).trim(); const words = (t.match(/[\p{L}]{2,}/gu) || []).length;
  if (words < 3 || lettersShare(t) < 0.6 || /-$/.test(t)) return true;      // symbols, a cut line
  if (titleCase(t) || /^(at|in|on|by|from|with|to|for|of|than|as|when|while)\b/i.test(t) || /\b(when|which|that|where|while|if|the|of|to|a|an|and|or|its|their|his|her|our|your)\s*,?$/i.test(t)) return true;      // «at highest metabolic activity», «the process that begins when»
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
/** PowerPoint outline lists: a bullet that has three or more bullets one level deeper under it is a list (its lead may itself be a bullet, and an item may be one word:
 *  «• Physical Assessment / ◦ Inspection ◦ Palpation ◦ Auscultation ◦ Percussion»). Only where the reader kept the outline levels. */
function mineDepthLists(lines) {
  const out = []; const codey = (t) => /[\[\]{}=_;$\\|<>]|\/\/|\(-?\d/.test(t);      // code, formulas, register names: not a list to examine
  const seqItems = new Set(mineSeqs(lines).flat().map(normKey));      // numbered steps are a SEQUENCE (asked in order), not a set
  if (lines.some((l) => l.depth)) lines.forEach((h, i) => { const d = h.depth || 0; const kids = []; let j = i + 1; for (; j < lines.length && (lines[j].depth || 0) > d; j++) if ((lines[j].depth || 0) === d + 1) kids.push(lines[j]);
    if (kids.length < 3) return; const lead = strip(h.text).replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').replace(/\s*[:：]\s*$/, ''); if (!lead || wc(lead) > 10 || h.endsSentence || NOT_HEADING.test(lead) || lettersShare(lead) < 0.6 || codey(lead)) return;
    const items = kids.map((x) => clip(strip(x.text), 80)).filter((t) => t.length >= 3 && wc(t) <= 9 && lettersShare(t) >= 0.7 && /\p{L}{3}/u.test(t) && !codey(t)); if (items.length < kids.length - 1) return;
    if (items.length >= 3 && items.filter((t) => OBJ_VERB.test(t)).length < Math.ceil(items.length / 2)) out.push({ lead, items: [...new Set(items)].slice(0, 8), sentence: [h.raw, ...kids.slice(0, 3).map((x) => x.raw)].join(' ') }); });
  // «The neurons that are cholinergic / (1) … (2) … (3) …» and «4. Mode of transmission / Hand hygiene / Personal protective equipment / …»
  lines.forEach((h, i) => { const t = strip(h.text); if (h.endsSentence || wc(t) > 10 || wc(t) < 2 || lettersShare(t) < 0.6 || NOT_HEADING.test(t)) return; const numbered = h.num != null;
    const kids = []; for (let j = i + 1; j < lines.length && kids.length < 8; j++) { const l = lines[j]; const ok = numbered ? l.num == null && !l.endsSentence && l.words <= 6 : l.num != null && l.words <= 12; if (!ok) break; kids.push(l); }
    if (kids.length < 3 || (!numbered && h.num != null) || codey(t) || ORDER_WORD.test(t) || /\b(procedure|protocol|method|technique)\b/i.test(t)) return; const items = kids.map((x) => clip(strip(x.text).replace(/,?\s*(?:and|or)\s*$/i, '').replace(/[,;.]$/, ''), 80)).filter((x) => x.length >= 3 && lettersShare(x) >= 0.7 && /\p{L}{3}/u.test(x) && !codey(x)); if (items.length < 3 || items.filter((x) => seqItems.has(normKey(x))).length >= 2) return;
    const lead = t.replace(/\s*[:：]\s*$/, ''); if (!out.some((x) => normKey(x.lead) === normKey(lead))) out.push({ lead, items: [...new Set(items)], sentence: [h.raw, ...kids.slice(0, 3).map((x) => x.raw)].join(' ') }); });
  // «… can improve the quality of patient care by» + three bullets: the sentence leads the list
  lines.forEach((h, i) => { if (h.bullet || !/\b(?:by|include|includes|including|such as|are|as follows|following|consists? of)\s*:?$/i.test(strip(h.text)) || wc(h.text) > 22) return;
    const kids = []; for (let j = i + 1; j < lines.length && lines[j].bullet && kids.length < 8; j++) kids.push(lines[j]); if (kids.length < 3) return;
    const items = kids.map((x) => clip(strip(x.text), 80)).filter((t) => t.length >= 3 && wc(t) <= 10 && lettersShare(t) >= 0.7 && !codey(t)); if (items.length < 3 || codey(h.text)) return;
    const lead = strip(h.text).replace(/\s*[:：]\s*$/, ''); if (!out.some((x) => normKey(x.lead) === normKey(lead))) out.push({ lead, items: [...new Set(items)], sentence: [h.raw, ...kids.slice(0, 3).map((x) => x.raw)].join(' ') }); });
  return out;
}
function mineLists(lines) {
  // a slide whose title came out last (some exporters write it after the bullets): bullets only, then one short plain line -> that line leads
  const last = lines[lines.length - 1];
  if (lines.length >= 4 && last && !last.bullet && last.num == null && last.words <= 8 && !last.endsSentence && lines.slice(0, -1).every((l) => l.bullet)) lines = [last, ...lines.slice(0, -1)];
  const out = []; const prose = lines.filter((l) => l.words >= 14).length >= 3;
  const CONT = /\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i; const contTitle = lines[0] && CONT.test(lines[0].text);
  for (let i = 0; i < lines.length; i++) {
    const h0 = lines[i]; const h = i === 0 && contTitle ? { ...h0, text: h0.text.replace(CONT, '') } : h0;      // «Uses of Documentation Forms (continued_1)»: the topic, without the marker
    if (i === 0 && contTitle && lines[1] && lines[1].words <= 5 && !lines[1].bullet && !lines[1].endsSentence && lines.length >= 5) continue;      // a short sub-heading right under a continued title leads the list («Incident report»)
    if (h.bullet || h.words > 10 || h.endsSentence || h.words < 1 || NOT_HEADING.test(h.text) || NOT_TERM.test(h.text) || defFromLine(h)) continue;
    const items = []; let j = i + 1;
    while (j < lines.length && items.length < 10) {
      const l = lines[j]; const itemLike = l.num == null && !NOT_HEADING.test(l.text) && (l.bullet || (l.words <= 10 && !l.endsSentence && !l.endsColon));
      if (!itemLike) break; items.push(l); j++;
    }
    const titleLike = (i === 0 || (i === 1 && /\(cont(?:inued)?[^)]*\)\s*$/i.test(lines[0].text))) && !prose;     // slide title (or the sub-heading under a «… (continued)» title) followed by short lines: PPTX paragraphs carry no bullet characters (a page of running text is not a slide: its first line may be a figure label)
    if (items.length >= 3 && (items.some((x) => x.bullet) || h.endsColon || titleLike) && !items.some((x) => defFromLine(x)) && items.filter((x) => OBJ_VERB.test(x.text)).length < Math.ceil(items.length / 2)) {
      const clean = items.map((x) => { const t = strip(x.text); const m = t.match(/^(.{3,40}?)\s*[:：–—-]\s+/); return clip(m && wc(m[1]) <= 5 ? m[1] : t, 80); }).filter((t) => t.length >= 3 && wc(t) <= 9);
      const tidy = clean.filter((t) => !/^step\s*\d+$/i.test(t) && !/[\[\]{}=_;$\\|]|-$|(?:^|[^\p{L}])\/|\/(?!\p{L})|^\(|\p{L}\/\p{L}+[-\/]/u.test(t) && lettersShare(t) >= 0.7 && /\p{L}{3}/u.test(t) && !fragment(t.replace(/^[a-z]/, (c) => c.toUpperCase())) && (t.match(/\(/g) || []).length === (t.match(/\)/g) || []).length && !/[\u{1D400}-\u{1D7FF}∑∫√≤≥]/u.test(t) && !/\b(19|20)\d{2}\b|\bet al\b|\bpp?\.\s*\d/.test(t) && !/\b(with|and|or|of|the|to|for|in|by|from|a|an|within|into|onto|between|than|that|which|via|are|is|was|were|be|as)$/i.test(t.replace(/[.,;:…]+$/, '')) && !/^(with|and|or|of|the|to|for|in|by|from|within|into|between|than|that|which)\b/i.test(t));
      if (clean.length - tidy.length >= 2 && clean.filter((t) => /^[a-z]/.test(t)).length >= 2) { i = j - 1; continue; }      // a paragraph wrapped into short lines, not a list      // no reference, table row, formula or cut-off fragment
      if (tidy.length >= 3 && !/[_{}=<>\/\\$]/.test(h.text) && (lettersShare(h.text) >= 0.6 || /^\p{L}[\p{L}\p{N}.\-]{1,15}$/u.test(h.text))) out.push({ lead: strip(h.text).replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, ''), items: tidy.slice(0, 8), sentence: listQuote(h, items) });
      i = j - 1;
    }
  }
  return out;
}
function mineSeqs(lines) {
  const head = lines.slice(0, 2).map((l) => l.text).join(' '); const ordered = ORDER_WORD_SEQ.test(head) || lines.some((l) => ORDER_WORD_SEQ.test(l.text) && l.endsColon);
  const out = []; let run = [];
  const flush = () => { if (run.length >= 3) out.push(run.slice(0, 5)); run = []; };
  lines.forEach((l) => { if (l.num != null && l.words >= 2 && (run.length === 0 ? l.num === 1 : l.num === run.length + 1)) run.push(l.text); else flush(); });
  flush(); return ordered || out.some((r) => r.filter((t) => /^[A-Z]?[a-z]+\b/.test(t) && VERB_IMP.test(t)).length >= Math.ceil(r.length * 0.6)) ? out : [];
}
const ORDER_WORD_SEQ = /\b(phases?|stages?|steps?|periods?|sequence|order|process|procedure|chain|cycle|development|how to|algorithm)\b/i;
const VERB_IMP = /^(check|refer|gather|perform|obtain|identify|introduce|explain|provide|use|make|continue|evaluate|ensure|lower|raise|ask|leave|document|dispose|return|wash|place|remove|apply|insert|record|measure|prepare|select|assess|plan|implement|research|develop|meet|stop|pick|go|repeat|add|mix|heat|cool|centrifuge|incubate|inoculate|stain|observe|count|calculate|compare|define|collect|choose|train|test|split|sort|start|open|close|clean|dry|cut|attach|connect|turn|set)\b/i;

// ---------------------------------------------------------------- key terms (for fill-in-the-blank)
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
function docFreq(pagesList) { const df = new Map(); pagesList.forEach((p) => new Set((p.text.toLowerCase().match(WORD_RE) || [])).forEach((w) => df.set(w, (df.get(w) || 0) + 1))); return df; }
function termScore(w, idx, df) {
  const lw = w.toLowerCase(); if (/^(something|anything|everything|nothing|someone|anyone|everyone|refers?|looking|performing|ensuring|providing|using|making|taking)$/.test(lw) || VERBS.has(lw) || (/s$/.test(lw) && VERBS.has(lw.replace(/e?s$/, ''))) || E.STOP.has(lw) || COMMON.has(lw) || /^(complete|statement|lecture|according)$/.test(lw) || /^\d+$/.test(w) || (/ly$/.test(lw) && lw.length > 5)) return -1;
  const letters = [...w].filter((c) => /\p{L}/u.test(c)).length, ar = /[؀-ۿ]/.test(w), acr = /^[A-Z]{2,6}$/.test(w);
  if (letters < (ar ? 4 : acr ? 2 : 6)) return -1;
  const cap = !ar && ((idx > 0 && /^[A-Z][a-z]/.test(w)) || acr); const d = df.get(lw) || 1;
  return Math.min(letters, 12) / 12 + (cap ? 1.2 : 0) + (d <= 1 ? 1.5 : d <= 2 ? 1 : d <= 4 ? 0.4 : 0);
}
function candidates(sentence, df) {
  const out = []; let m; WORD_RE.lastIndex = 0; let k = 0; const low = sentence.toLowerCase();
  const count = (w) => { let n = 0, i = -1; while ((i = low.indexOf(w, i + 1)) >= 0) n++; return n; };
  while ((m = WORD_RE.exec(sentence))) {
    const w = m[0].replace(/['’-]+$/, ''); const s = termScore(w, k++, df); if (s <= 0) continue; if (/\b(it|they|this|that|which|who|he|she|we|these|those)\s*$/i.test(sentence.slice(0, m.index))) continue;
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
const VERBS = new Set(('depend pump cause lead contain consist occur produce provide allow require involve include move flow carry control regulate increase decrease form help make give show use become remain create convert transport store release bind activate inhibit stimulate reduce raise enter leave pass cross generate maintain support prevent protect determine represent describe define explain affect change keep hold send receive exist appear happen begin start stop end follow connect separate combine divide split transfer travel enable ensure perform apply select compare measure detect respond react transform proceed present exhibit display suggest indicate report observe note mean imply pass close fall offer sense adjust constrict dilate preserve filter deliver excrete secrete absorb diffuse transmit conduct emit propagate fire relax contract bind dissociate synthesize degrade metabolize digest oxidize reduce phosphorylate express encode replicate transcribe translate infect invade attack destroy repair heal grow divide mutate evolve adapt survive spread influence trigger signal sustain depend decrease drop climb rise decline remain stay shift swap hide expose cover fill empty open close build develop grow reach contribute depend rely vary differ equal exceed contain surround attach bring take put get set run work read write record compile execute call return store load map match check test fail succeed run tell look document record write report check refer gather perform obtain identify introduce explain ensure leave ask return dispose evaluate implement develop determine select review organize organise establish validate innervate supply emerge exit synapse regulate modify transmit secrete').split(' '));
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
  if (CRIT_CUE.test(s) && w >= 9 && w <= 40 && !OBJ_VERB.test(s) && !c && !titleCase(s) && /[.!]$|\b(unless|only|except|but|however)\b/i.test(s) && !/^(it|this|these|those|they|thus|hence|therefore|since|although|that|there|here|then|also|but|and|so|we|our)\b/i.test(s)) { const top = phraseCandidates(s).filter((p) => p.toks.length <= 3)[0]; if (top) out.critics.push({ ref, sentence: s, claim: strip(s), topic: top.text }); }
}
// distractor pool = the best key term of each sentence (+ one-word definition terms): content words, not verbs/adverbs
function addTerm(out, word, ref) { const k = word.toLowerCase(); if (!out.terms.has(k)) out.terms.set(k, { word, refs: new Set() }); out.terms.get(k).refs.add(ref); }
function mine(pagesList) {
  const df = docFreq(pagesList); const out = { defs: [], causal: [], nums: [], lists: [], seqs: [], cloze: [], cloze2: [], defCloze: [], terms: new Map(), contrasts: [], bests: [], conds: [], critics: [], __lines: {} }; const allUnits = [];
  for (const p of pagesList) {
    const lines = contentLines(p.text); const units = []; out.__lines[p.ref] = lines;
    lines.forEach((l) => {
      const d = defFromLine(l); if (d) out.defs.push({ ref: p.ref, ...d });
      splitSentences(l.text).forEach((s) => { if (wc(s) >= 5 && !fragment(s) && sound(s) && !titleCase(s) && !/\(cont(inued)?/i.test(s)) { units.push(s); if (l.num == null && tokensOf(s).some((t) => isFunc(t.lw) || /ing$|ed$/.test(t.lw))) allUnits.push({ ref: p.ref, s }); } });      // a numbered step is a procedure (a sequence), not a fact to blank
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
    { const t0 = lines[0], t1 = lines[1]; if (t0 && t1 && !t0.bullet && t0.words <= 5 && !t0.endsSentence && /^(?:is|are|refers? to|means)\s+\S/i.test(t1.text) && t1.words >= 5) { const term = cleanTitle(t0.text), tail = strip(t1.text.replace(/^(?:is|are|refers? to|means)\s+/i, ''));
      if (term && !badTerm(term) && !out.defs.some((d) => normKey(d.term) === normKey(term)) && !badTail(tail)) out.defs.push({ ref: p.ref, term, tail: clip(tail, 160), sentence: t1.raw, unit: t1.raw, fromHead: true }); } }      // «Microbial Genetics / Is the science of heredity; …»
    mineDepthLists(lines).forEach((l) => { const clash = out.lists.filter((x) => x.ref === p.ref && (normKey(x.lead) === normKey(l.lead) || x.items.filter((it) => l.items.includes(it)).length >= 2));
      const mixed = clash.filter((x) => x.items.some((it) => normKey(it) === normKey(l.lead))); mixed.forEach((x) => out.lists.splice(out.lists.indexOf(x), 1));      // «Physical Assessment, Inspection, Palpation…» mixed two levels: the deeper list replaces it
      if (clash.length === mixed.length) out.lists.push({ ref: p.ref, ...l }); });
    mineSeqs(lines).forEach((items) => out.seqs.push({ ref: p.ref, items }));
  }
  { const topicKey = (t) => normKey(cleanTitle(String(t || '').split('\n').find((x) => x.trim()) || '').replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '')); const tk = Object.fromEntries(pagesList.map((pg) => [pg.ref, topicKey(pg.text)])); const span = {}; Object.values(tk).forEach((k) => { span[k] = (span[k] || 0) + 1; });
    out.lists.forEach((l) => { l.topic = tk[l.ref]; l.partial = span[l.topic] > 1 || /\(cont(?:inued)?[^)]*\)/i.test((pagesList.find((pg) => pg.ref === l.ref) || {}).text || ''); });      // a list continued over several slides of one topic: what is not on THIS slide may be on the next
    out.__topicPages = {}; pagesList.forEach((pg) => { (out.__topicPages[tk[pg.ref]] ||= []).push(pg.ref); }); }
  try { structureMine(pagesList, out); } catch (e) { out.secs = out.secs || []; out.fams = out.fams || []; out.examples = out.examples || []; out.effects = out.effects || []; out.gloss = out.gloss || []; out.ranges = out.ranges || []; out.purposes = out.purposes || []; out.stmts = out.stmts || []; if (typeof process !== 'undefined' && process.env && process.env.QZ_DEBUG) console.error(e); }
  // the lecture's own language model: key phrases for the blanks (instead of one lone word), plausible distractors, and the important sentences first
  if (allUnits.length >= 4) {
    const M = buildModel(allUnits, out.defs); out.model = M; const imp = new Map(M.sents.map((st) => [st.s, sentenceImportance(M, st, 0)]));
    const phraseOf = (st, skip) => { const best = st.cands.filter((c) => { const e = M.table.get(c.lw); const w0 = c.lw.split(' ')[0]; if (VERBS.has(w0) || VERBS.has(w0.replace(/e?s$/, '')) || /\s[-–]\s/.test(c.text) || /(ing|ly)$/.test(w0) || /^(something|anything|everything|nothing|someone|anyone|everyone|tells?|looks?|helps?|makes?|gives?|takes?)$/.test(w0)) return false; return e && e.score >= 0.18 * M.maxScore && (e.words >= 2 || c.lw.length >= 6) && !/^[A-Z]{1,2}$/.test(c.text) && !skip.has(c.lw); })
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

  // the structure adds what the plain sentences could not show: effects and their reversals, examples to place in a case, families of stages, statements to judge
  const all = {}; pagesList.forEach((p) => { const st = structOn(m, p.ref); Object.entries(st).forEach(([c, n]) => { if (n > 0) (all[c] = all[c] || { n: 0, pages: [] }), all[c].n += n, all[c].pages.push(p.ref); }); });
  Object.entries(all).forEach(([c, v]) => { if (!out[c]) return; const cap = Math.max(out[c].capacity, Math.min(40, Math.round(out[c].capacity + v.n))); if (cap > out[c].capacity) put(c, cap, [...new Set([...(out[c].pages || []), ...v.pages])]); });
  return { types: out, source: 'rules' };
}
/** per page, how many items of each identity the lecture's structure can carry (used by the analysis and by the profile) */
function structOn(m, ref) { const si = sItems(m); const on = (a) => a.filter((x) => x.ref === ref).length; const health = m.field === 'health' || true;
  const eff = si.effItems.filter((x) => x.ref === ref), effFlip = eff.filter((x) => x.it.flip).length, effPair = eff.filter((x) => x.it.pair).length;
  const ex = (m.examples || []).filter((x) => x.ref === ref), exCls = ex.filter((x) => exClass(x.example)).length; const fp = si.famPts.filter((x) => x.ref === ref);
  const fp4 = fp.filter((x) => x.fam.members.length >= 4).length, fpNoun = fp.filter((x) => x.fam.noun && /^(phase|stage|period|step|link|level)$/.test(x.fam.noun) && x.fam.members.length >= 4).length;
  const ordered = (m.fams || []).filter((f) => f.ordered && f.members.some((mm) => mm.ref === ref)).length; const stm = (m.stmts || []).filter((x) => x.ref === ref && x.mut.length);
  const D = deep(m); const deepScen = D.groups.reduce((a, f) => a + f.members.filter((mm) => mm.ref === ref && ptsOf(mm).length).length, 0) + D.pairs.filter((p) => p.kind === 'fam' && (p.a.ref === ref || p.b.ref === ref)).length + (D.pairs.some((p) => p.kind === 'state' && [p.a, p.b].some((e) => e.items.some((it) => it.ref === ref))) ? 1 : 0);
  const deepCrit = Math.floor(D.claims.filter((x) => x.ref === ref).length / 2) + (D.states.some((x) => x.items.some((it) => it.ref === ref)) ? 1 : 0);      // what the composer's deep forms can write here
  return { scenarios: Math.min(4, Math.floor(effFlip / 2) + exCls + fpNoun + deepScen), application: Math.min(4, fp4 + ex.length + on(m.ranges || [])), best_answer: Math.min(3, effFlip + fp.length + (m.defs.filter((d) => d.ref === ref).length ? 1 : 0)),
    critical_thinking: Math.min(3, stm.filter((x) => x.mut.length >= 2 && x.nuanced).length + deepCrit), not_except: Math.min(3, effPair + effFlip + (stm.length >= 4 ? 1 : 0) + fp.filter((x) => x.mem.points.length >= 3).length), compare_contrast: Math.min(3, effPair + fp.length + defSiblings(m).filter((x) => x.ref === ref).length),
    mechanisms: Math.min(2, on(m.purposes || [])), sequence: Math.min(2, ordered), understanding: Math.min(2, (m.gloss || []).filter((g) => g.ref === ref && g.kind === 'acronym').length), basic_recall: Math.min(3, effFlip + ex.length) }; }

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
    // the lecture's structure (structureMine): what each page can carry beyond its plain sentences
    const st = structOn(m, p.ref); ['scenarios', 'application', 'best_answer', 'critical_thinking', 'not_except', 'compare_contrast', 'mechanisms', 'sequence', 'understanding', 'basic_recall'].forEach((c) => { if (st[c] > 0) sup[c] = { pages: [p.ref] }; });
    if (Object.keys(sup).length) { const items = n.defs + n.causal + n.nums + n.lists + n.seqs + n.cloze + on(m.contrasts) + on(m.conds) + on(m.critics) + on(m.bests) + Object.values(st).reduce((a, b) => a + b, 0); const title = (parseLines(p.text)[0] || {}).text || p.ref;
      objectives.push({ id: 'o' + (objectives.length + 1), statement: clip(title, 120), pages: [p.ref], key_terms: [], capacity: Math.max(1, Math.min(4, items)), supports: sup }); }
  });
  return { objectives, profile: profile(pagesList, null, { semantic: false }), gaps: ['التوليد المحلي (بلا ذكاء اصطناعي) يدعم: التعريفات، إكمال الفراغ، السبب والنتيجة، الأرقام، القوائم، الترتيب. الأسئلة الأعمق (تحليل ومقارنة وحالات) تحتاج الذكاء الاصطناعي.'],
    lecture_character: 'تحليل آلي بالقواعد (بدون ذكاء اصطناعي).', discipline_guess: null };
}

// ================================================================ THE LECTURE'S STRUCTURE — what a teacher reads before writing a quiz
// (1) SECTIONS: a heading and the points under it. Sibling sections form a FAMILY - the growth phases, the oxygen groups, the links of the chain of infection, the
//     steps of the nursing process - ordered when the lecture presents them as phases / steps / a chain. Headings are found by their markers (1. / A- / II. / Step 3:),
//     by PowerPoint outline levels, and by titles that share a stem («Pathogenic properties of virus / of fungi / of algae»).
// (2) EXAMPLES attached to a category («Obligate anaerobes … Examples: Clostridium», «Direct care … bathing, teaching»).
// (3) EFFECT LISTS: points that state a direction (increased / reduced, dilation / constriction) under a condition («Responses to increased sympathetic activity»),
//     paired item by item with the opposite list when the lecture has one («Effects of parasympathetic activation»).
// (4) GLOSSES and ACRONYMS («Psychrophiles (cold-loving microbes)», «Nursing Interventions Classification (NIC)»).
// (5) RANGES («T1 to L2», «pH (6.5-7.5)»). (6) PURPOSES («dilate skeletal muscle blood vessels to increase oxygen & glucose supply»).
// The ten identities are written FROM this structure, the way the teachers' quizzes are: an effect and its reversal, a case that names an example, the stage a finding
// belongs to, the order of the phases, the statement a word swap made false.
const ROMAN_N = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
function markOf(raw) {
  const t = String(raw).trim().replace(/^[•●▪◦○■□▫‣⁃·*✓✔➢❑◼]+\s*/, ''); let m;
  if ((m = t.match(/^step\s*(\d{1,2})\s*[:.)-]\s*(.+)$/i))) return { kind: 'step', n: +m[1], rest: m[2] };
  if ((m = t.match(/^\(?(\d{1,2})\s?(?:[.)](?=\s|[A-Za-z])|-(?=\s?[A-Za-z])|:(?=\s))\s*(.+)$/))) return { kind: 'num', n: +m[1], rest: m[2] };
  if ((m = t.match(/^(i{1,3}|iv|vi{0,3}|ix|x|I{1,3}|IV|VI{0,3}|IX|X)\s?[.:)](?=\s?[A-Za-z])\s*(.+)$/))) return { kind: 'roman', n: ROMAN_N[m[1].toLowerCase()], rest: m[2] };
  if ((m = t.match(/^\(?([A-Ha-h])\s?(?:[.)]|-)(?:\s+|(?=[A-Z][a-z]))(.+)$/))) return { kind: 'alpha', n: m[1].toUpperCase().charCodeAt(0) - 64, rest: m[2] };
  return null;
}
// direction words and their reversal: the wrong options of physiology / microbiology questions are this reversal («increased heart rate» -> «reduced heart rate»)
const FLIP_PAIRS = [['increased', 'reduced'], ['increase', 'decrease'], ['reduce', 'increase'], ['increases', 'reduces'], ['increasing', 'reducing'], ['decreased', 'increased'], ['decrease', 'increase'], ['decreases', 'increases'],
  ['elevation', 'reduction'], ['elevated', 'lowered'], ['raises', 'lowers'], ['raise', 'lower'], ['dilate', 'constrict'], ['dilates', 'constricts'], ['dilated', 'constricted'], ['dilation', 'constriction'],
  ['bronchodilation', 'bronchoconstriction'], ['vasodilation', 'vasoconstriction'], ['stimulate', 'inhibit'], ['stimulates', 'inhibits'], ['stimulated', 'inhibited'], ['stimulation', 'inhibition'],
  ['stimulatory', 'inhibitory'], ['excitatory', 'inhibitory'], ['contraction', 'relaxation'], ['contracts', 'relaxes'], ['contract', 'relax'], ['closure', 'opening'], ['high', 'low'], ['higher', 'lower'],
  ['highest', 'lowest'], ['large', 'small'], ['little', 'large'], ['poor', 'rich'], ['viscid', 'watery'], ['far', 'near'], ['more', 'less'], ['rapid', 'slow'], ['fast', 'slow'], ['myelinated', 'unmyelinated'],
  ['short', 'long'], ['single', 'double'], ['hypertonic', 'hypotonic'], ['enter', 'leave'], ['enters', 'leaves'], ['gain', 'loss'], ['acidic', 'alkaline'], ['voluntary', 'involuntary'], ['maximum', 'minimum'],
  ['anterior', 'posterior'], ['internal', 'external'], ['direct', 'indirect'], ['directly', 'indirectly'], ['subjective', 'objective'], ['before', 'after'],
  ['زيادة', 'نقص'], ['يزيد', 'يقلل'], ['تزيد', 'تقلل'], ['ارتفاع', 'انخفاض'], ['توسع', 'تضيق'], ['انقباض', 'انبساط'], ['تحفيز', 'تثبيط'], ['يحفز', 'يثبط'], ['مرتفع', 'منخفض'], ['كبير', 'صغير'], ['سريع', 'بطيء']];
const FLIP = new Map(); FLIP_PAIRS.forEach(([a, b]) => { if (!FLIP.has(a)) FLIP.set(a, b); if (!FLIP.has(b) && !/ /.test(a)) FLIP.set(b, a); });
const DIR_RE = /\b(increased?|increases|increasing|decreased?|decreases|reduced?|reduces|reducing|reduction|elevation|elevated|raises?|lowers?|dilat(?:e|es|ed|ion)|constrict(?:s|ed|ion)?|bronchodilation|bronchoconstriction|vasodilation|vasoconstriction|stimulat(?:e|es|ed|ion|ory)|inhibit(?:s|ed|ion|ory)?|contraction|contracts?|relaxation|relax(?:es)?|closure|opening)\b/i;
const caseLike = (w, model) => (!w ? w : /^[A-Z]{2,}$/.test(model) ? w.toUpperCase() : /^[A-Z]/.test(model) ? w[0].toUpperCase() + w.slice(1) : w);
/** the statement with every direction word reversed (null when it states no direction) */
const fixArticles = (t) => t.replace(/\b([Aa])n?\s+([a-zA-Z])/g, (x, a, c) => (/[aeiouAEIOU]/.test(c) ? a + 'n ' : a + ' ') + c);
function flipText(s) { let n = 0; const out = String(s).replace(/[\p{L}]+/gu, (w) => { const f = FLIP.get(w.toLowerCase()); if (!f) return w; n++; return caseLike(f, w); }); return n && out !== s ? fixArticles(out) : null; }
/** «ribose instead of deoxyribose» -> «deoxyribose instead of ribose»; «in cell number, not in cell size» -> «in cell size, not in cell number» */
function swapText(s) {
  const m = String(s).match(/^(.*?)((?:[\p{L}\p{N}-]+\s+){0,2}[\p{L}\p{N}-]+)(\s+(?:instead of|rather than)\s+|,\s+not\s+(?:in |on |at |of )?)((?:[\p{L}\p{N}-]+\s+){0,2}[\p{L}\p{N}-]+)(.*)$/u); if (!m) return null;
  let a = m[2].split(/\s+/), b = m[4].split(/\s+/); const k = Math.min(a.length, b.length); let best = 1;
  for (let i = 2; i <= k; i++) if (a[a.length - 1].toLowerCase() === b[i - 1].toLowerCase() || a.slice(-i).join(' ').length <= 24) best = i;
  if (a[a.length - 1].toLowerCase() === b[b.length - 1].toLowerCase() && a.length >= 2 && b.length >= 2) best = 2;
  const A = a.slice(-best).join(' '), B = b.slice(0, best).join(' '); if (normKey(A) === normKey(B) || isFunc(A.toLowerCase()) || isFunc(B.toLowerCase())) return null;
  const pre = m[1] + a.slice(0, a.length - best).join(' ') + (a.length > best ? ' ' : ''), post = b.slice(best).join(' ');
  const out = `${pre}${B}${m[3]}${A}${post ? ' ' + post : ''}${m[5]}`.replace(/\s+/g, ' ').trim(); return out !== s ? out : null; }
/** an over-claim: what the lecture hedges («can», «may», «most», «usually») said as a rule («always», «all») - a classic wrong option of «which is most accurate» */
function overclaim(s) {      // «can be» -> «is always», «usually / often» -> «always», «most / some / many bacteria» -> «all bacteria» (never «the most common» -> «the all common»)
  const r = [[/\b(?:can|may) be\b/i, () => 'is always'], [/\busually\b/i, () => 'always'], [/\boften\b/i, () => 'always']]; for (const [rx, w] of r) if (rx.test(s) && !/\bnot\s+$/i.test(s.slice(0, s.search(rx)))) { const out = s.replace(rx, (x) => caseLike(w(), x)); if (out !== s) return out; }
  const m = String(s).match(/(^|[^\p{L}])(most|some|many)(\s+(?:of\s+(?:the\s+)?)?[a-z]+s)\b/iu); if (!m || /\bthe\s*$/i.test(s.slice(0, m.index + m[1].length))) return null;
  const out = s.slice(0, m.index) + m[1] + caseLike('all', m[2]) + m[3] + s.slice(m.index + m[0].length); return out !== s ? out : null; }
function negateText(s) { const r = [[/\bcannot\b/i, 'can'], [/\bcan't\b/i, 'can'], [/\bcan not\b/i, 'can'], [/\bis not\b/i, 'is'], [/\bare not\b/i, 'are'], [/\bdoes not\b/i, 'does'], [/\bdo not\b/i, 'do'], [/\bnot\s/i, ''], [/\bis\b/i, 'is not'], [/\bare\b/i, 'are not'], [/\bcan\b/i, 'cannot']];
  for (const [rx, w] of r) if (rx.test(s)) { const out = s.replace(rx, (x) => caseLike(w, x)).replace(/\s+/g, ' '); if (out !== s) return out; } return null; }
const nuanced = (s) => !!(swapText(s) || overclaim(s));      // a statement with a qualifier or a contrast in it: judging its altered copies is critical reading, not recall
const sameWords = (a, b) => normKey(a).split(' ').sort().join(' ') === normKey(b).split(' ').sort().join(' ');
const mutations = (s) => [flipText(s), swapText(s), negateText(s), overclaim(s)].filter((x, i, a) => x && normKey(x) !== normKey(s) && !sameWords(x, s) && a.findIndex((y) => y && normKey(y) === normKey(x)) === i);
const titleCase = (t) => { const w = String(t).split(/\s+/).filter((x) => /^\p{L}{4,}/u.test(x)); return w.length >= 3 && !/[.!?]$/.test(String(t).trim()) && w.filter((x) => /^\p{Lu}/u.test(x)).length >= w.length * 0.8; };
const cleanStmt = (t) => strip(String(t).replace(/^[\s.,;:•●▪◦‣-]+/, '').replace(/\s*(?:e\.\s?g\.?|eg\.?|examples?\s*:?|for example,?)\s*$/i, '').replace(/[.]\s+(?:it|they|this)\s+(?:may|can|is|are)(?:\s+be)?\s*$/i, '.').replace(/[:]\s*$/, ''));
// measured offline: for each form, the share of its questions that asked a fact the teachers also asked in their own quizzes on the same lectures (ANS, microbiology,
// nursing process; 50 and 100 questions each), smoothed: 0.35 + 0.5 x (hits + 1) / (questions + 4). The agent starts from these and its own evidence takes over.
const PRIORS_FROM_TEACHERS = {"pairing": 0.636, "leastEffect": 0.636, "famOrder": 0.696, "matchRow": 0.628, "bestDef": 0.683, "distinguish": 0.623, "caseLead": 0.564, "caseEffect": 0.6, "exceptPoint": 0.6, "listNot": 0.637, "setOf": 0.577, "rangeQ": 0.55, "defMeaning": 0.577, "falseOf": 0.558, "caseExample": 0.537, "famLead": 0.55, "effectRecall": 0.493, "listBelongs": 0.493, "defToTerm": 0.489, "statement": 0.475, "defCloze": 0.475, "cloze": 0.465, "bestPoint": 0.465, "exampleOf": 0.441, "accurateOf": 0.4, "bestEffect": 0.406, "pickExample": 0.4, "caution": 0.421, "numValue": 0.433, "numStatement": 0.45, "acroQ": 0.406};
// ================================================================ THE SELF-LEARNING AGENT — the local generator improves itself from the students' answers
// Every local question carries the name of the FORM that wrote it (caseEffect, bestPoint, cloze…). Each answer a student gives is an observation:
//  · how hard the form's questions are (right / wrong) - questions everybody gets right, or nobody does, teach little; the most useful sit around 60 %;
//  · which kind of wrong option was chosen (a reversed direction, a swapped pair, a negation, an over-claim, a sibling's item…) - a wrong option nobody picks
//    is not doing its job; the kinds students actually fall for are the plausible ones;
//  · a report («بلّغ عن مشكلة») against a question - a strong sign the form misfired.
// After every answer the agent updates its numbers (kept on this device), and every NEXT quiz is written with them: for each identity the forms are tried in
// the order of their learned quality (with a small bonus for forms it knows little about, so it keeps exploring), and the wrong options are chosen by the kinds
// students fall for. It starts from PRIOR beliefs measured offline (how often each form asked what teachers ask, on real lectures and teachers' own quizzes),
// and its own evidence takes over as answers accumulate. Without answers it changes nothing.
const LEARN = (() => {
  // the self-learning agent: two jobs only - (1) learn from every answer students give, (2) learn from every report on a question - and order each identity's forms by what it learned
  const KEY = 'quizzy_learner_v1', MIN_ANSWERS = 30;
  // prior: share of a form's questions that asked a fact the teachers also asked (ANS, microbiology, nursing; 100 questions each) - see docs/STATUS.md
  const PRIOR = Object.assign(Object.create(null), PRIORS_FROM_TEACHERS);
  let S = null; const blank = () => ({ v: 1, answers: 0, forms: {}, reports: 0, since: Date.now(), updated: 0 });
  const store = () => { try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; } catch (_) { return null; } };
  const load = () => { if (S) return S; try { const raw = store() && store().getItem(KEY); S = raw ? JSON.parse(raw) : blank(); if (!S || S.v !== 1) S = blank(); } catch (_) { S = blank(); } return S; };
  const save = () => { S.updated = Date.now(); try { const st = store(); if (st) st.setItem(KEY, JSON.stringify(S)); } catch (_) { /* storage full or blocked: learning stays in memory */ } };
  const F = (form) => { const s = load(); return s.forms[form] || (s.forms[form] = { answered: 0, correct: 0, reports: 0 }); };
  /** (1) one answer: q = { form, options: [texts], correct_index }, chosen = index of the option picked (null = left blank) */
  function observe(q, chosen) { if (!q || !q.form || chosen == null || !Array.isArray(q.options)) return; const f = F(q.form); f.answered++; load().answers++; if (chosen === q.correct_index) f.correct++; save(); }
  /** (2) a report on a question counts against the form that wrote it */
  function report(form) { if (!form) return; F(form).reports++; load().reports++; save(); }
  const ready = () => load().answers >= MIN_ANSWERS;
  /** a form's learned quality in [0, 1]: its prior, then its evidence - difficulty near 60 % right is best, reports count heavily against it */
  function score(form) { const f = load().forms[form]; const prior = PRIOR[form] != null ? PRIOR[form] : 0.5; if (!f || !f.answered) return prior;
    const p = (f.correct + 1) / (f.answered + 2); const diff = Math.max(0, 1 - Math.abs(p - 0.6) / 0.6); const rep = Math.min(1, (f.reports * 8) / (f.answered + 4));
    const ev = 0.75 * diff + 0.25 * (1 - rep) - 0.5 * rep; const w = f.answered / (f.answered + 15); return Math.max(0, Math.min(1, (1 - w) * prior + w * ev)); }
  /** the forms of one identity in the order to try them: unchanged until the agent has seen enough answers; then by learned quality (+ an exploration bonus) */
  function rank(forms) { if (!ready()) return forms; const s = load();
    return forms.map((f, i) => { const a = (s.forms[f] || {}).answered || 0; return [f, score(f) + 0.08 / Math.sqrt(a + 1), i]; }).sort((x, y) => (Math.abs(y[1] - x[1]) > 0.04 ? y[1] - x[1] : x[2] - y[2])).map((x) => x[0]); }
  function stats() { const s = load(); const qtypeOf = {}; Object.entries(FORMS).forEach(([t, l]) => l.forEach((f) => { qtypeOf[f] = t; }));
    const forms = Object.keys(Object.assign({}, PRIOR, s.forms)).filter((f) => qtypeOf[f]).map((f) => { const x = s.forms[f] || {}; return { form: f, qtype: qtypeOf[f], score: +score(f).toFixed(3), prior: PRIOR[f] != null ? PRIOR[f] : null, answered: x.answered || 0, correct: x.correct || 0, reports: x.reports || 0 }; }).sort((a, b) => b.score - a.score);
    return { answers: s.answers, reports: s.reports, ready: ready(), min_answers: MIN_ANSWERS, since: s.since, updated: s.updated, forms }; }
  function reset() { S = blank(); save(); }
  function importState(o) { if (o && o.v === 1 && o.forms) { S = o; save(); return true; } return false; }
  return { observe, report, score, rank, stats, reset, export: () => JSON.parse(JSON.stringify(load())), import: importState, _mem: () => { S = blank(); } };
})();

const cleanTitle = (t) => strip(String(t).replace(/\s*\((?:cont(?:inued)?[^)]*|\d+)\)\s*$/i, '').replace(/\s*[-–]\s*\d+\s*$/, '').replace(/\s*[:：]\s*$/, '').replace(/\s+/g, ' '));
const shortPoint = (t, n = 16) => { const s = strip(String(t).replace(/^[•●▪◦○■□▫‣⁃·*✓✔➢❑◼\s]+/, '')); return wc(s) <= n ? s : null; };
const singular = (w) => w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
const tokenSet = (s) => new Set(tokensOf(s).filter((t) => !isFunc(t.lw) && t.w.length > 3).map((t) => singular(t.lw)));
const overlap = (a, b) => { const A = tokenSet(a), B = tokenSet(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((x) => B.has(x) && n++); return n / Math.min(A.size, B.size); };
const ORGAN = /^(heart|cardiac|pupil|eye|vision|saliva|salivary|bladder|urinary|urine|digestive|gastrointestinal|stomach|intestine|bowel|bronch\w*|respiratory|airway|lung|sweat|vessel|liver|kidney|pancrea\w*|skin|gland|uterus|genital\w*|penis|muscle|brain|blood|glucose|pressure|coronar\w*|sphincter|defecation)$/;
const ORDER_WORD = /\b(phases?|stages?|steps?|periods?|sequence|order|process|chain|cycle|development|course|progression|links?|levels?)\b/i;

function structureMine(pagesList, out) {
  const L = out.__lines; const refs = pagesList.map((p) => p.ref); const pn = (r) => +String(r).split('p').pop() || 0;
  const titleOf = (ref) => { const ls = L[ref] || [], a = ls[0], b = ls[1]; if (!a) return ''; const wrap = b && !b.bullet && b.words <= 2 && /^[A-Z]/.test(b.text) && !/[.:!?]$/.test(a.text) && a.words <= 7 && !markOf(b.raw);      // «Responses to Increased Sympathetic» / «Activity»
    return cleanTitle(wrap ? a.text + ' ' + b.text : a.text); };
  // ---- (1) sections
  const secs = [];
  refs.forEach((ref) => { const lines = L[ref] || []; const marks = lines.map((l) => markOf(l.raw));
    lines.forEach((l, i) => { const mk = marks[i]; if (!mk) return; const rest = mk.rest.trim(); const c = rest.match(/^(.{2,60}?)\s*[:：]\s*(.*)$/);
      let lead, tail = ''; if (c && wc(c[1]) <= 7) { lead = c[1]; tail = c[2]; } else if (wc(rest) <= 7 && !/[.!?]$/.test(rest)) lead = rest; else return;
      lead = strip(lead).replace(/\s+/g, ' '); if (/^[A-Z\s.&-]+$/.test(lead) && /[A-Z]{3}/.test(lead)) lead = lead.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()); if (lettersShare(lead) < 0.6 || !/\p{L}{2}/u.test(lead) || DIR_RE.test(lead)) return;
      const nextMarked = i + 1 < lines.length && !!marks[i + 1]; if (!tail && !/[:：]\s*$/.test(rest) && nextMarked && mk.kind !== 'roman' && mk.kind !== 'step') return;      // an item of a numbered list, not a heading
      const pts = []; if (shortPoint(tail, 30)) pts.push({ text: strip(tail), raw: l.raw });
      for (let j = i + 1; j < lines.length && pts.length < 6; j++) { if (marks[j]) break; const x = lines[j]; if ((x.words <= 4 && !/[:.]$/.test(x.text) && /^[A-Z]/.test(x.text) && !x.bullet && pts.length) || titleCase(x.text)) break; if (x.words >= 3 && sound(x.text) && !x.endsColon && !/\b(are|is|of|to|the|and|or|be|as)$/i.test(strip(x.text))) pts.push({ text: cleanStmt(x.text), raw: x.raw }); }
      secs.push({ ref, kind: mk.kind, n: mk.n, lead, line: l.raw, points: pts, src: 'mark', idx: i }); }); });
  refs.forEach((ref) => { const lines = L[ref] || []; lines.forEach((l, i) => { if (!l.endsColon || l.words > 6 || markOf(l.raw) || i + 1 >= lines.length || lines[i + 1].endsColon) return; const lead = strip(l.text); if (badTerm(lead) || NOT_TERM.test(lead) || DIR_RE.test(lead) || /\b(except|include|includes|including|as|are|is|of|to|by|with|for|from|that|which|when|via|into)$/i.test(lead) || /^\w+ly\b/i.test(lead) || /\bto\b/i.test(lead) && wc(lead) >= 3) return;
    const pts = []; for (let j = i + 1; j < lines.length && pts.length < 5 && !lines[j].endsColon && !markOf(lines[j].raw); j++) if (lines[j].words >= 3 && sound(lines[j].text)) pts.push({ text: cleanStmt(lines[j].text), raw: lines[j].raw });
    if (!pts.length) return; secs.push({ ref, kind: 'colon', n: null, lead, line: l.raw, points: pts, src: 'colon', idx: i });
    if (!out.defs.some((d) => normKey(d.term) === normKey(lead)) && !(pts.length >= 3 && wc(pts[0].text) <= 6) && wc(pts[0].text) >= 4 && !badTail(pts[0].text)) out.defs.push({ ref, term: lead.replace(/\s*\([A-Z]{2,6}\)$/, ''), tail: pts[0].text, sentence: pts[0].raw, unit: pts[0].raw, fromHead: true }); }); });
  // outline levels (PowerPoint): a paragraph with deeper paragraphs under it is a heading; siblings at one level form a family
  refs.forEach((ref) => { const lines = L[ref] || []; if (!lines.some((l) => l.depth)) return;
    lines.forEach((l, i) => { const d = l.depth || 0; const kids = []; for (let j = i + 1; j < lines.length && (lines[j].depth || 0) > d; j++) if ((lines[j].depth || 0) === d + 1) kids.push(lines[j]); if (!kids.length) return;
      const c = l.text.match(/^(.{2,60}?)\s*[:：]\s*(.*)$/); const lead = strip(c && wc(c[1]) <= 6 ? c[1] : l.text); if (wc(lead) > 6 || DIR_RE.test(lead) || lettersShare(lead) < 0.6 || secs.some((s) => s.ref === ref && s.idx === i)) return;
      const pts = []; if (c && shortPoint(c[2], 30)) pts.push({ text: strip(c[2]), raw: l.raw }); kids.forEach((k) => { if (k.words >= 2 && pts.length < 6) pts.push({ text: strip(k.text), raw: k.raw }); });
      secs.push({ ref, kind: 'depth' + d, n: null, lead, line: l.raw, points: pts, src: 'depth', idx: i, depth: d }); }); });
  refs.forEach((ref) => { const lines = L[ref] || []; lines.forEach((l, i) => { if (i === 0 || l.bullet || l.num != null || l.words > 4 || /[.:!?,;]$/.test(l.text) || !/^[A-Z]/.test(l.text) || markOf(l.raw)) return;
    const pts = []; for (let j = i + 1; j < lines.length && pts.length < 6 && lines[j].bullet && !markOf(lines[j].raw); j++) if (lines[j].words >= 2) pts.push({ text: cleanStmt(lines[j].text), raw: lines[j].raw }); if (pts.length < 2) return;
    secs.push({ ref, kind: 'col', n: null, lead: strip(l.text), line: l.raw, points: pts, src: 'col', idx: i }); }); });
  // titles that share a stem: «Pathogenic Properties of Virus / of Fungi / of Algae»
  const shortLines = []; refs.forEach((ref) => (L[ref] || []).forEach((l, i) => { const t = cleanTitle(l.text); if (wc(t) >= 3 && wc(t) <= 7 && !/[.!?,;]$/.test(l.text) && /^[A-Z]/.test(t)) shortLines.push({ ref, i, t, l }); }));
  const byStem = new Map(); shortLines.forEach((x) => { const w = x.t.split(/\s+/); for (let k = w.length - 1; k >= 2; k--) { const stem = w.slice(0, k).join(' ').toLowerCase(), rest = w.slice(k).join(' '); if (!rest || wc(rest) > 3 || !/^[A-Z]/.test(rest) || rest.split(/\s+/).some((y) => isFunc(y.toLowerCase()))) continue; if (!byStem.has(stem)) byStem.set(stem, new Map()); const m = byStem.get(stem); if (!m.has(rest.toLowerCase())) m.set(rest.toLowerCase(), { ...x, name: rest, stem: w.slice(0, k).join(' ') }); } });
  const stemFams = []; [...byStem.entries()].filter(([, m]) => m.size >= 3).sort((a, b) => b[0].length - a[0].length).forEach(([stem, m]) => { if (stemFams.some((f) => f.stem.startsWith(stem))) return;
    const mem = [...m.values()].map((x) => { const lines = L[x.ref]; const pts = []; for (let j = x.i + 1; j < lines.length && pts.length < 6; j++) { const y = lines[j]; if (shortLines.some((z) => z.ref === x.ref && z.i === j && byStem.get(stem).has(z.t.split(/\s+/).slice(stem.split(' ').length).join(' ').toLowerCase()) && z.t.toLowerCase().startsWith(stem))) break; if (y.words >= 3 && sound(y.text) && !/^[A-Z][^.]{0,40}$/.test(y.text.trim()) || (y.words >= 3 && y.bullet)) pts.push({ text: strip(y.text), raw: y.raw }); }
      return { ref: x.ref, kind: 'stem', n: null, lead: x.name, full: x.t, line: x.l.raw, points: pts, src: 'stem', idx: x.i }; });
    stemFams.push({ stem, members: mem }); });
  // ---- families: marked sections numbered 1,2,3… (across pages, a gap of up to 4 pages), outline siblings, title stems
  const fams = []; const seen = new Set();
  ['num', 'alpha', 'roman', 'step'].forEach((kind) => { let cur = null; secs.filter((s) => s.kind === kind).sort((a, b) => pn(a.ref) - pn(b.ref) || a.idx - b.idx).forEach((s) => {
    if (cur && s.n === cur[cur.length - 1].n + 1 && pn(s.ref) - pn(cur[cur.length - 1].ref) <= 4) { cur.push(s); return; }
    if (cur && s.n <= cur[cur.length - 1].n && s.n > 1 && pn(s.ref) - pn(cur[cur.length - 1].ref) <= 4 && cur.some((c) => c.n === s.n)) return;      // «2. Reservoir of infection» repeated under «Breaking the chain»: not a new member
    if (cur && cur.length >= 2) fams.push({ members: cur, kind }); cur = [s]; }); if (cur && cur.length >= 2) fams.push({ members: cur, kind }); });
  refs.forEach((ref) => { const cs = secs.filter((s) => s.ref === ref && s.src === 'col'); if (cs.length >= 2) fams.push({ members: cs, kind: 'col' }); });
  refs.forEach((ref, ri) => { const ds = secs.filter((s) => s.ref === ref && s.src === 'depth'); const levels = [...new Set(ds.map((s) => s.depth))];
    levels.forEach((d) => { const grp = ds.filter((s) => s.depth === d); if (grp.length < 2) return;
      const prevF = fams.find((f) => f.kind === 'depth' && f.depth === d && pn(f.members[f.members.length - 1].ref) === pn(ref) - 1 && overlap(titleOf(f.members[0].ref), titleOf(ref)) >= 0.5);
      if (prevF) prevF.members.push(...grp); else fams.push({ members: grp, kind: 'depth', depth: d }); }); });
  stemFams.forEach((f) => fams.push({ members: f.members, kind: 'stem', stem: f.stem }));
  fams.forEach((f) => { const leads = f.members.map((m) => m.lead.toLowerCase()); f.members = f.members.filter((m, i) => leads.indexOf(m.lead.toLowerCase()) === i);
    const last = f.members.map((m) => singular((m.lead.split(/\s+/).pop() || '').toLowerCase())); f.noun = last.every((w) => w === last[0] && w.length > 2) && /^(phase|stage|period|step|link|type|group|factor|level|class|method|mode|route|layer|region|form|category|component|process|division|system|receptor|organ|gland|hormone|cell|tissue|test|sign|symptom|disease|infection|drug|nerve)$/.test(last[0]) ? last[0] : null;
    const near = [...new Set(f.members.flatMap((m) => [m.ref, refs[refs.indexOf(m.ref) - 1], refs[refs.indexOf(m.ref) - 2]]))].filter(Boolean);
    f.ordered = (f.kind === 'step' || f.members.some((m) => ORDER_WORD.test(m.lead)) || (f.kind !== 'stem' && near.some((r) => ORDER_WORD.test(titleOf(r)))) || (f.kind === 'depth' && f.members.some((m) => ORDER_WORD.test(titleOf(m.ref))))) && f.members.length >= 3;
    f.members.forEach((m) => { m.fam = f; }); });
  out.secs = secs.concat(stemFams.flatMap((f) => f.members)); out.fams = fams.filter((f) => f.members.length >= 2);
  // ---- (2) examples
  const EG = /(?:\be\.\s?g\.?\s*[:,]?|\beg\.\s|\bfor example,?|\bexamples?(?:\s+of\s[^:]{2,50}?)?\s*(?:are|include|:)|\bcommon types\s*:|\bsuch as)\s*/i;
  const exPieces = (s0, keepLower) => { const s = strip(String(s0).split(/[);]/)[0].replace(/\([^)]*\)?/g, ' ').split(/\b(?:that|which|who)\b/)[0]); let caps = false; return s.split(/\s*(?:,|;|\band\b|\bor\b|\betc\.?)\s*/i).map((x) => x.trim()).filter(Boolean).map((x) => { const w = x.split(/\s+/); const keep = []; for (const t of w) { const lw = t.toLowerCase().replace(/[^\p{L}\p{N}.-]/gu, ''); if (keep.length && (/^(and|or|but|is|are|was|were|be|can|could|may|might|will|would|has|have|had|do|does|did|not|no)$/.test(lw) || VERBS.has(lw) || VERBS.has(lw.replace(/e?s$/, '')) || /^(cause|causes|carries|carry|produce|produces|tolerates?|block|blocks|stop|stops)$/.test(lw))) break; keep.push(t); if (keep.length >= 4) break; } return strip(keep.join(' ').split(':')[0].replace(/^[-–•\s]+/, '').replace(/[():]+$/g, '')); })
    .filter((x) => x && x.length >= 3 && wc(x) <= 4 && lettersShare(x) >= 0.7 && !/^(many|some|other|others|all|most|several|the|this|these|it|its|common|typical|usual)\b/i.test(x) && !/\b(of|to|in|on|at|with)$/i.test(x))
    .filter((x, i) => { if (i === 0) caps = /^[A-Z]/.test(x); return keepLower || !caps || /^[A-Z]/.test(x) || /(itis|osis|emia|iasis)$/i.test(x); }); };      // «Measles, production of interferon…»: after a named example, the lower-case pieces are other statements
  const examples = [];
  refs.forEach((ref) => { const lines = L[ref] || []; let lastTerm = null;
    lines.forEach((l, i) => { const d = defFromLine(l); const np = (l.text.match(/^([A-Z][\p{L}-]+(?:\s[\p{L}-]+){0,2})\s*\(/u) || [])[1]; const mk = markOf(l.raw);
      const ct = (l.text.match(/^(.{2,50}?)\s*[:：](?:\s|$)/) || [])[1]; const own = d ? d.term : np || (mk && wc(strip(mk.rest.split(':')[0])) <= 5 ? strip(mk.rest.split(':')[0]) : null) || (ct && wc(ct) <= 5 && !badTerm(ct) ? strip(ct) : null);
      const m = l.text.match(EG); if (m) { const raw0 = l.text.slice(0, m.index).replace(/\([^)]*\)?/g, ' '); const segs = raw0.split(/[.;](?=\s)|\s[-–]\s|\s{3,}/); let before = strip(segs[segs.length - 1].replace(/^[\s:,-]+/, '')); if (/^(can|may|might|will|is|are|was|were|has|have)\b/i.test(before) && segs.length > 1) before = strip(segs[segs.length - 2]); let cat = null;
        const secHere = () => { const c = out.secs.filter((x) => x.ref === ref && x.idx <= i).sort((a, b) => b.idx - a.idx)[0]; return c ? (c.full || c.lead) : null; };
        if (segs.length > 1 && wc(before) >= 2 && wc(before) <= 8 && !/^(it|they|these|this|those)\b/i.test(before) && !OBJ_VERB.test(before) && /[.;]\s*$/.test(segs.slice(0, -1).join('.').trim() + '.')) cat = before; else if (d && l.text.indexOf(d.tail) < m.index) cat = d.term; else if (own && ct && l.text.indexOf(ct) === 0 && wc(before) > 8) cat = own; else if (/^(it|they|these|this|those)\b/i.test(before)) cat = secHere(); else if (wc(before) >= 1 && wc(before) <= 8 && !/[.:]\s*$/.test(raw0.trim()) && !OBJ_VERB.test(before)) cat = before.replace(/^(?:\d+[-.)]\s*|[A-H][.-]\s*)/, ''); else if (!before.trim() || /[.]\s*$/.test(raw0.trim()) || /^(examples?|common types|e\.\s?g)/i.test(l.text)) cat = (own && l.text.indexOf(':') < m.index && l.text.indexOf(':') >= 0 ? own : null) || lastTerm; else if (own) cat = own; else cat = d ? d.term : null;
        if (cat) cat = strip(cat.split(/\s*:\s/)[0]); if (cat && wc(cat) <= 8 && !/[:]$/.test(cat)) exPieces(l.text.slice(m.index + m[0].length).split(/[.](?=\s+[A-Z])/)[0]).forEach((ex) => { if (normKey(ex) !== normKey(cat)) examples.push({ ref, category: strip(cat), example: ex, sentence: l.raw, idx: i }); }); }
      if (own && !m) lastTerm = own; else if (own && m && d) lastTerm = d.term;
      if (l.depth && i > 0) { const head = [...lines.slice(0, i)].reverse().find((x) => (x.depth || 0) === l.depth - 1); const hd = head && defFromLine(head);      // «Direct care: …» with «Bathing, teaching, listening…» under it
        if (hd && /,/.test(l.text) && !defFromLine(l) && (l.text.match(/,/g) || []).length >= 2) exPieces(l.text, true).filter((x) => /^[A-Za-z]/.test(x)).forEach((ex) => examples.push({ ref, category: hd.term, example: ex, sentence: l.raw, idx: i, action: true })); } }); });
  out.examples = examples.filter((e, i, a) => a.findIndex((x) => normKey(x.example) === normKey(e.example) && normKey(x.category) === normKey(e.category)) === i);
  // ---- (3) effect lists: per page, the marked / bulleted points, most of them stating a direction
  const effects = [];
  refs.forEach((ref) => { const lines = L[ref] || []; if (lines.length < 3) return; const title = titleOf(ref); const items = lines.slice(1).filter((l) => l.bullet || l.num != null || markOf(l.raw));
    const parts = items.flatMap((l) => l.text.split(/\s(?=\d{1,2}\s?\.\s?[a-zA-Z])/).map((x, k) => (k ? { ...l, text: x.replace(/^\d{1,2}\s?\.\s?/, ''), words: wc(x) } : { ...l, text: x, words: wc(x) })));
    const dirItems = parts.filter((l) => DIR_RE.test(l.text) && l.words >= 2 && l.words <= 30); if (dirItems.length < 3 || dirItems.length < items.length * 0.5) return;
    const cond = cleanTitle(title).replace(/^(responses?|effects?|actions?|results?|signs?|changes?|consequences?|features?|findings?)\s+(?:to|of|in|during|on)\s+/i, '').replace(/\s+/g, ' ');
    if (!cond || wc(cond) > 10) return; const ex = effects.find((e) => normKey(e.cond) === normKey(cond)); const its = dirItems.map((l) => ({ text: strip(l.text.replace(/^\d{1,2}\s?[-.)]\s*/, '')), raw: l.raw, ref }));
    if (ex) ex.items.push(...its); else effects.push({ ref, cond, title, items: its }); });
  effects.forEach((e) => { const ct = tokenSet(e.cond); e.opp = effects.find((o) => o !== e && [...tokenSet(o.cond)].some((t) => [...ct].some((u) => antonym(t, u) || (t !== u && (t.endsWith(u) || u.endsWith(t)) && Math.abs(t.length - u.length) <= 4)))) || null; });
  const allEff = effects.flatMap((e) => e.items); const df = new Map(); allEff.forEach((it) => tokenSet(it.text.replace(DIR_RE, ' ')).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const organ = (it) => [...tokenSet(it.text.replace(DIR_RE, ' '))].filter((t) => !/^(activity|effect|effects|cause|system|function|functions|secretion|secretions|level|rate|increase|reduce|allow)$/.test(t) && (df.get(t) || 0) <= 3);
  effects.forEach((e) => e.items.forEach((it) => { it.organ = organ(it); it.flip = flipText(it.text); it.eff = e; if (e.opp) { const cand = e.opp.items.map((o) => { const sh = organ(o).filter((t) => it.organ.includes(t)); return [o, sh.length + (sh.some((t) => ORGAN.test(t)) ? 1 : 0)]; }).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]); it.pair = cand.length && (cand.length === 1 || cand[0][1] > cand[1][1]) ? cand[0][0] : null; } }));
  out.effects = effects.filter((e) => e.items.length >= 3);
  // ---- (4) glosses and acronyms
  const gloss = [];
  refs.forEach((ref) => (L[ref] || []).forEach((l) => { let m; const t = l.text; if (t.indexOf('(') < 0) return;      // no bracket, no gloss (and no slow regex scan of the line)
    const ar = /([A-Za-z][\p{L}’'-]*(?:\s+[\p{L}’'-]+){0,7})\s*\(\s*([A-Za-z][A-Za-z-]{1,7})\s*\)/gu; while ((m = ar.exec(t))) { const acro = m[2]; const up = acro.replace(/[^A-Z]/g, ''); if (up.length < 2 && !/^[a-z]?[A-Z]{2,}/.test(acro)) continue;
      const words = m[1].split(/\s+/); const content = words.map((w, k) => [w, k]).filter(([w]) => !isFunc(w.toLowerCase())); let exp = null;
      if (up.length >= 2 && content.length >= up.length && !/^[a-z]/.test(acro)) { const span = content.slice(-up.length); const ini = span.map(([w]) => w[0].toUpperCase()).join(''); if (ini === up) exp = words.slice(span[0][1]).join(' '); }
      const lastW = (words[words.length - 1] || '').replace(/[^\p{L}]/gu, ''); const subseq = (a, b) => { let k = 0; for (const ch of b) if (ch === a[k]) k++; return k === a.length; };
      if (!exp && lastW.length > acro.length + 2 && lastW[0].toLowerCase() === acro[0].toLowerCase() && subseq(acro.toLowerCase(), lastW.toLowerCase()) && !/^[a-z]/.test(acro)) exp = lastW;
      if (exp && (wc(exp) >= 2 || /^[a-z]{6,}$/i.test(exp))) gloss.push({ ref, term: acro, mean: strip(exp), sentence: l.raw, kind: 'acronym' });
      else if (/^[a-z][A-Z]{2,}$/.test(acro)) { const tail = content.slice(-3).map(([w]) => w); const desc = strip(words.slice(Math.max(0, words.length - 4)).join(' ').replace(/^.*?\b(?:as|are|is)\s+(?:a\s+|an\s+|the\s+)?/i, '').replace(/^(a|an|the|of|used|RNA|DNA)\s+/i, '')); if (wc(desc) >= 1 && wc(desc) <= 4) gloss.push({ ref, term: acro, mean: desc, sentence: l.raw, kind: 'role' }); } }
    if ((m = t.match(/^([A-Z][\p{L}-]{3,}(?:\s[\p{L}-]+){0,1})\s*\(\s*([^)]{4,40}?)\s*\)\s*$/u)) && !/\d/.test(m[2]) && !/^[A-Z]{2,}$/.test(m[2]) && !/^(cont|continued|contd|see|e\.g|i\.e)\b/i.test(m[2]) && wc(m[2]) <= 5) gloss.push({ ref, term: m[1], mean: strip(m[2].replace(/\s*[-–]\s*/g, '-').replace(/\s+/g, ' ')), sentence: l.raw, kind: 'gloss' }); }));
  out.gloss = gloss.filter((g, i, a) => a.findIndex((x) => normKey(x.term) === normKey(g.term)) === i);
  // ---- (5) ranges and (6) purposes, from the sentences
  const ranges = [], purposes = [];
  const SPINAL = /\b([CTLS])(\d{1,2})\s*(?:-|–|to|through)\s*([CTLS])(\d{1,2})\b/; const NUMR = /(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)(?:\s*(%|°C|°F|mmHg|mg|g|kg|mL|ml|years?|hours?|days?|minutes?|weeks?))?/;
  const PURPOSE = /^(.{6,110}?)\s+(?:in order\s+)?to\s+(increase|decrease|reduce|prevent|allow|protect|ensure|maintain|provide|help|control|improve|hide|identify|transfer|prepare|restrict|avoid|promote|support|facilitate|enable|detect|determine|remove|keep|limit|stop|block|stimulate|inhibit|regulate|relieve|evade|escape|minimi[sz]e|maximi[sz]e)\b(.{3,90})$/i;
  refs.forEach((ref) => { const ls = L[ref] || []; const joined = ls.map((l) => l.text).join(' ').replace(/\s+/g, ' ');
    splitSentences(joined).forEach((t) => { let m; const g = new RegExp(SPINAL.source, 'g'); while ((m = g.exec(t))) ranges.push({ ref, sentence: t, text: m[0], index: m.index, cls: 'spinal', line: t });
      const g2 = new RegExp(NUMR.source, 'g'); while ((m = g2.exec(t))) if (!/\b(19|20)\d{2}\b/.test(m[0]) && +m[1] < +m[2] && !/[\p{L}\d.]/u.test(t[m.index - 1] || '') && wc(t) >= 3 && wc(t) <= 90) ranges.push({ ref, sentence: t, text: m[0].trim(), index: m.index, cls: m[3] ? 'u:' + m[3].toLowerCase() : (+m[2] <= 14 ? 'small' : 'num'), line: t, lo: +m[1], hi: +m[2] }); }); });
  refs.forEach((ref) => (L[ref] || []).forEach((l) => { const t = l.text; let m;
    if ((m = t.match(PURPOSE)) && wc(m[1]) >= 2 && !/^(it|this|that|they|these|there)\b/i.test(m[1]) && !/\b(begins?|starts?|continues?|tends?|needs?|likely|able|unable|has|have|is|are|seems?|appears?|going|wants?|tries|try|learn|must|ought|used)$/i.test(m[1].trim()) && !/\b(which|who|whom|whose|in which|that)\b/i.test(m[1]) && sound(t)) {
      let act = strip(m[1].replace(/^\d{1,2}\s?[-.)]\s*/, '')); const dm = act.match(/^(.{2,50}?)\s*[:：]\s+/); if (dm && wc(dm[1]) <= 5) act = strip(dm[1]); purposes.push({ ref, sentence: l.raw, act, purpose: strip('to ' + m[2] + m[3].split(/[.;](?=\s|$)/)[0]), line: t }); } }));
  out.ranges = ranges; out.purposes = purposes;
  // ---- statements a word swap or a reversal makes false (for «which is most accurate» / «which is FALSE»)
  const stmts = [];
  const allSecs = out.secs; refs.forEach((ref) => { const title = titleOf(ref); (L[ref] || []).slice(1).forEach((l, i0) => { const i = i0 + 1; const s = cleanStmt(l.text.replace(/^\d{1,2}\s?[-.)]\s*/, '')); if (wc(s) < 5 || wc(s) > 30 || !sound(l.text) || OBJ_VERB.test(s) || fragment(s) || l.endsColon || /^(can|may|might|is|are|was|were|has|have|had|will|could|should|must|do|does|did|used)\b/i.test(s) || /\b(are|is|of|to|the|and|or|be|as|by|with)$/i.test(s) || (s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) return;
    const sec = allSecs.filter((x) => x.ref === ref && x.idx < i && (x.src === 'stem' || x.src === 'mark' || x.src === 'colon')).sort((a, b) => b.idx - a.idx)[0]; const topic = sec ? (sec.full || sec.lead) : title;
    const mut = mutations(s); stmts.push({ ref, sentence: l.raw, text: s, mut, topic, sec: sec ? sec.line : 'page:' + ref, nuanced: nuanced(s) }); }); });
  out.stmts = stmts;
}

// ---------------------------------------------------------------- building questions
/* A source item can be asked in more than one FORM (a definition: term -> meaning, meaning -> term, which statement is true, a missing word of it...). The first form of
 * each type is the original question; the other forms exist so a thin lecture can still fill the requested count WITHOUT repeating a question. Every form is built from verbatim
 * source lines (the evidence stays exact) and rotates with the slot's `variant`. */
const FORMS = { basic_recall: ['defMeaning', 'effectRecall', 'pickExample', 'setOf', 'cloze', 'listBelongs', 'defCloze'], understanding: ['defToTerm', 'acroQ', 'statement'], mechanisms: ['causeEffect', 'purposeQ', 'effectCause'],
  application: ['famLead', 'exampleOf', 'rangeQ', 'numValue', 'numStatement'], not_except: ['listNot', 'leastEffect', 'falseOf', 'exceptPoint'], sequence: ['famOrder', 'seqOrder', 'seqNext'],
  compare_contrast: ['pairing', 'distinguish', 'contrast', 'matchRow'], best_answer: ['bestEffect', 'bestPoint', 'bestDef', 'bestOf'], scenarios: ['caseEffect', 'caseExample', 'caseLead', 'scenario'], critical_thinking: ['accurateOf', 'caution'] };
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
  return { ar, arx, iso, seed, here, take, mk, note, byLen, slot, qt, qts, ex, used, nth: slot.__nth || 0, usedDistractors: used.__dis || (used.__dis = new Set()) };
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
  const stem = (c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length)).replace(/[•●▪◦○■□▫‣⁃·✓✔➢❑◼]\s*/g, '').replace(/^\s*[-–]\s*/, '').trim();
  if (wc(stem.replace('____', '')) < 5) return null;
  return T.mk((T.ar ? 'أكمل العبارة حسب المحاضرة: ' : 'Complete the statement from the lecture: ') + stem, c.term, ordered, c,
    T.ex(`الكلمة الناقصة في جملة المحاضرة هي ${T.qt(c.term)}. الخيارات الأخرى (${T.qts(ordered)}) كلمات من المحاضرة نفسها، لكنها لا تُكمل هذه الجملة.`, `The missing word in the lecture's sentence is ${T.qt(c.term)}. The other options (${T.qts(ordered)}) are words from the same lecture that do not complete this sentence.`),
    `مصطلح أساسي في: ${clip(c.sentence, 50)}${tag ? ' (' + c.term + ')' : ''}`);
}
// items of OTHER lists as distractors: those of a sibling list come first (a list headed the same way, e.g. «ID3» / «C4.5» / «CART», on a page near this one), so a wrong option
// looks like it could belong; an item sharing a word with this list, or found on its page, is never used (it might be true here)
const foreignItems = (m, l, pages) => { const listTok = new Set(E.toks([l.lead, ...l.items].join(' ')).filter((t) => !/^(features?|trees?|model|data|method|algorithms?)$/.test(t) || true)); const short = (x) => { const n = x.lead.split(/\s[-–—]+\s|[:(]/)[0].trim(); return wc(n) === 1 || /\d/.test(n) || /^[A-Z]{2,}\b/.test(n) ? 'name' : wc(n) <= 3 ? 'short' : 'long'; }; const pn = (r) => +String(r).split('p').pop() || 0;      // «ID3 -- Iterative Dichotomizer 3» is named «ID3» const pn = (r) => +String(r).split('p').pop() || 0;
  const seen = new Set(); const out = [];
  const leadKey = (x) => normKey(strip(x.lead).replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').replace(/[:：]\s*$/, '')); const own = new Set(m.lists.filter((x) => leadKey(x) === leadKey(l) || (l.topic && x.topic === l.topic)).flatMap((x) => x.items.map(normKey)));
  const topicText = normKey(((m.__topicPages && m.__topicPages[l.topic]) || [l.ref]).map((r) => pages[r] || '').join(' '));      // the whole topic (all its slides), not only this one      // a list continued on the next slide is ONE list: its other part is never a wrong option
  m.lists.filter((x) => x !== l && leadKey(x) !== leadKey(l) && !(l.topic && x.topic === l.topic)).map((x) => [x, (short(x) === short(l) ? 0 : 6) + Math.min(6, Math.abs(pn(x.ref) - pn(l.ref)))]).sort((a, b) => a[1] - b[1]).forEach(([x, rank]) => x.items.forEach((it) => {
    const k = normKey(it); if (seen.has(k)) return; seen.add(k);
    if (!l.items.some((z) => normKey(z) === k) && !own.has(k) && !topicText.includes(k) && E.toks(it).filter((t) => listTok.has(t)).length * 2 < Math.max(1, E.toks(it).length) && !OBJ_VERB.test(it)) out.push([it, rank]); }));
  return out; };
// «which row correctly matches…» (the shape of the teachers' quizzes): three things of the lecture, each with its short meaning (a definition's head, or the one point a
// sibling list - «ID3» / «C4.5» / «CART» - has and the others do not); wrong rows are the same pairs mixed up
const shortMeaning = (d) => { const t = strip(d.tail).replace(/[.;:]+$/, '').trim(); return wc(t) >= 2 && wc(t) <= 8 && lettersShare(t) >= 0.7 && !/^[a-z]/.test(t) === !/^[a-z]/.test(t) && !/^(in|by|for|on|at|with|from|to|of|using|and|or|but|the|this|that)\b/i.test(t) && !/[,]/.test(d.term) && !/^[a-z]\s/i.test(d.term) && !/^(remark|note|notes|example|hint|tip|caution|warning)s?$/i.test(d.term) ? t : null; };      // the WHOLE meaning, short (a cut-off clause is not a meaning)
const listNameKind = (l) => { const n = l.lead.split(/\s[-–—]+\s|[:(]/)[0].trim(); return wc(n) <= 2 && (/\d/.test(n) || /^[A-Z]{2,}\b/.test(n)) && l.items.filter((it) => wc(it) >= 2).length >= 3; };      // a named method («ID3», «C4.5», «CART») with real points under it
function matchPairs(m) {
  if (m.__pairs) return m.__pairs; const out = [];
  const defs = m.defs.filter((d) => shortMeaning(d) && wc(d.term) <= 4); const seen = new Set();
  defs.forEach((d) => { const k = normKey(d.term); if (seen.has(k)) return; seen.add(k); out.push({ term: d.term, mean: shortMeaning(d), ref: d.ref, x: d, kind: 'def' }); });
  m.defs.forEach((d) => { const v = (d.tail.match(/(\d+(?:\.\d+)?)\s?%/) || [])[0]; if (v && wc(d.term) <= 3 && /^[A-Z]/.test(d.term) && !badTerm(d.term)) out.push({ term: d.term, mean: v.replace(/\s/g, ''), ref: d.ref, x: d, kind: 'num' }); });
  (m.gloss || []).filter((g) => g.kind !== 'acronym').forEach((g) => { if (!seen.has(normKey(g.term))) { seen.add(normKey(g.term)); out.push({ term: g.term, mean: g.mean, ref: g.ref, x: { ref: g.ref, sentence: g.sentence }, kind: 'gloss' }); } });
  const named = m.lists.filter(listNameKind);
  named.forEach((l) => { const others = new Set(named.filter((o) => o !== l).flatMap((o) => o.items.map(normKey))); const own = l.items.find((it) => !others.has(normKey(it)) && wc(it) >= 2 && wc(it) <= 7);
    if (own) out.push({ term: l.lead.split(/\s[-–—]+\s/)[0].trim(), mean: own, ref: l.ref, x: l, kind: 'list' }); });
  return (m.__pairs = out);
}
// ---- helpers of the structure forms
const isHealth = (m) => m.field === 'health';
const cap1s = (s) => String(s).replace(/^\s*\p{Ll}/u, (c) => c.toUpperCase());
const condPhrase = (c) => { const t = String(c).trim(); return /^[A-Z]{2,}\b/.test(t) ? t : t[0].toLowerCase() + t.slice(1).replace(/\b([A-Z])([a-z]+)\b/g, (w, a, b) => (/^(Activity|Activation|System|Response|Division|Discharge|Sympathetic|Parasympathetic|Nervous)$/.test(w) ? a.toLowerCase() + b : w)); };
const condLabels = (e) => { const A = tokensOf(e.cond).map((t) => t.w), B = e.opp ? tokensOf(e.opp.cond).map((t) => t.w) : [];
  for (const a of A) for (const b of B) if (antonym(a, b) || (a.toLowerCase() !== b.toLowerCase() && (a.toLowerCase().endsWith(b.toLowerCase()) || b.toLowerCase().endsWith(a.toLowerCase())))) return [cap1s(a.toLowerCase()), cap1s(b.toLowerCase())];
  return [cap1s(e.cond), cap1s(e.opp ? e.opp.cond : 'other')]; };
const memName = (mem) => { const n = mem.full ? cleanTitle(mem.full) : mem.lead; return /^[A-Z\s.&()-]+$/.test(n) && /[A-Z]{4}/.test(n) ? n.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : n; };
const topicOf = (x) => { const t = cleanTitle(x.topic || ''); return t && wc(t) <= 8 && !/^(introduction|overview|summary|definition|outline|thank)/i.test(t) && normKey(t) !== normKey(x.text) ? t : ''; };
const DISEASE_RE = /(itis|osis|emia|aemia|iasis|pathy)$|\b(disease|poisoning|infections?|fever|flu|influenza|hepatitis\s?[a-e]?|tuberculosis|rabies|tetanus|measles|malaria|plague|cholera|typhoid|polio|aids|hiv|diphtheria|botulism|anthrax|dysentery|diarrhea|meningitis|sepsis|rubella|mumps|pneumonia|herpes|chicken pox|whooping cough|toxoplasmosis|brucellosis|septicemia|endocarditis|sinusitis|mycosis|gastro ?enteritis)\b/i;
const exClass = (x) => (/^[A-Za-z]+ing\b/.test(x) ? 'act' : DISEASE_RE.test(x) ? 'dis' : (/^[A-Z]\.\s?[a-z]{3,}/.test(x) || (/^[A-Z][a-z]{3,}/.test(x) && /(us|um|ella|ium|ococcus|bacter|monas|bacillus|myces|dium|ia|ida|ella|virus)$/.test(x.split(' ')[0])) || /\b(virus|bacteria|bacterium)\b/i.test(x)) ? 'mic' : null);
function siblingCats(m, x) { const pn = (r) => +String(r).split('p').pop() || 0; const has = (c) => (m.examples || []).some((y) => normKey(y.category) === normKey(c) && normKey(y.example) === normKey(x.example));
  const cats = (m.examples || []).filter((y) => Math.abs(pn(y.ref) - pn(x.ref)) <= 3).sort((a, b) => Math.abs(pn(a.ref) - pn(x.ref)) - Math.abs(pn(b.ref) - pn(x.ref))).map((y) => y.category);
  const sec = (m.secs || []).find((s) => normKey(s.lead) === normKey(x.category) && s.fam); if (sec) cats.push(...sec.fam.members.map(memName));
  return [...new Set(cats.filter((c) => normKey(c) !== normKey(x.category) && !has(c) && wc(c) <= 8))]; }
function rangeFakes(x) {
  if (x.cls === 'spinal') return ['C1–C4', 'T1–T6', 'T1–L2', 'L1–L5', 'L4–S2', 'S2–S4', 'C5–T1'].filter((y) => normKey(y.replace('–', '-')) !== normKey(x.text.replace(/\s*(to|through)\s*/, '-')));
  const lo = x.lo, hi = x.hi, w = hi - lo, dec = /\./.test(x.text) ? 1 : 0, f = (v) => (+v.toFixed(dec)).toString(); const sep = /to/.test(x.text) ? ' to ' : '-'; const unit = (x.text.match(/(%|°C|°F|mmHg|mg|g|kg|mL|ml|years?|hours?|days?|minutes?|weeks?)$/) || [''])[0];
  return [[lo + w, hi + w], [Math.max(0, lo - w), Math.max(0.1, hi - w)], [lo / 2, hi / 2], [lo, hi + w]].filter(([a, b]) => a < b).map(([a, b]) => `${f(a)}${sep}${f(b)}${unit ? (unit === '%' ? '%' : ' ' + unit) : ''}`); }
function famTitle(m, f) { const L = m.__lines || {}; const refs = Object.keys(L); const pnOf = (r) => +String(r).split('p').pop() || 0; const p0 = pnOf(f.members[0].ref);
  for (let d = 0; d <= 1; d++) { const r = refs.find((x) => pnOf(x) === p0 - d); const t = r && L[r][0] ? cleanTitle(L[r][0].text) : ''; if (t && ORDER_WORD.test(t) && wc(t) <= 7 && !f.members.some((mm) => normKey(mm.lead) === normKey(t))) return t.replace(/\bMic\./, 'Microbial '); }
  return f.noun ? (f.noun + 's').replace(/ss$/, 's') : ''; }
// definitions next to each other on one page (genotype / phenotype, objective / subjective data) are a family too: their meanings tell them apart
function defSiblings(m) { if (m.__ds) return m.__ds; const out = []; const by = {}; m.defs.forEach((d) => { if (wc(d.term) <= 4 && wc(d.tail) <= 12 && /^[A-Z]/.test(d.term) && !badTerm(d.term) && !d.fromHead) (by[d.ref] = by[d.ref] || []).push(d); });
  Object.values(by).filter((a) => a.length >= 2).forEach((a) => { const fam = { members: a.map((d) => ({ ref: d.ref, lead: d.term, line: d.sentence, points: [{ text: d.tail, raw: d.sentence }] })) }; fam.members.forEach((mm) => { mm.fam = fam; out.push({ ref: mm.ref, sentence: mm.line + '#ds', point: strip(mm.points[0].text), mem: mm, fam }); }); });
  return (m.__ds = out); }
function sItems(m) { if (m.__si) return m.__si; const si = { famPts: [], effItems: [] }; const seen = new Set();
  (m.fams || []).forEach((f) => f.members.forEach((mem) => mem.points.forEach((p) => { const sp = shortPoint(p.text, 18); if (!sp || wc(sp) < 3 || seen.has(p.raw)) return; seen.add(p.raw); si.famPts.push({ ref: mem.ref, sentence: p.raw, point: sp, mem, fam: f }); })));
  (m.effects || []).forEach((e) => e.items.forEach((it) => si.effItems.push({ ref: it.ref, sentence: it.raw, it, eff: e })));
  return (m.__si = si); }
const FORM = {
  defMeaning(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'defMeaning')[0]; if (!cand) return null; T.take('defMeaning', cand);
    const others = T.byLen(m.defs.filter((d) => normKey(d.term) !== normKey(cand.term)), (d) => d.tail, cand.tail.length).slice(0, 8);
    const ws = pick(others, 3, T.seed);
    return T.mk(T.ar ? `ما المقصود بـ «${cand.term}» حسب المحاضرة؟` : `According to the lecture, what is "${cand.term}"?`, clip(cand.tail), ws.map((d) => clip(d.tail)), cand,
      T.ex(`هذا هو تعريف ${T.qt(cand.term)} في المحاضرة. الخيارات الأخرى تعريفات المحاضرة لمصطلحات أخرى: ${T.qts(ws.map((d) => d.term))}.`, `This is how the lecture defines ${T.qt(cand.term)}. The other options are the lecture's definitions of other terms: ${T.qts(ws.map((d) => d.term))}.`), `تعريف ${cand.term}`); },
  defToTerm(T, slot, m) { if (m.defs.length < 4) return null; const cand = T.here(m.defs, 'defToTerm')[0]; if (!cand) return null; T.take('defToTerm', cand);
    const pnD = (r) => +String(r).split('p').pop() || 0; const near = m.defs.filter((d) => normKey(d.term) !== normKey(cand.term) && !badTerm(d.term)).sort((a, b) => Math.abs(pnD(a.ref) - pnD(cand.ref)) - Math.abs(pnD(b.ref) - pnD(cand.ref)));
    const w = pick([...new Set(near.slice(0, 6).map((d) => d.term))], 3, T.seed);
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
      const near = pairs.filter((p) => p !== a && p.kind === a.kind && normKey(p.term) !== normKey(a.term) && normKey(p.mean) !== normKey(a.mean) && (a.kind === 'list' || Math.abs(pn(p.ref) - pn(a.ref)) <= 1)).sort((x, y) => Math.abs(pn(x.ref) - pn(a.ref)) - Math.abs(pn(y.ref) - pn(a.ref)));
      const trio = [a]; near.forEach((p) => { if (trio.length < 3 && !trio.some((t) => normKey(t.term) === normKey(p.term) || normKey(t.mean) === normKey(p.mean))) trio.push(p); });
      if (trio.length === 2 && a.kind === 'num') { const [x, y] = trio; const k2 = 'mr2|' + [x.term, y.term].map(normKey).sort().join('|'); if (T.used.has(k2)) continue; T.used.add(k2); T.take('matchRow', a.x); const num = (v) => parseFloat(v), fmt = (v) => `${+v.toFixed(1)}%`;
        const row2 = (u, v) => `${x.term}: ${u}; ${y.term}: ${v}`; const alt = (v) => fmt(num(v) * 2 > 100 ? num(v) / 2 : num(v) * 2); const w2 = [row2(y.mean, x.mean), row2(alt(x.mean), y.mean), row2(x.mean, alt(y.mean))];
        const r2 = T.mk(T.ar ? `أي صف يطابق «${x.term}» و«${y.term}» بنسبتيهما حسب المحاضرة؟` : `Which row correctly matches ${x.term} and ${y.term} to their percentages in the lecture?`, row2(x.mean, y.mean), w2, x.x, T.ex(`في المحاضرة: ${T.qt(x.term)} ${T.qt(x.mean)}، و${T.qt(y.term)} ${T.qt(y.mean)}. الصفوف الأخرى تبدّل النسبتين أو تغيّر إحداهما.`, `In the lecture: ${T.qt(x.term)} ${T.qt(x.mean)}; ${T.qt(y.term)} ${T.qt(y.mean)}. The other rows swap or alter the values.`), `مطابقة نسب: ${x.term} و${y.term}`);
        if (r2 && y.x && y.x.sentence) r2.evidence.push({ page: y.ref, quote: y.x.sentence }); return r2; }
      if (trio.length < 3) continue;
      const setKey = 'mrset|' + trio.map((t) => normKey(t.term)).sort().join('|'); if (T.used.has(setKey) && !slot.loose) continue;      // the same three things in another order is the same question
      T.used.add(key); T.used.add(setKey); T.take('matchRow', a.x);
      const terms = trio.map((t) => t.term), means = trio.map((t) => t.mean); const row = (perm) => terms.map((t, i) => `${t}: ${means[perm[i]]}`).join('; ');
      const swaps = [[0, 2, 1], [1, 0, 2], [2, 1, 0]]; const wrong = [row([1, 2, 0]), row([2, 0, 1]), row(swaps[T.seed % 3])];
      const names = terms.map((t) => (T.ar ? `«${t}»` : t)).join(T.ar ? '، ' : ', ');
      const stem = a.kind === 'num' ? (T.ar ? `أي صف يطابق ${names} بنسبها حسب المحاضرة؟` : `Which row correctly matches ${names} to their percentages in the lecture?`) : a.kind !== 'list' ? (T.ar ? `أي صف يطابق ${names} بمعانيها حسب المحاضرة؟` : `Which row correctly matches ${names} to their meanings in the lecture?`) : (T.ar ? `أي صف يطابق ${names} بما تذكره المحاضرة عن كلٍّ منها؟` : `Which row correctly matches ${names} to what the lecture lists for each?`);
      return T.mk(stem, row([0, 1, 2]), wrong, a.x,
        T.ex(`في المحاضرة: ${trio.map((t) => `${T.qt(t.term)} ← ${T.qt(t.mean)}`).join('، ')}. الصفوف الأخرى تخلط بينها.`, `In the lecture: ${trio.map((t) => `${T.qt(t.term)} - ${T.qt(t.mean)}`).join('; ')}. The other rows mix them up.`), `مطابقة: ${terms.join(' / ')}`); }
    return null; },
  // ======================================================== forms written from the lecture's STRUCTURE (see structureMine): the shapes of the teachers' quizzes
  caseEffect(T, slot, m) { if (!m.effects || !isHealth(m)) return null;
    for (const e of m.effects.filter((x) => x.items.some((it) => slot.pages.includes(it.ref)))) { const ok = e.items.filter((it) => flipOk(it));
      for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) { const a = ok[(i + T.seed) % ok.length], b = ok[(j + T.seed) % ok.length]; if (a === b || overlap(a.text, b.text) > 0.3) continue;
        const k = 'ce|' + a.raw + '|' + b.raw; if (T.used.has(k)) continue; T.used.add(k); T.take('caseEffect', { ref: a.ref, sentence: a.raw });
        const both = (x, y) => `${x}; ${y}`; const cond = condPhrase(e.cond);
        const r = T.mk(T.ar ? `مريض يمرّ بـ${cond}. أي مجموعة من العلامات متوقعة حسب المحاضرة؟` : `A patient is experiencing ${cond}. Which combination of findings is expected according to the lecture?`, both(a.text, b.text), [both(a.flip, b.flip), both(a.text, b.flip), both(a.flip, b.text)], { ref: a.ref, sentence: a.raw },
          T.ex(`المحاضرة تذكر مع ${T.qt(cond)}: ${T.qt(a.text)} و${T.qt(b.text)}. الخيارات الأخرى تعكس اتجاه إحداهما أو كلتيهما.`, `With ${T.qt(cond)} the lecture lists ${T.qt(a.text)} and ${T.qt(b.text)}. The other options reverse one or both of them.`), `علامتان متوقعتان مع ${cond}`);
        if (r && b.ref && b.raw !== a.raw) r.evidence.push({ page: b.ref, quote: b.raw }); return r; } }
    return null; },
  caseExample(T, slot, m) { if (!isHealth(m)) return null;
    for (const x of T.here(m.examples || [], 'caseExample')) { const cls = exClass(x.example); if (!cls || (cls === 'act' && !/\b(care|intervention|activit|action|task|nursing|procedure|treatment|duty|role)/i.test(x.category))) continue; const sib = siblingCats(m, x); if (sib.length < 3) continue;
      const k = 'cx|' + normKey(x.example); if (T.used.has(k) && !slot.loose) continue; T.used.add(k); T.take('caseExample', x); const ex = x.example, exl = cls === 'act' ? ex[0].toLowerCase() + ex.slice(1) : ex;
      const stem = T.ar ? `حالة: ${ex}. حسب المحاضرة، هذا مثال على أيٍّ مما يلي؟` : cls === 'act' ? `A nurse is observed ${exl}. According to the lecture, this is an example of:` : cls === 'mic' ? `A laboratory isolate is identified as ${ex}. In the lecture, ${ex} is given as an example of:` : `A patient is diagnosed with ${ex}. In the lecture, this is given as an example of:`;
      const w = pick(sib, 3, T.seed);
      return T.mk(stem, x.category, w, x, T.ex(`المحاضرة تذكر ${T.qt(ex)} مثالًا على ${T.qt(x.category)}. الخيارات الأخرى فئات أخرى من المحاضرة نفسها لها أمثلة غيره.`, `The lecture gives ${T.qt(ex)} as an example of ${T.qt(x.category)}. The other options are other categories of the same lecture, with other examples.`), `حالة: ${ex}`); }
    return null; },
  caseLead(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.famPts.filter((p) => p.fam.noun && /^(phase|stage|period|step|link|level)$/.test(p.fam.noun) && p.fam.members.length >= 4), 'caseLead')) {
      const w = x.fam.members.filter((o) => o !== x.mem).map(memName); if (w.length < 3) continue; T.take('caseLead', x); const noun = x.fam.noun;
      return T.mk(T.ar ? `باحث يبحث عن المرحلة التي تصفها المحاضرة هكذا: «${T.iso(x.point)}». أي مرحلة هي؟` : `A researcher is looking for the ${noun} the lecture describes as follows: "${x.point}". Which ${noun} is it?`, memName(x.mem), pick(w, 3, T.seed), x,
        T.ex(`هذا الوصف وارد تحت ${T.qt(memName(x.mem))} في المحاضرة. الخيارات الأخرى مراحل أخرى من القائمة نفسها بأوصاف مختلفة.`, `The lecture gives this description under ${T.qt(memName(x.mem))}. The other options are the other ${noun}s of the same list.`), `تحديد ${noun}: ${clip(x.point, 40)}`); }
    return null; },
  famLead(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.famPts.filter((p) => p.fam.members.length >= 4), 'famLead')) { const w = x.fam.members.filter((o) => o !== x.mem && !o.points.some((q) => overlap(q.text, x.point) >= 0.6)).map(memName); if (w.length < 3) continue; T.take('famLead', x);
      const noun = x.fam.noun || 'one';
      return T.mk(T.ar ? `تصف المحاضرة أحد العناصر هكذا: «${T.iso(x.point)}». أيّها هو؟` : `The lecture describes one ${noun === 'one' ? 'of the following' : noun} as follows: "${x.point}". Which ${noun === 'one' ? 'one' : noun} is it?`, memName(x.mem), pick(w, 3, T.seed), x,
        T.ex(`هذا الوصف وارد تحت ${T.qt(memName(x.mem))}. البقية عناصر شقيقة في القائمة نفسها لها أوصاف أخرى.`, `This description is given under ${T.qt(memName(x.mem))}; the others are its siblings in the same list, described differently.`), `وصف ${memName(x.mem)}`); }
    return null; },
  exampleOf(T, slot, m) {
    for (const x of T.here(m.examples || [], 'exampleOf')) { const sib = siblingCats(m, x); if (sib.length < 3) continue; const k = 'eo|' + normKey(x.example); if (T.used.has(k) && !slot.loose) continue; T.used.add(k); T.take('exampleOf', x);
      return T.mk(T.ar ? `حسب المحاضرة، «${x.example}» مثال على أيٍّ مما يلي؟` : `According to the lecture, "${x.example}" is given as an example of which of the following?`, x.category, pick(sib, 3, T.seed), x,
        T.ex(`المحاضرة تذكر ${T.qt(x.example)} مثالًا على ${T.qt(x.category)}. الخيارات الأخرى فئات أخرى في المحاضرة.`, `The lecture gives ${T.qt(x.example)} as an example of ${T.qt(x.category)}. The others are other categories of the lecture.`), `مثال: ${x.example}`); }
    return null; },
  pickExample(T, slot, m) {
    for (const x of T.here(m.examples || [], 'pickExample')) { const sib = siblingCats(m, x); if (sib.length < 2) continue; const own = new Set((m.examples || []).filter((y) => normKey(y.category) === normKey(x.category)).map((y) => normKey(y.example)));
      const pnE = (r) => +String(r).split('p').pop() || 0; const others = [...new Set((m.examples || []).filter((y) => sib.some((c) => normKey(c) === normKey(y.category)) && !own.has(normKey(y.example))).sort((a, b) => Math.abs(pnE(a.ref) - pnE(x.ref)) - Math.abs(pnE(b.ref) - pnE(x.ref))).map((y) => y.example))]; if (others.length < 3) continue;
      const k = 'pe|' + normKey(x.category) + '|' + normKey(x.example); if (T.used.has(k)) continue; T.used.add(k); T.take('pickExample', x);
      return T.mk(T.ar ? `أي مما يلي تذكره المحاضرة مثالًا على «${x.category}»؟` : `Which of the following does the lecture give as an example of "${x.category}"?`, x.example, pick(others.slice(0, 5), 3, T.seed), x,
        T.ex(`${T.qt(x.example)} مثال تذكره المحاضرة على ${T.qt(x.category)}. الخيارات الأخرى أمثلة على فئات أخرى.`, `${T.qt(x.example)} is the lecture's example of ${T.qt(x.category)}; the other options are examples of other categories.`), `مثال على ${x.category}`); }
    return null; },
  rangeQ(T, slot, m) {
    for (const x of T.here(m.ranges || [], 'rangeQ')) { const same = [...new Set((m.ranges || []).filter((y) => y.cls === x.cls && normKey(y.text) !== normKey(x.text)).map((y) => y.text))]; const fake = rangeFakes(x).filter((y) => !same.some((z) => normKey(z) === normKey(y)) && normKey(y) !== normKey(x.text));
      const w = [...pick(same, 2, T.seed), ...fake].filter((y, i, a) => a.findIndex((z) => normKey(z) === normKey(y)) === i).slice(0, 3); if (w.length < 3) continue; T.take('rangeQ', x);
      const words = x.sentence.split(/\s+/); let pos = 0, at = 0; for (let i = 0; i < words.length; i++) { if (pos >= x.index) { at = i; break; } pos += words[i].length + 1; at = i; }
      const lo = Math.max(0, at - 12), win = words.slice(lo, at + 14).join(' '); const stem = win.replace(x.text, '____'); if (!stem.includes('____')) continue;
      return T.mk((T.ar ? 'أكمل حسب المحاضرة: ' : 'Complete according to the lecture: ') + (lo ? '… ' : '') + stem, x.text, w, x,
        T.ex(`النطاق الوارد في المحاضرة هنا هو ${T.qt(x.text)}. ${same.length ? 'بعض الخيارات نطاقات تذكرها المحاضرة لأشياء أخرى، والباقي مغيَّر.' : 'الخيارات الأخرى مغيَّرة عنه.'}`, `The range the lecture gives here is ${T.qt(x.text)}. ${same.length ? 'Some options are ranges the lecture gives for other things; the rest are altered.' : 'The other options are altered.'}`), `نطاق: ${x.text}`); }
    return null; },
  purposeQ(T, slot, m) {
    for (const x of T.here(m.purposes || [], 'purposeQ')) { const flip = flipText(x.purpose); const others = [...new Set((m.purposes || []).filter((y) => y !== x && overlap(y.purpose, x.purpose) < 0.5).map((y) => y.purpose))];
      const w = [flip, ...pick(others, 3, T.seed)].filter(Boolean).map(cap1s).filter((y, i, a) => a.indexOf(y) === i && normKey(y) !== normKey(x.purpose)).slice(0, 3); if (w.length < 3) continue; T.take('purposeQ', x);
      const eff = (m.effects || []).find((e) => e.items.some((it) => it.raw === x.sentence)); const verbStart = /^(dilate|constrict|increase|reduce|stimulate|inhibit|secrete|release|block|produce|cause|allow|use)\b/i.test(x.act);
      const stem = T.ar ? `حسب المحاضرة، ما الغرض من: «${T.iso(x.act)}»؟` : eff && verbStart ? `According to the lecture, why does ${condPhrase(eff.cond)} ${x.act[0].toLowerCase() + x.act.slice(1)}?` : `According to the lecture, what is the purpose of the following: "${x.act}"?`;
      return T.mk(stem, cap1s(x.purpose), w, x, T.ex(`المحاضرة تذكر الغرض صراحة: ${T.qt(x.purpose)}. ${flip ? 'أحد الخيارات يعكسه، والباقي أغراض لأشياء أخرى في المحاضرة.' : 'الخيارات الأخرى أغراض لأشياء أخرى في المحاضرة.'}`, `The lecture states the purpose: ${T.qt(x.purpose)}. ${flip ? 'One option reverses it; the others are purposes of other things in the lecture.' : 'The others are purposes of other things in the lecture.'}`), `الغرض من: ${clip(x.act, 40)}`); }
    return null; },
  bestPoint(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.famPts, 'bestPoint')) { const sibPts = x.fam.members.filter((o) => o !== x.mem).map((o) => (o.points.map((q) => shortPoint(q.text, 18)).filter((q) => q && wc(q) >= 3 && !x.mem.points.some((z) => overlap(z.text, q) >= 0.6)))[T.seed % Math.max(1, o.points.length)] || null).filter(Boolean);
      const w = [...new Set(sibPts)].slice(0, 3); if (w.length < 3) { const mt = mutations(x.point)[0]; if (mt) w.push(mt); } if (w.length < 3) continue; T.take('bestPoint', x); const nm = memName(x.mem);
      return T.mk(T.ar ? `أي العبارات التالية أكثر اتساقًا مع «${nm}» حسب المحاضرة؟` : `Which statement is MOST consistent with "${nm}" according to the lecture?`, x.point, pick(w, 3, T.seed), x,
        T.ex(`المحاضرة تذكر تحت ${T.qt(nm)}: ${T.qt(x.point)}. العبارات الأخرى تصف عناصر شقيقة له في القائمة نفسها.`, `Under ${T.qt(nm)} the lecture states ${T.qt(x.point)}. The other statements describe its siblings in the same list.`), `الأنسب لوصف ${nm}`); }
    return null; },
  bestEffect(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.effItems.filter((p) => p.it.flip && wc(p.it.text) <= 16), 'bestEffect')) { const it = x.it, e = x.eff; const opp = e.opp ? e.opp.items.filter((o) => o !== it.pair && wc(o.text) <= 16) : [];
      const w = [it.flip, it.pair && it.pair.text, ...pick(opp, 2, T.seed).map((o) => o.text), ...pick(e.items.filter((o) => o !== it && o.flip), 2, T.seed).map((o) => o.flip)].filter((y, i, a) => y && a.indexOf(y) === i && normKey(y) !== normKey(it.text)).slice(0, 3); if (w.length < 3) continue;
      T.take('bestEffect', x); const cond = condPhrase(e.cond);
      return T.mk(T.ar ? `أي ما يلي أكثر اتساقًا مع ${cond} حسب المحاضرة؟` : `Which finding is MOST consistent with ${cond} according to the lecture?`, it.text, w, x,
        T.ex(`المحاضرة تذكر مع ${T.qt(cond)}: ${T.qt(it.text)}. ${it.pair ? `وتذكر العكس (${T.qt(clip(it.pair.text, 60))}) مع ${T.qt(condPhrase(e.opp.cond))}.` : 'الخيارات الأخرى تعكس الاتجاه أو تخص حالة أخرى.'}`, `With ${T.qt(cond)} the lecture lists ${T.qt(it.text)}. The other options reverse it or belong to the opposite condition.`), `الأنسب مع ${cond}`); }
    return null; },
  bestDef(T, slot, m) { const pn = (r) => +String(r).split('p').pop() || 0;
    for (const d0 of T.here(m.defs.filter((x) => wc(x.tail) <= 28 && !badTerm(x.term) && /^[A-Z(]/.test(x.term)), 'bestDef')) { const d = { ...d0, tail: strip(d0.tail.split(/\.\s+(?=[A-Z])/)[0]) }; const mut = mutations(d.tail).filter((y) => wc(y) <= 30); const sib = m.defs.filter((y) => y !== d0 && normKey(y.term) !== normKey(d.term) && normKey(y.tail) !== normKey(d.tail) && Math.abs(pn(y.ref) - pn(d.ref)) <= 1 && overlap(y.tail, d.tail) < (y.ref === d.ref ? 0.9 : 0.5) && wc(y.tail) <= 28 && !badTerm(y.term)).sort((a, b) => (a.ref === d.ref ? 0 : 1) - (b.ref === d.ref ? 0 : 1)).map((y) => strip(y.tail.split(/\.\s+(?=[A-Z])/)[0]));
      const w = [...mut.slice(0, 1), ...sib.slice(0, 2), ...mut.slice(1)].filter((y, i, a) => a.indexOf(y) === i).slice(0, 3); if (w.length < 3 || !mut.length) continue; T.take('bestDef', d0);
      return T.mk(T.ar ? `أي العبارات التالية تصف «${d.term}» على أفضل وجه حسب المحاضرة؟` : `Which statement BEST describes "${d.term}" according to the lecture?`, clip(d.tail, 200), w.map((y) => clip(y, 200)), d,
        T.ex(`هذا هو وصف المحاضرة لـ${T.qt(d.term)}. أحد الخيارات نسخة محرّفة منه، والبقية أوصاف المحاضرة لمصطلحات قريبة.`, `This is how the lecture describes ${T.qt(d.term)}. One option is an altered copy of it; the others describe neighbouring terms.`), `أفضل وصف لـ${d.term}`); }
    return null; },
  accurateOf(T, slot, m) {
    for (const x of T.here((m.stmts || []).filter((y) => y.mut.length >= 2 && y.nuanced), 'accurateOf')) { const w = x.mut.slice(0, 3); if (w.length < 3) { const more = (m.stmts || []).find((y) => y !== x && y.ref === x.ref && y.mut.length && overlap(y.text, x.text) < 0.5); if (more) w.push(more.mut[0]); } if (w.length < 3) continue;
      T.take('accurateOf', x); const topic = topicOf(x);
      return T.mk(T.ar ? `أي العبارات التالية أدق حسب المحاضرة${topic ? ` عن «${topic}»` : ''}؟` : `Which statement${topic ? ` about "${topic}"` : ''} is most accurate according to the lecture?`, x.text, w, x,
        T.ex(`العبارة الدقيقة هي عبارة المحاضرة كما وردت: ${T.qt(x.text)}. في الخيارات الأخرى قُلب اتجاه أو بُدّل لفظ أو عُمّم ما خصّته المحاضرة، فصارت غير صحيحة.`, `The accurate statement is the lecture's own: ${T.qt(x.text)}. In the others a direction was reversed, a word swapped or a hedge turned into a rule.`), `تقييم عبارات عن ${topic || clip(x.text, 30)}`); }
    return null; },
  falseOf(T, slot, m) { const pn = (r) => +String(r).split('p').pop() || 0;
    for (const x of T.here((m.stmts || []).filter((y) => y.mut.length), 'falseOf')) { const near = (m.stmts || []).filter((y) => y !== x && y.sec === x.sec && overlap(y.text, x.text) < 0.5 && wc(y.text) <= 25 && !y.mut.some((z) => normKey(z) === normKey(x.text))); if (near.length < 3) continue;
      T.take('falseOf', x); const topic = topicOf(x); const key = x.mut[(slot.variant || 0) % x.mut.length]; const w = pick(near, 3, T.seed).map((y) => y.text);
      return T.mk(T.ar ? `أي العبارات التالية خاطئة حسب المحاضرة${topic ? ` عن «${topic}»` : ''}؟` : `Which statement${topic ? ` about "${topic}"` : ''} is FALSE according to the lecture?`, key, w, { ref: x.ref, sentence: x.sentence },
        T.ex(`المحاضرة تقول: ${T.qt(x.text)}، والعبارة المختارة تغيّرها فتصير خاطئة. العبارات الأخرى واردة في المحاضرة كما هي.`, `The lecture says ${T.qt(x.text)}; the chosen statement changes it, so it is false. The other statements are in the lecture as written.`), `اكتشاف العبارة الخاطئة عن ${topic || clip(x.text, 30)}`); }
    return null; },
  leastEffect(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.effItems.filter((p) => (p.it.pair || p.it.flip) && wc(p.it.text) <= 16), 'leastEffect')) { const it = x.it, e = x.eff; const key = it.pair ? it.pair.text : it.flip; const trues = e.items.filter((o) => o !== it && wc(o.text) <= 16 && overlap(o.text, key) < 0.6);
      if (trues.length < 3) continue; T.take('leastEffect', x); const cond = condPhrase(e.cond); const w = pick(trues, 3, T.seed).map((o) => o.text); const health = isHealth(m);
      const r = T.mk(T.ar ? `أي ما يلي الأقل اتساقًا مع ${cond} حسب المحاضرة؟` : health ? `A patient is experiencing ${cond}. Which finding would be LEAST consistent with this according to the lecture?` : `Which of the following is LEAST consistent with ${cond} according to the lecture?`, key, w, it.pair ? { ref: it.pair.ref, sentence: it.pair.raw } : x,
        T.ex(`${T.qt(key)} لا يتفق مع ${T.qt(cond)}: ${it.pair ? `المحاضرة تذكره مع ${T.qt(condPhrase(e.opp.cond))}، وتذكر مع ${T.qt(cond)} عكسه (${T.qt(clip(it.text, 60))}).` : `المحاضرة تذكر عكسه: ${T.qt(it.text)}.`} الخيارات الأخرى واردة مع ${T.qt(cond)}.`, `${T.qt(key)} does not fit ${T.qt(cond)}; the lecture states ${T.qt(it.text)} for it. The other options are listed with ${T.qt(cond)}.`), `الأقل اتساقًا مع ${cond}`);
      if (r && it.pair) r.evidence.push({ page: it.ref, quote: it.raw }); return r; }
    return null; },
  exceptPoint(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.famPts, 'exceptPoint')) { const own = x.mem.points.map((q) => shortPoint(q.text, 18)).filter((q) => q && wc(q) >= 3); if (own.length < 3) continue;
      const k = 'xp|' + x.mem.line; if (T.used.has(k) && !slot.loose) continue; const foreign = x.fam.members.filter((o) => o !== x.mem).flatMap((o) => o.points.map((q) => shortPoint(q.text, 18)).filter((q) => q && wc(q) >= 3 && !own.some((z) => overlap(z, q) >= 0.5)));
      if (!foreign.length) continue; T.used.add(k); T.take('exceptPoint', x); const nm = memName(x.mem); const key = foreign[T.seed % foreign.length];
      return T.mk(T.ar ? `كل ما يلي تذكره المحاضرة عن «${nm}» ما عدا:` : `All of the following are stated in the lecture about "${nm}" EXCEPT:`, key, pick(own, 3, T.seed), x,
        T.ex(`${T.qt(key)} لا يخص ${T.qt(nm)}؛ المحاضرة تذكره لعنصر آخر في القائمة نفسها. الخيارات الأخرى واردة تحت ${T.qt(nm)}.`, `${T.qt(key)} is stated for another item of the same list, not for ${T.qt(nm)}; the other options are listed under ${T.qt(nm)}.`), `الاستثناء في ${nm}`); }
    return null; },
  distinguish(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.famPts.concat(defSiblings(m)), 'distinguish')) { const pa = x.point; if (wc(pa) > 12 || /:/.test(pa)) continue; const sibs = x.fam.members.filter((o) => o !== x.mem).map((o) => [o, (o.points.map((q) => shortPoint(q.text, 12)).filter((q) => q && wc(q) >= 2 && !/:/.test(q) && overlap(q, pa) < 0.5))[0]]).filter(([, q]) => q);
      if (!sibs.length) continue; const [ob, pb] = sibs[T.seed % sibs.length]; const third = sibs.find(([o]) => o !== ob); const A = memName(x.mem), B = memName(ob);
      const k = 'ds|' + [A, B].map(normKey).sort().join('|'); if (T.used.has(k) && !slot.loose) continue;
      const row = (p, q) => `${A}: ${p}; ${B}: ${q}`; const w = [row(pb, pa), third ? row(pa, third[1]) : flipText(pb) && row(pa, flipText(pb)), third ? row(third[1], pb) : flipText(pa) && row(flipText(pa), pb)].filter(Boolean); if (w.length < 3) continue;
      T.used.add(k); T.take('distinguish', x);
      const r = T.mk(T.ar ? `أي تمييز بين «${A}» و«${B}» صحيح حسب المحاضرة؟` : `Which distinction between "${A}" and "${B}" is correct according to the lecture?`, row(pa, pb), w, x,
        T.ex(`في المحاضرة: ${T.qt(A)} ← ${T.qt(pa)}، و${T.qt(B)} ← ${T.qt(pb)}. الخيارات الأخرى تبدّل بينهما أو تنسب لأحدهما وصف عنصر ثالث.`, `In the lecture: ${T.qt(A)} - ${T.qt(pa)}; ${T.qt(B)} - ${T.qt(pb)}. The other options swap them or give one of them a third item's description.`), `التمييز بين ${A} و${B}`);
      return r; }
    return null; },
  pairing(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.effItems.filter((p) => p.it.pair && wc(p.it.text) <= 12 && wc(p.it.pair.text) <= 14), 'pairing')) { const it = x.it, e = x.eff; const [la, lb] = condLabels(e); const a = it.text, b = it.pair.text;
      const k = 'pr|' + it.raw; if (T.used.has(k)) continue; const row = (p, q) => `${la}: ${p}; ${lb}: ${q}`; const fa = it.flip, fb = flipText(b);
      const w = [row(b, a), fa && row(fa, b), fb && row(a, fb), fa && fb && row(fa, fb)].filter(Boolean).filter((y, i, arr) => arr.indexOf(y) === i).slice(0, 3); if (w.length < 3) continue; T.used.add(k); T.take('pairing', x);
      const org = it.organ.filter((t) => it.pair.organ.includes(t))[0]; const r = T.mk(T.ar ? `أي اقتران صحيح حسب المحاضرة${org ? ` بشأن «${org}»` : ''}؟` : `Which pairing${org ? ` for the ${org}` : ''} is correct according to the lecture?`, row(a, b), w, x,
        T.ex(`المحاضرة تذكر مع ${T.qt(la)}: ${T.qt(a)}، ومع ${T.qt(lb)}: ${T.qt(b)}. الخيارات الأخرى تبدّل بينهما أو تعكس اتجاه أحدهما.`, `The lecture lists ${T.qt(a)} for ${T.qt(la)} and ${T.qt(b)} for ${T.qt(lb)}. The others swap them or reverse one of them.`), `مقارنة ${la} و${lb}${org ? ' في ' + org : ''}`);
      if (r) r.evidence.push({ page: it.pair.ref, quote: it.pair.raw }); return r; }
    return null; },
  famOrder(T, slot, m, pages) {
    const ord = (m.fams || []).filter((y) => y.ordered && y.members.length >= 3).sort((a, b) => b.members.length - a.members.length); const here0 = ord.filter((y) => y.members.length >= 4 && y.members.some((o) => slot.pages.includes(o.ref)));      // the slot's own family when it is a real sequence, then the longest ordered families of the lecture (the six links of the chain before a three-step list)
    for (const f of here0.concat(ord.filter((y) => !here0.includes(y)))) { const names = f.members.slice(0, 6).map(memName); if (names.some((n) => wc(n) > 5)) continue;
      const k = 'fo|' + names.join('|'); if (T.used.has(k)) continue; const idx = names.map((_, i) => i); const chain = (ord) => ord.map((i) => names[i]).join(' → '); const seen = new Set([chain(idx)]); const wrong = [];
      for (let t = 1; wrong.length < 3 && t < 80; t++) { const c = chain(pick(idx, idx.length, T.seed + t)); if (!seen.has(c)) { seen.add(c); wrong.push(c); } } if (wrong.length < 3) continue; T.used.add(k);
      const title = famTitle(m, f); const first = f.members[0];
      return { slot: slot.slot, unwritable_reason: null, stem: T.ar ? `أي ترتيب صحيح${title ? ` لـ«${title}»` : ''} حسب المحاضرة؟` : `Which order${title ? ` of "${title}"` : ''} is the one given in the lecture?`, options: [chain(idx), ...wrong], correct_index: 0,
        explanation: T.arx ? `الترتيب في المحاضرة: ${names.map((x) => T.qt(x)).join(' ← ')}.` : `The order in the lecture: ${names.map((x) => T.qt(x)).join(' → ')}.`, purpose: `ترتيب ${title || names[0]}`, reasoning_pattern: 'sequence',
        evidence: [{ page: first.ref, quote: first.line }, { page: f.members[f.members.length - 1].ref, quote: f.members[f.members.length - 1].line }], uses_external: false }; }
    return null; },
  acroQ(T, slot, m) { const ac = (m.gloss || []).filter((g) => g.kind === 'acronym');
    for (const x of T.here(ac, 'acroQ')) { const others = ac.filter((g) => g !== x && normKey(g.mean) !== normKey(x.mean)).map((g) => g.mean); if (others.length < 3) continue; T.take('acroQ', x);
      return T.mk(T.ar ? `في المحاضرة، إلامَ يشير الاختصار «${x.term}»؟` : `In the lecture, what does "${x.term}" stand for?`, x.mean, pick(T.byLen(others, (y) => y, x.mean.length).slice(0, 6), 3, T.seed), x,
        T.ex(`${T.qt(x.term)} في المحاضرة اختصار لـ${T.qt(x.mean)}. الخيارات الأخرى توسيعات اختصارات أخرى وردت في المحاضرة.`, `In the lecture ${T.qt(x.term)} stands for ${T.qt(x.mean)}; the others expand other abbreviations of the lecture.`), `اختصار ${x.term}`); }
    return null; },
  effectRecall(T, slot, m) { const si = sItems(m);
    for (const x of T.here(si.effItems.filter((p) => p.it.flip && wc(p.it.text) <= 18), 'effectRecall')) { const it = x.it, e = x.eff;
      const w = [it.flip, it.pair && it.pair.text, ...pick(e.items.filter((o) => o !== it && o.flip && wc(o.flip) <= 18), 3, T.seed).map((o) => o.flip)].filter((y, i, a) => y && a.indexOf(y) === i && normKey(y) !== normKey(it.text)).slice(0, 3); if (w.length < 3) continue;
      T.take('effectRecall', x); const cond = condPhrase(e.cond);
      return T.mk(T.ar ? `أي تغيّر تذكره المحاضرة مع ${cond}؟` : `Which change does the lecture associate with ${cond}?`, it.text, w, x,
        T.ex(`المحاضرة تذكر مع ${T.qt(cond)}: ${T.qt(it.text)}. ${it.pair ? `وتذكر ${T.qt(clip(it.pair.text, 60))} مع ${T.qt(condPhrase(e.opp.cond))}. ` : ''}الخيارات الأخرى تعكس اتجاه ما تذكره المحاضرة.`, `With ${T.qt(cond)} the lecture lists ${T.qt(it.text)}. The other options reverse what the lecture states${it.pair ? ' or belong to the opposite condition' : ''}.`), `أثر ${cond}`); }
    return null; },
  setOf(T, slot, m, pages) {
    for (const l of T.here(m.lists.filter((y) => !y.partial && y.items.length >= 3 && y.items.length <= 6 && y.items.every((it) => wc(it) <= 4)), 'setOf')) { const own = l.items.slice(0, 5); const foreign = foreignItems(m, l, pages).map((y) => y[0]).filter((y) => wc(y) <= 4); if (foreign.length < 2) continue;
      const join = (a) => a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; const w = []; for (let t = 0; t < own.length && w.length < 3; t++) { const c = own.slice(); c[(t + T.seed) % own.length] = foreign[t % foreign.length]; const s = join(c); if (!w.includes(s)) w.push(s); } if (w.length < 3) continue;
      const k = 'so|' + keyOf(l); if (T.used.has(k)) continue; T.used.add(k); T.take('setOf', l); const lead = clip(strip(l.lead), 80);
      return T.mk(T.ar ? `أي مجموعة تطابق ما تذكره المحاضرة تحت «${lead}»؟` : `Which set matches what the lecture lists under "${lead}"?`, join(own), w, l,
        T.ex(`المحاضرة تذكر تحت ${T.qt(lead)}: ${own.map(T.qt).join('، ')}. في كل خيار آخر استُبدل عنصر بعنصر من موضع آخر في المحاضرة.`, `Under ${T.qt(lead)} the lecture lists ${own.map(T.qt).join(', ')}. In each other option one item was replaced by an item from elsewhere in the lecture.`), `مجموعة: ${lead}`); }
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
    for (const l of m.lists.filter((x) => slot.pages.includes(x.ref) && !x.partial && (slot.extra || !T.used.has(keyOf(x))))) {      // «NOT listed» needs the WHOLE list on the slide
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
/* ================================================================ THE COMPOSER: the agent that improves questions WHILE they are generated
 * A second agent, separate from LEARN (which learns from students' answers and reports AFTER quizzes). For every slot it:
 *  1. builds a candidate from EVERY form of the slot's identity (the forms learned from the teachers' quizzes, the deep forms below, and any form registered later),
 *     each on a copy of the generator's state, and keeps only candidates that pass the same checks as an accepted question (validation, duplicates, leaks);
 *  2. scores them: reasoning depth of the form (recall < understanding < application < inference / evaluation), quality of the wrong options (no "not"/"always"
 *     look-alikes of the key, no length cue), the form's known quality (teachers' quizzes, then LEARN's evidence from students), and REPETITION - each earlier use
 *     of the same form and of the same stem opening in this quiz costs points, and one form may not fill an identity while another form can write the slot;
 *  3. builds the winner for real. Deterministic (same lecture, same quiz).
 * It also RECOGNISES the material that supports deep thinking (deep(m)): states with their findings, families whose members carry distinguishing features,
 * two groups that a case can be told apart by, and lecture statements that can be checked as claims - feeding the scenario and critical-thinking forms here,
 * the planner's capacities, and the AI path (guide(): a shape and the deep material for each slot, rotated so the AI does not repeat one shape). */
const IMPERATIVE_RE = /^(enumerate|predict|describe|list|explain|define|discuss|identify|understand|know|recogni[sz]e|outline|compare|differentiate|distinguish|state|mention|name|classify|demonstrate|apply|analy[sz]e|illustrate|summari[sz]e|review|learn|study|determine|evaluate|interpret|use|discover|find|out\s*line)\b/i;
const CLAIM_VERB = /\b(is|are|was|were|has|have|can|cannot|may|will|must|should|causes?|leads?|results?|produces?|requires?|contains?|increases?|decreases?|reduces?|raises?|lowers?|promotes?|inhibits?|stimulates?|prevents?|allows?|occurs?|refers?|includes?|involves?|forms?|grows?|enters?|binds?|acts?|makes?|becomes?|depends?|ensures?|provides?|helps?|يؤدي|يسبب|تسبب|يزيد|تزيد|يقلل|تقلل|يمنع|تمنع|هو|هي)\b/i;
const claimOk = (t) => { const s = strip(String(t)); return wc(s) >= 5 && wc(s) <= 24 && !IMPERATIVE_RE.test(s) && CLAIM_VERB.test(s) && !/[?؟:]$/.test(s) && !/[()[\]]/.test(s) && !/[.;]\s+\S/.test(s) && lettersShare(s) >= 0.7; };
const TWISTY = /\b(instead of|rather than|except|unless|without|but not|not|no|never|neither|nor)\b/i;
/** what one mutation did to a lecture statement (null = not one of the four clean changes, never used as a claim) */
function mutKind(orig, mut) { const k = normKey(mut); const is = (f) => { const v = f(orig); return !!v && normKey(v) === k; };
  return is(flipText) ? 'flip' : is(negateText) ? 'negate' : is(overclaim) ? 'overclaim' : is(swapText) ? 'swap' : null; }
const claimMuts = (x) => x.__cm || (x.__cm = (x.mut || []).map((t) => ({ t, kind: mutKind(x.text, t) })).filter((y) => y.kind && (y.kind !== 'overclaim' || x.nuanced) && (y.kind !== 'negate' || !TWISTY.test(x.text))));
const FAM_NOUN = /^(phase|stage|period|step|link|level|type|class|factor|group|category|kind|stage)$/;
const famNoun = (f) => (f.noun && FAM_NOUN.test(f.noun) ? f.noun : null);
const ptsOf = (mem) => mem.points.map((p) => ({ text: shortPoint(p.text, 18), raw: p.raw })).filter((p) => p.text && wc(p.text) >= 2);
const distinct = (p, others) => others.every((o) => overlap(p, o) < 0.4 && normKey(p) !== normKey(o));
const flipOk = (it) => it.flip && wc(it.text) <= 9 && !/\b(cause|causes|causing|to|for|during|so|which|by)\b|[(:]/i.test(it.text);
const lc1 = (t) => (/^[A-Z][a-z]/.test(t) && !/^[A-Z][a-z]+[A-Z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);

/** the deep-thinking material of a lecture (cached on the mined lecture) */
function deep(m) {
  if (m.__deep) return m.__deep;
  const states = (m.effects || []).map((e) => ({ e, items: e.items.filter((it) => it.flip && wc(it.text) <= 12) })).filter((s) => s.items.length >= 3);
  const groups = (m.fams || []).filter((f) => f.members.length >= 4 && f.members.filter((mm) => ptsOf(mm).length).length >= 3);
  const pairs = []; (m.effects || []).forEach((e) => { const o = e.opp && typeof e.opp === 'object' ? e.opp : (m.effects || []).find((x) => x !== e && x.cond === e.opp); if (o && o !== e && !pairs.some((p) => (p.a === e && p.b === o) || (p.a === o && p.b === e))) pairs.push({ a: e, b: o, kind: 'state' }); });
  (m.fams || []).filter((f) => f.members.length >= 2).forEach((f) => { const ms = f.members.filter((mm) => ptsOf(mm).length); for (let i = 0; i + 1 < ms.length && i < 3; i++) pairs.push({ a: ms[i], b: ms[i + 1], kind: 'fam', fam: f }); });
  const claims = (m.stmts || []).filter((x) => claimOk(x.text) && claimMuts(x).length);
  return (m.__deep = { states, groups, pairs, claims, size: states.length + groups.length + pairs.length + claims.length });
}

Object.assign(FORM, {
  /** scenarios - the case gives findings; the student infers which member of a family (phase, step, type...) they point to */
  caseInfer(T, slot, m) { const D = deep(m);
    const items = []; D.groups.forEach((f) => f.members.forEach((mem) => ptsOf(mem).forEach((p) => items.push({ ref: mem.ref, sentence: p.raw, point: p.text, mem, fam: f }))));
    for (const x of T.here(items, 'caseInfer')) { const sib = x.fam.members.filter((o) => o !== x.mem); const sibPts = sib.flatMap((o) => ptsOf(o).map((p) => p.text)); if (!distinct(x.point, sibPts)) continue;
      if (x.fam.members.some((o) => overlap(x.point, memName(o)) >= 0.5)) continue;      // the description must not name an option
      if (/^[A-Z][a-z]+ing\b/.test(x.point) && !T.ar) { const n0 = famNoun(x.fam); const names = sib.map(memName).filter(Boolean); if (names.length < 3) continue; T.take('caseInfer', x); const who = isHealth(m) ? 'A nurse' : 'Someone';
        const w = pick(names, 3, T.seed); return T.mk(`${who} is ${lc1(x.point)}. According to the lecture, which ${n0 || 'of the following'} does this activity belong to?`, memName(x.mem), w, x,
          T.ex(`في المحاضرة هذا النشاط (${T.qt(x.point)}) وارد تحت ${T.qt(memName(x.mem))}، والخيارات الأخرى عناصر القائمة نفسها: ${T.qts(w)}.`, `The lecture lists this activity (${T.qt(x.point)}) under ${T.qt(memName(x.mem))}; the other options are the other items of the same list: ${T.qts(w)}.`), `تصنيف نشاط: ${clip(x.point, 40)}`); }
      const more = ptsOf(x.mem).find((p) => p.raw !== x.sentence && distinct(p.text, sibPts) && overlap(p.text, x.point) < 0.4); const names = sib.map(memName).filter((n) => n && normKey(n) !== normKey(memName(x.mem))); if (names.length < 3) continue;
      T.take('caseInfer', x); const noun = famNoun(x.fam); const f = [x.point, more && more.text].filter(Boolean); const n = (T.nth || 0) % 3;
      const show = T.ar ? f.map((y) => `«${T.iso(y)}»`).join(' و') : f.map((y) => `"${y}"`).join(' and ');
      const stem = T.ar ? [`حالة تُلاحظ فيها: ${show}. حسب المحاضرة، أيّ ${noun ? 'مرحلة/فئة' : 'مما يلي'} تفسّر هذه الملاحظات؟`, `وصلتك ملاحظات من حالة: ${show}. إلى أيّ مما يلي تشير حسب المحاضرة؟`, `أنت تراجع حالة تظهر فيها: ${show}. أيّ مما يلي أنسب تفسير لها حسب المحاضرة؟`][n]
        : [`A case shows ${show}. According to the lecture, which ${noun || 'of the following'} ${noun ? 'is this most likely' : 'best explains these observations'}?`, `You are given these observations: ${show}. Which ${noun || 'option'} of the lecture do they point to?`, `While reviewing a case you note ${show}. Based on the lecture, which ${noun || 'of the following'} fits best?`][n];
      const w = pick(names, 3, T.seed); const r = T.mk(stem, memName(x.mem), w, x,
        T.ex(`في المحاضرة ${f.length > 1 ? 'هاتان الملاحظتان واردتان' : 'هذه الملاحظة واردة'} تحت ${T.qt(memName(x.mem))} وحده، والخيارات الأخرى ${noun ? 'مراحل/فئات' : 'عناصر'} من القائمة نفسها بملامح مختلفة: ${T.qts(w)}. المطلوب الاستدلال من الملاحظة إلى ما تدل عليه.`, `In the lecture ${f.length > 1 ? 'these observations are' : 'this observation is'} listed under ${T.qt(memName(x.mem))} only; the other options are other ${noun ? noun + 's' : 'items'} of the same list, with different features: ${T.qts(w)}. The task is to reason from the observation to what it indicates.`), `استدلال من ملاحظات: ${clip(x.point, 40)}`);
      if (r && more) r.evidence.push({ page: x.ref, quote: more.raw }); return r; }
    return null; },
  /** scenarios - two cases, one finding each; the student must tell which state / group each one belongs to (the four pairings) */
  caseContrast(T, slot, m) { const D = deep(m);
    for (const p of D.pairs) { const A = p.kind === 'state' ? { name: condPhrase(p.a.cond), pts: p.a.items.filter((it) => wc(it.text) <= 12).map((it) => ({ text: it.text, raw: it.raw, ref: it.ref })) } : { name: memName(p.a), pts: ptsOf(p.a).map((q) => ({ ...q, ref: p.a.ref })) };
      const B = p.kind === 'state' ? { name: condPhrase(p.b.cond), pts: p.b.items.filter((it) => wc(it.text) <= 12).map((it) => ({ text: it.text, raw: it.raw, ref: it.ref })) } : { name: memName(p.b), pts: ptsOf(p.b).map((q) => ({ ...q, ref: p.b.ref })) };
      if (!A.name || !B.name || normKey(A.name) === normKey(B.name) || !A.pts.length || !B.pts.length) continue;
      if (![...A.pts, ...B.pts].some((q) => slot.pages.includes(q.ref))) continue;
      for (const a of A.pts) { if (!distinct(a.text, B.pts.map((q) => q.text)) || overlap(a.text, A.name) >= 0.5 || overlap(a.text, B.name) >= 0.5) continue;
        const b = B.pts.find((q) => distinct(q.text, A.pts.map((z) => z.text)) && overlap(q.text, a.text) < 0.3 && overlap(q.text, A.name) < 0.5 && overlap(q.text, B.name) < 0.5 && !(p.kind === 'state' && normKey(q.text) === normKey(flipText(a.text) || ''))); if (!b) continue;
        const k = 'cc|' + a.raw + '|' + b.raw; if (T.used.has(k)) continue; T.used.add(k); T.take('caseContrast', { ref: a.ref, sentence: a.raw }); const pt = p.kind === 'state' && isHealth(m); const n = (T.nth || 0) % 2;
        const c1 = T.ar ? (pt ? 'المريض 1' : 'الوصف 1') : pt ? 'Patient 1' : 'Description 1', c2 = T.ar ? (pt ? 'المريض 2' : 'الوصف 2') : pt ? 'Patient 2' : 'Description 2'; const lab = (x, y) => (T.ar ? `${c1}: ${x}، ${c2}: ${y}` : `${c1}: ${x}; ${c2}: ${y}`);
        const stem = T.ar ? (pt ? `${c1}: ${T.iso(a.text)}. ${c2}: ${T.iso(b.text)}. حسب المحاضرة، أيّ ربط صحيح؟` : `أمامك وصفان من الواقع: (1) «${T.iso(a.text)}» (2) «${T.iso(b.text)}». حسب المحاضرة، إلى أيّ منهما ينتمي كل وصف؟`)
          : pt ? (n ? `${c1} shows ${lc1(a.text)}, while ${c2} shows ${lc1(b.text)}. According to the lecture, which pairing is correct?` : `Two patients are compared. ${c1}: ${a.text}. ${c2}: ${b.text}. Which pairing matches the lecture?`)
          : (n ? `You meet two situations. ${c1}: "${a.text}". ${c2}: "${b.text}". According to the lecture, where does each belong?` : `Two descriptions are given. ${c1}: "${a.text}". ${c2}: "${b.text}". Which pairing matches the lecture?`);
        const r = T.mk(stem, lab(A.name, B.name), [lab(B.name, A.name), lab(A.name, A.name), lab(B.name, B.name)], { ref: a.ref, sentence: a.raw },
          T.ex(`المحاضرة تذكر ${T.qt(a.text)} مع ${T.qt(A.name)}، و${T.qt(b.text)} مع ${T.qt(B.name)}. التمييز بين الحالتين يحتاج معرفة ما يخصّ كل واحدة.`, `The lecture lists ${T.qt(a.text)} under ${T.qt(A.name)} and ${T.qt(b.text)} under ${T.qt(B.name)}. Telling the two cases apart needs what is specific to each.`), `تمييز حالتين: ${A.name} / ${B.name}`);
        if (r && b.raw !== a.raw) r.evidence.push({ page: b.ref, quote: b.raw }); return r; } }
    return null; },
  /** critical thinking - two students' summaries; one, both or neither may be subtly altered (reversed, negated, over-generalised, swapped); who is right? */
  judgeClaims(T, slot, m) { const D = deep(m);
    for (const x of T.here(D.claims, 'judgeClaims')) { const mate = D.claims.find((y) => y !== x && y.sec === x.sec && topicOf(y) === topicOf(x) && overlap(y.text, x.text) < 0.5 && !T.used.has('jc|' + keyOf(y))); if (!mate) continue;
      const n = T.nth || 0; const c = (T.seed + n) % 4; const aT = c === 0 || c === 2, bT = c === 1 || c === 2; const rot = (ms, k) => { const pref = ['flip', 'overclaim', 'swap', 'negate']; const o = pref.slice(k % 4).concat(pref.slice(0, k % 4)); return o.map((q) => ms.find((y) => y.kind === q)).find(Boolean); }; const mx = rot(claimMuts(x), n), my = rot(claimMuts(mate), n + 1);
      const A = aT ? x.text : mx.t, B = bT ? mate.text : my.t; T.take('judgeClaims', x); T.used.add('jc|' + keyOf(mate)); T.used.add('jc|' + keyOf(x)); const topic = topicOf(x);
      const L = T.ar ? ['الطالب (أ) فقط', 'الطالب (ب) فقط', 'كلاهما مصيب', 'لا أحد منهما'] : ['Only Student A', 'Only Student B', 'Both students', 'Neither student']; const ki = aT && !bT ? 0 : !aT && bT ? 1 : aT && bT ? 2 : 3;
      const stem = T.ar ? `طالبان لخّصا ما قالته المحاضرة${topic ? ` عن «${topic}»` : ''}:\nالطالب (أ): «${T.iso(A)}»\nالطالب (ب): «${T.iso(B)}»\nحسب المحاضرة، من المصيب؟` : `Two students summarise what the lecture says${topic ? ` about "${topic}"` : ''}.\nStudent A: "${A}"\nStudent B: "${B}"\nAccording to the lecture, who is right?`;
      const why = (who, ok, orig, mu) => (ok ? T.ex(`${who} نقل المحاضرة كما هي: ${T.qt(orig)}.`, `${who} matches the lecture: ${T.qt(orig)}.`) : T.ex(`${who} ${({ flip: 'قلب لفظًا إلى ضده', negate: 'نفى ما تقرّره المحاضرة', overclaim: 'جعل ما هو غالب قاعدةً مطلقة', swap: 'بدّل بين أمرين' })[mu.kind]}، والمحاضرة تقول: ${T.qt(orig)}.`, `${who} ${({ flip: 'turned a word into its opposite', negate: 'negated what the lecture states', overclaim: 'turned a qualified statement into an absolute rule', swap: 'swapped two things' })[mu.kind]}; the lecture says: ${T.qt(orig)}.`));
      const r = T.mk(stem, L[ki], L.filter((_, i) => i !== ki), x, why(T.arx ? 'الطالب (أ)' : 'Student A', aT, x.text, mx) + ' ' + why(T.arx ? 'الطالب (ب)' : 'Student B', bT, mate.text, my), `تقييم ادعاءين: ${topic || clip(x.text, 30)}`);
      if (r && mate.sentence !== x.sentence) r.evidence.push({ page: mate.ref, quote: mate.sentence }); return r; }
    return null; },
  /** critical thinking - what exactly is wrong (if anything) with a claim about the lecture: error analysis with mutually exclusive, mechanical answers */
  claimFlaw(T, slot, m) { const D = deep(m);
    const AR = { flip: 'تستبدل لفظًا أساسيًا بضده', negate: 'تنفي ما تقرّره المحاضرة (تضيف «لا/ليس» أو تحذفها)', overclaim: 'تجعل عبارة مقيّدة («غالبًا/بعض») مطلقة («دائمًا/كل»)', swap: 'تبدّل بين أمرين تفرّق المحاضرة بينهما', none: 'لا خطأ فيها؛ تطابق المحاضرة' };
    const EN = { flip: 'It replaces a key word with its opposite', negate: 'It negates what the lecture states (adds or drops a "not")', overclaim: 'It turns a qualified statement (often / some) into an absolute one (always / all)', swap: 'It swaps two things the lecture keeps apart', none: 'Nothing; it matches the lecture' };
    for (const x of T.here(D.claims, 'claimFlaw')) { const ms = claimMuts(x); if (!ms.length) continue; const n = T.nth || 0; const showTrue = n % 4 === 3;      // every 4th of these questions shows the lecture's own statement
      const pref = ['flip', 'overclaim', 'swap', 'negate']; const order = pref.slice(n % 4).concat(pref.slice(0, n % 4)); const mu = order.map((k) => ms.find((y) => y.kind === k)).find(Boolean);      // the kind of error rotates across the quiz
      const shown = showTrue ? x.text : mu.t, kind = showTrue ? 'none' : mu.kind;
      const LBL = T.ar ? AR : EN; T.take('claimFlaw', x); const w = pick(['flip', 'negate', 'overclaim', 'swap', 'none'].filter((k) => k !== kind), 3, T.seed + n).map((k) => LBL[k]); const f = n % 2; const topic = topicOf(x);
      const stem = T.ar ? (f ? `كتب زميلك${topic ? ` عن «${topic}»` : ''}: «${T.iso(shown)}». ما الخطأ في هذه العبارة إن وُجد، حسب المحاضرة؟` : `في ملاحظات طالب${topic ? ` عن «${topic}»` : ''}: «${T.iso(shown)}». كيف تقيّم هذه العبارة مقارنةً بالمحاضرة؟`)
        : f ? `A classmate writes${topic ? ` about "${topic}"` : ''}: "${shown}". What, if anything, is wrong with this statement according to the lecture?` : `A student's notes${topic ? ` on "${topic}"` : ''} say: "${shown}". How does this note compare with the lecture?`;
      const kindAr = { flip: 'استبدلت لفظًا أساسيًا بضده', negate: 'نفت ما تقرّره المحاضرة', overclaim: 'جعلت العبارة المقيّدة مطلقة', swap: 'بدّلت بين أمرين' }[kind];
      return T.mk(stem, LBL[kind], w, x, showTrue ? T.ex(`العبارة هي نص المحاضرة نفسه: ${T.qt(x.text)}، فلا خطأ فيها.`, `The note is the lecture's own statement: ${T.qt(x.text)}, so nothing is wrong with it.`)
        : T.ex(`المحاضرة تقول: ${T.qt(x.text)}. العبارة المكتوبة ${kindAr}.`, `The lecture says: ${T.qt(x.text)}. The note ${EN[kind].replace(/^It /, '').replace(/^(\w)/, (c) => c.toLowerCase())}.`), `تحليل خطأ في عبارة: ${clip(x.text, 40)}`); }
    return null; },
  /** critical thinking - from two given findings infer the state (or group), then predict another finding of it; wrong options belong elsewhere */
  inferAlso(T, slot, m) { const D = deep(m); const n = T.nth || 0;
    for (const s of D.states) { const its = s.items.filter((it) => slot.pages.includes(it.ref) || s.e.ref === slot.pages[0]); if (its.length < 3 || s.items.length < 6) continue;
      const order = pick(s.items, s.items.length, T.seed + n); for (let i = 0; i + 2 < order.length; i++) { const a = order[i], b = order[i + 1], c = order[i + 2]; if (overlap(a.text, b.text) > 0.3 || overlap(c.text, a.text) > 0.3 || overlap(c.text, b.text) > 0.3) continue;
        const k = 'ia|' + c.raw; if (T.used.has(k)) continue; const w = order.filter((y) => y !== a && y !== b && y !== c && flipOk(y) && overlap(y.text, c.text) < 0.3).slice(0, 3).map((y) => y.flip); if (w.length < 3) continue;
        T.used.add(k); T.take('inferAlso', { ref: c.ref, sentence: c.raw });
        const stem = T.ar ? `مريض لديه: ${T.iso(a.text)}، و${T.iso(b.text)}. إذا استمرت الحالة نفسها، فأيّ علامة أخرى تتوقعها حسب المحاضرة؟` : `A patient shows ${lc1(a.text)} and ${lc1(b.text)}. If the same state persists, which other finding would you most expect according to the lecture?`;
        const r = T.mk(stem, c.text, w, { ref: c.ref, sentence: c.raw }, T.ex(`العلامتان تدلان على ${T.qt(condPhrase(s.e.cond))}، والمحاضرة تذكر معها ${T.qt(c.text)}. الخيارات الأخرى علامات الحالة المعاكسة.`, `The two findings point to ${T.qt(condPhrase(s.e.cond))}, and the lecture lists ${T.qt(c.text)} with it. The other options are findings of the opposite state.`), `استنتاج علامة من حالة: ${condPhrase(s.e.cond)}`);
        if (r) r.evidence.push({ page: a.ref, quote: a.raw }); return r; } }
    for (const f of D.groups.filter((g) => /^(phase|stage|period)$/.test(g.noun || ''))) for (const mem of f.members) { if (!slot.pages.includes(mem.ref)) continue; const pts = ptsOf(mem); if (pts.length < 2) continue; const sibPts = f.members.filter((o) => o !== mem).flatMap((o) => ptsOf(o).map((p) => ({ ...p, ref: o.ref })));
      for (let i = 0; i < pts.length; i++) { const g = pts[(i + n) % pts.length], key = pts.find((p) => p !== g && overlap(p.text, g.text) < 0.4); if (!key) continue; const k = 'ia|' + key.raw; if (T.used.has(k)) continue;
        const w = pick(sibPts.filter((p) => distinct(p.text, pts.map((z) => z.text))), 3, T.seed + n).map((p) => p.text); if (w.length < 3) continue; T.used.add(k); T.take('inferAlso', { ref: mem.ref, sentence: key.raw });
        const stem = T.ar ? `تُلاحظ في حالةٍ: «${T.iso(g.text)}». أيّ مما يلي تتوقع أن يرافقه حسب المحاضرة؟` : `In a case you observe: "${g.text}". Which of the following would you also expect, according to the lecture?`;
        const r = T.mk(stem, key.text, w, { ref: mem.ref, sentence: key.raw }, T.ex(`الملاحظة تدل على ${T.qt(memName(mem))}، والمحاضرة تذكر معه ${T.qt(key.text)}. الخيارات الأخرى تخصّ ${f.members.length - 1} عناصر أخرى من القائمة نفسها.`, `The observation points to ${T.qt(memName(mem))}, which the lecture also describes as ${T.qt(key.text)}. The other options belong to other items of the same list.`), `استنتاج ما يرافق: ${clip(g.text, 40)}`);
        if (r) r.evidence.push({ page: mem.ref, quote: g.raw }); return r; } }
    return null; },
});
FORMS.scenarios = ['caseInfer', 'caseContrast', 'caseEffect', 'scenario', 'caseLead', 'caseExample'];
FORMS.critical_thinking = ['judgeClaims', 'claimFlaw', 'inferAlso', 'accurateOf', 'caution'];
/** how much reasoning a form asks for: 1 recall, 2 understanding / application, 3 inference / evaluation (the composer prefers deeper forms) */
const FORM_DEPTH = { defMeaning: 1, effectRecall: 1.3, pickExample: 1.5, setOf: 1.3, cloze: 1, listBelongs: 1.3, defCloze: 1, defToTerm: 1.5, acroQ: 1.2, statement: 1.8, causeEffect: 2, purposeQ: 2, effectCause: 2.2,
  famLead: 1.8, exampleOf: 2, rangeQ: 2, numValue: 1.3, numStatement: 1.8, listNot: 2, leastEffect: 2.4, falseOf: 2.3, exceptPoint: 2.2, famOrder: 2.2, seqOrder: 2.2, seqNext: 2.3,
  pairing: 2.4, distinguish: 2.5, contrast: 2.4, matchRow: 2, bestEffect: 2.3, bestPoint: 2.2, bestDef: 2.2, bestOf: 2.3,
  caseInfer: 3, caseContrast: 3, caseEffect: 2.6, scenario: 2.3, caseLead: 1.6, caseExample: 1.5, judgeClaims: 3, claimFlaw: 3, inferAlso: 3, accurateOf: 2, caution: 1 };

const THINKING = new Set(['scenarios', 'critical_thinking']);
const COMPOSER = (() => {
  const NEG = /^(not|no|never|always|all|only|every|none|cannot|can|t|isn|aren|doesn|don|is|are|does|do)$/;
  /** 0..1: how good the wrong options are - a "not"/"always" look-alike of the key is a weak lure, so is a key much longer than the others */
  function lureQuality(r) { const key = r.options[r.correct_index], kw = normKey(key).split(' '); const ws = r.options.filter((_, i) => i !== r.correct_index); let triv = 0;
    ws.forEach((w) => { const b = normKey(w).split(' '); const A = new Set(kw), B = new Set(b); const diff = b.filter((x) => !A.has(x)).concat(kw.filter((x) => !B.has(x))); if (diff.length <= 2 && diff.every((x) => NEG.test(x))) triv++; });
    const avg = ws.reduce((a, w) => a + w.length, 0) / Math.max(1, ws.length); return Math.max(0, 1 - (triv / 3) * 0.8 - (key.length > 1.8 * avg + 12 ? 0.3 : 0)); }
  const frameOf = (stem) => normKey(String(stem).replace(/^(مراجعة|Review): /, '')).split(' ').slice(0, 3).join(' ');
  const formsFor = (qtype) => (FORMS[qtype] || []).filter((f) => FORM[f]);
  /** the generator's state, copied before a candidate is tried and restored after (a candidate that is not chosen leaves no trace) */
  const snap = (used) => ({ set: new Set(used), concepts: new Set(used.__concepts || []), sent: new Map(used.__sent || []), dis: new Set(used.__dis || []) });
  const restore = (used, s) => { used.clear(); s.set.forEach((x) => used.add(x)); const fix = (k, src) => { if (!used[k]) return; used[k].clear(); src.forEach((v, kk) => (used[k] instanceof Map ? used[k].set(kk, v) : used[k].add(v))); };
    fix('__concepts', s.concepts); fix('__sent', s.sent); fix('__dis', s.dis); };
  function score(S, slot, name, r) { const all = S.base.concat(S.acc); const same = all.filter((c) => c.form === name).length; const fr = frameOf(r.stem); const sameFrame = all.filter((c) => frameOf(c.stem) === fr).length;
    return 0.4 * ((FORM_DEPTH[name] || 1.5) / 3) + 0.25 * LEARN.score(name) + 0.2 * lureQuality(r) - 0.2 * same - 0.08 * sameFrame; }
  /** the composer's decision for one slot: every form of the identity tried, judged, scored; the best one built for real (null = no form can write this slot) */
  function compose(S, slot) { const names = formsFor(slot.qtype); if (!names.length) return null; const all = S.base.concat(S.acc); const s0 = snap(S.used); const cands = [];
    for (const name of names) { slot.__nth = all.filter((c) => c.form === name).length; let r = null; try { r = FORM[name](toolkit(slot, S.m, S.used, S.pages, S.lang), slot, S.m, S.pages); } catch (_) { r = null; } restore(S.used, s0);
      if (!r) continue; r.form = name; if (!S.check(slot, r)) continue; cands.push({ name, r, sc: score(S, slot, name, r), same: slot.__nth }); }
    if (!slot.loose && THINKING.has(slot.qtype)) for (let i = cands.length - 1; i >= 0; i--) if ((FORM_DEPTH[cands[i].name] || 1.5) < 2) cands.splice(i, 1);      // a scenario / critical question must make the student reason, not recall
    const capQuiz = slot.loose ? Infinity : Math.max(3, Math.ceil(0.12 * (S.want || all.length + 1)));
    { const within = cands.filter((c) => c.same < capQuiz); const over = cands.filter((c) => c.same < Math.ceil(capQuiz * 1.5));
      cands.splice(0, cands.length, ...(within.length || !slot.cover ? within : over)); }      // a page with no question yet may go over the cap (up to half again) - only when no other form can write it
    S.stats.composer_candidates = (S.stats.composer_candidates || 0) + cands.length; if (!cands.length) return null;
    const typeN = all.filter((c) => c.qtype === slot.qtype).length + 1, cap = Math.max(2, Math.ceil(0.4 * Math.max(typeN, (S.planned && S.planned[slot.qtype]) || 0)));      // one form never fills an identity while another form can write the slot
    const pool = cands.length > 1 && cands.some((c) => c.same < cap) ? cands.filter((c) => c.same < cap) : cands; const best = pool.reduce((b, c) => (c.sc > b.sc + 1e-9 ? c : b));
    slot.__nth = best.same; const r = FORM[best.name](toolkit(slot, S.m, S.used, S.pages, S.lang), slot, S.m, S.pages); if (r) r.form = best.name; return r; }
  /** a form added later joins its identity, and the composer weighs it like the others (no other change needed) */
  function register(qtype, name, fn, depth = 2) { if (!FORMS[qtype] || typeof fn !== 'function') return false; FORM[name] = fn; if (!FORMS[qtype].includes(name)) FORMS[qtype].push(name); FORM_DEPTH[name] = depth; return true; }
  // ---- the AI path: no local building, but the same two jobs - a suitable shape per slot without repeating one shape, and the deep material for scenario / critical slots
  const SHAPES = {
    scenarios: ['vignette: describe a case through two findings taken from the cited pages and ask which state / phase / category of the lecture explains them (wrong options = sibling states / phases of the same lecture)',
      'two cases: Case 1 and Case 2 each show one finding; ask which pairing of states / groups is correct (the four pairings are the options)', 'prediction: a stated condition of the lecture; ask which combination of findings is expected (wrong options reverse one or both)',
      'decision in context: a realistic situation in the lecture\'s field; ask for the best action / interpretation the lecture supports'],
    critical_thinking: ['evaluate two claims: Student A and Student B each restate a point of the lecture, one or both possibly altered (reversed, negated, over-generalised, swapped); options: Only A / Only B / Both / Neither',
      'error analysis: quote a claim (possibly altered); ask what exactly is wrong with it - its opposite word, an added negation, an over-generalisation, a swap - or that it is correct', 'inference: give two findings, the student infers the state, then predicts another finding of it',
      'best-supported conclusion: which conclusion follows from the lecture\'s evidence (wrong options over-reach, reverse or misattribute it)'],
    basic_recall: ['term from its meaning', 'complete a key statement (one decisive term blanked)', 'which item belongs to a list of the lecture'], understanding: ['meaning in other words', 'which statement is true', 'what an abbreviation stands for'],
    mechanisms: ['cause -> effect', 'effect -> cause', 'purpose of a step / structure'], application: ['classify a new example into the lecture\'s categories', 'apply a value / range from the lecture', 'which member of a family fits a description'],
    not_except: ['all of the following EXCEPT', 'which is NOT true', 'which is LEAST related'], sequence: ['correct order', 'what comes next', 'what comes first'],
    compare_contrast: ['difference between two items', 'match items to their groups', 'which feature distinguishes A from B'], best_answer: ['best description', 'most accurate statement', 'best example'] };
  function material(m, refs) { const D = deep(m); const on = (r) => refs.includes(r); const out = [];
    D.states.filter((s) => s.items.some((it) => on(it.ref))).slice(0, 2).forEach((s) => out.push(`${s.e.cond}: ${s.items.slice(0, 5).map((it) => it.text).join('; ')}`));
    D.groups.filter((f) => f.members.some((mm) => on(mm.ref))).slice(0, 1).forEach((f) => out.push(f.members.map((mm) => `${memName(mm)}: ${ptsOf(mm).slice(0, 2).map((p) => p.text).join('; ')}`).join(' | ')));
    D.pairs.filter((p) => p.kind === 'fam' && [p.a, p.b].some((mm) => on(mm.ref))).slice(0, 1).forEach((p) => out.push(`${memName(p.a)} vs ${memName(p.b)}`));
    D.claims.filter((x) => on(x.ref)).slice(0, 2).forEach((x) => out.push(`checkable claim: ${x.text}`)); return out.join('\n').slice(0, 700); }
  /** annotate the AI's slots: a shape (rotated per identity, least used first) and, for scenario / critical slots, the lecture's deep material on those pages */
  function guide(plan, pagesList) { if (!plan || !plan.slots) return plan; let m = null; try { m = mine(pagesList); } catch (_) { m = null; } const used = {};
    for (const s of plan.slots) { const list = SHAPES[s.qtype]; if (!list) continue; const u = (used[s.qtype] ||= list.map(() => 0)); const i = u.indexOf(Math.min(...u)); u[i]++; s.shape = list[i];
      if (m && (s.qtype === 'scenarios' || s.qtype === 'critical_thinking')) { const mt = material(m, s.pages || []); if (mt) s.material = mt; } }
    return plan; }
  return { compose, score, lureQuality, register, deep, guide, formsFor, depth: FORM_DEPTH };
})();


/* The accept step shared by planned slots and the finishing pass: static validation, duplicates, leaks. `base` = questions accepted elsewhere (the AI's), for duplicate context only. */
function session(pagesList, st, plan, base) {
  const pages = Object.fromEntries(pagesList.map((p) => [p.ref, p.text])); const m = mine(pagesList); m.field = st.field || E.detectField(pagesList.map((p) => p.text).join(' ')); const used = new Set(); const acc = [], dropped = [];
  const ctx = { pages, field: st.field, language: 'source', allowExternal: false, sourceAr: E.arRatio(pagesList.slice(0, 10).map((p) => p.text).join(' ')) > .4 };
  const stats = { drafted: 0, rejected_validation: 0, rejected_verifier: 0, rejected_duplicate: 0, rejected_leak: 0, unwritable: 0, retries: 0 };
  const judge = (s, raw) => { const relaxed = !!s.extra;
    const c = { form: raw.form || null, slot: s.slot, qtype: s.qtype, task: null, objective: s.objective, objective_id: s.objective_id, difficulty: s.difficulty, stem: raw.stem, options: raw.options, correct_index: raw.correct_index, explanation: raw.explanation,
      purpose: raw.purpose, reasoning_pattern: raw.reasoning_pattern, evidence: raw.evidence, uses_external: false, extra: relaxed, variant: s.variant || 0, angle: s.angle || null, pk: E.pageKey(s.pages), local: true };
    const v = E.validateQ(c, ctx); let d; const known = base.concat(acc);
    if (v.some((x) => x.severity === 'decisive')) return { ok: false, key: 'rejected_validation', reasons: v.filter((x) => x.severity === 'decisive').map((x) => x.message) };
    const same = (a) => E.norm(a.stem) === E.norm(c.stem) && E.norm(a.options[a.correct_index]) === E.norm(c.options[c.correct_index]);      // round 2: only an identical question is a copy
    if (s.loose ? (d = (known.find(same) || {}).slot) !== undefined : (d = E.dupOf(c, known, relaxed)) != null) return { ok: false, key: 'rejected_duplicate', reasons: [`مكرر للسؤال ${d}.`] };
    if (!s.loose && (d = E.leaks(c, known, relaxed)) != null) return { ok: false, key: 'rejected_leak', reasons: [`يكشف إجابة سؤال آخر (${d}).`] };
    return { ok: true, c, v }; };
  const check = (s, raw) => judge(s, raw).ok;
  const take = (s, raw) => { stats.drafted++; const j = judge(s, raw); if (!j.ok) { stats[j.key]++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: j.reasons }); return false; }
    j.c.issues = j.v.concat([{ code: 'rules_mode', message: 'وُلّد بالقواعد بلا حل مستقل: المشتتات من المصدر نفسه وليست من استدلال نموذج.', severity: 'minor' }]); acc.push(j.c); return true; };
  const planned = {}; ((plan && plan.slots) || []).forEach((x) => { planned[x.qtype] = (planned[x.qtype] || 0) + 1; });
  return { pages, m, used, acc, dropped, stats, take, check, planned, base, lang: st.language || 'source' };
}
/* The finishing pass: the requested count is ALWAYS delivered (a student who asks for 100 questions gets 100 - asking the same lecture again in other ways is how one studies).
 * Round 1: the page with the FEWEST questions so far gives one more question (any type, any unused form), so the lecture stays evenly covered.
 * Round 2 (the lecture is thin for this count): the limits that keep a quiz varied are lifted - a sentence may be blanked again, a list asked for all its items -
 *   only a question identical to one already in the quiz is refused.
 * Round 3 (still short): review copies - questions already in the quiz asked again later, marked «مراجعة», their options in another order. */
function finish(S, pagesList, want, startNo, pool, st) {
  const refs = pagesList.map((p) => p.ref); const total = () => S.base.length + S.acc.length; let no = startNo;
  const cnt = (ref) => S.base.concat(S.acc).filter((c) => (c.evidence || []).some((e) => e.page === ref)).length; const obj = (ref) => (pool || []).find((o) => o.pages.includes(ref)) || {};
  const topicOfRef = Object.fromEntries(pagesList.map((p) => [p.ref, normKey(cleanTitle((p.text.split('\n').find((l) => l.trim()) || '').replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '')))]));      // continuation slides («… (continued_3)») share their topic
  const tcnt = (ref) => refs.filter((r) => topicOfRef[r] === topicOfRef[ref]).reduce((a, r) => a + cnt(r), 0);
  for (const level of [1, 2]) { if (total() >= want) break; S.used.__level = level; const dead = new Set(); let v = level === 2 ? 1000 : 0;
    for (let guard = 0; total() < want && guard < 6000; guard++) {
      const ref = refs.filter((r) => !dead.has(r)).sort((a, b) => (cnt(a) > 0) - (cnt(b) > 0) || tcnt(a) - tcnt(b) || cnt(a) - cnt(b) || E.pn(a) - E.pn(b))[0]; if (!ref) break; let built = false, anyRaw = false; const uncovered = cnt(ref) === 0;
      // the composer's order of identities for this extra question: the ones furthest below what the plan asked for first, then the least represented (rotation breaks ties)
      const have = {}; S.base.concat(S.acc).forEach((c) => { have[c.qtype] = (have[c.qtype] || 0) + 1; });
      const order = TYPES.map((t, i) => [t, ((S.planned && S.planned[t]) || 0) - (have[t] || 0), have[t] || 0, (i - v % TYPES.length + TYPES.length) % TYPES.length]).sort((a, b) => b[1] - a[1] || a[2] - b[2] || a[3] - b[3]).map((x) => x[0]);
      for (let k = 0; k < order.length * (uncovered ? 2 : 1) && !built; k++) { const qtype = order[k % order.length]; const o = obj(ref);      // an uncovered page: every identity within the repetition cap first, then (second pass) over it
        const s = { slot: no, qtype, pages: [ref], extra: true, loose: level === 2, cover: uncovered && k >= order.length, variant: v, objective: o.statement || '', objective_id: o.id || '', difficulty: E.difficultyFor(st, qtype), angle: null };
        const raw = COMPOSER.compose(S, s); if (!raw) continue; anyRaw = true; if (S.take(s, raw)) { built = true; no++; } }
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
  const S = session(pagesList, st, plan, []); const want = plan.requested || plan.slots.length; S.want = want; let lastYield = Date.now();
  for (const s of plan.slots) { progress('drafting', Math.round(100 * S.acc.length / Math.max(1, want)));
    if (Date.now() - lastYield > 40) { await new Promise((r) => setTimeout(r, 0)); lastYield = Date.now(); }      // let the page breathe (a phone shows the progress instead of freezing); same questions
    const raw = COMPOSER.compose(S, s); if (!raw) { S.stats.unwritable++; S.dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: ['المصدر لا يحوي نمطًا مناسبًا لهذا النوع في الصفحات المحددة (التوليد المحلي).'] }); continue; }
    S.take(s, raw); }
  if (S.acc.length < want) { progress('retrying', Math.round(100 * S.acc.length / Math.max(1, want))); finish(S, pagesList, want, Math.max(0, ...plan.slots.map((s) => s.slot)) + 1, plan.pool, st); }
  if (S.acc.length > want) S.acc.length = want;
  if (S.acc.length >= want) S.dropped.forEach((d) => { d.replaced = true; });      // whatever a planned slot could not give was made up by another question
  return { accepted: S.acc, dropped: S.dropped, stats: S.stats };
}
/* The AI path's last resort: `known` = what the AI delivered; build `missing` more questions locally from any page (never a copy of a known one). */
async function fill(plan, known, missing, pagesList, st, progress) {
  const S = session(pagesList, st, plan, known); const want = known.length + missing; S.want = want; progress('retrying', Math.round(100 * known.length / Math.max(1, want)));
  finish(S, pagesList, want, Math.max(0, ...known.map((c) => c.slot || 0), ...plan.slots.map((s) => s.slot)) + 1, plan.pool, st); return { accepted: S.acc, dropped: S.dropped, stats: S.stats };
}
/* Flashcards without AI: one card = one idea, read from the whole lecture (its definitions, the orders of its phases / steps, the examples of each group,
 * the two sides of each paired effect, its abbreviations and ranges, its causes and lists), then SPREAD over the pages - one card per page in turn - so twenty
 * cards cover the lecture instead of its first slides. The back is short (the first sentence); the quote is the lecture's own line. */
function cards(pagesList, n, spreadN = n) {
  const m = mine(pagesList); const pool = []; const ar = (t) => isAr(t); const first = (t) => clip(strip(String(t).replace(/^[\s\-–•]+/, '').split(/\.\s+(?=[A-Z\u0600-\u06FF])/)[0]), 160);
  const add = (front, back, ref, quote, w = 1) => { if (front && back && ref && quote) pool.push({ front, back, page: ref, quote, w }); };
  m.defs.forEach((d) => add(ar(d.sentence) ? `ما المقصود بـ «${d.term}»؟` : `What is "${d.term}"?`, first(d.tail), d.ref, d.sentence, 3));
  (m.fams || []).filter((f) => f.ordered && f.members.length >= 3 && f.members.every((x) => wc(memName(x)) <= 5)).forEach((f) => { const t = famTitle(m, f); add(t ? `Order of "${t}"` : `Put in the lecture's order: ${f.members.map(memName).slice().sort().join(', ')}`, f.members.map(memName).join(' → '), f.members[0].ref, f.members[0].line, 4); });
  (m.fams || []).forEach((f) => f.members.forEach((x) => { const pt = x.points.map((q) => shortPoint(q.text, 18)).find((q) => q && wc(q) >= 3); if (pt && !m.defs.some((d) => normKey(d.term) === normKey(x.lead)) && !/\(/.test(pt.slice(0, 30))) add(`"${memName(x)}": what does the lecture say about it?`, pt, x.ref, (x.points.find((q) => q.text.startsWith(pt.slice(0, 20))) || x.points[0]).raw, 2); }));
  const cats = {}; (m.examples || []).forEach((x) => { (cats[x.category] = cats[x.category] || { ref: x.ref, quote: x.sentence, ex: [] }).ex.push(x.example); });
  Object.entries(cats).forEach(([c, v]) => add(`Give the lecture's example(s) of "${c}"`, [...new Set(v.ex)].slice(0, 4).join(', '), v.ref, v.quote, 2));
  (m.effects || []).forEach((e) => e.items.forEach((it) => { if (it.pair) { const [la, lb] = condLabels(e); const org = it.organ.filter((t) => it.pair.organ.includes(t))[0] || 'this organ'; add(`${cap1s(org)}: ${la} vs ${lb}?`, `${la}: ${clip(it.text, 70)}; ${lb}: ${clip(it.pair.text, 70)}`, it.ref, it.raw, 3); } }));
  (m.gloss || []).forEach((g) => add(g.kind === 'acronym' ? `What does "${g.term}" stand for?` : `"${g.term}" - what is it?`, g.mean, g.ref, g.sentence, 2));
  (m.ranges || []).forEach((r) => { const blank = r.sentence.replace(r.text, '____'); if (blank !== r.sentence && wc(blank) <= 30) add(`Complete: ${blank}`, r.text, r.ref, r.sentence, 2); });
  m.causal.forEach((c) => add(isAr(c.sentence) ? `ماذا يحدث عندما: ${c.head}؟` : `What follows when: ${c.head}?`, `${c.conn} ${clip(c.tail, 140)}`, c.ref, c.sentence, 2));
  m.lists.forEach((l) => add(isAr(l.sentence) ? `اذكر ما يندرج تحت: ${clip(strip(l.lead), 80)}` : `List: ${clip(strip(l.lead), 80)}`, l.items.slice(0, 6).join('، '), l.ref, l.sentence, 2));
  m.cloze.forEach((c) => add((isAr(c.sentence) ? 'أكمل: ' : 'Complete: ') + c.sentence.slice(0, c.index) + '____' + c.sentence.slice(c.index + c.term.length), c.term, c.ref, c.sentence, 1));
  // one card per page in turn (the stronger kinds first on each page), no two cards with the same front
  const byPage = new Map(); pool.forEach((c) => { if (!byPage.has(c.page)) byPage.set(c.page, []); byPage.get(c.page).push(c); }); byPage.forEach((a) => a.sort((x, y) => y.w - x.w));
  const pages0 = pagesList.map((p) => p.ref).filter((r) => byPage.has(r)); const stride = Math.max(1, Math.ceil(pages0.length / Math.max(1, spreadN))); const order = [];      // evenly spaced pages first: twenty cards of a 56-slide lecture reach its end
  for (let off = 0; off < stride; off++) for (let i = off; i < pages0.length; i += stride) order.push(pages0[i]); const out = [], seen = new Set();
  for (let round = 0; out.length < n && order.some((r) => byPage.get(r).length > 0); round++) for (const r of order) { const c = byPage.get(r).shift(); if (!c) continue; const k = normKey(c.front); if (seen.has(k)) continue; seen.add(k); out.push(c); if (out.length >= n) break; }
  return out;
}
window.QZE.rules = { mine, analyse, profile, generate, fill, cards, diagnose, learn: LEARN, composer: COMPOSER };
})();
