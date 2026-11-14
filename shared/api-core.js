/* Quizzy — browser "server" core. Implements the /api/* contract the UI uses, entirely in the page:
 * extraction (pdf.js/JSZip) · planning/validation engine (engine.js, rules.js) · quizzes, attempts, cards.
 * Everything environment-specific comes from window.QZ_HOST (defined BEFORE this file by an edition's host.js):
 *   platform() -> {signedIn,user,aiAvailable,...}   store() -> {get,set,del,list}   llm.json(task,system,prompt)
 *   capabilities(pl) · bannerText(pl) · auth{login,register,logout,forgot,reset,password,delete} · handle(...) · printPdf
 * Must be loaded before the UI module: it replaces window.fetch for /api/* calls. */
(() => {
const E = window.QZE, realFetch = window.fetch.bind(window);
const nowS = () => Date.now() / 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const ER = (status, code, message, extra) => J({ code, message, ...(extra || {}) }, status);
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
const SCORING = { points_per_correct: 1, negative_marking: false, unanswered: 0, text: 'درجة واحدة لكل إجابة صحيحة، بلا خصم على الخطأ، والسؤال غير المجاب يساوي صفرًا. الدرجة = الصحيح ÷ عدد الأسئلة.' };

// ---------------------------------------------------------------- host adapters (see header)
const H = window.QZ_HOST;
// AI ONLY (the Claude edition): every analysis, plan and question is Claude's. The local generator (rules.js) is not even shipped there; nothing falls back to it,
// fills a quiz with it, or uses its heuristics. The owner's lecture_reader / quiz_engine rules (owner_rules.js) still read the lecture and check the evidence.
const AI_ONLY = !!H.aiOnly;
if (!H) throw new Error('QZ_HOST missing: load an edition host.js before api-core.js');
const platform = () => H.platform();
const store = () => H.store();
const llm = H.llm;
const cache = new Map(); // doc id -> object (reads are frequent: polling)
async function getDoc(k) { if (cache.has(k)) return cache.get(k); const v = await (await store()).get(k); if (v) cache.set(k, v); return v; }
async function putDoc(k, v) { cache.set(k, v); await (await store()).set(k, v); }
async function delDoc(k) { cache.delete(k); await (await store()).del(k); }
async function putMany(entries) { entries.forEach(([k, v]) => cache.set(k, v)); const st = await store(); if (st.setMany) await st.setMany(entries); else for (const [k, v] of entries) await st.set(k, v); }
/* PAGES WITHOUT THEIR FILE (a page reloaded in the middle of an upload, after the pages and before the file record): nothing reaches them, and they fill the
 * viewer's storage. Once a session, in the background, they are removed - never the pages of an upload still running here, nor any written in the last hour. */
const UPLOADING = new Set(); let gcRan = false;
// what is being deleted right now (the page removed it at once, the store follows): every list and read leaves it out meanwhile, so it never comes back on screen
// ...and once deleted, for the rest of the session: a list read while the store was still deleting must not bring it back when its answer arrives late
const DELETING = new Set(), GONE = new Set(); const hidden = (id) => DELETING.has(id) || GONE.has(id);
const deleting = async (ids, f) => { ids.forEach((id) => DELETING.add(id)); try { const r = await f(); ids.forEach((id) => GONE.add(id)); return r; } finally { ids.forEach((id) => DELETING.delete(id)); } };
async function gcPages(docs) { if (gcRan) return; gcRan = true;
  try { if (!docs.length) return; const ids = new Set(docs.map((d) => d.id)), old = nowS() - 3600; const st = await store(); const pages = (await st.list('page')) || [];
    const by = {}; for (const p of pages) if (p && p.doc && !ids.has(p.doc) && !UPLOADING.has(p.doc) && !(p.at > old)) (by[p.doc] ||= []).push(K.page(p.doc, p.page_no));
    for (const did in by) if (!(await st.get(K.doc(did)))) await delMany(by[did]); } catch (_) { gcRan = false; } }      // each file asked for once more: a short list never costs a page
async function delMany(keys) { keys.forEach((k) => cache.delete(k)); const st = await store(); if (st.delMany) await st.delMany(keys); else for (const k of keys) await st.del(k); }
/** read many documents with ONE round trip when the store can (network stores), cache-first */
async function getMany(keys) {
  const out = {}; const miss = []; keys.forEach((k) => (cache.has(k) ? (out[k] = cache.get(k)) : miss.push(k)));
  if (miss.length) { const st = await store(); if (st.getMany) Object.assign(out, await st.getMany(miss)); else for (const k of miss) { const v = await st.get(k); if (v) out[k] = v; } miss.forEach((k) => out[k] && cache.set(k, out[k])); }
  return out;
}
const K = { doc: (id) => 'doc_' + id, page: (id, n) => `page_${id}_${n}`, quiz: (id) => 'quiz_' + id, att: (id) => 'att_' + id, card: (id) => 'card_' + id, ckpt: (id) => 'ckpt_' + id };
async function listKind(kind) { const l = ((await (await store()).list(kind)) || []).filter((d) => d && !hidden(d.id)); const kf = { doc: K.doc, quiz: K.quiz, attempt: K.att, card: K.card }[kind]; if (kf) l.forEach((d) => cache.set(kf(d.id), d)); return l; }

// ---------------------------------------------------------------- extraction (browser)
const OK_MIN = 80;
const MAX_UPLOAD_MB = 40;      // what the Files page promises (the server edition accepts the same)
const STORAGE_FULL = 'امتلأت مساحة التخزين التي يسمح بها متصفحك لهذا الموقع، فلم يُحفظ ما طلبتَه (ولم يضِع شيء مما عندك). أفرِغ بعضها: احذف كويزات أو ملفات قديمة (من «كويزاتي» و«ملفاتي»، وهناك زر يحذف الكويزات الفاشلة دفعة واحدة)، أو نزّل نسخة من بياناتك ثم امسحها من «حسابي»، ثم أعد المحاولة.';
// the device's storage was out of reach for a moment (the browser closed its connection: a phone that put the page in the background): the store opens it again by
// itself (shared/stores.js) - this is said only when even that failed, in words a student understands, never as the browser's English error
const STORAGE_LOST = 'انقطع اتصال الصفحة بمساحة الحفظ على جهازك لحظةً، فلم يكتمل طلبك (وما حُفظ قبله باقٍ). أعد المحاولة، وإن تكرر فحدّث الصفحة.';
const storageLost = (e) => !!e && (e.code === 'storage_unavailable' || ['InvalidStateError', 'TransactionInactiveError'].includes(e.name) || /IDBDatabase|IDBTransaction|IDBObjectStore|IndexedDB|Indexed Database|database connection/i.test(String(e.message || '')));
const NOT_GRANTED = 'لم يُسمح لكويزي باستخدام Claude في هذه الصفحة. حدّث الصفحة، ثم اضغط «سماح» حين يطلب Claude الإذن.';
const jobErr = (e) => (!e ? 'خطأ غير متوقع' : e.code === 'not_granted' ? NOT_GRANTED : e.code === 'storage_full' ? STORAGE_FULL : storageLost(e) ? STORAGE_LOST : e.message || String(e));      // what a failed job tells the student
// PDFs often store Arabic as shaped presentation forms (U+FB50–FEFF): fold them back to base letters so terms/regexes/quotes match
const unshape = (s) => (/[\ufb50-\ufdff\ufe70-\ufeff]/.test(s) ? s.normalize('NFKC') : s.normalize('NFC'));
const cleanLines = (s) => s.replace(/\u0000/g, '').split('\n').map((l) => l.replace(/[ \t ​]+/g, ' ').trim()).reduce((o, l) => { if (l || (o.length && o[o.length - 1])) o.push(l); return o; }, []).join('\n').trim();
// a bullet drawn with a symbol font (Wingdings / Symbol) arrives as a PRIVATE-USE character, which shows as an empty box («□ The blood is…»): a bullet at the start
// of a line, nothing elsewhere
const fixGlyphs = (s) => String(s || '').replace(/^([ \t]*)[\uE000-\uF8FF]+[ \t]*/gm, '$1• ').replace(/[\uE000-\uF8FF]/g, '');
const clean = (s) => cleanLines(fixGlyphs(unshape(String(s || ''))));
function classify(text, images) {
  const n = text.length; if (n) { const bad = [...text].filter((c) => c === '\uFFFD' || (c >= '\uE000' && c <= '\uF8FF')).length; if (bad / n > .15) return ['garbled', ['النص المستخرج من هذه الصفحة تالف (خط غير قياسي)، فلن يُستخدم.']]; }
  if (!n) return images ? ['image_only', ['الصفحة صورة بلا نص يمكن قراءته.']] : ['empty', ['صفحة فارغة.']];
  if (n < OK_MIN) return ['low_text', [images ? 'نص قليل مع صور؛ محتوى الصور غير مقروء.' : 'نص قليل جدًا (قد تكون صفحة عنوان).']];
  return ['ok', images ? ['تحتوي على صور/أشكال لم تُقرأ؛ الأسئلة لن تعتمد عليها.'] : []];
}
// a running header/footer ("Sebastian Raschka STAT 479: Machine Learning FS 2019 ! 15") comes in variants (page number glued or on its own line, a stray
// glyph): lines are compared by their words alone, so every variant counts toward the same key
const boilKey = (l) => { const k = l.toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim(); return k.replace(/\s/g, '').length >= 6 ? k : ''; };
function stripBoiler(pages) {
  if (pages.length < 4) return; const cnt = new Map(); pages.forEach((p) => new Set(p.text.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 90).map(boilKey).filter(Boolean)).forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1)));
  const thr = Math.max(3, Math.floor(pages.length * .5)); const rep = new Set([...cnt].filter(([, v]) => v >= thr).map(([k]) => k)); if (!rep.size) return;
  pages.forEach((p) => (p.text = clean(p.text.split('\n').filter((l) => { const t = l.trim(); return !(t && t.length < 90 && rep.has(boilKey(t))); }).join('\n'))));
}
/* ---- FRONT MATTER: what is ABOUT the lecture, not the lecture - never a source of questions or cards.
 * The cover (title, the lecturer's name, the university, the book / chapter), the objectives and the outline ("Objectives", "At the end of this lecture the
 * students will be able to…", "Outline", "الأهداف"), and the closing slide ("Thank you", "Questions?", "References"); and, inside a content page, a line that
 * only names the lecturer or the institution. Returns Map(page_no -> reason) for one document's pages (in order); the lines are removed in place. */
const FM_HEAD_STRONG = /^(?:learning|lecture|session|course|intended\s+learning)\s+(?:objectives?|outcomes?|goals?|aims?)\s*:?$|^ilos?\b|^(?:at|by)\s+the\s+end\s+of\s+(?:this|the)\s+(?:lecture|session|chapter|class|unit|module)|^(?:students?|you)\s+(?:will|should)\s+be\s+able\s+to|^(?:الأهداف|أهداف\s+(?:المحاضرة|الدرس|التعلم)|مخرجات\s+التعلم|محاور\s+المحاضرة|في\s+نهاية\s+(?:هذه\s+)?(?:المحاضرة|الدرس))/i;      // objectives wherever they are
const FM_HEAD_WEAK = /^(?:objectives?|outcomes?|goals?|aims?|out\s*-?\s*lines?|(?:table\s+of\s+)?contents?|agenda|lecture\s+(?:plan|outline|overview)|المحتويات|محتوى\s+المحاضرة)\s*:?$/i;      // the same words as a page's own heading: only at the start of the file (a nursing page titled «Goals» is content)
const FM_HEAD = { test: (l) => FM_HEAD_STRONG.test(l) || FM_HEAD_WEAK.test(l) };
const FM_END = /^(?:thank(?:s|\s+you)(?:\s+for\s+(?:your\s+)?(?:attention|listening))?|any\s+questions|questions|the\s+end|references?|bibliography|further\s+reading|شكرا|شكرًا|شكراً|نهاية\s+المحاضرة|المراجع|أسئلة)\s*[.!?؟:]*$/i;
const FM_VERB = /^(?:understand|describe|explain|enumerate|list|identify|define|discuss|differentiate|distinguish|compare|predict|recogni[sz]e|outline|state|mention|classify|demonstrate|apply|analy[sz]e|illustrate|summari[sz]e|know|recall|determine|evaluate|interpret|يشرح|يعدد|يعرّف|يعرف|يميز|يقارن|يصف|يذكر|يحدد|يفهم|يتعرف)\b/i;
const FM_PERSON = /^(?:(?:dr|prof|professor|lecturer|instructor|tutor|presented\s+by|prepared\s+by|supervised\s+by|by)\b\.?\s*:?\s*\S|د\.\s*\S|الدكتور(?:ة)?\s|أ\.\s*د|إعداد\s*:|تقديم\s*:)|\S+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b|\b(?:university|college|faculty|department|school|institute)\s+of\b|^(?:جامعة|كلية|قسم)\s/i;
const FM_TITLE = /\b(?:lecture|chapter|unit|module|session|week|edition|book\s+cover|course|semester|level|year|dr|prof)\b|محاضرة|الفصل|الوحدة|المستوى/i;
const fmVerbLine = (l) => /\b(?:is|are|was|were|has|have|can|may|will|causes?|leads?|results?|produces?|requires?|contains?|increases?|decreases?|reduces?|includes?|involves?|refers?|occurs?)\b/i.test(l) && l.split(/\s+/).length >= 6;
// talk to the CLASS, not about the subject: greetings, check points, logging in, taking notes, the chat, attendance, cameras, phones, breaks - a slide made of
// such lines («CLASS CHECK POINT'S: Good Morning, CHECK you had your morning coffee, CHECK you are logged in with your ID…») is not lecture content
const HK_HEAD = /^(?:class\s+check\s*-?\s*points?|check\s*-?\s*points?|house\s*-?\s*keeping|class\s+(?:rules|reminders?|expectations|etiquette|norms|guidelines)|ground\s+rules|reminders?|announcements?|before\s+we\s+(?:start|begin)|welcome(?:\s+(?:back|to\s+(?:the\s+)?class))?|good\s+(?:morning|afternoon|evening)|attendance|(?:zoom|online|virtual)\s+(?:class\s+)?(?:etiquette|rules|guidelines)|تعليمات\s+المحاضرة|قواعد\s+(?:المحاضرة|الحضور|الفصل)|تنبيهات|إعلانات|الحضور\s+والغياب|صباح\s+الخير)\b/i;
const HK_LINE = /\b(?:good\s+(?:morning|afternoon|evening)|(?:morning|your|had\s+your)\s+coffee|coffee\s+break|logged\s+in|log\s*-?\s*in\s+(?:with|using|to)|sign\s*-?\s*in\s+(?:with|using|to)|your\s+(?:student\s+)?(?:id|number|first\s+name|full\s+name)\b|with\s+(?:your\s+)?first\s+name|taking\s+notes|take\s+notes|(?:take|taking|mark|record)\s+attendance|attendance\s+(?:sheet|list|is|will)|(?:turn|switch)\s+(?:on|off)\s+(?:your\s+)?(?:camera|video|mic(?:rophone)?)|(?:your|the)\s+(?:camera|microphone)\s+(?:on|off)|un?mute\s+(?:your|the)|in\s+the\s+chat\b|(?:typing|type|write)\s+(?:it\s+)?in\s+the\s+chat|raise\s+your\s+hand|(?:be\s+)?afraid\s+to\s+ask|ask\s+(?:any\s+|your\s+)?questions\s+(?:in|by|at|during)|phones?\s+(?:off|on\s+silent|silent)|be\s+on\s+time|(?:zoom|teams|webex)\s+(?:link|meeting|session|call|class)|on\s+(?:blackboard|moodle)|office\s+hours|(?:quiz|exam|test)\s+(?:next\s+week|is\s+on|will\s+be\s+on)|(?:homework|assignment)\s+(?:is\s+)?due|صباح\s+الخير|سجّ?ل\s+دخولك|دوّ?ن\s+ملاحظاتك|اكتب\s+سؤالك\s+في)/i;
const hkLine = (l) => HK_LINE.test(l) || /^\s*(?:[\d.)•\-–*]+\s*)?check\b.{0,60}\b(?:you|your)\b/i.test(l) || /^\s*(?:[\d.)•\-–*]+\s*)?(?:hi|hello|welcome)\b.{0,30}(?::\)|!|$)/i.test(l);
// the general rule behind it: a slide that SPEAKS TO THE STUDENTS (instructions, greetings, «you / your», «make sure…», «feel free…») and shares almost none of its
// words with the rest of the lecture is about the class, not the subject - whatever words it uses (a procedure in a nursing lecture also speaks in imperatives,
// but its words - patient, order, equipment - run through the whole lecture)
const ADDRESS = /^(?:[\d.)•\-–*]+\s*)?(?:please\s+)?(?:check|make\s+sure|ensure\s+(?:you|that\s+you)|remember\s+to|don'?t\s+forget|do\s+not\s+(?:be|forget|hesitate)|be\s+(?:on\s+time|sure|ready|prepared|quiet|respectful|punctual|kind)|bring|turn\s+(?:on|off)|switch\s+(?:on|off)|keep\s+your|join|log\s*-?\s*in|sign\s*-?\s*in|type|raise|mute|respect|participate|arrive|feel\s+free|let'?s|welcome|hello|hi\b|good\s+(?:morning|afternoon|evening)|no\s+(?:phones?|food|eating|talking)|silence)\b|\b(?:you|your|yourself|yourselves)\b/i;
const FM_STOP = new Set('this that with from have will your what when where which their there they them then than been were also into only such some more most each other these those about after before while because between through during without within under over very much many make made used uses using does done'.split(' '));
const docWords = (t) => [...new Set((String(t).toLowerCase().match(/[a-z\u0600-\u06FF]{4,}/g) || []).filter((w) => !FM_STOP.has(w)))];
function frontMatter(pages) {
  const out = new Map(); if (!pages.length) return out; const words = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length; const w0 = words;
  const seen = new Map(); pages.forEach((p) => docWords(p.text).forEach((x) => seen.set(x, (seen.get(x) || 0) + 1)));      // on how many pages each word occurs
  pages.forEach((p, i) => {
    let lines = p.text.split('\n').map((l) => l.trim()).filter(Boolean); const head = lines.slice(0, 3).map((l) => l.replace(/^[•●▪◦‣\-–*\d.)\s]+/, ''));
    // the lecturer / institution lines are dropped wherever they are (short lines only: a sentence that cites a person stays)
    const kept = lines.filter((l) => !(FM_PERSON.test(l) && words(l) <= 8)); if (kept.length !== lines.length) { p.text = kept.join('\n'); lines = kept; }
    // talk to the class: a whole slide of it is left out; a stray line of it on a content slide («Do not be afraid to ask questions in the chat!») is dropped
    const hk = lines.filter(hkLine).length; const title0 = (lines[0] || '').replace(/^[•●▪◦‣\-–*\d.)\s]+/, '').replace(/[’']\s*s\b/i, 's');
    if (lines.length && (HK_HEAD.test(title0) || (lines.length >= 2 && hk / lines.length >= 0.5 && w0(p.text) <= 90))) { out.set(p.page_no, 'housekeeping'); return; }
    { const talk = lines.slice(1).filter((l) => hkLine(l) || ADDRESS.test(l)).length, body = Math.max(1, lines.length - 1); const ws = docWords(p.text); const shared = ws.filter((x) => (seen.get(x) || 0) > 1).length;
      if (pages.length >= 4 && lines.length >= 3 && talk / body >= 0.6 && (!ws.length || shared / ws.length < 0.25) && w0(p.text) <= 90) { out.set(p.page_no, 'housekeeping'); return; } }
    if (hk) { const k2 = lines.filter((l) => !(hkLine(l) && words(l) <= 16)); if (k2.length && k2.length !== lines.length) { p.text = k2.join('\n'); lines = k2; } }
    const w = words(p.text); const body = lines.filter((l) => !FM_HEAD.test(l.replace(/^[•●▪◦‣\-–*\d.)\s]+/, '')));
    if (!lines.length) return;      // an empty page gives nothing anyway (it is not called a cover)
    if (w <= 14 && lines.some((l) => FM_END.test(l.replace(/^[•●▪◦‣\-–*\s]+/, '')))) { out.set(p.page_no, 'closing'); return; }
    if (FM_END.test(head[0] || '') && /^(?:references?|bibliography|further\s+reading|المراجع)/i.test(head[0])) { out.set(p.page_no, 'references'); return; }
    const early = i <= 2; const isHead = (l) => { const t = l.replace(/^[•●▪◦‣\-–*\d.)\s]+/, ''); return FM_HEAD_STRONG.test(t) || (early && FM_HEAD_WEAK.test(t)); };
    const objAt = lines.findIndex(isHead);
    const verbs = lines.filter((l) => FM_VERB.test(l.replace(/^[•●▪◦‣\-–*\d.)\s]+/, ''))).length;
    if (objAt >= 0) { const before = lines.slice(0, objAt).filter((l) => !/^[A-Z\s&,'-]+$/.test(l)); if (objAt <= 2 || words(before.join(' ')) < 25) { out.set(p.page_no, 'objectives'); return; }
      p.text = lines.slice(0, objAt).join('\n'); lines = lines.slice(0, objAt); }      // content first, then an objectives block: the block goes
    if (early && lines.length >= 3 && verbs / lines.length >= 0.6) { out.set(p.page_no, 'objectives'); return; }      // a list of what the students will be able to do (at the start only: «Identify the patient… Explain the procedure…» later on is a procedure)
    const sentences = p.text.split(/(?<=[.!?؟])\s+|\n+/).filter(fmVerbLine).length;      // statements of fact on the page
    if (i === 0 && pages.length > 1 && w <= 40 && (lines.length <= 4 || FM_TITLE.test(p.text) || /https?:\/\/|www\.|\S@\S/.test(p.text)) && (sentences === 0 || (sentences === 1 && FM_TITLE.test(p.text) && lines.length >= 2))) { out.set(p.page_no, 'cover'); return; }      // (five lines or more with no sign of a cover - «Lecture», a course, a link - is a heading over a list or a diagram: content)
    if (i > 0 && w <= 40 && sentences === 0 && /^(?:book\s+cover\b|chapter\s+\d+\b|lecture\s+\d+\b|المحاضرة\s+\S+\s*$|الفصل\s+\S+\s*$)/im.test(p.text)) { out.set(p.page_no, 'cover'); return; }      // a second chapter / lecture inside the same file starts with its own cover
    if (pages.length > 1 && w <= 6 && !lines.some(fmVerbLine) && body.length <= 3 && (i === 0 || i === pages.length - 1)) out.set(p.page_no, i === 0 ? 'cover' : 'closing');
  });
  if (out.size >= pages.length) out.clear();      // never the whole document
  return out;
}
/** pages whose text was READ FROM AN IMAGE (a picture slide, a diagram with labels): when the file has its own slide text, questions come from that text only -
 *  recognised text of a picture is often wrong («Bram» for «Brain», broken Arabic labels). A file that is all pictures (a scanned lecture) keeps them: it has nothing else. */
function imageTextPages(metas) { const ocr = metas.filter((m) => m.ocr), native = metas.filter((m) => !m.ocr && ['ok', 'low_text'].includes(m.status));
  return native.length >= 3 || native.length >= 0.3 * metas.length ? new Set(ocr.map((m) => m.page_no)) : new Set(); }
const IMAGE_TEXT_REASON = 'نص هذه الصفحة مقروء آليًا من صورة (شريحة مصوّرة أو مخطط): الأسئلة تُبنى من نص الشرائح نفسه فقط.';
const FM_REASON = { housekeeping: 'شريحة موجّهة للفصل لا للمادة (ترحيب، تعليمات حضور ودخول، تدوين، أسئلة في المحادثة…): ليست من مادة الدرس.', cover: 'غلاف المحاضرة (العنوان واسم المحاضِر): ليس من مادة الدرس.', objectives: 'أهداف الدرس أو مخططه: ليست من مادة الدرس.', closing: 'شريحة الختام: ليست من مادة الدرس.', references: 'المراجع: ليست من مادة الدرس.' };
// ---- SCANNED pages: text recognition in the browser (tesseract.js, fetched by scripts/fetch_ocr.sh; the host says where: H.ocrBase). Loaded only when a PDF
// has pages that are pictures; the student sees the progress ("قراءة الصفحات المصوّرة… ٣ من ١٠"). Without the files (or on any failure) such pages stay
// "a picture without text" and the page says so - nothing is guessed.
const OCR_MAX_PAGES = 60, OCR_MIN_CONF = 45;
const progress = (detail) => { try { window.dispatchEvent(new CustomEvent('qz-progress', { detail })); } catch { /* old browser */ } };
const OCRW = {};      // one recognition worker per language set, created on first use: English alone reads English pages best (mixing in the Arabic model turned a noisy
// English page into Arabic letters); Arabic pages (and Arabic with English terms) go to the Arabic+English worker
function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { s.remove(); bad(new Error('تعذّر تحميل جزء من الموقع لازم لقراءة الملف؛ تحقق من الإنترنت ثم أعد المحاولة.')); }; document.head.appendChild(s); }); }
function ocrWorker(langs = ['eng']) {
  const k = langs.join('+');
  if (!OCRW[k]) { OCRW[k] = (async () => { const base = H.ocrBase; if (!base) throw new Error('ocr unavailable');
    if (!window.Tesseract) await loadScript(base + 'tesseract.min.js');
    return window.Tesseract.createWorker(langs, 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', gzip: true, workerBlobURL: false }); })();
    OCRW[k].catch(() => { delete OCRW[k]; }); }
  return OCRW[k];
}
// a photographed / photocopied page has shadows and grey gradients: black text on white, judged against its own neighbourhood (Bradley's adaptive threshold
// over an integral image), reads far better than the page as it is
function binarize(cx, w, h) {
  const img = cx.getImageData(0, 0, w, h), d = img.data, g = new Uint8ClampedArray(w * h), S = new Float64Array((w + 1) * (h + 1));
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
  for (let y = 1; y <= h; y++) { let row = 0; for (let x = 1; x <= w; x++) { row += g[(y - 1) * w + x - 1]; S[y * (w + 1) + x] = S[(y - 1) * (w + 1) + x] + row; } }
  const r = Math.max(8, Math.round(Math.min(w, h) / 24));
  for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1); const n = (x1 - x0) * (y1 - y0);
      const sum = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]; const v = g[y * w + x] * n < sum * 0.85 ? 0 : 255; const j = (y * w + x) * 4; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; } }
  cx.putImageData(img, 0, 0);
}
async function ocrPage(pdf, no) {
  const page = await pdf.getPage(no); const vp1 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: Math.max(1, Math.min(3, 1800 / vp1.width)) });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); const cx = c.getContext('2d', { willReadFrequently: true }); await page.render({ canvasContext: cx, viewport: vp }).promise;
  binarize(cx, c.width, c.height);
  const read = async (langs) => { const { data } = await (await ocrWorker(langs)).recognize(c, {}, { text: true, blocks: true }); const lines = [];
    // the speckles at the edge of a photocopy come out as junk words AT THE ENDS of a line ("RES EF"): those are trimmed; a word in the middle is never dropped
    // (that would change the sentence), and a line that was mostly guessed is left out whole
    const bad = (w) => w.confidence < 55 || !/\p{L}{2}|\d/u.test(w.text);
    (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((pa) => (pa.lines || []).forEach((l) => { let ws = (l.words || []).filter((w) => String(w.text || '').trim());
      while (ws.length && bad(ws[0])) ws = ws.slice(1); while (ws.length && bad(ws[ws.length - 1])) ws = ws.slice(0, -1);
      const mean = ws.length ? ws.reduce((a, w) => a + w.confidence, 0) / ws.length : 0; const t = ws.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      if (t && mean >= 60 && /\p{L}{2}/u.test(t)) lines.push({ text: t, x0: Math.min(...ws.map((w) => w.bbox.x0)), x1: Math.max(...ws.map((w) => w.bbox.x1)), y: -l.bbox.y0, h: l.bbox.y1 - l.bbox.y0 }); })));
    return { text: lines.length ? E.reflowLines(lines) : '', conf: lines.length ? data.confidence || 0 : 0 }; };
  let r = await read(['eng']);
  if (r.conf < 70) { try { const r2 = await read(['ara', 'eng']); if (r2.conf > r.conf) r = r2; } catch { /* keep the English reading */ } }
  c.width = c.height = 0; return r;
}
/** Text recognition (OCR) is a SUPPORT for when it is really needed: a lecture that is pictures (a scan, photographed pages) has no other text, so its pages are read.
 *  In a file with its own text, a picture slide is NOT recognised: the questions come from the text the file carries (recognised picture text gave «Bram» for
 *  «Brain» and broken Arabic labels as options). */
function ocrNeeded(pages) { const native = pages.filter((p) => (p.text.match(/[\p{L}\p{N}]+/gu) || []).length >= 8).length; return native < 3 && native < 0.3 * pages.length; }
async function ocrScanned(pdf, pages, name) {
  const pictures = pages.filter((p) => !p.text.trim() && p.image_count);
  if (pictures.length && !ocrNeeded(pages)) { pictures.forEach((p) => { p.ocr_skipped = true; }); return; }
  const todo = pictures.slice(0, OCR_MAX_PAGES); if (!todo.length || !H.ocrBase) return;
  progress({ phase: 'ocr-load', name, done: 0, total: todo.length });
  try { await ocrWorker(['eng']); } catch { progress({ phase: 'ocr-done', name }); return; }
  for (let i = 0; i < todo.length; i++) { const p = todo[i];
    try { const r = await ocrPage(pdf, p.page_no); if (r.conf >= OCR_MIN_CONF && r.text.trim()) { p.text = clean(r.text); p.ocr = Math.round(r.conf); } else p.ocr_unclear = true; } catch { p.ocr_unclear = true; }
    progress({ phase: 'ocr', name, done: i + 1, total: todo.length }); }
  progress({ phase: 'ocr-done', name });
}
async function extractPdf(buf, name) {
  if (!window.pdfjsLib) await loadScript(new URL('pdf.min.js', document.baseURI).href);      // the readers are loaded when a file is uploaded, not on every visit (~400 KB less to download first)
  const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', document.baseURI).href;
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise; if (pdf.numPages > 400) throw new Error('عدد الصفحات يتجاوز 400.');
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i); const tc = await pg.getTextContent();
    // visual lines with their geometry, then back into sentences (E.reflowLines): a sentence cut at every line end made half-sentence questions
    const lines = []; let cur = null;
    for (const it of tc.items) { const t = it.transform || [1, 0, 0, 1, 0, 0], x = t[4], y = t[5], w = it.width || 0, hgt = Math.hypot(t[2], t[3]) || it.height || 0;
      if (cur && Math.abs(y - cur.y) > 3) { lines.push(cur); cur = null; }
      if (!cur) cur = { text: '', x0: Infinity, x1: -Infinity, y, h: 0 };
      cur.text += it.str; if (it.str.trim()) { cur.x0 = Math.min(cur.x0, x); cur.x1 = Math.max(cur.x1, x + w); cur.h = Math.max(cur.h, hgt); }
      if (it.hasEOL) { lines.push(cur); cur = null; } }
    if (cur) lines.push(cur);
    const text = E.reflowLines(lines.filter((l) => l.text.trim()).map((l) => (l.x0 === Infinity ? { ...l, x0: 0, x1: 0 } : l)));
    let images = 0, frac = 0; try { const ops = await pg.getOperatorList(); const O = lib.OPS, PAINT = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintJpegXObject].filter((x) => x != null));
      // how much of the page each picture covers (the area of its unit square under the current transform: the product of the transforms' determinants)
      const v = pg.view || [0, 0, 612, 792], area = Math.abs((v[2] - v[0]) * (v[3] - v[1])) || 1; let det = 1; const st = [];
      ops.fnArray.forEach((f, k) => { const a = ops.argsArray[k];
        if (f === O.save) st.push(det); else if (f === O.restore) det = st.length ? st.pop() : 1;
        else if (f === O.transform && a) det *= (a[0] * a[3] - a[1] * a[2]);
        else if (f === O.paintFormXObjectBegin) { st.push(det); const m = a && a[0]; if (m && m.length === 6) det *= (m[0] * m[3] - m[1] * m[2]); }
        else if (f === O.paintFormXObjectEnd) det = st.length ? st.pop() : 1;
        else if (PAINT.has(f)) { images++; frac = Math.max(frac, Math.min(1, Math.abs(det) / area)); } }); } catch { /* ignore */ }
    pages.push({ page_no: i, text: clean(text), image_count: images, fig_frac: Math.round(frac * 1000) / 1000 });
  }
  await ocrScanned(pdf, pages, name);
  // the figure reader sees the whole slide, as the student does (its labels where they point)
  Object.defineProperty(pages, 'figureImages', { value: async (no) => { const page = await pdf.getPage(no); const vp1 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: Math.max(1, Math.min(2.5, 1400 / vp1.width)) });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: cx, viewport: vp }).promise; const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); return b ? [b] : []; } });
  return pages;
}
/** a picture of a deck as a JPEG Claude can read (at most 1600 px a side; a picture too small to carry labels, or of a kind the browser cannot draw - EMF, WMF - is none) */
async function asJpeg(blob) { try { const bmp = await createImageBitmap(blob); if (Math.min(bmp.width, bmp.height) < 120) return null; const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); } catch { return null; } }
async function extractPptx(buf) {
  if (!window.JSZip) await loadScript(new URL('jszip.min.js', document.baseURI).href);
  const zip = await window.JSZip.loadAsync(buf); let names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  try {      // the order the presenter set (presentation.xml), not the file numbers: a slide moved in PowerPoint keeps its old file name
    const pres = await zip.files['ppt/presentation.xml'].async('string'), rels = await zip.files['ppt/_rels/presentation.xml.rels'].async('string');
    const target = {}; rels.replace(/<Relationship\b[^>]*>/g, (r) => { const id = (r.match(/\bId="([^"]+)"/) || [])[1], t = (r.match(/\bTarget="([^"]+)"/) || [])[1]; if (id && t) target[id] = 'ppt/' + t.replace(/^\/?(ppt\/)?/, ''); return r; });
    const ordered = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => target[m[1]]).filter((n) => n && zip.files[n]);
    if (ordered.length) names = ordered;
  } catch (e) { /* no presentation part: file-number order */ }
  if (names.length > 400) throw new Error('عدد الشرائح يتجاوز 400.'); const pages = [];
  let slideArea = 12192000 * 6858000; try { const pres = await zip.files['ppt/presentation.xml'].async('string'); const m = pres.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/); if (m) slideArea = +m[1] * +m[2]; } catch (_) { /* the default 16:9 size */ }
  const pics = {};      // slide number -> its large pictures (media file, share of the slide), largest first
  for (let i = 0; i < names.length; i++) {
    const xml = new DOMParser().parseFromString(await zip.files[names[i]].async('string'), 'application/xml'); const paras = [];
    // a paragraph's outline level (a:pPr lvl) is the lecture's own hierarchy - a heading and the points under it: a sub-level paragraph is written with its level's bullet sign
    xml.querySelectorAll('p, a\\:p').forEach((p) => { const t = [...p.getElementsByTagName('a:t')].map((x) => x.textContent).join('').trim(); if (!t) return;
      const pr = [...p.childNodes].find((c) => c.nodeName === 'a:pPr'); const lvl = Math.min(4, +((pr && pr.getAttribute('lvl')) || 0));
      paras.push(lvl ? ['•', '◦', '▪', '‣'][lvl - 1] + ' ' + t : t); });      // one bullet sign per level (the page text is trimmed line by line, so indentation would be lost)
    // a SmartArt diagram and a chart LOOK like pictures but carry real text in their own parts of the file: read without any recognition
    try { const relsName = names[i].replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'); const rels = zip.files[relsName] ? await zip.files[relsName].async('string') : '';
      const target = (id) => { const m = rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*>`)); const t = m && (m[0].match(/\bTarget="([^"]+)"/) || [])[1]; return t ? 'ppt/' + t.replace(/^(\.\.\/)+/, '').replace(/^\/?ppt\//, '') : null; };
      const partText = async (n, sel) => { if (!n || !zip.files[n]) return []; const d = new DOMParser().parseFromString(await zip.files[n].async('string'), 'application/xml'); return sel(d); };
      for (const rel of xml.getElementsByTagName('dgm:relIds')) { const dm = target(rel.getAttribute('r:dm'));
        const pts = await partText(dm, (d) => [...d.getElementsByTagName('dgm:pt')].filter((pt) => !pt.getAttribute('type') || pt.getAttribute('type') === 'node').map((pt) => [...pt.getElementsByTagName('a:t')].map((x) => x.textContent).join('').trim()).filter(Boolean));
        pts.forEach((t) => paras.push(t)); }
      for (const ch of xml.getElementsByTagName('c:chart')) { const cp = target(ch.getAttribute('r:id'));
        const lines = await partText(cp, (d) => { const title = [...(d.getElementsByTagName('c:title')[0] || { getElementsByTagName: () => [] }).getElementsByTagName('a:t')].map((x) => x.textContent).join('').trim();
          const cats = [...new Set([...d.getElementsByTagName('c:cat')].flatMap((c) => [...c.getElementsByTagName('c:v')].map((v) => v.textContent.trim())).filter((v) => v && !/^-?[\d.,]+$/.test(v)))];
          const series = [...new Set([...d.getElementsByTagName('c:ser')].map((sr) => [...(sr.getElementsByTagName('c:tx')[0] || { getElementsByTagName: () => [] }).getElementsByTagName('c:v')].map((v) => v.textContent.trim()).join(' ')).filter(Boolean))];
          return [title, ...cats.map((c) => '• ' + c), ...(series.length > 1 ? series.map((c) => '• ' + c) : [])].filter(Boolean); });      // one series is the measure, not an item
        lines.forEach((t) => paras.push(t)); } } catch (e) { /* a broken part: the slide's own text is kept */ }
    const images = xml.getElementsByTagName('p:pic').length; let frac = 0;
    try { const relsName = names[i].replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'); const rels = zip.files[relsName] ? await zip.files[relsName].async('string') : ''; const list = [];
      for (const pic of xml.getElementsByTagName('p:pic')) { const ext = pic.getElementsByTagName('a:ext')[0], blip = pic.getElementsByTagName('a:blip')[0]; if (!ext || !blip) continue;
        const f = (+ext.getAttribute('cx') || 0) * (+ext.getAttribute('cy') || 0) / slideArea; const id = blip.getAttribute('r:embed'); const m = id && rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*>`)); const t = m && (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
        if (t) list.push({ file: 'ppt/' + t.replace(/^(\.\.\/)+/, '').replace(/^\/?ppt\//, ''), frac: Math.min(1, f) }); }
      list.sort((a, b) => b.frac - a.frac); frac = list.length ? list[0].frac : 0; pics[i + 1] = list.filter((x) => x.frac >= 0.06).slice(0, 2); } catch (_) { /* a broken part: no picture read */ }
    pages.push({ page_no: i + 1, text: clean([...new Set(paras.length ? paras : [])].length === paras.length ? paras.join('\n') : paras.join('\n')), image_count: images, fig_frac: Math.round(frac * 1000) / 1000 });
  }
  Object.defineProperty(pages, 'figureImages', { value: async (no) => { const out = []; for (const x of pics[no] || []) { const z = zip.files[x.file]; if (!z) continue; const j = await asJpeg(await z.async('blob')); if (j) out.push(j); } return out; } });
  return pages;
}
// ---- PowerPoint 97-2003 (.ppt): an OLE compound file holding the "PowerPoint Document" stream of binary records. The slides' text is read in
// presentation order (the persist directory of the newest edit maps each slide to its record), one page per slide, like a .pptx.
function cfbStreams(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf); const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  if (u8.length < 512 || sig.some((b, i) => u8[i] !== b)) throw new Error('ليس ملف PowerPoint قديمًا صالحًا.');
  const ss = 1 << dv.getUint16(30, true), mss = 1 << dv.getUint16(32, true), nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), cutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true), difStart = dv.getUint32(68, true), nDif = dv.getUint32(72, true);
  const off = (s) => 512 + s * ss; const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(76 + i * 4, true));
  for (let d = difStart, k = 0; d < 0xFFFFFFFA && k < nDif && fatSecs.length < nFat; k++) { const per = ss / 4 - 1; for (let i = 0; i < per && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(off(d) + i * 4, true)); d = dv.getUint32(off(d) + per * 4, true); }
  const fat = new Uint32Array(fatSecs.length * ss / 4); fatSecs.forEach((s, i) => { for (let j = 0; j < ss / 4; j++) fat[i * ss / 4 + j] = off(s) + j * 4 + 4 <= u8.length ? dv.getUint32(off(s) + j * 4, true) : 0xFFFFFFFE; });
  const chain = (start, table, limit) => { const out = []; for (let s = start, g = 0; s < 0xFFFFFFFA && g < limit; g++) { out.push(s); s = table[s]; if (s === undefined) break; } return out; };
  const read = (start, size) => { const secs = chain(start, fat, (size / ss | 0) + 2 + 1e6 * !size); const o = new Uint8Array(secs.length * ss); secs.forEach((s, i) => o.set(u8.subarray(off(s), off(s) + ss), i * ss)); return size ? o.subarray(0, size) : o; };
  const dir = read(dirStart, 0); const dd = new DataView(dir.buffer, dir.byteOffset, dir.byteLength); const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) { const nl = dd.getUint16(p + 64, true); if (!nl) { entries.push(null); continue; }
    let name = ''; for (let i = 0; i < nl / 2 - 1; i++) name += String.fromCharCode(dd.getUint16(p + i * 2, true));
    entries.push({ name, type: dir[p + 66], start: dd.getUint32(p + 116, true), size: dd.getUint32(p + 120, true) }); }
  const root = entries.find((e) => e && e.type === 5); const mini = root ? read(root.start, root.size) : new Uint8Array(0);
  const mfat = miniFatStart < 0xFFFFFFFA ? (() => { const b = read(miniFatStart, 0); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); })() : new Uint32Array(0);
  const stream = (name) => { const e = entries.find((x) => x && x.type === 2 && x.name === name); if (!e) return null;
    if (e.size >= cutoff) return read(e.start, e.size);
    const secs = chain(e.start, mfat, e.size / mss + 2); const o = new Uint8Array(secs.length * mss); secs.forEach((s, i) => o.set(mini.subarray(s * mss, s * mss + mss), i * mss)); return o.subarray(0, e.size); };
  return stream;
}
function extractPptBinary(buf) {
  const stream = cfbStreams(buf); const doc = stream('PowerPoint Document'); if (!doc) throw new Error('لا يحتوي الملف على عرض PowerPoint.');
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength); const N = doc.length;
  const head = (o) => (o + 8 <= N ? { ver: dv.getUint16(o, true) & 0xF, inst: dv.getUint16(o, true) >> 4, type: dv.getUint16(o + 2, true), len: dv.getUint32(o + 4, true) } : null);
  const utf16 = (o, len) => { let s = ''; for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(dv.getUint16(o + i, true)); return s; };
  const latin = (o, len) => { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(doc[o + i]); return s; };
  // every text atom under a record, in order (OfficeArt drawing records share the same 8-byte header, so one walk covers the slide and its shapes)
  const texts = (o, out, depth = 0) => { const h = head(o); if (!h || depth > 40) return out; const end = Math.min(N, o + 8 + h.len);
    if (h.type === 0x0FA0) out.push(utf16(o + 8, h.len)); else if (h.type === 0x0FA8) out.push(latin(o + 8, h.len)); else if (h.type === 0x0F9E && h.len >= 4) out.push({ ref: dv.getInt32(o + 8, true) });
    else if (h.ver === 0xF) for (let p = o + 8; p + 8 <= end;) { const c = head(p); if (!c) break; texts(p, out, depth + 1); p += 8 + c.len; }
    return out; };
  // the newest edit's persist directory: persist id -> offset of its record (older edits fill what the newer ones do not override)
  let persist = new Map(), docRef = null;
  try { const cu = stream('Current User'); const cdv = new DataView(cu.buffer, cu.byteOffset, cu.byteLength); let edit = cdv.getUint32(16, true);
    for (let g = 0; g < 200 && edit > 0 && edit < N; g++) { const h = head(edit); if (!h || h.type !== 0x0FF5) break; const b = edit + 8;
      if (docRef == null) docRef = dv.getUint32(b + 16, true); const pd = dv.getUint32(b + 12, true); const ph = head(pd);
      if (ph && ph.type === 0x1772) for (let p = pd + 8; p < pd + 8 + ph.len;) { const w = dv.getUint32(p, true); const id0 = w & 0xFFFFF, n = w >>> 20; p += 4; for (let k = 0; k < n; k++, p += 4) if (!persist.has(id0 + k)) persist.set(id0 + k, dv.getUint32(p, true)); }
      const prev = dv.getUint32(b + 8, true); if (!prev || prev === edit) break; edit = prev; } } catch (e) { persist = new Map(); }
  // the slide list (in presentation order) with each slide's persist id and the placeholder text kept in the list itself
  const findDoc = () => { if (docRef != null && persist.has(docRef)) { const o = persist.get(docRef); const h = head(o); if (h && h.type === 0x03E8) return o; } for (let o = 0; o + 8 <= N;) { const h = head(o); if (!h) break; if (h.type === 0x03E8) return o; o += 8 + h.len; } return -1; };
  const d0 = findDoc(); const slides = [];
  if (d0 >= 0) { const dh = head(d0); for (let p = d0 + 8; p + 8 <= d0 + 8 + dh.len;) { const h = head(p); if (!h) break;
      if (h.type === 0x0FF0 && h.inst === 0) { let cur = null; for (let q = p + 8; q + 8 <= p + 8 + h.len;) { const c = head(q); if (!c) break;
          if (c.type === 0x03F3) { cur = { persistId: dv.getUint32(q + 8, true), list: [] }; slides.push(cur); } else if (cur && c.type === 0x0FA0) cur.list.push(utf16(q + 8, c.len)); else if (cur && c.type === 0x0FA8) cur.list.push(latin(q + 8, c.len));
          q += 8 + c.len; } }
      p += 8 + h.len; } }
  const clean1 = (t) => String(t).replace(/\r|\u000b/g, '\n').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pages = [];
  slides.forEach((s, i) => { const o = persist.get(s.persistId); let parts = [];
    if (o != null && head(o) && head(o).type === 0x03EE) parts = texts(o, []).map((x) => (typeof x === 'string' ? x : s.list[x.ref] || ''));
    const lines = [...parts, ...s.list.filter((t) => !parts.includes(t))].flatMap(clean1);
    pages.push({ page_no: i + 1, text: clean(lines.filter((x) => !/^[*#‹›<>]+$/.test(x)).join('\n')), image_count: 0 }); });      // «*» is the slide-number field
  if (!pages.length) throw new Error('لم يُعثر على شرائح في الملف.');
  return pages;
}
function parseSpec(spec, total) {
  if (spec == null || spec === '' || (Array.isArray(spec) && !spec.length)) return Array.from({ length: total }, (_, i) => i + 1);
  const s = new Set(); if (Array.isArray(spec)) spec.forEach((x) => s.add(+x)); else for (const part of String(spec).trim().split(/[,،;\s]+/)) { if (!part) continue; const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let x = a; x <= b; x++) s.add(x); } else if (/^\d+$/.test(part)) s.add(+part); else throw new Error('نطاق صفحات غير صالح: ' + part); }
  const bad = [...s].filter((p) => p < 1 || p > total); if (bad.length) throw new Error(`صفحات خارج الملف (١–${total}): ${bad.slice(0, 5)}`); return [...s].sort((a, b) => a - b);
}
function docSummary(d, withPages) {
  const ps = d.pages || []; const by = (st) => ps.filter((p) => p.status === st).map((p) => p.page_no);
  const out = { id: d.id, title: d.title, filename: d.filename, kind: d.kind_, status: d.status, error: d.error, page_count: d.page_count, created_at: d.created_at,
    quality: { ok: ps.filter((p) => p.status === 'ok').length, low_text: by('low_text'), image_only: by('image_only'), empty: by('empty'), garbled: by('garbled'), figures_unread: ps.filter((p) => p.image_count && p.status === 'ok' && !p.ocr).map((p) => p.page_no), read_from_images: ps.filter((p) => p.ocr).map((p) => p.page_no) } };
  if (withPages) out.pages = ps; return out;
}
/** what the tutor, the similar question and the correction are given about ONE question: the question, the student's answer, and the text of the lecture pages it
 *  was taken from (its evidence pages and the page after each, up to three pages) - read back from the store; a file since deleted leaves the quote and explanation */
async function qCtx(x, ans) {
  const txt = (id) => { const o = x.options.find((z) => z.id === id); return o ? o.text : ''; };
  const want = []; (x.evidence || []).forEach((e) => { if (e.doc_id && e.page_no) [e.page_no, e.page_no + 1].forEach((n) => { if (!want.some((w) => w.doc === e.doc_id && w.no === n)) want.push({ doc: e.doc_id, no: n, ref: e.page_no === n ? (e.ref || `p${n}`) : `p${n}` }); }); });
  const pick = want.slice(0, 3); const pages = {};
  try { const got = await getMany(pick.map((w) => K.page(w.doc, w.no))); pick.forEach((w) => { const pg = got[K.page(w.doc, w.no)]; if (pg && pg.text) pages[w.ref] = fixGlyphs(pg.text).slice(0, 3500); }); } catch (_) { /* the quote and explanation are enough */ }
  return { stem: x.stem, options: x.options.map((o) => o.text), chosen: ans.sel ? txt(ans.sel) : null, correct: txt(x.correct_option_id), explanation: x.explanation || '', quote: ((x.evidence || [])[0] || {}).quote || '', pages };
}
async function loadSource(sources, opts = {}) {
  if (opts.waitFigures) await figuresSettled(sources.map((s) => s.document_id));      // the quiz itself (not the read-ahead) waits a short while for pictures still being read
  const pages = [], excluded = [];
  for (let di = 0; di < sources.length; di++) { const s = sources[di]; const d = await getDoc(K.doc(s.document_id)); if (!d) throw new Error('ملف غير موجود.'); if (d.status !== 'ready') throw new Error(`الملف «${d.title}» لم تكتمل معالجته.`);
    const wanted = parseSpec(s.pages, d.page_count); const fromImage = imageTextPages(d.pages || []); const figOk = (m) => !!(m && m.figure_lines);      // a slide of a picture only, whose labels Claude read
    const usable = wanted.filter((no) => { const meta = d.pages.find((p) => p.page_no === no); return meta && (['ok', 'low_text'].includes(meta.status) || figOk(meta)) && !fromImage.has(no); });
    const texts = await getMany(usable.map((no) => K.page(d.id, no)));
    for (const no of wanted) { const meta = d.pages.find((p) => p.page_no === no); const ref = `d${di + 1}p${no}`;
      if (!meta || !(['ok', 'low_text'].includes(meta.status) || figOk(meta))) { excluded.push({ ref, document: d.title, page: no, status: meta ? meta.status : 'missing', reason: (meta && meta.notes) || 'غير مقروءة' }); continue; }
      if (fromImage.has(no)) { excluded.push({ ref, document: d.title, page: no, status: 'image_text', reason: IMAGE_TEXT_REASON }); continue; }
      const pg = texts[K.page(d.id, no)]; pages.push({ ref, doc_id: d.id, doc_title: d.title, page_no: no, text: pg ? fixGlyphs(pg.text) : '', status: meta.status, ...(pg && Array.isArray(pg.fig) && pg.fig.length ? { fig: pg.fig } : {}) }); }      // (files read before the glyph fix: cleaned here too)
    // the cover, the objectives / outline and the closing of THIS document are not lecture content: no question or card is made from them
    const mine = pages.filter((p) => p.doc_id === d.id); const fm = frontMatter(mine);      // (also removes, in place, the lines that only name the lecturer or the institution)
    for (const p of mine) { if (fm.has(p.page_no)) { excluded.push({ ref: p.ref, document: d.title, page: p.page_no, status: 'front_matter', reason: FM_REASON[fm.get(p.page_no)] }); pages.splice(pages.indexOf(p), 1); } } }
  return { pages, excluded };
}
/* ---- THE FIGURE READER (reading a lecture, Claude edition): a slide that carries a large picture (a sixth of it or more - not a logo, not the template's
 * decoration) is shown to Claude, which judges whether the picture holds lecture information the slide's text lacks and copies only what is written in it; a second
 * look confirms every line (engine.js readFigure). What passes is added to that slide's text, so the reading, the plan and the questions see it, and a question
 * quoting it quotes the slide. The cover, the objectives and the closing are not looked at; a page read by text recognition is not looked at again. */
// a slide is shown only when its picture is large AND its own text is thin (under FIG_THIN words: a title, a label or two) - where the lesson is in the picture;
// a slide whose text already teaches is not (its questions come from its text). Read side by side; the reading of the lecture waits at most FIG_WAIT_MS from the upload.
const FIG_MIN_FRAC = 0.06, FIG_THIN = 30, FIG_MAX_PAGES = 24, FIG_BUDGET_MS = 60000, FIG_WAIT_MS = 45000;
const FIGJOBS = new Map();      // doc id -> { t0, p }: its figures being read (this visit)
const wordsOf = (t) => (String(t || '').match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).length;
// A SCATTERED slide (a PDF's diagram of text boxes, a table, columns): its text comes back as many short pieces that are not list points («Respiratory»,
// «Acidosis», «which a», «of cortex.») - its meaning is in the arrangement, so the layout reader restates it (a real renal lecture lost four sections to this)
const BULLET = /^(\d{1,2}[.)]|[•▪◦●‣\-–*\uf0a7\uf0d8])\s*/;
function scattered(text) { const ls = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean); if (ls.length < 6) return false;
  const frag = ls.filter((l) => !BULLET.test(l) && wordsOf(l) <= 3).length; return frag >= 5 && frag / ls.length >= 0.4; }
// ...and only when the owner's reader approves little of it (at most FIG_LAYOUT_OK words of taught text): a scattered slide whose pieces still read as sentences
// is written from as it is (a real 66-slide lecture: 37 scattered slides, 15 of them with almost nothing approved - its four uncovered sections among them)
const FIG_LAYOUT_OK = 15;
const approvedWords = (text) => { const O = ownerRules(); if (!O) return 0; try { return O.readPages([O.pageFromText(1, text)], 'lecture').units.filter((u) => u.decision === 'include').reduce((n, u) => n + wordsOf(u.text), 0); } catch (_) { return 0; } };
function figureCandidates(pages, kind) { const fm = frontMatter(pages.map((p) => ({ ref: 'p' + p.page_no, page_no: p.page_no, text: p.text })));
  const out = []; for (const p of pages) { if (p.ocr || fm.has(p.page_no)) continue;
    if (kind === 'pdf' && scattered(p.text)) { const ok = approvedWords(p.text); if (ok <= FIG_LAYOUT_OK) out.push(Object.assign(p, { fig_mode: 'layout', fig_rank: ok })); continue; }      // the slide as it is drawn is what the reader needs (a PDF page is rendered whole)
    if ((p.fig_frac || 0) >= FIG_MIN_FRAC && wordsOf(p.text) < FIG_THIN) out.push(Object.assign(p, { fig_mode: 'figure', fig_rank: 0 })); }
  return out.sort((a, b) => a.fig_rank - b.fig_rank || a.page_no - b.page_no).slice(0, FIG_MAX_PAGES).sort((a, b) => a.page_no - b.page_no); }      // over the cap: the slides with least approved text first
/** the figures of these files still being read: waited for, at most until FIG_WAIT_MS after their upload (what is read later counts for the next quiz) */
async function figuresSettled(ids) { const jobs = [...new Set(ids)].map((id) => FIGJOBS.get(id)).filter(Boolean); if (!jobs.length) return;
  await Promise.all(jobs.map((j) => Promise.race([j.p, new Promise((r) => setTimeout(r, Math.max(0, j.t0 + FIG_WAIT_MS - Date.now())))]))); }
async function unstick(d) { if (d && d.status === 'processing' && d.figures_pending && !FIGJOBS.has(d.id)) { delete d.figures_pending; const ok = usableOf(d); Object.assign(d, { status: ok ? 'ready' : 'unreadable' }); await putDoc(K.doc(d.id), d).catch(() => {}); } }
const usableOf = (d) => (d.pages || []).some((p) => ['ok', 'low_text'].includes(p.status) || p.figure_lines);
/** a page with the lines read in its picture after its own text (what the questions are written and checked on) */
const withFig = (p) => (p.fig && p.fig.length ? { ...p, text: (p.text ? p.text + '\n' : '') + p.fig.join('\n') } : p);
/* THE ANALYSIS of a lecture: its text as read (cached on that text - the read-ahead and the quiz share it), and, beside it, a small analysis of the slides whose
 * pictures were read (cached on those slides with their lines). Their objectives join the lecture's, so the plan gives those slides their questions. */
async function analyseAll(src, st, sec) { const fp = src.pages.filter((p) => p.fig && p.fig.length).map(withFig);
  const [A, B] = await Promise.all([analyseCached(preRead(src), st, sec), fp.length ? analyseCached(fp, st, sec).catch(() => null) : null]);
  if (B && B.objectives && B.objectives.length) { const have = new Set(A.objectives.map((o) => o.id)); B.objectives.forEach((o) => { let oid = 'fig_' + o.id; while (have.has(oid)) oid += '_'; have.add(oid); A.objectives.push({ ...o, id: oid }); }); }
  return A; }
async function readFigures(d, pages, todo) {
  const t0 = Date.now(); let done = 0, stop = false; const added = []; const at = new Map(pages.map((p, i) => [p.page_no, i]));
  progress({ phase: 'figures', name: d.filename, done: 0, total: todo.length });
  await E.mapLimit(todo, Math.max(1, Math.min(8, H.concurrency || 3)), async (p) => {
    if (!stop && Date.now() - t0 < FIG_BUDGET_MS && !GONE.has(d.id)) {
      try { const imgs = await pages.figureImages(p.page_no);
        if (imgs.length) { const i = at.get(p.page_no); const r = await E.readFigure(llm, { title: d.title, page_no: p.page_no, text: p.text, before: i > 0 ? pages[i - 1].text : '', after: (pages[i + 1] || {}).text || '' }, imgs, p.fig_mode);
          if (r.lines.length && !GONE.has(d.id)) { added.push({ page_no: p.page_no, lines: r.lines.length });
            await putDoc(K.page(d.id, p.page_no), { kind: 'page', doc: d.id, page_no: p.page_no, text: p.text, fig: r.lines, at: nowS() });
            const m = d.pages.find((x) => x.page_no === p.page_no); if (m) Object.assign(m, { figure_lines: r.lines.length, notes: 'أُضيف إلى نص الصفحة ما كُتب في صورتها.' }); } } }
      catch (e) { if (e && (e.code === 'quota' || e.code === 'images_unavailable' || e.code === 'not_granted' || e.code === 'need_copy')) stop = true; } }
    progress({ phase: 'figures', name: d.filename, done: ++done, total: todo.length }); });
  if (GONE.has(d.id) || !(await getDoc(K.doc(d.id)))) return;      // deleted meanwhile
  Object.assign(d, { figures: { looked: todo.length, added, ms: Date.now() - t0 } }); if (added.length && d.status === 'unreadable') Object.assign(d, { status: 'ready', error: null });      // a lecture of pictures whose labels were read is usable
  await putDoc(K.doc(d.id), d);
  // what the pictures added is analysed now, in the background (a small analysis of those slides only, kept like any other): the quiz then finds it ready
  if (added.length) prepareAnalysis({ sources: [{ document_id: d.id, pages: null }] }, await platform()).catch(() => {});
}
/* ---- THE SLIDES AS THEY LOOK, kept on this device: a slide with a large picture is kept as an image when its file is read (in the background), so the
 * explanation shows the slide itself and Claude, explaining it, SEES its pictures. In the browser's own storage (IndexedDB) - not the claude.ai store, which is
 * shared by every viewer of the page and holds 256 KB a document; another device simply shows the slide's text. */
const SLIDE_IMG_MAX = 60; let SIMG = null;
function simg() { if (SIMG) return SIMG; SIMG = new Promise((res, rej) => { const r = indexedDB.open('qz-slides', 1); r.onupgradeneeded = () => r.result.createObjectStore('img'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); SIMG.catch(() => { SIMG = null; }); return SIMG; }
async function simgDo(mode, fn) { const db = await simg(); return new Promise((res, rej) => { const t = db.transaction('img', mode); let out; const q = fn(t.objectStore('img')); if (q) q.onsuccess = () => { out = q.result; }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
const slideImgPut = (k, blob) => simgDo('readwrite', (st) => st.put(blob, k)).catch(() => { /* no room: the text is shown */ });
const slideImgGet = (k) => simgDo('readonly', (st) => st.get(k)).catch(() => null);
const slideImgKeys = (doc) => simgDo('readonly', (st) => st.getAllKeys(IDBKeyRange.bound(doc + ':', doc + ':\uffff'))).catch(() => []);
const slideImgDrop = (doc) => simgDo('readwrite', (st) => st.delete(IDBKeyRange.bound(doc + ':', doc + ':\uffff'))).catch(() => {});
async function keepSlideImages(id, pages) { if (typeof indexedDB === 'undefined' || !pages.figureImages) return;
  for (const p of pages.filter((x) => (x.fig_frac || 0) >= FIG_MIN_FRAC || x.fig_mode === 'layout').slice(0, SLIDE_IMG_MAX)) { if (GONE.has(id)) return;
    try { const [b] = await pages.figureImages(p.page_no); if (b) await slideImgPut(id + ':' + p.page_no, b); } catch (_) { /* that slide shows its text */ } } }

/* ---- THE LECTURE EXPLAINED, SLIDE BY SLIDE (#/explain/<file>): the file's slides as a quiz reads them (the cover, the objectives and the closing out; a slide's
 * picture lines with it), each explained on demand by the AI (engine.js makeExplain) at the level the student chose, KEPT (a slide is never explained twice at one
 * level), and the next one prepared while the student reads. Where the student is (and which slides they marked understood) is kept per file. */
const XC = (doc, page, level, text) => 'xpc_' + hash53(doc + '|' + page + '|' + level + '|' + text), XP = (doc) => 'xpl_' + doc;
const XLEVELS = ['simple', 'deep', 'exam'];
const XBUSY = new Map();      // what is being explained now: a second ask (the prefetch, then the student) waits for that one
async function explainSlides(docId) { const src = await loadSource([{ document_id: docId, pages: null }]); return src.pages.map(withFig).map((p) => ({ page_no: p.page_no, text: p.text })); }
async function explainRoute(docId, act, method, b, pl) {
  const d = await getDoc(K.doc(docId)); if (!d || hidden(docId)) return ER(404, 'not_found', 'الملف غير موجود.'); if (d.status !== 'ready') return ER(409, 'not_ready', 'الملف لم يكتمل بعد.');
  const prog = async () => (await getDoc(XP(docId))) || { kind: 'xprog', id: XP(docId), doc: docId, current: 0, understood: [], level: 'simple' };
  if (act === 'progress' && method === 'PUT') return J(await serial(XP(docId), async () => { const p = await prog(); if (Number.isInteger(b.current)) p.current = b.current; if (XLEVELS.includes(b.level)) p.level = b.level;      // one write at a time («فهمتها» then the next slide: two at once lost the mark)
    if (Number.isInteger(b.understood)) p.understood = [...new Set([...(p.understood || []), b.understood])]; p.updated_at = nowS(); await putDoc(XP(docId), p); return p; }));
  let slides; try { slides = await explainSlides(docId); } catch (e) { return ER(422, 'source_error', e.message); }
  if (!act) { const have = new Set((await slideImgKeys(docId)).map((k) => +String(k).split(':').pop()));
    return J({ id: d.id, title: d.title, slides: slides.map((x) => (have.has(x.page_no) ? { ...x, img: true } : x)), progress: await prog(), ai: !!(pl.aiAvailable && llm && E.makeExplain) }); }
  if (act === 'image' && method === 'GET') { const blob = await slideImgGet(docId + ':' + (+b.page)); return blob ? new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }) : ER(404, 'not_found', 'لا صورة لهذه الشريحة على هذا الجهاز.'); }
  const i = slides.findIndex((x) => x.page_no === +b.page); if (i < 0) return ER(404, 'not_found', 'الشريحة غير موجودة.');
  if (!pl.aiAvailable || !llm || !E.makeExplain) return ER(503, 'no_ai', 'الشرح يحتاج Claude: افتح كويزي من داخل claude.ai ووافق على استخدامه.');
  const c = { title: d.title, page_no: slides[i].page_no, text: slides[i].text, before: (slides[i - 1] || {}).text || '', after: (slides[i + 1] || {}).text || '', total: slides.length };
  if (act === 'slide') { const img = await slideImgGet(docId + ':' + c.page_no); if (img && H.figuresReady && (await H.figuresReady().catch(() => false))) c.images = [img]; }      // Claude sees the slide as it looks
  if (act === 'ask' && method === 'POST') { try { const ar = await E.makeSlideAnswer(llm, c, b.q, b.history, b.selection); return J(ar ? { ar } : { ar: null }); } catch (e) { return ER(e && e.code === 'quota' ? 429 : 502, (e && e.code) || 'ask_failed', (e && e.message) || String(e)); } }
  if (act === 'slide' && method === 'POST') { const level = XLEVELS.includes(b.level) ? b.level : 'simple'; const key = XC(docId, c.page_no, level, c.text + (c.images ? '|seen' : ''));
    if (!b.refresh) { const hit = await getDoc(key).catch(() => null); if (hit && hit.data) return J({ page: c.page_no, level, ...hit.data, kept: true }); }
    if (!XBUSY.has(key)) XBUSY.set(key, (async () => { try { const x = await E.makeExplain(llm, c, level); if (x) await putDoc(key, { kind: 'xcache', id: key, doc: docId, page: c.page_no, level, data: x, at: nowS() }).catch(() => {}); return x; } finally { XBUSY.delete(key); } })());
    try { const x = await XBUSY.get(key); return x ? J({ page: c.page_no, level, ...x }) : ER(422, 'no_explanation', 'لم يتيسّر شرح سليم لهذه الشريحة الآن. حاول مرة أخرى.'); }
    catch (e) { return ER(e && e.code === 'quota' ? 429 : 502, (e && e.code) || 'explain_failed', (e && e.message) || String(e)); } }
  return ER(405, 'method', 'غير مدعوم.');
}
const typeSupportOut = (heur, field) => Object.fromEntries(E.ORDER.map((c) => [c, { label: E.QT[c][0], level: heur[c].level, missing: heur[c].missing }]));

// ---------------------------------------------------------------- quizzes
const JOBS = new Map(); // quiz id -> {stage,pct}
const SEEN = new Map();      // quiz id -> the progress last shown and since when
const RESUMED = new Set();      // quizzes this page took up again after an interruption (once each)
// a quiz is written inside the page: closed or reloaded (a phone reloads a page left in the background for long), the work stops - said plainly, with what to do
const INTERRUPTED = 'توقّف إنشاء الكويز لأن الصفحة أُغلقت أو أُعيد تحميلها (يحدث على الجوال عند الخروج من التطبيق مدة طويلة). اضغط «إعادة المحاولة»، وأبقِ الصفحة ظاهرة حتى يجهز.';
/* A QUIZ BEING MADE IN ANOTHER TAB (the link opened twice) is not «interrupted»: each tab keeps on this device which quizzes it is making, refreshed while it makes
 * them and removed when it closes. The other tab used to mark such a quiz «failed - the page was closed» and save that, and a «retry» there made it twice. */
const TAB = rid(), RUN_KEY = 'qz_running_v1', RUN_MS = 30000;
const runsRead = () => { try { return JSON.parse(localStorage.getItem(RUN_KEY) || '{}') || {}; } catch (_) { return {}; } };
const runsWrite = (o) => { try { localStorage.setItem(RUN_KEY, JSON.stringify(o)); } catch (_) { /* storage blocked: this tab only */ } };
function markRun(id, on) { const o = runsRead(), now = Date.now(); for (const k in o) if (!o[k] || now - o[k].at > RUN_MS) delete o[k]; if (on) o[id] = { tab: TAB, at: now }; else if (o[id] && o[id].tab === TAB) delete o[id]; runsWrite(o); }
const elsewhere = (id) => { const r = runsRead()[id]; return !!r && r.tab !== TAB && Date.now() - r.at < RUN_MS; };
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') { setInterval(() => { if (!JOBS.size) return; const o = runsRead(), now = Date.now(); for (const id of JOBS.keys()) o[id] = { tab: TAB, at: now }; runsWrite(o); }, 10000);
  window.addEventListener('pagehide', () => { const o = runsRead(); let n = 0; for (const k in o) if (o[k] && o[k].tab === TAB) { delete o[k]; n++; } if (n) runsWrite(o); }); }
const LOCAL_LABEL = 'محلي (بدون ذكاء اصطناعي)';
const QDEF = { generator: 'claude', count: 20, difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only', create_cards: false };
async function quizOut(q, full) {
  if (['analyzing', 'generating'].includes(q.status) && !JOBS.has(q.id)) {      // not being made in this tab: what the device holds now (another tab may have finished it)
    let now = null; try { now = await (await store()).get(K.quiz(q.id)); } catch (_) { /* the copy in memory */ }
    if (now && now.updated_at >= (q.updated_at || 0)) { cache.set(K.quiz(q.id), now); q = now; } }
  const there = ['analyzing', 'generating'].includes(q.status) && !JOBS.has(q.id) && elsewhere(q.id);      // being made in another tab of this page
  // THE QUIZ GOES ON BY ITSELF: a quiz whose page was closed or reloaded while it was being made (a phone does that to an app left in the background) is taken up
  // again the next time the app opens - from its checkpoint, the questions already written kept - instead of ending «failed». Once per page load; within six hours (a quiz left for longer waits for its «retry», which also takes up from the checkpoint).
  if (['analyzing', 'generating'].includes(q.status) && !JOBS.has(q.id) && !there && !RESUMED.has(q.id) && !hidden(q.id) && nowS() - (q.updated_at || 0) < 6 * 3600) {
    RESUMED.add(q.id); const pl = await platform();
    if (pl.aiAvailable || q.settings.generator === 'rules') { try { const gen = q.status === 'generating' && q.plan && q.plan.feasible_count > 0; await startJob(q, gen ? 'generating' : 'analyzing', () => (gen ? jobGenerate(q.id) : jobAnalyse(q.id, true))); } catch (_) { /* said below */ } } }
  if (['analyzing', 'generating'].includes(q.status) && !JOBS.has(q.id) && !there) { q.status = 'failed'; q.error = INTERRUPTED; try { await putDoc(K.quiz(q.id), q); } catch (_) { /* shown now; saved next time */ } }
  if (q._unsaved) { const why = q._unsaved; delete q._unsaved; try { await putDoc(K.quiz(q.id), q); } catch (_) { q._unsaved = why; } }      // a finished quiz not saved yet: tried again now
  const prog = { ...(JOBS.get(q.id) || (there ? { stage: 'elsewhere', pct: q.progress_pct || 5 } : { stage: q.progress_stage, pct: q.progress_pct || 0 })) }; const wait = JOBS.has(q.id) && H.waitState ? H.waitState() : null; if (wait) prog.note = wait;      // the viewer's AI asked us to wait a few seconds: said on the progress screen
  if (JOBS.has(q.id) && RESUMED.has(q.id)) prog.resumed = true;      // the screen says it went on from where it stopped
  if (JOBS.has(q.id)) { const k = prog.stage + '|' + prog.pct, seen = SEEN.get(q.id), now = Date.now(); if (!seen || seen.k !== k) SEEN.set(q.id, { k, t: now });      // how long nothing new has shown (no new step, no answer from Claude)
    prog.idle_s = Math.max(0, Math.round((now - Math.max(SEEN.get(q.id).t, H.lastAnswerAt ? H.lastAnswerAt() : 0)) / 1000)); } else SEEN.delete(q.id);
  const o = { id: q.id, title: q.title, status: q.status, settings: q.settings, error: q.error, is_demo: false, generator: q.generator, fallback: q.fallback || null, progress: prog, created_at: q.created_at, updated_at: q.updated_at, scoring: SCORING, error_code: q.error_code || null, ...(q._unsaved ? { unsaved: q._unsaved } : {}) };
  if (q.report) { o.report = q.report; o.question_count = q.report.delivered; }
  if (full) { o.plan = q.plan || null; if (q.analysis) o.analysis = { lecture_character: q.analysis.lecture_character, gaps: q.analysis.gaps, discipline_guess: q.analysis.discipline_guess, excluded_pages: q.analysis.excluded_pages, heuristic_support: q.analysis.heuristic_support, diagnostics: q.analysis.diagnostics, fallback: q.analysis.fallback,
      objectives: q.analysis.objectives.map((x) => ({ id: x.id, statement: x.statement, pages: x.pages, types: Object.keys(x.supports) })) }; o.source_preview = q.source_preview; }
  return o;
}
async function touch(q) { if (hidden(q.id)) return; q.updated_at = nowS(); await putDoc(K.quiz(q.id), q);      // (a quiz deleted while it was being made is not brought back by its job)
  if (!['analyzing', 'generating'].includes(q.status)) progress({ stage: 'quiz', id: q.id, status: q.status }); }      // the quiz screen shows a finished quiz AT ONCE (it no longer waits for its next 1.5 s check)
/* A JOB NEVER STOPS IN SILENCE: whatever fails in it - a read, a save, Claude - the quiz ends «failed» with the reason, and the screen says so. Before, a read or
 * a save that failed at the start or at the end of a job left the quiz «busy» for ever: the student's progress bar never moved again (until a reload). */
async function startJob(q, status, job) {
  JOBS.set(q.id, { stage: 'queued', pct: 0 }); markRun(q.id, true); q.status = status; q.error = null; q.error_code = null;      // (marked before it is saved: another tab never sees it «busy» and orphaned)
  try { await touch(q); } catch (e) { JOBS.delete(q.id); markRun(q.id, false); q.status = 'failed'; q.error = jobErr(e); q.error_code = (e && e.code) || null; throw e; }
  job().catch((e) => jobFailed(q.id, e)).finally(() => markRun(q.id, false));
}
async function jobFailed(id, e) {
  JOBS.delete(id); const q = cache.get(K.quiz(id)); if (!q || q.status === 'ready') return; q.status = 'failed'; q.error = jobErr(e); q.error_code = (e && e.code) || null;
  try { await touch(q); } catch (_) { progress({ stage: 'quiz', id, status: q.status }); }      // not even saved: the screen still shows why (the quiz is in memory)
}
/** Say WHAT was found and what to do, instead of a dead-end sentence. */
const srcStats = (pages) => ({ pages: pages.length, words: pages.reduce((n, p) => n + String(p.text || '').split(/\s+/).filter(Boolean).length, 0) });
function noObjectivesMessage(generator, d) {
  if (generator === 'rules') return `لم يجد التوليد المحلي ما يكفي لبناء أسئلة في هذا النطاق (${d.pages} صفحة، نحو ${d.words} كلمة؛ وُجد ${d.defs} تعريفًا و${d.lists} قائمة و${d.cloze} جملة صالحة لإكمال الفراغ). هذا الوضع يحتاج جملًا كاملة أو تعريفات بصيغة «مصطلح: شرح» أو قوائم تحت عنوان. جرّب نطاقًا أوسع، أو اربط ذكاءً اصطناعيًا ليفهم الملف مهما كانت صياغته.`;
  return `النص المقروء في هذا النطاق قليل جدًا لبناء أهداف (${d.pages} صفحة، نحو ${d.words} كلمة). وسّع نطاق الصفحات، أو تأكد أن الملف نصي لا صور ممسوحة.`;
}
/* The AI analysis of a lecture (its objectives and its profile) depends only on the pages' text and a few settings: analysed once, it is kept (this device, the 20 most recent) and
 * reused - a second quiz from the same lecture, a retry after a failure, a different count or difficulty all skip this whole phase (several model calls). A degraded (fallback)
 * analysis is never kept. ANALYSIS_V changes whenever the analysis changes shape: older ones are then ignored. */
const ANALYSIS_V = 'a6';      // a5: a section of short slides the first reading skipped is analysed again
const hash53 = (str) => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
async function analyseCached(pages, st, sec) {
  let key = null; try { key = 'acache_' + hash53(ANALYSIS_V + '|' + (st.field || '') + '|' + (st.external_mode || '') + '|' + pages.map((p) => p.ref + '\u0001' + p.text).join('\u0002')); } catch (_) { /* no cache */ }
  if (key) { try { const hit = await getDoc(key); if (hit && hit.v === ANALYSIS_V && hit.analysis && hit.analysis.objectives) return JSON.parse(JSON.stringify(hit.analysis)); } catch (_) { /* a damaged entry is just a miss */ } }
  if (key && ANALYSING.has(key)) return JSON.parse(JSON.stringify(await ANALYSING.get(key)));      // already being analysed (prepared while the student chose the settings): wait for THAT call, never a second one
  const run = (async () => { const a = await E.analyse(llm, pages, st, { concurrency: H.concurrency || 1, chunkChars: H.analysisChunkChars || 0, aiOnly: AI_ONLY, sectionOf: sec ? (r) => (sec[r] || {}).key || '' : null });
    if (key && !a.fallback && a.objectives.length) { try { await putDoc(key, { kind: 'acache', id: key, v: ANALYSIS_V, analysis: JSON.parse(JSON.stringify(a)), at: nowS() });
      const all = (await listKind('acache')).sort((x, y) => (y.at || 0) - (x.at || 0)); for (const x of all.slice(20)) await delDoc(x.id); } catch (_) { /* the cache is an optimisation: never a failure */ } }
    return a; })();
  if (key) { ANALYSING.set(key, run); run.then(() => ANALYSING.delete(key), () => ANALYSING.delete(key)); }
  return JSON.parse(JSON.stringify(await run));
}
const ANALYSING = new Map();      // lecture text -> the analysis in progress
// how long this page has been hidden (screen off, another app): a quiz is written inside the page, so that time is not the quiz's own - it is reported apart
let HIDDEN_MS = 0, hiddenAt = null; const hiddenNow = () => HIDDEN_MS + (hiddenAt ? Date.now() - hiddenAt : 0);
/* THE TIME A QUIZ IS GIVEN (Claude only): every question ready within 100 s of «create» - the time the page was hidden does not count (the browser holds the
 * requests then). A further round of top-ups starts only when it can end inside it; the rounds before it are planned to deliver the count. */
const CFG = (typeof window !== 'undefined' && window.QZ_CONFIG) || {};      // (tests may shorten the two limits)
const QUIZ_LIMIT_MS = +CFG.quizLimitMs || 97000, QUIZ_HARD_MS = +CFG.quizHardMs || 600000;      // the time a quiz is given; the time it may never pass - a safety ceiling only (10 min): the count is never cut by the clock
const quizDeadline = (q, ms = QUIZ_LIMIT_MS) => { const t0 = (q.timing && q.timing.t0) || Date.now(), h0 = (q.timing && q.timing.hidden0) || 0; return () => t0 + ms + Math.max(0, hiddenNow() - h0); };
try { if (typeof document !== 'undefined') { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else if (hiddenAt) { HIDDEN_MS += Date.now() - hiddenAt; hiddenAt = null; } }); } } catch (_) { /* no document */ }
/* ---- The owner's lecture_reader on the AI path (shared/owner_rules.js, a faithful port of lecture_reader.py). Before the AI analyses or writes anything,
 * every part of every page is classified by the owner's rules: assessable (include), context only (headings, objectives heading, closing), excluded (lecturer,
 * institution, objectives, logistics, page numbers, copyright, references), or uncertain (review). The AI itself then settles the uncertain parts with the
 * owner's own prompt (resolve_reviews) - the smart reading. What it excludes never reaches the analysis or the writing; headings and labels stay as context,
 * and a question's quote must lie inside an approved part (validate_question_evidence), never in a heading, an objective or a credit. Kept per lecture text,
 * like the analysis, so the read-ahead does it while the student chooses, and a second quiz from the same lecture does not read it again. */
const READ_V = 'r3'; const READING = new Map();      // lecture text -> the reading in progress (r3: every line the rules are not sure of is read by Claude)
const ownerRules = () => (typeof window !== 'undefined' && window.QZ_OWNER) || null;
/* THE TEXT THE AI READS: every part of a page the reader did not exclude, in the page's own order. A fact keeps the label it belongs to («Astrocytes:» / «- Provide the
 * nutrients to the neurons.»; «Ventral (anterior) horn:» / «contains the cell bodies of motor neurons…») - with the labels taken out (only the first heading was kept),
 * a real lecture reached Claude as facts without their names, and 4 of its 20 sections were refused as «fragmentary». A heading, a label or an uncertain part is
 * there to be understood, not quoted: the evidence of a question must still lie inside an approved part (validate_question_evidence). */
/* A LIST UNDER ITS HEADING IS A TAUGHT FACT (our rule beside the owner's reader, which reads every short item alone as a label): «Its divided into 4 parts» +
 * «Fimbria / Infundibulum / Ampulla / Isthmus» are the four parts of the fallopian tube. A real 48-page lecture lost such slides entirely (14 of its 42 text pages:
 * the female organs, the parts of the tube, the external genitalia, the male duct system) and a quiz chased one of them round after round. A heading followed by
 * three or more short items - never an objective, an outline, the references or a credit - is kept for the questions, and a quote from inside it is evidence. */
const ENUM_META = /\b(objectives?|outline|contents|agenda|references?|bibliography|acknowledg\w*|questions?\??|thank\w*)\b/i;
const wordsIn = (x) => (String(x).match(/[\p{L}\p{N}]+/gu) || []).length;
function enumBlocks(O, us) {
  const listy = (u) => !u.hard_exclusion && u.decision !== 'exclude' && u.category !== 'topic_heading' && wordsIn(u.text) >= 1 && wordsIn(u.text) <= 6;
  const out = [];
  for (let i = 0; i < us.length; i++) { const hd = us[i]; if (hd.category !== 'topic_heading' || hd.decision === 'exclude' || ENUM_META.test(hd.text) || (O.QUESTION_META && O.matches(O.QUESTION_META, hd.text))) continue;
    let j = i + 1; while (j < us.length && listy(us[j])) j++; if (j - i - 1 >= 3) { out.push(us.slice(i, j)); i = j - 1; } }
  return out;
}
const aiText = (O, us) => us.filter((u) => u.decision !== 'exclude').map((u) => String(u.category === 'topic_heading' ? O.cleanLead(u.text) : u.text).trim()).filter(Boolean).join('\n');
async function readForAI(src) {
  const O = ownerRules(); if (!O || !llm || !src.pages.length) return { src: { ...src, pages: src.pages.map(withFig) }, check: null, stats: null };
  const key = 'rcache_' + hash53(READ_V + '|' + src.pages.map((p) => p.ref + '\u0001' + p.text).join('\u0002'));
  const pages = src.pages.map((p, i) => O.pageFromText(i + 1, p.text)); let report = O.readPages(pages, 'lecture'); const report0 = report;      // (report0: the rules' own reading, where headings are still headings)
  let decided = null; try { const hit = await getDoc(key); if (hit && hit.v === READ_V) decided = hit.decisions; } catch (_) { /* a miss */ }
  if (!decided && READING.has(key)) decided = await READING.get(key);      // the same lecture is already being read (the upload's read-ahead): wait for it, never a second request
  if (!decided) { let done; READING.set(key, new Promise((r) => { done = r; }));
    decided = {}; let complete = true;
    // THE SMART READING DECIDES: the owner's rules are sure of two things only - a full taught sentence (approved) and what is not lecture content (the lecturer, the
    // institution, objectives, references, logistics, page numbers: hard_exclusion). Every other line - a slide fragment («– Plasma membrane of a muscle fiber»), a heading,
    // a label, an uncertain part - is read by Claude with the owner's own review prompt: a taught fact is approved, a heading or a bare label stays context. (The rules alone
    // called most of a slide-fragment lecture «short labels»: a real 50-question quiz lost 24 of its 54 drafts to that and ended at 21.)
    const pending = report.units.filter((u) => !u.hard_exclusion && (u.decision === 'review' || u.decision === 'context') && !(u.kind === 'table' && !u.layout_verified))
      .map((u) => (u.decision === 'review' ? u : { ...u, decision: 'review' }));
    const chunks = []; for (let i = 0; i < pending.length; i += 30) chunks.push(pending.slice(i, i + 30));      // side by side, each small enough to answer every line
    await E.mapLimit(chunks, H.concurrency || 1, async (part) => {
      try { const r = await O.resolveReviews(O.makeReport('lecture', part, []), (prompt) => llm.json('reading', 'You classify uncertain lecture fragments for a quiz, exactly as instructed.', prompt));
        r.units.forEach((u) => { decided[u.unit_id] = u.decision; }); }
      catch (_) { complete = false; }      // not settled: those parts stay out of the evidence (the owner's rule: uncertain is never assumed assessable)
    });
    if (complete) { try { await putDoc(key, { kind: 'rcache', id: key, v: READ_V, decisions: decided, at: nowS() }); const all = (await listKind('rcache')).sort((x, y) => (y.at || 0) - (x.at || 0)); for (const x of all.slice(20)) await delDoc(x.id); } catch (_) { /* optimisation only */ } }
    done(decided); READING.delete(key);
  }
  report = O.makeReport('lecture', report.units.map((u) => (decided[u.unit_id] ? { ...u, decision: decided[u.unit_id], category: 'semantic_review' } : u)), report.warnings);
  const counts = report.counts(); const byNo = new Map();
  report.units.forEach((u) => { if (!byNo.has(u.page)) byNo.set(u.page, []); byNo.get(u.page).push(u); });
  const fin = new Map(report.units.map((u) => [u.unit_id, u])); const by0 = new Map(); report0.units.forEach((u) => { if (!by0.has(u.page)) by0.set(u.page, []); by0.get(u.page).push(u); });
  const enums = new Map(); by0.forEach((us, n) => { const bl = enumBlocks(O, us).filter((b) => b.every((u) => (fin.get(u.unit_id) || u).decision !== 'exclude')); if (bl.length) enums.set(n, bl); });      // a list Claude put out (not lecture content) stays out
  const hasFig = (p) => !!(p.fig && p.fig.length);
  const kept = src.pages.map((p, i) => { const us = byNo.get(i + 1) || []; if (!us.some((u) => u.decision === 'include') && !enums.has(i + 1) && !hasFig(p)) return null; return withFig({ ...p, text: aiText(O, us) }); }).filter(Boolean);
  if (!kept.length) return { src: { ...src, pages: src.pages.map(withFig) }, check: null, stats: { counts, applied: false } };      // the reader approved nothing here: the AI reads the pages as they are (the local path, and its checks, still stand)
  const noOf = Object.fromEntries(src.pages.map((p, i) => [p.ref, i + 1]));
  // the owner's rule first: the quote inside ONE approved unit. Then the same rule over a sentence the PDF broke into pieces - a line wrapped onto the next one («Synapse
  // between a motor neuron and a» / «skeletal muscle fiber»), a superscript split off («Ca» «2+» «and holds tropomyosin»): the quote may run over neighbouring units of its page,
  // compared without spaces, as long as at least 70% of it lies in approved units and anything else in between is a short label (three words at most) - never a heading
  // line of four words or more, an objective, a credit or an excluded part
  const byPage = new Map(); report.units.forEach((u) => { if (!byPage.has(u.page)) byPage.set(u.page, []); byPage.get(u.page).push(u); });
  const sq = (x) => String(x || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}%+=<>]/gu, ''); const nW = (x) => (String(x).match(/[\p{L}\p{N}]+/gu) || []).length;
  const passable = (u) => u.decision === 'include' || (u.decision === 'context' && u.category !== 'topic_heading' && nW(u.text) <= 3);
  const figOf = Object.fromEntries(src.pages.map((p, i) => [i + 1, hasFig(p) ? p.fig.map((l) => String(l).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}%+=<>]/gu, '')) : []]));
  const inApproved = (pageNo, quote) => { try { report.unitEvidence(pageNo, quote); return true; } catch (_) { /* below */ }
    { const q0 = String(quote || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}%+=<>]/gu, ''); const fl = figOf[pageNo] || []; if (q0.length >= 3 && (fl.some((l) => l.includes(q0)) || fl.join('').includes(q0))) return true; }      // the lines read in the slide's picture
    const q = sq(quote); if (q.length < 12) return false; const us = byPage.get(pageNo) || [];
    for (let i = 0; i < us.length; i++) { if (!passable(us[i])) continue; let t = ''; const segs = [];
      for (let j = i; j < Math.min(us.length, i + 6) && passable(us[j]); j++) { const x = sq(us[j].text); segs.push([t.length, t.length + x.length, us[j].decision === 'include']); t += x;
        const k = t.indexOf(q); if (k < 0) continue; const inc = segs.reduce((n, [a, b, ok]) => n + (ok ? Math.max(0, Math.min(b, k + q.length) - Math.max(a, k)) : 0), 0); if (inc >= 0.7 * q.length) return true; } }
    const unNum = (x) => sq(String(x).replace(/(^|\s)(\d{1,2}[.)]|[•▪◦●\-–])(?=\s)/g, ' '));      // a list's own numbering and bullets are not part of what it says
    for (const bl of enums.get(pageNo) || []) { const t = bl.map((u) => unNum(u.category === 'topic_heading' ? O.cleanLead(u.text) : u.text)).join(''); const qq = unNum(quote); if (qq.length >= 8 && t.includes(qq)) return true; }
    return false; };
  const check = (c) => { if (O.matches(O.QUESTION_META, c.stem)) return 'السؤال عن بيانات العرض أو أهداف المحاضرة، لا عن محتواها (قواعد قراءة المحاضرة).';
    for (const e of c.evidence || []) if (!inApproved(noOf[e.page], e.quote)) return 'الاقتباس ليس من جزء معتمد للأسئلة (عنوان أو هدف أو بيانات محاضر أو جزء غير محسوم). استشهد بجملة تعليمية من الصفحة.';
    return null; };
  return { src: { ...src, pages: kept }, check, stats: { counts, applied: true, pages_kept: kept.length, pages: src.pages.length, list_pages: enums.size, figure_pages: src.pages.filter(hasFig).length } };
}
/* The analysis does not wait for the reading: it reads the lecture as the owner's reader has already decided it WITHOUT the AI (its certain metadata out, the uncertain
 * fragments still in), at the same moment as the AI settles those fragments. reconcileRead() then keeps of the analysis only the pages the finished reading kept, so the
 * questions are still written and checked on exactly the reading's text. Same text every time for a lecture, so the read-ahead and the quiz share one analysis. */
function preRead(src) {
  const O = ownerRules(); if (!O || !src.pages.length) return src.pages;
  const report = O.readPages(src.pages.map((p, i) => O.pageFromText(i + 1, p.text)), 'lecture'); const byNo = new Map(); report.units.forEach((u) => { if (!byNo.has(u.page)) byNo.set(u.page, []); byNo.get(u.page).push(u); });
  const kept = src.pages.map((p, i) => { const us = byNo.get(i + 1) || []; if (!us.some((u) => u.decision === 'include' || u.decision === 'review') && !enumBlocks(O, us).length) return null; return { ...p, text: aiText(O, us) }; }).filter(Boolean);
  return kept.length ? kept : src.pages;
}
/* THE LECTURE'S OWN SECTIONS - its structure, not the analysis's wording. A slide heading starts a section; the slides after it that repeat that heading
 * («… (continued)», «(2/3)», «Part 2», «تابع») or carry none stay in it. Used for the coverage, the forms of each section and the batches. Only for a lecture
 * that shows its structure (headings on at least 40% of its pages, two sections or more, no single «section» spanning most of a long deck, as a running header
 * would): otherwise the sections are the topics the analysis found. ref -> { key, label }. */
// continuation marks, as whole words only («Contraction» and «Control» are not «cont.»): (continued), cont'd, contd, cont., تابع, تكملة, يتبع; «(2/3)», «2 of 3»; «Part 2»
const SEC_CONT = /[(\[]?\s*(?:(?<!\p{L})cont(?:inued|['’]?d)?\.?(?!\p{L})|(?<!\p{L})(?:تابع|تكملة|يتبع)(?!\p{L}))\s*[)\]]?/giu;
const secClean = (h) => String(h || '').replace(SEC_CONT, ' ').replace(/[(\[]\s*\d+\s*(?:\/|of|من)\s*\d+\s*[)\]]/giu, ' ').replace(/[-–—:]?\s*(?<!\p{L})(?:part|pt\.?)\s*\d+(?!\p{L})/giu, ' ').replace(/\s+/g, ' ').trim();
const secKeyOf = (h) => secClean(h).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an) (?=\S)/, '');      // «The action potential» and «Action Potential» are one section
// an exercise slide («Check your understanding», «Quiz», «تحقق من فهمك») reviews the section it follows: it neither starts a section nor names one
const EXERCISE = /^(?:check (?:your|for) understanding|test (?:your ?self|your knowledge|your understanding)|self ?(?:check|test|assessment)|quick (?:check|quiz)|(?:review|practice|revision|discussion|study) questions?|questions?|quiz(?:zes)?|pop quiz|exercises?|activit(?:y|ies)|case (?:study|studies|scenarios?)|think about it|تحقق من فهمك|اختبر (?:نفسك|معلوماتك|فهمك)|اسئله(?: (?:للمراجعه|المراجعه|ونقاش|تقويميه))?|تمارين|تمرين|نشاط|انشطه|حاله (?:دراسيه|سريريه)|سؤال|تقويم)$/u;
// a title broken over two lines ends on a word no title ends with («Basic Functions of the» + «Nervous System»)
const OPEN_END = /(?:^|\s)(?:of|the|and|in|on|for|to|with|a|an|from|by|at|or|its|their|vs\.?|versus|&|between|into|within|و|في|من|إلى|على|عن|مع|بين)$/iu;
const exKey = (t) => secKeyOf(t).replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
const SEC_FN = new Set('of the and in on for to with a an from by at or vs vs. versus its their between into within'.split(' '));
const bulletL = (l) => /^[-–—•●▪◦*>➢✓]|^\(?\d+\s*[.)\-]|^\(?[a-z][.)]\s/i.test(l), wordsL = (l) => l.split(/\s+/).filter(Boolean), punctEnd = (l) => /[.!?;:؟،,]$/.test(l);
const FIGCAP = /^(?:fig(?:ure)?s?\.?|شكل|صورة)\s*[\d٠-٩]/iu;      // «Fig.10: …», «Figure 17–3»: a caption, never a title
const titleLine = (l) => l.length <= 80 && wordsL(l).length <= 10 && !punctEnd(l) && !bulletL(l) && !!secKeyOf(l) && /\p{L}{2}/u.test(l) && !FIGCAP.test(l);      // a bare page number («23») is not a title either
// Title Case: most of its words (not «of», «the»…) start with a capital
const capped = (l) => { const w = wordsL(l).filter((x) => /^\p{L}/u.test(x) && !SEC_FN.has(x.toLowerCase())); return w.length > 0 && w.filter((x) => /^\p{Lu}/u.test(x)).length / w.length >= .5; };
const shortItem = (x) => !!x && !bulletL(x) && wordsL(x).length <= 4 && !punctEnd(x);
function lectureSections(pages) {
  const O = ownerRules(); if (!O || !pages || pages.length < 2) return null;
  let rep; try { rep = O.readPages(pages.map((p, i) => O.pageFromText(i + 1, p.text)), 'lecture'); } catch (_) { return null; }
  const lines = pages.map((p) => String(p.text || '').split('\n').map((l) => l.trim()).filter(Boolean));
  // the reader's own finds: a slide's topic heading, and the short label lines of each slide (a title the slide's text puts lower down is one of them)
  const tops = {}, labels = {}; rep.units.forEach((u) => { const t = String(u.text || '');
    if (u.category === 'topic_heading' && tops[u.page] == null && secKeyOf(t)) tops[u.page] = t.split('\n')[0].trim();
    if (u.category === 'topic_heading' || u.category === 'short_label') t.split('\n').forEach((l) => (labels[u.page] ||= new Set()).add(secKeyOf(l))); });
  // a slide's TITLE is its first line when that line looks like one: short, no sentence end (nor «:» - «There are two main types of cells:» opens a list), not a
  // bullet, with more lines under it (the reader may file «Hormonal Control: ADH» as a «term: definition» line - as a title it still starts a section)
  const firsts = lines.map((ls, i) => { const top = tops[i + 1]; if (top) { const j = ls.findIndex((l) => l === top || l.startsWith(top)); return { j: Math.max(0, j), t: top }; }
    return ls.length >= 3 && titleLine(ls[0]) ? { j: 0, t: ls[0] } : null; });
  const known = new Set(firsts.filter(Boolean).map((f) => secKeyOf(f.t)));
  const freq = {}; lines.forEach((ls) => new Set(ls.map(secKeyOf)).forEach((k) => { freq[k] = (freq[k] || 0) + 1; }));
  const runningHeader = (l) => freq[secKeyOf(l)] > Math.max(3, 0.3 * pages.length);
  // a title wrapped onto the next line is joined with it («Organization of The Nervous» + «System»); three short lines in a row are a list, and a line that is
  // itself a slide title elsewhere («Neurons») is not the second half of this one
  const wrapped = (ls, i) => { const t = ls[i], nx = ls[i + 1], after = ls[i + 2];
    if (!nx || bulletL(nx) || punctEnd(nx) || !secKeyOf(nx) || known.has(secKeyOf(nx))) return t;
    const n = wordsL(t).length + wordsL(nx).length;
    if (OPEN_END.test(t)) return wordsL(nx).length <= 4 && n <= 12 ? t + ' ' + nx : t;
    if (wordsL(t).length < 2 || !capped(t) || !/^\p{Lu}/u.test(nx) || OPEN_END.test(nx)) return t;
    if (after && bulletL(after) && wordsL(nx).length <= 6 && n <= 12) return t + ' ' + nx;      // the lines above the first bullet are the title («…Rehabilitation, Health» + «Restoration, and Palliative Care»)
    const listy = shortItem(after) && /^\p{Lu}/u.test(after);
    return !listy && wordsL(nx).length <= 2 && n <= 10 ? t + ' ' + nx : t; };
  // when the text puts the title lower down (a text box read out of order: «• Damage to…» / «Frontal Lobe» / «• …»): a short line the reader calls a label, or a
  // Title Case line, that stands alone between bullets or broken sentences - not an item of a list of short lines, not a running header
  const midTitle = (ls, lab) => { for (let i = 1; i < ls.length; i++) { const l = ls[i]; if (!titleLine(l) || wordsL(l).length > 6 || /:/.test(l) || !/^[^\p{L}]*(?:\p{Lu}|[؀-ۿ])/u.test(l) || runningHeader(l)) continue;      // «Dorsal horn: responsible» is a term and its definition
      if (!lab.has(secKeyOf(l)) && !(capped(l) && !/[؀-ۿ]/.test(l))) continue;
      const prev = ls[i - 1], nx = ls[i + 1];
      if ((shortItem(prev) && /^\p{Lu}/u.test(prev) && !OPEN_END.test(prev)) || (shortItem(nx) && shortItem(ls[i + 2]))) continue;
      return wrapped(ls, i); } return null; };
  const head = {};
  lines.forEach((ls, i) => { const f = firsts[i];
    if (f && EXERCISE.test(exKey(f.t))) return;
    const t = f && !punctEnd(f.t) ? wrapped(ls, f.j) : midTitle(ls, labels[i + 1] || new Set());
    if (t && !EXERCISE.test(exKey(t))) head[i + 1] = t; });
  const headed = pages.filter((_, i) => head[i + 1]).length; if (headed < 2 || headed / pages.length < 0.4) return null;
  const out = {}; let cur = null, n = 0; const size = {};
  pages.forEach((p, i) => { const h = head[i + 1]; const k = h ? secKeyOf(h) : '';
    if (k && (!cur || k !== cur.k)) { n++; cur = { k, key: 'S' + n, label: secClean(O.cleanLead ? O.cleanLead(h) : h).slice(0, 80) }; }
    else if (!cur) { n++; cur = { k: '', key: 'S' + n, label: (p.text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 80) }; }
    out[p.ref] = { key: cur.key, label: cur.label }; size[cur.key] = (size[cur.key] || 0) + 1; });
  const biggest = Math.max(...Object.values(size)); if (n < 2 || (pages.length >= 8 && biggest > 0.6 * pages.length)) return null;
  return out;
}
/** each objective belongs to the section of its first page in the lecture (none: the analysis's topics are used, as before) */
/** section key -> the pages of that section that the quiz is written from (the objectives' pages, in lecture order) */
function secPagesOf(analysis, pages) { const ok = new Set((pages || []).map((p) => p.ref)); const out = {}; const pnum = (r) => +String(r).replace(/^d\d+p/, '');
  for (const o of (analysis && analysis.objectives) || []) if (o.section) (o.pages || []).forEach((r) => { if (ok.has(r)) { const l = (out[o.section] ||= []); if (!l.includes(r)) l.push(r); } });
  for (const k in out) out[k].sort((a, b) => pnum(a) - pnum(b)).splice(6); return out; }
function annotateSections(analysis, sec) {
  const pnum = (r) => +String(r).replace(/^d\d+p/, '');
  for (const o of analysis.objectives) { const first = (o.pages || []).slice().sort((a, b) => pnum(a) - pnum(b))[0]; const x = sec && first ? sec[first] : null;
    if (x) { o.section = x.key; o.section_label = x.label; } else { delete o.section; delete o.section_label; } }
  analysis.lecture_sections = sec ? new Set(Object.values(sec).map((x) => x.key)).size : 0;
  analysis.page_sections = sec ? Object.fromEntries(Object.entries(sec).map(([r, x]) => [r, x.key])) : {};      // a question covers the sections of the pages it quotes too
  return analysis;
}
function reconcileRead(analysis, pages) {
  const ok = new Set(pages.map((p) => p.ref)); const a = JSON.parse(JSON.stringify(analysis)); const keep = (refs) => (refs || []).filter((r) => ok.has(r));
  a.objectives = a.objectives.map((o) => { const pg = keep(o.pages); const sup = {}; for (const [t, v] of Object.entries(o.supports || {})) { const vp = keep((v && v.pages) || o.pages); if (vp.length) sup[t] = { ...v, pages: vp }; }
    return { ...o, pages: pg, supports: sup }; }).filter((o) => o.pages.length && Object.keys(o.supports).length);
  return a;
}
async function readAndAnalyse(src, st) { const sec = lectureSections(src.pages); const [R, A] = await Promise.all([readForAI(src), analyseAll(src, st, sec)]); return { readSrc: R, analysis: annotateSections(reconcileRead(A, R.src.pages), sec) }; }
/* «Read ahead»: the AI path's longest single step is reading the whole lecture (its objectives and profile). It depends only on the pages' text, not on the count or the
 * difficulty - so it starts while the student is still choosing them, on the new-quiz page, and the quiz job then finds it done (or joins it). Same analysis, same questions:
 * only the waiting moves to a moment the student is busy anyway. Nothing is started for the local generator, without an AI, or for a file that is not ready. */
async function prepareAnalysis(b, pl) {
  if (!pl.aiAvailable || !llm || ((b && b.settings && b.settings.generator) === 'rules') || !(b && (b.sources || []).length)) return { started: false };
  let src; try { src = await loadSource(b.sources); } catch (_) { return { started: false }; } if (!src.pages.length) return { started: false };
  const st = { ...QDEF, ...(b.settings || {}) }; st.field = E.detectField(src.pages.map((p) => p.text).join(' '));
  readAndAnalyse(src, st).catch(() => { /* the quiz job will try again and report */ });
  return { started: true, pages: src.pages.length };
}
/** Analyse the lecture and build the plan. With `auto` the same job carries on to generation (nobody confirms a plan; the
 *  requested count is always delivered - asking the lecture again in other ways is study, not padding). */
async function jobAnalyse(id, auto) {
  const q = await getDoc(K.quiz(id)); if (!q) { JOBS.delete(id); return; } JOBS.set(id, { stage: 'reading_source', pct: 10 }); let chain = false, fb = null;
  try {
    const src = await loadSource(q.settings.sources, { waitFigures: true }); if (!src.pages.length) throw new Error('لا توجد صفحات مقروءة في النطاق المختار.');
    const heur = AI_ONLY ? null : E.support(src.pages.map((p) => p.text), q.settings.field); JOBS.set(id, { stage: 'analyzing_lecture', pct: 30 });      // Claude only: no keyword cue vetoes a type Claude found await new Promise((r) => setTimeout(r, 0));      // the screen shows the stage before the (local) analysis takes the processor
    const rules = q.settings.generator === 'rules' && !!E.rules && !AI_ONLY;
    const tR = Date.now(); let readSrc = null, analysis, tA = tR, tRead = tR;
    const sec = lectureSections(src.pages);      // the lecture's own sections (its headings), for coverage, forms and batches
    if (rules) analysis = annotateSections(E.rules.analyse(src.pages), sec);
    else { const rp = readForAI(src).then((x) => { tRead = Date.now(); return x; }); const both = await Promise.all([rp, analyseAll(src, q.settings, sec)]); readSrc = both[0]; analysis = annotateSections(reconcileRead(both[1], readSrc.src.pages), sec); tA = tRead; }      // the reading and the analysis side by side
    q.timing = { ...(q.timing || {}), reading_ms: tA - tR, analysis_ms: Math.max(0, Date.now() - tA) };      // a read-ahead that already finished makes both close to 0; analysis_ms = what it added after the reading
    if (!analysis.objectives.length) { const d = rules ? E.rules.diagnose(src.pages) : srcStats(src.pages); analysis.diagnostics = d; q.analysis = analysis; q.status = 'insufficient'; q.error = noObjectivesMessage(q.settings.generator, d); return; }
    if (E.detectField && analysis.discipline_guess && (analysis.discipline_guess in { health: 1, science: 1, engineering: 1, cs: 1, math: 1, business: 1, law: 1, humanities: 1 })) q.settings.field = analysis.discipline_guess;
    q.plan = E.buildPlan(analysis, q.settings, heur); analysis.heuristic_support = heur; analysis.excluded_pages = src.excluded; q.analysis = analysis; q.error = null;
    chain = !!(auto && q.plan.feasible_count > 0);
    q.status = chain ? 'generating' : 'planned'; q.progress_pct = chain ? 5 : 100; q.progress_stage = chain ? 'drafting' : 'planned';   // straight to 'generating': the UI never sees a 'planned' flicker
  } catch (e) { if (q.settings.generator === 'claude' && E.rules && aiUnavailable(e)) fb = e; else { q.status = 'failed'; q.error = jobErr(e); q.error_code = (e && e.code) || null; } }
  finally { if (!chain && !fb) JOBS.delete(id); if (chain) await touch(q).catch(() => { /* the plan is in memory: the generation goes on, and its own save at the end is the one that counts */ }); else await touch(q); }
  if (fb) return switchToLocal(id, fb, auto);
  if (chain) await jobGenerate(id);          // JOBS keeps the id the whole time, so the quiz stays "busy" between the two phases
}
/** Is the AI itself unavailable (down, unreachable, out of credit, not allowed) — as opposed to something about the file? Then the site still delivers:
 *  the quiz is rebuilt locally (no key, no AI) and says so. Whoever pays for the AI never takes the whole site down with an empty balance. */
const aiUnavailable = (e) => !!e && (e.fallback === true || ['quota', 'not_granted', 'network', 'auth', 'rate_limited', 'keys_invalid', 'bad_request', 'too_large', 'bad_json', 'llm_not_configured', 'llm_error'].includes(e.code)
  || /HTTP (4\d\d|5\d\d)|تعذّر الاتصال|فشل استدعاء|credit balance/i.test(String(e.message || '')));
async function switchToLocal(id, err, auto) {
  const q = await getDoc(K.quiz(id)); q.settings.generator = 'rules'; q.fallback = { from: 'claude', code: (err && err.code) || (H.quotaSince && H.quotaSince((q.timing && q.timing.t0) || 0) ? 'quota' : null), reason: String((err && err.message) || err || '').slice(0, 240) };
  q.plan = null; q.analysis = null; q.questions = undefined; q.report = undefined; q.error = null; q.status = 'analyzing'; q.progress_stage = 'reading_source'; q.progress_pct = 10; await touch(q);
  await jobAnalyse(id, auto);
}
function assignOptions(c, targetPos, rnd) {
  const opts = c.options.map((t) => ({ id: 'o' + rid().slice(0, 8), text: t })); const key = opts[c.correct_index]; const others = opts.filter((o) => o !== key);
  for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; } others.splice(targetPos, 0, key); return [others, key.id];
}
/* A CHECKPOINT OF THE QUIZ BEING MADE: the questions accepted so far are kept on the device (every few seconds, beside the quiz) - a page closed or reloaded in the
 * middle (a phone does that to an app left in the background) takes up from there, instead of starting over and asking Claude for them again. Removed once the
 * quiz is ready, or with the quiz. */
function checkpointer(id, sig) { let last = null, timer = null, at = 0; const key = K.ckpt(id);
  const save = () => { timer = null; at = Date.now(); if (!last || hidden(id)) return; putDoc(key, { kind: 'ckpt', id: key, quiz: id, sig, accepted: last, at: nowS() }).catch(() => { /* the next one */ }); };
  return { put: (list) => { last = list.slice(); if (!timer) timer = setTimeout(save, Math.max(0, 3000 - (Date.now() - at))); },
    end: (done) => { if (timer) { clearTimeout(timer); timer = null; if (!done) save(); } if (done) delDoc(key).catch(() => { /* removed with the quiz anyway */ }); } };
}
async function jobGenerate(id) {
  const q = await getDoc(K.quiz(id)); if (!q) { JOBS.delete(id); return; } JOBS.set(id, { stage: 'drafting', pct: 5 }); let fb = null, ck = null;
  try {
    const tG = Date.now(); const src0 = await loadSource(q.settings.sources, { waitFigures: true }); const rules = q.settings.generator === 'rules' && !!E.rules && !AI_ONLY;
    const read = rules ? { src: src0, check: null, stats: null } : await readForAI(src0); const src = read.src;      // the same reading as the analysis (kept), so the plan's pages exist here
    const want = q.plan.requested; const sig = hash53(JSON.stringify((q.plan.slots || []).map((s) => [s.slot, s.objective_id])));
    let resume = []; if (!rules) { try { const c0 = await getDoc(K.ckpt(id)); if (c0 && c0.sig === sig && Array.isArray(c0.accepted)) resume = c0.accepted; } catch (_) { /* none kept */ } ck = checkpointer(id, sig); }
    const f0 = Math.min(0.9, resume.length / Math.max(1, want)); const prog = (s, p) => JOBS.set(id, { stage: s, pct: Math.round(100 * f0 + p * (1 - f0)) });      // (resumed: the bar goes on from where it was)
    // what the quizzes so far taught about the forms in lectures like this one (the development track: the profile shipped with the app + this account's own)
    const dens = E.densityOf(src.pages); const guide = rules || !E.formGuide ? null : E.formGuide(E.mergeProfiles(await baseProfile(), await ownProfile()), dens);
    if (!rules) E.assignForms(q.plan.slots, null, guide);      // a suggested form per slot, rotated inside each section of the lecture (the writer reads the pages and may take another of the type)
    const res = rules ? await E.rules.generate(q.plan, src.pages, q.settings, prog) : await E.generateToCount(llm, q.plan, src.pages, q.settings, prog, { concurrency: H.concurrency || 1, evidenceCheck: read.check, budgetMs: AI_ONLY ? 0 : Math.max(25000, 70000 - (q.timing && q.timing.t0 ? Date.now() - q.timing.t0 : 0)), until: AI_ONLY ? quizDeadline(q) : null, hardUntil: AI_ONLY ? quizDeadline(q, QUIZ_HARD_MS) : null, topupRounds: AI_ONLY ? 6 : 1, aiOnly: AI_ONLY, sectionPages: secPagesOf(q.analysis, src.pages), pageSection: q.analysis.page_sections || {}, shape: (slots, prior) => E.assignForms(slots, prior, guide), resume, checkpoint: ck ? ck.put : null });      // Claude only: what is missing is written by Claude in a further round, never filled locally
    if (!rules && res.outcomes && res.outcomes.length) learnFrom(res.outcomes, dens, { id: (q.settings.sources[0] || {}).document_id, title: (src.pages[0] || {}).doc_title }).catch(() => { /* the learning never stands in a quiz's way */ });      // every quiz teaches the forms (first attempts only)
    if (!rules && !res.accepted.length && AI_ONLY) { const bad = (res.dropped || []).find((d) => (d.reasons || []).some((r) => /^خطأ في خدمة التوليد/.test(r)));      // nothing usable from Claude: say why (no local quiz)
      throw Object.assign(new Error(H.quotaSince && H.quotaSince((q.timing && q.timing.t0) || 0) ? 'نفدت حصة Claude في حسابك قبل أن يكتب أي سؤال. تتجدد الحصة بعد مدة؛ أعد المحاولة حينها.' : bad ? bad.reasons[0] : 'لم يكتب Claude سؤالًا اجتاز الفحوص من هذا الملف. أعد المحاولة، أو جرّب نطاقًا أوسع.'), { code: 'no_questions' }); }
    if (!rules && !res.accepted.length && E.rules) { const bad = (res.dropped || []).find((d) => (d.reasons || []).some((r) => /^خطأ في خدمة التوليد/.test(r))); if (bad) throw Object.assign(new Error(bad.reasons[0]), { fallback: true }); }   // every model call failed: not the file's fault
    // still short after the AI's top-up rounds (a thin lecture, or questions it could not make verifiable): the local generator makes up the rest from the lecture's own lines
    if (!rules && res.accepted.length < want && E.rules && !AI_ONLY) { const f = await E.rules.fill(q.plan, res.accepted, want - res.accepted.length, src.pages, q.settings, prog); res.accepted.push(...f.accepted); res.dropped.push(...f.dropped); for (const k in f.stats) res.stats[k] = (res.stats[k] || 0) + f.stats[k]; res.stats.local_filled = f.accepted.length; }
    if (res.accepted.length >= want) res.dropped.forEach((d) => { d.replaced = true; });
    if (read.stats) res.stats.owner_reading = read.stats;      // what the owner's reader approved, for the operator
    const quotaHit = !rules && H.quotaSince ? H.quotaSince((q.timing && q.timing.t0) || 0) : false;      // the viewer's AI quota ran out during this quiz: the rest was made locally
    const timing = { ...(q.timing || {}), generation_ms: Date.now() - tG, total_ms: q.timing && q.timing.t0 ? Date.now() - q.timing.t0 : null, ai: !rules, calls: H.llmStats ? H.llmStats().calls - ((q.timing && q.timing.calls0) || 0) : null, log: H.llmStats && H.llmStats().log ? H.llmStats().log.filter((x) => q.timing && q.timing.t0 && x[1] * 1000 >= q.timing.t0 - 120000).slice(-200).map((x) => [({ generate: 'g', verify: 'v', verify_explanation: 'e', analyze: 'a', profile: 'p', reading: 'r' })[x[0]] || String(x[0]).slice(0, 2), Math.round((x[1] * 1000 - q.timing.t0) / 100) / 10, x[2]]) : null,      /* [g|v|e|a|p|r, start s after the quiz began, seconds] */ waits: H.llmStats ? H.llmStats().waits - ((q.timing && q.timing.waits0) || 0) : null, local_filled: res.stats.local_filled || 0, hidden_ms: q.timing && q.timing.hidden0 != null ? hiddenNow() - q.timing.hidden0 : 0 };
    const acc = E.orderQuestions(res.accepted.slice(0, want)); const rnd = Math.random; const O = ownerRules();
    const pos = O ? O.balancedLetters(acc.length, rnd) : acc.map((_, i) => i % 4).sort(() => rnd() - .5);      // quiz_engine.balanced_letters: spread over A-D, never one letter three times in a row
    const labelOf = (r) => { const p = src.pages.find((x) => x.ref === r); return p ? { doc_id: p.doc_id, doc_title: p.doc_title, page: p.page_no, page_no: p.page_no, ref: r } : { ref: r }; };
    const had = new Map((q.questions || []).map((x) => [x.stem, x]));      // COMPLETING a quiz (its first run was cut short): the questions it already has stay exactly as they were - ids, options, attempts
    q.questions = acc.map((c, i) => { const was = had.get(c.stem); if (was) return { ...was, position: i + 1 }; const [opts, key] = assignOptions(c, pos[i], rnd); const ev = c.evidence.map((e) => ({ ...e, ...labelOf(e.page) })); const minor = (c.issues || []).filter((x) => x.severity === 'minor');
      return { id: rid(), position: i + 1, form: c.form || null, qtype: c.qtype, type_label: E.QT[c.qtype][0], task: c.task, objective: c.objective, difficulty: c.difficulty, stem: c.stem, options: opts, correct_option_id: key, explanation: c.explanation, purpose: c.purpose,
        source_pages: [...new Set(ev.map((e) => e.page_no).filter(Boolean))].sort((a, b) => a - b), evidence: ev, version: 1, review_status: minor.length ? 'flagged' : 'machine_verified', validation: { issues: c.issues || [], verified: { static: true, blind_solver: !rules }, objective_id: c.objective_id, ...(c.ai_form ? { ai_form: c.ai_form } : {}) }, prompt_version: rules || c.local ? 'rules-1.0' : 'web-p1.0' }; });      // a question the local generator wrote says so, also inside an AI quiz
    const planned = Object.entries(q.plan.distribution).filter(([, n]) => n).map(([t]) => t), by = Object.fromEntries(E.ORDER.map((t) => [t, q.questions.filter((x) => x.qtype === t).length])); const objDone = new Set(acc.map((c) => c.objective_id));
    q.report = { requested: q.plan.requested, planned: q.plan.feasible_count, delivered: q.questions.length, by_type: by, identity_coverage: { numerator: planned.filter((t) => by[t]).length, denominator: planned.length, definition: 'أنواع الهوية المخطط لها التي سُلّم منها سؤال واحد على الأقل.' },
      section_coverage: (() => { const t = (o) => o.section || String(o.statement || o.id || '').toLowerCase().replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').trim(); const all = new Set(q.analysis.objectives.map(t)); const done = new Set();
        // a section is covered by a question that QUOTES it (where its fact really is); the section of the question's objective counts only when its quotes name none
        const ps = q.analysis.page_sections || {}, oById = Object.fromEntries(q.analysis.objectives.map((o) => [o.id, o]));
        acc.forEach((c) => { const ks = (c.evidence || []).map((e) => ps[e.page]).filter((k) => k && all.has(k)); if (ks.length) ks.forEach((k) => done.add(k)); else if (oById[c.objective_id]) done.add(t(oById[c.objective_id])); });
        const missing = [...new Set(q.analysis.objectives.filter((o) => !done.has(t(o))).map((o) => o.section_label || o.statement))].slice(0, 4); return { covered: done.size, total: all.size, missing }; })(),
      objective_coverage: { numerator: objDone.size, denominator: q.analysis.objectives.length, definition: 'أهداف المصدر التي غطاها سؤال مُسلَّم واحد على الأقل.' }, dropped: res.dropped, stats: res.stats, excluded_pages: src.excluded, unsupported_types: q.plan.unsupported_types,
      flagged: q.questions.filter((x) => x.review_status === 'flagged').length, extra: acc.filter((c) => c.extra).length, local_filled: rules ? 0 : acc.filter((c) => c.local).length,
      shortfall: acc.length < want ? (quotaHit ? { requested: want, possible: acc.length, quota: true, reason: 'نفدت حصة Claude في حسابك قبل اكتمال العدد.', suggestions: [] } : { requested: want, possible: acc.length, reason: 'سُئل عن كل معلومة في هذا النطاق مرة، ولا يُكرَّر سؤال ولا تُعاد صياغة جملة لإكمال العدد.', suggestions: ['لزيادة العدد: وسّع نطاق الصفحات أو أضف لكتشرًا آخر.'] }) : q.plan.shortfall, generator: rules ? LOCAL_LABEL : H.generatorLabel, prompt_version: rules ? 'rules-1.0' : 'web-p1.0' };
    q.report.timing = timing; if (quotaHit) q.report.quota = true; if (quotaHit && !rules && acc.length < want) q.report.can_complete = true;      // its checkpoint is kept: «أكمل الأسئلة الناقصة» writes only what is missing once the quota is back
    if (res.outcomes) q.report.forms = { density: dens, first_attempts: res.outcomes.length, as_suggested: res.outcomes.filter((o) => o.ok).length, tips: (q.plan.slots || []).filter((s) => s.form_tip).length };      // (internal) how the suggested forms fared
    const allLocal = !rules && acc.length > 0 && acc.every((c) => c.local);      // the AI contributed no usable question: this IS a local quiz, and it says so
    if (allLocal) { q.settings.generator = 'rules'; q.fallback = { from: 'claude', reason: 'لم ينتج الذكاء الاصطناعي أي سؤال اجتاز التحقق من المصدر' }; q.report.generator = LOCAL_LABEL; q.report.prompt_version = 'rules-1.0'; }
    q.generator = rules || allLocal ? LOCAL_LABEL : H.generatorLabel; q.status = q.questions.length ? 'ready' : 'insufficient'; q.error = q.questions.length ? null : 'لم ينجح أي سؤال في اجتياز التحقق.'; q.progress_pct = 100;
  } catch (e) { if (q.settings.generator === 'claude' && E.rules && aiUnavailable(e)) fb = e; else { q.status = 'failed'; q.error = jobErr(e); q.error_code = (e && e.code) || null; } }
  finally { if (!fb) JOBS.delete(id); if (ck) ck.end(q.status === 'ready' && !(q.report && q.report.can_complete));      // (a quiz that did not finish keeps its latest checkpoint: «retry» takes up from it)
    // a finished quiz whose save failed (the device's storage out of reach, or full) is NOT thrown away: it stays ready in this page - the student can solve it now -
    // and its save is tried again each time the quiz is read, until it is kept (quizOut)
    try { await touch(q); } catch (e) { if (q.status !== 'ready') throw e; q._unsaved = jobErr(e); progress({ stage: 'quiz', id: q.id, status: q.status }); } }
  if (fb) return switchToLocal(id, fb, true);
}

// ---------------------------------------------------------------- the development track (the forms learn from the quizzes: engine.js FL)
/* What the quizzes taught about the forms is kept per account (FP): every AI quiz adds its first attempts, and the next quiz reads it, added to the profile shipped
 * with the app (shared/forms_profile.js, from the owner's run of the track). The track itself (#/dev, the owner's only): the corpus of study files shipped with this
 * edition (corpus/index.json - heavy, medium and light lectures) is read exactly as an upload is, but in memory (nothing is added to the files), and each STEP asks
 * Claude one round of slots on the cells that have learned least, with the four fixed forms only - until every cell its lectures reach is learned (FL.READY), or
 * FL.MAX_STEPS steps. One step at a time; the page carries on step after step and can stop between two. */
const FP = 'fprofile', FDEV = 'fdev';
const bakedProfile = () => (typeof window !== 'undefined' && window.QZ_FORMS_PROFILE) || null;
// what every quiz starts from: the profile the owner shared with everyone («حدّث للجميع», kept in the artifact's shared store), else the one shipped with the app
const baseProfile = async () => { try { const x = H.sharedForms ? await H.sharedForms.get() : null; if (x && x.cells) return x; } catch (_) { /* not shared yet */ } return bakedProfile(); };
const ownProfile = async () => { try { const p = await getDoc(FP); return p && p.cells ? p : null; } catch (_) { return null; } };
// lec: the owner's lecture the quiz was made from - the track lists what each of them taught (its density, how many quizzes)
const learnFrom = (outcomes, dens, lec) => serial(FP, async () => { const p = (await ownProfile()) || { kind: 'fprofile', id: FP, v: 1, cells: {}, quizzes: 0 };
  E.learnForms(p, outcomes, dens); if (lec && lec.id) { const L = (p.lectures ||= {}); const o = L[lec.id] || {}; L[lec.id] = { title: lec.title || o.title || '', dens, quizzes: (o.quizzes || 0) + 1, at: nowS() }; }
  p.updated_at = nowS(); await putDoc(FP, p); return p; });
const devAllowed = (pl) => !!(H.devTrack && pl && pl.owner && pl.devOwner !== false && pl.aiAvailable && llm && E.exploreSlots);      // (devOwner: the page's author, not the owner of a copy)
let DEV_INDEX = null, DEV_BUSY = null;
async function devCorpus() { if (DEV_INDEX) return DEV_INDEX; const r = await realFetch('./corpus/index.json'); if (!r.ok) throw Object.assign(new Error('ملفات مسار التطوير غير موجودة في هذه النسخة.'), { code: 'no_corpus' }); return (DEV_INDEX = await r.json()); }
/* the lectures the track works on: the owner's own (every ready file of «ملفاتي», newest first - a new lecture is read before the study files), then the study files
 * shipped with this edition. The owner's are read from their files as a quiz reads them; nothing is added or changed in them. */
async function devLectures() { const idx = await devCorpus().catch((e) => { if (e && e.code === 'no_corpus') return []; throw e; });
  const docs = (await listKind('doc')).filter((d) => d.status === 'ready').sort((a, b) => b.created_at - a.created_at);
  return [...docs.map((d) => ({ id: 'own_' + d.id, doc: d.id, title: d.title, own: true })), ...idx]; }
async function devState() { const s = await getDoc(FDEV); return s && s.v === 1 ? s : { kind: 'fdev', id: FDEV, v: 1, steps: 0, lectures: {}, log: [] }; }
// the types some read lecture of each density supports; a type NONE of them supports is still tried there (forced) once every lecture has been read
const reachOf = (st) => { const r = Object.fromEntries(E.FL.DENS.map((d) => [d, []])); for (const l of Object.values(st.lectures || {})) if (r[l.dens]) (l.types || []).forEach((t) => { if (!r[l.dens].includes(t)) r[l.dens].push(t); }); return r; };
const forcedOf = (st, d) => { const r = reachOf(st)[d] || []; return E.ORDER.filter((t) => !r.includes(t)); };
/** a corpus file read as an upload is (extraction, running headers, page status, cover / objectives / closing out) - kept in memory, never in the student's files */
async function memSource(buf, name) {
  const pages = /\.pdf$/i.test(name) ? await extractPdf(buf, name) : await extractPptx(buf); stripBoiler(pages);
  const out = pages.filter((p) => ['ok', 'low_text'].includes(classify(p.text, p.image_count)[0])).map((p) => ({ ref: 'd1p' + p.page_no, doc_id: 'corpus', doc_title: name, page_no: p.page_no, text: fixGlyphs(p.text), status: 'ok' }));
  const fm = frontMatter(out); return { pages: out.filter((p) => !fm.has(p.page_no)), excluded: out.filter((p) => fm.has(p.page_no)).map((p) => ({ ref: p.ref, page: p.page_no, status: 'front_matter' })) };
}
async function devStatus() {
  const [all, st, own] = await Promise.all([devLectures(), devState(), ownProfile()]); const prog = E.formsProgress(own); const unread = all.filter((l) => !st.lectures[l.id]).length;      // all ten types x four forms x three densities
  const idx = all.filter((l) => !l.own); const fromQ = (own && own.lectures) || {};
  return { mine: all.filter((l) => l.own).map((l) => { const x = st.lectures[l.id] || {}, q = fromQ[l.doc] || {}; return { id: l.id, title: l.title, read: !!st.lectures[l.id], dens: x.dens || q.dens || null, types: x.types || [], runs: x.runs || 0, quizzes: q.quizzes || 0 }; }),
    corpus: idx.map((l) => { const x = st.lectures[l.id] || {}; return { id: l.id, title: l.title, density: l.density, lang: l.lang, file: l.file, read: !!st.lectures[l.id], dens: x.dens || null, types: x.types || [], runs: x.runs || 0 }; }),
    steps: st.steps, max_steps: E.FL.MAX_STEPS, ready: prog.ready && !unread, unread, pct: unread ? Math.min(prog.pct, 99) : prog.pct, need: prog.need, cells: prog.cells, forms: E.AI_FORMS, types: Object.fromEntries(E.ORDER.map((t) => [t, E.QT[t][0]])),
    learned: prog.cells.filter((c) => !['new', 'learning'].includes(c.status)).length, quizzes: (own && own.quizzes) || 0, limits: { ready: E.FL.READY, max: E.FL.MAX, step: E.FL.STEP }, log: (st.log || []).slice(-12).reverse(), busy: !!DEV_BUSY,
    shared: await (async () => { const x = H.sharedForms ? await H.sharedForms.get().catch(() => null) : null; return x && x.cells ? { updated_at: x.updated_at || null, quizzes: x.quizzes || 0, cells: Object.keys(x.cells).length, attempts: Object.values(x.cells).reduce((n, c) => n + (c.n || 0), 0) } : null; })(),
    can_share: !!H.sharedForms };
}
/** ONE step: a lecture never read first (its types are not known before), then the lecture run least among those with cells still to learn; one round of
 *  exploration slots on it (generate() with oneRound: first attempts only); what they show is learned at once. */
async function devStep(target) {
  if (DEV_BUSY) return DEV_BUSY;      // a second click joins the step that is running
  DEV_BUSY = (async () => { const t0 = Date.now(); const [idx, st, own0] = await Promise.all([devLectures(), devState(), ownProfile()]); const own = own0 || { cells: {} };
    if (st.steps >= E.FL.MAX_STEPS) return { done: 'max_steps' };
    const prog = E.formsProgress(own); const left = (l) => { const x = st.lectures[l.id] || {}, d = x.dens, f = forcedOf(st, d); return prog.cells.filter((c) => c.dens === d && (c.status === 'new' || c.status === 'learning') && ((x.types || []).includes(c.type) || f.includes(c.type))).length; };
    const unread = idx.filter((l) => !st.lectures[l.id]); const open = idx.filter((l) => st.lectures[l.id] && !st.lectures[l.id].exhausted && left(l) > 0);
    const lec = (target && idx.find((l) => l.id === target)) || unread[0] || open.sort((a, b) => (st.lectures[a.id].runs || 0) - (st.lectures[b.id].runs || 0) || left(b) - left(a))[0]; if (!lec) return { done: 'ready' };      // round the lectures, so a stop half-way leaves every density part-learned
    let src0; if (lec.own) src0 = await loadSource([{ document_id: lec.doc }]);      // the owner's lecture: its pages as a quiz reads them
    else { const r = await realFetch('./corpus/' + (lec.src || lec.file)); if (!r.ok) throw Object.assign(new Error('تعذّرت قراءة ' + lec.file), { code: 'no_corpus' });
      const buf = /\.json$/.test(lec.src || '') ? Uint8Array.from(atob((await r.json()).b64), (ch) => ch.charCodeAt(0)).buffer : await r.arrayBuffer();      // a deck shipped as its bytes in JSON (see build.py)
      src0 = await memSource(buf, lec.file); } const settings = { ...QDEF, count: E.FL.STEP, field: E.detectField(src0.pages.map((p) => p.text).join(' ')) };
    const { readSrc, analysis } = await readAndAnalyse(src0, settings); const pages = readSrc.src.pages; const plan = E.buildPlan(analysis, settings, null); const dens = E.densityOf(pages);
    const types = E.ORDER.filter((t) => plan.pool.some((o) => o.types && o.types[t]));
    const prev = st.lectures[lec.id] || {}; st.lectures[lec.id] = { ...prev, dens, types };      // its types count for this density before the forced ones are worked out
    const force = idx.every((l) => st.lectures[l.id]) ? forcedOf(st, dens) : [];      // every lecture read: a type no lecture of this density supports is tried anyway (only Claude's refusals settle it)
    const slots = E.exploreSlots(plan.pool, own, dens, Math.min(E.FL.STEP, Math.max(8, plan.natural_count || 0)), { force }); const g = E.formGuide(E.mergeProfiles(await baseProfile(), own), dens);
    slots.forEach((s) => { s.difficulty = E.difficultyFor(settings, s.qtype); const tip = g.tip(s.qtype, E.AI_FORMS[s.qtype].indexOf(s.shape)); if (tip) s.form_tip = tip; });      // as a real quiz would send it: a form with a recurring failure carries its fixed reminder
    st.lectures[lec.id] = { dens, types, runs: (prev.runs || 0) + (slots.length ? 1 : 0), exhausted: !slots.length && !idx.some((l) => !st.lectures[l.id]), label: lec.density };
    let res = { outcomes: [], accepted: [], stats: {} };
    if (slots.length) res = await E.generate(llm, { slots, requested: slots.length }, pages, settings, () => {}, { concurrency: H.concurrency || 1, evidenceCheck: readSrc.check, sectionPages: secPagesOf(analysis, pages), oneRound: true });
    if (res.outcomes.length) await learnFrom(res.outcomes, dens);
    st.steps++; (st.log ||= []).push({ at: nowS(), lecture: lec.id, dens, slots: slots.length, first: res.outcomes.length, ok: res.outcomes.filter((o) => o.ok).length, ms: Date.now() - t0 }); st.log = st.log.slice(-60);
    await putDoc(FDEV, st); return { ok: true, quota: !!(H.quotaSince && H.quotaSince(t0)) }; })();
  try { return await DEV_BUSY; } finally { DEV_BUSY = null; }
}

// ---------------------------------------------------------------- attempts
const CHAINS = new Map();      // attempt id -> the last read-modify-write in line: the writes of one attempt happen one at a time
const serial = (key, fn) => { const run = (CHAINS.get(key) || Promise.resolve()).catch(() => {}).then(fn); CHAINS.set(key, run); run.catch(() => {}).then(() => { if (CHAINS.get(key) === run) CHAINS.delete(key); }); return run; };
// PRACTICE: the page gets each question's key with it (the student's own quiz - its answer key is a download away), so the right answer and the explanation show the moment
// an option is chosen; the answer is saved in the background. An exam keeps its key here until it is handed in.
const qStateItem = (x, ans, reveal, i, practice) => { const it = { id: x.id, position: i + 1, qtype: x.qtype, type_label: x.type_label, stem: x.stem, options: [], selected_option_id: ans.sel || null, flagged: !!ans.flag, answered: !!ans.sel, source_pages: x.source_pages };
  if (reveal) Object.assign(it, { correct_option_id: x.correct_option_id, explanation: x.explanation, is_correct: ans.sel === x.correct_option_id, evidence: x.evidence });
  else if (practice) it.practice_key = { correct_option_id: x.correct_option_id, explanation: x.explanation, evidence: x.evidence, source_pages: x.source_pages }; return it; };
async function attState(a) {
  const q = await getDoc(K.quiz(a.quiz_id)); const by = Object.fromEntries(q.questions.map((x) => [x.id, x])); const sub = a.status === 'submitted', practice = a.mode === 'practice';
  const items = a.order.map((qid, i) => { const x = by[qid], ans = a.answers[qid] || {}; const it = qStateItem(x, ans, sub || (practice && ans.revealed), i, practice && !sub); it.options = a.optOrder[qid].map((id) => x.options.find((o) => o.id === id)); return it; });
  const score = items.filter((i) => i.is_correct).length;
  return { id: a.id, quiz_id: q.id, quiz_title: q.title, mode: a.mode, status: a.status, current_index: a.idx, elapsed_seconds: a.elapsed || 0, time: { limit: a.timer, remaining: a.timer ? Math.max(0, a.timer - Math.floor(nowS() - a.started)) : null },
    score: sub ? score : null, max_score: sub ? items.length : null, questions: items, scoring: SCORING, answered: items.filter((i) => i.answered).length, total: items.length, generator: q.generator, is_demo: false, started_at: a.started, submitted_at: a.submittedAt };
}
const attRow = async (a) => { const s = await attState(a); return { id: a.id, quiz_id: a.quiz_id, quiz_title: s.quiz_title, mode: a.mode, status: a.status, answered: s.answered, total: s.total, score: s.score, max_score: s.max_score, started_at: a.started, updated_at: a.updated, submitted_at: a.submittedAt }; };
async function expire(a) { if (a.status === 'in_progress' && a.mode === 'exam' && a.timer && nowS() - a.started > a.timer + 2) { a.status = 'submitted'; a.submittedAt = nowS(); a.updated = nowS(); await putDoc(K.att(a.id), a); } return a; }

// ---------------------------------------------------------------- cards
/* Flashcards. With an AI: the lecture is cut into small parts spread over the WHOLE lecture, asked IN PARALLEL (each for its share), and the
 * asking stops as soon as the requested number is in - a slow provider is given a deadline, and whatever is still missing (or everything, when
 * the service fails) is completed at once by the local builder, which reads the whole lecture and spreads its cards over its pages. */
const CARDS_DEADLINE_MS = 30000;      // a provider still writing after this is not waited for: the local builder completes the set at once
async function genCards(docId, b) {
  const d = await getDoc(K.doc(docId)); if (!d) return ER(404, 'not_found', 'الملف غير موجود.'); const local = !!b.rules || !(await platform()).aiAvailable; const src = await loadSource([{ document_id: docId, pages: b.pages }]); if (!src.pages.length) return ER(422, 'cards_error', 'لا توجد صفحات مقروءة في هذا النطاق.');
  const existing = (await listKind('card')).filter((c) => c.document_id === docId); const seen = existing.map((c) => E.toks(c.front)); const fps = new Set(existing.map((c) => E.norm(c.front)));
  let created = 0, fromAI = 0; const rej = { quote_missing: 0, duplicate: 0, empty: 0, error: 0 }; const n = Math.max(3, Math.min(60, b.count || 20)); const sc = (() => { try { const k = llm && llm.scale ? +llm.scale() : 1; return k > 0 && k <= 1 ? k : 1; } catch (_) { return 1; } })();
  const byRef = Object.fromEntries(src.pages.map((p) => [p.ref, p]));
  const accept = async (c, pagesText, gen) => { if (created >= n) return false; const front = String(c.front || '').trim(), back = String(c.back || '').trim();
    if (front.length < 8 || back.length < 2) { rej.empty++; return false; } if (!pagesText[c.page] || !E.quoteIn(c.quote || '', pagesText[c.page])) { rej.quote_missing++; return false; }
    const ft = E.toks(front); if (fps.has(E.norm(front)) || seen.some((t) => E.jac(ft, t) >= .7)) { rej.duplicate++; return false; } fps.add(E.norm(front)); seen.push(ft); created++;
    const id = rid(); await putDoc(K.card(id), { kind: 'card', id, document_id: docId, front, back, source_page: byRef[c.page].page_no, evidence: String(c.quote).slice(0, 300), state: 'new', times_known: 0, times_review: 0, due_at: null, interval_days: 0, generator: gen, created_at: nowS() }); return true; };
  if (!local) {
    const callCards = async (pg, per, lang) => { try { const [s, p] = E.P.cards(pg, per, lang); return ((await llm.json('cards', s, p)) || {}).cards || []; }       // a provider that finds the request too large gets it in two halves
      catch (e) { const ks = Object.keys(pg); if (e && e.code === 'too_large' && ks.length > 1) { const mid = Math.ceil(ks.length / 2); const part = (a) => Object.fromEntries(a.map((k) => [k, pg[k]])); return [...(await callCards(part(ks.slice(0, mid)), Math.max(2, Math.ceil(per / 2)), lang)), ...(await callCards(part(ks.slice(mid)), Math.max(2, Math.ceil(per / 2)), lang))]; } throw e; } };
    const chunks = []; { let cur = [], len = 0; const max = Math.max(2500, Math.round(7000 * sc)); for (const p of src.pages) { cur.push(p); len += Math.min(p.text.length, 2500); if (len > max) { chunks.push(cur); cur = []; len = 0; } } if (cur.length) chunks.push(cur); }
    const want = Math.min(chunks.length, Math.max(2, Math.ceil(n / 3))); const pickIdx = [...new Set(Array.from({ length: want }, (_, k) => Math.floor(k * chunks.length / want)))];      // parts spread over the whole lecture, not its first pages
    const per = Math.max(2, Math.ceil((n * 1.3) / pickIdx.length)); const deadline = Date.now() + (+((window.QZ_CONFIG || {}).cardsDeadlineMs) || H.cardsDeadlineMs || CARDS_DEADLINE_MS); let done = 0;
    progress({ stage: 'cards', done: 0, total: pickIdx.length });
    await new Promise((resolve) => { let settled = false; const finish = () => { if (!settled) { settled = true; resolve(); } }; setTimeout(finish, Math.max(0, deadline - Date.now()));
      E.mapLimit(pickIdx, H.concurrency || 3, async (ci) => { if (settled || created >= n) return; const chunk = chunks[ci]; const pg = Object.fromEntries(chunk.map((p) => [p.ref, p.text.slice(0, Math.max(1200, Math.round(2500 * sc)))]));
        let cs = []; try { cs = await callCards(pg, per, b.language); } catch (e) { rej.error++; } if (settled) return; for (const c of cs) { if (created >= n) break; if (await accept(c, pg, H.generatorLabel)) fromAI++; }
        done++; progress({ stage: 'cards', done, total: pickIdx.length }); if (created >= n) finish(); }).then(finish, finish); });
  }
  // the local builder: the whole lecture at once, cards spread over its pages (it also completes what the AI did not give in time)
  if (created < n && E.rules && !AI_ONLY) { const pagesText = Object.fromEntries(src.pages.map((p) => [p.ref, p.text])); for (const c of E.rules.cards(src.pages, n * 3, n - created)) { if (created >= n) break; await accept(c, pagesText, 'rules'); } }
  return J({ created, requested: n, from_ai: fromAI, from_local: created - fromAI, rejected: rej, excluded_pages: src.excluded });
}

// ---------------------------------------------------------------- router
async function handle(method, path, qs, init) {
  const pl = await platform(); let b = {}; let m;
  if (init && init.body && !(init.body instanceof FormData)) { try { b = JSON.parse(init.body); } catch { /* ignore */ } }
  const me = pl.user || null;
  const R = (o) => (o instanceof Response ? o : J(o.body === undefined ? { ok: true } : o.body, o.status || 200));
  const A = H.auth || {};
  const UNAUTH = () => ER(401, 'unauthenticated', 'سجّل الدخول للمتابعة.');
  if (path === '/api/auth/capabilities') return J({ password_reset: false, llm: true, rules_mode: !AI_ONLY && !!E.rules, claude_ok: !!pl.aiAvailable, tutor: !!(pl.aiAvailable && E.makeTutorReply), ai_missing: H.aiMissingMessage || '', registration: 'open', llm_is_test: false, dev: devAllowed(pl), ...(H.capabilities ? await H.capabilities(pl) : {}) });
  if (path === '/api/auth/me') return me ? J(me) : UNAUTH();
  const authName = (path.match(/^\/api\/auth\/(login|register|guest|logout|forgot|reset|password|delete)$/) || [])[1];
  if (authName) {
    if (A[authName]) { const r = R(await A[authName](b, pl)); if (['login', 'register', 'guest', 'logout', 'delete', 'reset'].includes(authName)) cache.clear(); return r; }
    if (authName === 'login' || authName === 'register' || authName === 'guest') return me ? J(me) : UNAUTH();
    if (authName === 'logout') return J({ ok: true });
    return ER(503, 'unavailable', 'غير متاح في هذه النسخة.');
  }
  if (path.startsWith('/api/auth/')) return ER(404, 'not_found', 'غير متاح.');
  const openPath = path === '/api/operator' || path.startsWith('/api/accounts/') || path.startsWith('/api/llm/') || path.startsWith('/api/composer/') || path.startsWith('/api/chrome-ai') || path.startsWith('/api/semantic');      // the operator's page works without an account (it is how the operator finds out WHY accounts do not work yet); each of these checks the OPERATOR flag of this device itself. Everything else needs an account
  if (H.requireAuth && !me && !openPath) return UNAUTH();
  if (H.handle) { const r = await H.handle(method, path, qs, b, init, pl); if (r) return R(r); }
  if (path === '/api/events') return J({ ok: true });
  if (path === '/api/reports') { const id = rid(); await putDoc('report_' + id, { kind: 'report', id, ...b, status: 'open', created_at: nowS() });
    // the composer (rules.js COMPOSER) handles every report on a question it wrote: never written again, the form kept off that fact when the answer / source / options
    // were wrong, and the form weighed down in every next quiz on this device
    let handled = null; if (b.target_type === 'question' && b.target_id && E.rules && E.rules.composer) { try { for (const q of await listKind('quiz')) { const x = (q.questions || []).find((z) => z.id === b.target_id);
      if (x) { if (x.form) handled = E.rules.composer.report({ form: x.form, stem: x.stem, key: ((x.options || []).find((o) => o.id === x.correct_option_id) || {}).text, kind: b.kind }); break; } } } catch (_) { /* never in the way */ } }
    return J({ id, handled }); }

  // documents
  if (path === '/api/documents' && method === 'POST') {
    const f = init.body.get('file'); if (!f) return ER(422, 'validation', 'لا يوجد ملف.'); const name = f.name || 'file', lower = name.toLowerCase(); const buf = await f.arrayBuffer(); const head = new Uint8Array(buf.slice(0, 4)); const sig = String.fromCharCode(...head);
    const kind = sig.startsWith('%PDF') && lower.endsWith('.pdf') ? 'pdf' : sig.startsWith('PK') && lower.endsWith('.pptx') ? 'pptx' : head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0 && lower.endsWith('.ppt') ? 'ppt' : null; if (!kind) return ER(415, 'unsupported_type', 'الملف غير مدعوم أو تالف. المدعوم: PDF وPowerPoint (PPTX وPPT).');
    if (buf.byteLength > MAX_UPLOAD_MB * 1024 * 1024) return ER(413, 'too_large', `الحجم يتجاوز ${MAX_UPLOAD_MB}MB.`);
    const id = rid(); let pages; try { pages = kind === 'pdf' ? await extractPdf(buf, name) : kind === 'ppt' ? extractPptBinary(buf) : await extractPptx(buf); } catch (e) { return ER(422, 'extract_failed', 'تعذّرت قراءة الملف: ' + e.message); }
    stripBoiler(pages); const meta = [];
    const pageRows = []; for (const p of pages) { let [status, notes] = classify(p.text, p.image_count); if (p.ocr && status === 'ok') notes = ['قُرئت من صورة الصفحة (قد تحوي أخطاء قراءة قليلة).']; else if (p.ocr_unclear) notes = ['صورة غير واضحة بما يكفي لقراءتها.'];
      else if (p.ocr_skipped) notes = ['شريحة مصوّرة بلا نص: لم تُقرأ آليًا لأن في الملف نصًا كافيًا، والأسئلة تُبنى من نص الشرائح نفسه.'];
      meta.push({ page_no: p.page_no, status, char_count: p.text.length, notes: notes.join(' '), image_count: p.image_count, snippet: p.text.slice(0, 160), ...(p.ocr ? { ocr: p.ocr } : {}) }); pageRows.push([K.page(id, p.page_no), { kind: 'page', doc: id, page_no: p.page_no, text: p.text, at: nowS() }]); }
    const rollback = async () => { cache.delete(K.doc(id)); try { await delMany(pageRows.map(([k]) => k)); } catch (_) { /* best effort */ } };
    UPLOADING.add(id); try { await putMany(pageRows); } catch (e) { UPLOADING.delete(id); await rollback(); throw e; }
    const usable = meta.filter((p) => ['ok', 'low_text'].includes(p.status)).length;
    const d = { kind: 'doc', id, title: ((init.body.get('title') || name.replace(/\.[^.]+$/, '')) + '').slice(0, 120) || 'ملف', filename: name.slice(0, 200), kind_: kind, status: usable ? 'ready' : 'unreadable', error: usable ? null : 'صفحاته صور ولم يُستخرج منها نص واضح. إن كان عندك الملف الأصلي (PowerPoint، أو PDF صُدِّر منه) فارفعه بدلًا منه.', page_count: pages.length, pages: meta, created_at: nowS() };
    try { await putDoc(K.doc(id), d); } catch (e) { await rollback(); throw e; } finally { UPLOADING.delete(id); }
    // the figure reader, IN THE BACKGROUND: the file is ready at once (a real 64-slide lecture waited four minutes when every slide with a picture was read first);
    // only the slides whose own text is too thin to carry a question are shown to Claude, and the reading of the lecture (loadSource) waits for them a short while
    const figs = kind !== 'ppt' && pages.figureImages && H.figuresReady ? figureCandidates(pages, kind) : [];
    if (kind !== 'ppt') keepSlideImages(id, pages).catch(() => {});      // the slides as they look, for the explanation (this device)
    if (figs.length && (await H.figuresReady().catch(() => false))) { const job = { t0: Date.now(), p: null }; job.p = readFigures(d, pages, figs).catch(() => {}).finally(() => FIGJOBS.delete(id)); FIGJOBS.set(id, job); }
    return J(docSummary(d));
  }
  if (path === '/api/documents') { const l = await listKind('doc'); for (const d of l) await unstick(d); gcPages(l); return J(l.sort((a, b) => b.created_at - a.created_at).map((d) => docSummary(d))); }
  if ((m = path.match(/^\/api\/documents\/(\w+)\/pages\/(\d+)$/))) { const d = await getDoc(K.doc(m[1])); if (!d) return ER(404, 'not_found', 'الملف غير موجود.'); const p = await getDoc(K.page(m[1], +m[2])); const meta = d.pages.find((x) => x.page_no === +m[2]); return p ? J({ page_no: +m[2], text: p.text, figure: p.fig || [], status: meta.status, notes: meta.notes, image_count: meta.image_count }) : ER(404, 'not_found', 'الصفحة غير موجودة.'); }
  if ((m = path.match(/^\/api\/documents\/(\w+)\/cards\/generate$/))) return genCards(m[1], b);
  if ((m = path.match(/^\/api\/documents\/(\w+)$/))) { const d = await getDoc(K.doc(m[1])); if (!d || (hidden(m[1]) && method !== 'DELETE')) return ER(404, 'not_found', 'الملف غير موجود.'); await unstick(d);
    if (method === 'DELETE') { await deleting([d.id], () => delDoc(K.doc(d.id))); delMany(d.pages.map((p) => K.page(d.id, p.page_no))).catch(() => { /* gcPages() removes what is left */ });
      listKind('xcache').then((l) => delMany([...l.filter((x) => x.doc === d.id).map((x) => x.id), XP(d.id)])).catch(() => { /* its explanations: an optimisation only */ }); slideImgDrop(d.id); return J({ ok: true }); }      /* the file goes at once; its pages follow in the background */ if (method === 'PATCH') { if (b.title) d.title = String(b.title).slice(0, 120); await putDoc(K.doc(d.id), d); } return J(docSummary(d, true)); }

  // quizzes
  if (path === '/api/quizzes/options') return J({ counts: [10, 20, 30, 50, 100], default_count: 20, difficulty: { easy: 'سهلة', medium: 'متوسطة', hard: 'متقدمة', mixed: 'متنوعة' }, focus: { balanced: 'متوازن', understand_apply: 'فهم وتطبيق', critical: 'تفكير نقدي', recall: 'استرجاع' }, types: Object.fromEntries(E.ORDER.map((c) => [c, { ar: E.QT[c][0], en: c }])), scoring: SCORING });
  if (path === '/api/quizzes/prepare' && method === 'POST') return J(await prepareAnalysis(b, pl));
  if ((m = path.match(/^\/api\/explain\/(\w+)\/image\/(\d+)$/))) return explainRoute(m[1], 'image', method, { page: +m[2] }, pl);
  if ((m = path.match(/^\/api\/explain\/(\w+)(?:\/(slide|ask|progress))?$/))) return explainRoute(m[1], m[2] || '', method, b, pl);
  if (path === '/api/quizzes' && method === 'POST') {
    const st = { ...QDEF, ...(b.settings || {}) }; st.count = Math.max(5, Math.min(100, +st.count || 20)); st.generator = !pl.aiAvailable || st.generator === 'rules' ? 'rules' : 'claude'; if (!(b.sources || []).length) return ER(422, 'validation', 'اختر ملفًا.');
    let src; try { src = await loadSource(b.sources); } catch (e) { return ER(422, 'source_error', e.message); }
    if (!src.pages.length) return ER(422, 'no_readable_pages', 'لا توجد صفحات مقروءة في النطاق المختار.', { excluded: src.excluded });
    st.sources = b.sources.map((s) => ({ document_id: s.document_id, pages: s.pages || null })); st.field = E.detectField(src.pages.map((p) => p.text).join(' ')); const heur = E.support(src.pages.map((p) => p.text), st.field);
    const id = rid(); const doc = await getDoc(K.doc(b.sources[0].document_id));
    const st0 = H.llmStats ? H.llmStats() : {}; const q = { kind: 'quiz', id, title: (b.title || doc.title).slice(0, 120), settings: st, status: 'draft', created_at: nowS(), updated_at: nowS(), timing: { t0: Date.now(), calls0: st0.calls || 0, waits0: st0.waits || 0, hidden0: hiddenNow() }, progress_pct: 0, source_preview: { readable_pages: src.pages.length, excluded_pages: src.excluded, words: heur._meta.words, type_support: typeSupportOut(heur) } };
    await putDoc(K.quiz(id), q); return J(await quizOut(q, true));
  }
  if (path === '/api/quizzes') return J(await Promise.all((await listKind('quiz')).sort((a, b) => b.created_at - a.created_at).map((q) => quizOut(q))));
  if (path === '/api/jobs') return J([...JOBS.entries()].filter(([id]) => !hidden(id)).map(([id, j]) => ({ id, title: (cache.get(K.quiz(id)) || {}).title || '', stage: j.stage, pct: j.pct || 0 })));      // the quizzes being made in this page now

  // COMPLETE A QUIZ THE QUOTA CUT SHORT: once the viewer's Claude quota is back, the missing questions are written from where the first run stopped (its checkpoint);
  // the questions it already has - and the attempts on them - stay as they are
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/complete$/)) && method === 'POST') {
    const q = await getDoc(K.quiz(m[1])); if (!q) return ER(404, 'not_found', 'الكويز غير موجود.'); if (!pl.aiAvailable) return ER(503, 'llm_not_configured', H.aiMissingMessage);
    if (JOBS.has(q.id) || elsewhere(q.id)) return ER(409, 'busy', 'المعالجة جارية بالفعل.');
    const r = q.report || {}; if (q.status !== 'ready' || !r.can_complete || (q.questions || []).length >= ((q.plan && q.plan.requested) || 0)) return ER(409, 'complete', 'هذا الكويز مكتمل.');
    const c0 = await getDoc(K.ckpt(q.id)).catch(() => null); if (!c0 || !Array.isArray(c0.accepted)) return ER(409, 'cannot_complete', 'تعذّر إكمال هذا الكويز؛ أنشئ كويزًا جديدًا.');
    q.timing = { ...(q.timing || {}), t0: Date.now(), calls0: H.llmStats ? H.llmStats().calls : 0, hidden0: 0, waits0: 0 }; q.progress_stage = 'drafting'; q.progress_pct = Math.round(100 * q.questions.length / q.plan.requested);
    await startJob(q, 'generating', () => jobGenerate(q.id)); return J({ ok: true });
  }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/(analyze|generate)$/))) {
    const q = await getDoc(K.quiz(m[1])); if (!q) return ER(404, 'not_found', 'الكويز غير موجود.'); if (!pl.aiAvailable && q.settings.generator !== 'rules') return ER(503, 'llm_not_configured', H.aiMissingMessage);
    if (JOBS.has(q.id) || elsewhere(q.id)) return ER(409, 'busy', JOBS.has(q.id) ? 'المعالجة جارية بالفعل.' : 'يُنشأ هذا الكويز الآن في نافذة أخرى من كويزي: تابعه هناك.');
    if (m[2] === 'analyze') { if (q.status === 'ready') return ER(409, 'already_ready', 'الكويز جاهز بالفعل (ومحاولاتك مرتبطة بأسئلته). أنشئ كويزًا جديدًا.'); await startJob(q, 'analyzing', () => jobAnalyse(q.id, !!b.auto_generate)); return J({ ok: true }); }
    if (q.status === 'ready') return ER(409, 'already_ready', 'الكويز جاهز بالفعل؛ أنشئ كويزًا جديدًا.'); if (!['planned', 'failed', 'insufficient'].includes(q.status) || !q.plan) return ER(409, 'not_planned', 'حلّل المحتوى وأكّد الخطة أولًا.');
    if (!q.plan.feasible_count) return ER(409, 'nothing_feasible', 'المصدر لا يدعم أي سؤال؛ وسّع المصدر.');
    if (q.plan.feasible_count < q.plan.requested && !b.accept_reduced) return ER(409, 'shortfall', `المصدر يدعم ${q.plan.feasible_count} سؤالًا فقط من أصل ${q.plan.requested}. وافق على العدد الأقل أو وسّع المصدر.`, { shortfall: q.plan.shortfall });
    await startJob(q, 'generating', () => jobGenerate(q.id)); return J({ ok: true });
  }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/questions$/))) { const q = await getDoc(K.quiz(m[1])); return q ? J(q.questions || []) : ER(404, 'not_found', 'الكويز غير موجود.'); }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/attempts$/))) {
    const q = await getDoc(K.quiz(m[1])); if (!q || q.status !== 'ready') return ER(409, 'not_ready', 'الكويز غير جاهز.'); let order = q.questions.map((x) => x.id); if (b.only_question_ids) order = order.filter((x) => b.only_question_ids.includes(x));
    if (b.shuffle_questions) order.sort(() => Math.random() - .5); const optOrder = {}; q.questions.forEach((x) => { const ids = x.options.map((o) => o.id); if (b.shuffle_options !== false && q.settings.shuffle_options !== false) ids.sort(() => Math.random() - .5); optOrder[x.id] = ids; });
    const tm = b.timer_minutes != null ? b.timer_minutes : q.settings.timer_minutes; const a = { kind: 'attempt', id: rid(), quiz_id: q.id, mode: b.mode || q.settings.mode || 'practice', order, optOrder, answers: {}, idx: 0, elapsed: 0, status: 'in_progress', started: nowS(), updated: nowS(), timer: tm ? tm * 60 : null };
    await putDoc(K.att(a.id), a); return J(await attState(a));
  }
  if (path === '/api/quizzes/batch-delete' && method === 'POST') {      // many quizzes at once (the «كويزاتي» page): their attempts are listed once, not once per quiz
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => /^\w+$/.test(x))); if (!ids.size) return ER(422, 'validation', 'لم يُحدَّد أي كويز.');
    return deleting([...ids], async () => { const [allAtt, found] = await Promise.all([listKind('attempt'), Promise.all([...ids].map((id) => getDoc(K.quiz(id))))]);
      const atts = allAtt.filter((a) => ids.has(a.quiz_id)).map((a) => K.att(a.id)), quizzes = found.filter(Boolean).map((q) => K.quiz(q.id));
      await delMany([...atts, ...quizzes]); delMany(found.filter(Boolean).map((q) => K.ckpt(q.id))).catch(() => { /* there were none */ }); return J({ deleted: quizzes.length, attempts_deleted: atts.length }); });
  }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/pdf$/))) return ER(501, 'pdf_unavailable', H.pdfMessage || 'تنزيل PDF غير متاح في هذه النسخة.');
  if ((m = path.match(/^\/api\/quizzes\/(\w+)$/))) { const q = await getDoc(K.quiz(m[1])); if (!q || (hidden(m[1]) && method !== 'DELETE')) return ER(404, 'not_found', 'الكويز غير موجود.');
    if (method === 'DELETE') { await deleting([q.id], async () => delMany([...(await listKind('attempt')).filter((x) => x.quiz_id === q.id).map((a) => K.att(a.id)), K.quiz(q.id)])); delDoc(K.ckpt(q.id)).catch(() => { /* there was none */ }); return J({ ok: true }); }
    if (method === 'PATCH') {
      if (b.title) q.title = String(b.title).slice(0, 120);
      if (b.settings && ['claude', 'rules'].includes(b.settings.generator) && !JOBS.has(q.id) && q.status !== 'ready') { q.settings.generator = b.settings.generator; q.status = 'draft'; q.plan = null; q.analysis = null; q.error = null; }
      await touch(q); return J({ ok: true }); } return J(await quizOut(q, true)); }

  // attempts
  if (path === '/api/attempts' && method === 'GET') { let l = await listKind('attempt'); if (qs.get('quiz_id')) l = l.filter((a) => a.quiz_id === qs.get('quiz_id'));
    /* an attempt whose quiz is gone (or going) cannot be shown */ l = (await Promise.all(l.map(async (a) => (!hidden(a.quiz_id) && (await getDoc(K.quiz(a.quiz_id))) ? a : null)))).filter(Boolean); l = await Promise.all(l.map(expire)); if (qs.get('status')) l = l.filter((a) => a.status === qs.get('status'));
    return J(await Promise.all(l.sort((a, c) => c.updated - a.updated).slice(0, 100).map(attRow))); }
  if ((m = path.match(/^\/api\/attempts\/(\w+)(\/\w+)?$/))) {
    let a = await getDoc(K.att(m[1])); if (!a) return ER(404, 'not_found', 'المحاولة غير موجودة.'); a = await expire(a); const act = m[2];
    if (!act && method === 'GET') return J(await attState(a)); if (!act && method === 'DELETE') { await delDoc(K.att(a.id)); return J({ ok: true }); }
    if (act === '/answer') { if (a.status === 'submitted') return ER(409, a.mode === 'exam' && a.timer ? 'time_up' : 'already_submitted', 'المحاولة مسلَّمة ولا يمكن تعديلها.');
      const q = await getDoc(K.quiz(a.quiz_id)); const x = q.questions.find((z) => z.id === b.question_id); if (!x) return ER(404, 'not_found', 'السؤال ليس ضمن المحاولة.'); const ans = (a.answers[x.id] ||= {}); const r = { saved: true, saved_at: nowS() };
      if (b.option_id != null || b.clear) { if (a.mode === 'practice' && ans.revealed) return ER(409, 'locked', 'تم عرض التفسير لهذا السؤال؛ لا يمكن تغيير الإجابة في وضع التدريب.');
        const sel = b.clear ? null : b.option_id; if (sel && !x.options.some((o) => o.id === sel)) return ER(422, 'bad_option', 'الخيار لا ينتمي لهذا السؤال.'); ans.sel = sel;
        if (a.mode === 'practice' && sel) { ans.revealed = true; Object.assign(r, { is_correct: sel === x.correct_option_id, correct_option_id: x.correct_option_id, explanation: x.explanation, evidence: x.evidence, source_pages: x.source_pages }); } }
      if (b.flagged != null) ans.flag = b.flagged; a.updated = nowS(); await putDoc(K.att(a.id), a); return J(r); }
    if (act === '/correction' && method === 'POST') {      // the ARABIC CORRECTION of a wrong (or blank) answer: made on demand by the AI, checked, kept with the attempt
      const q = await getDoc(K.quiz(a.quiz_id)); const x = q && q.questions.find((z) => z.id === b.question_id); if (!x) return ER(404, 'not_found', 'السؤال ليس ضمن المحاولة.');
      const ans = a.answers[x.id] || {}; if (!(a.status === 'submitted' || (a.mode === 'practice' && ans.revealed))) return ER(409, 'not_revealed', 'لم يُعرض تفسير هذا السؤال بعد.');
      if (ans.sel && ans.sel === x.correct_option_id) return J({ available: false, reason: 'not_wrong' });
      if (ans.fix && ans.fix.opt === (ans.sel || null) && ans.fix.v === 2) return J({ available: true, ar: ans.fix.ar, cached: true });
      if (!pl.aiAvailable) return J({ available: false, reason: 'no_ai' });
      const ctx = await qCtx(x, ans);      // (also for a lecture in Arabic: the correction diagnoses the slip, it does not only translate)
      let ar; try { ar = await E.makeCorrection(llm, ctx); } catch (e) { return J({ available: true, ar: null, reason: 'failed' }); }
      if (!ar) return J({ available: true, ar: null, reason: 'rejected' });
      await serial(a.id, async () => { const cur = await getDoc(K.att(a.id)); if (!cur) return; (cur.answers[x.id] ||= {}).fix = { ar, opt: ans.sel || null, v: 2 }; await putDoc(K.att(a.id), cur); });      // re-read, then write: several corrections of one attempt arrive together
      return J({ available: true, ar, cached: false }); }
    // THE TUTOR AFTER ANY QUESTION (right or wrong, once its answer is shown): the student asks about it and is answered from the pages of their own lecture; or asks
    // for a SIMILAR QUESTION on the same idea, answered on the spot. Both on demand, checked by the engine; nothing is kept but what the page shows.
    if ((act === '/tutor' || act === '/similar') && method === 'POST') {
      const q = await getDoc(K.quiz(a.quiz_id)); const x = q && q.questions.find((z) => z.id === b.question_id); if (!x) return ER(404, 'not_found', 'السؤال ليس ضمن المحاولة.');
      const ans = a.answers[x.id] || {}; if (!(a.status === 'submitted' || (a.mode === 'practice' && ans.revealed))) return ER(409, 'not_revealed', 'أجب عن السؤال أولًا.');
      if (!pl.aiAvailable || !llm) return J({ available: false, reason: 'no_ai' });
      const ctx = await qCtx(x, ans);
      try {
        if (act === '/similar') { const sq = await E.makeSimilar(llm, ctx); return J(sq ? { available: true, question: sq } : { available: true, question: null, reason: 'rejected' }); }
        const ask = String(b.ask || '').trim(); if (!ask) return ER(422, 'empty', 'اكتب سؤالك.');
        const ar = await E.makeTutorReply(llm, ctx, ask, Array.isArray(b.history) ? b.history : []); return J(ar ? { available: true, ar } : { available: true, ar: null, reason: 'rejected' });
      } catch (e) { return J({ available: true, ar: null, question: null, reason: 'failed', code: (e && e.code) || null }); }
    }
    if (act === '/position') { if (a.status === 'submitted') return J({ saved: false, status: 'submitted' }); a.idx = Math.min(b.index, a.order.length - 1); a.elapsed = Math.max(a.elapsed, b.elapsed_seconds); a.updated = nowS(); await putDoc(K.att(a.id), a); return J({ saved: true, saved_at: nowS() }); }
    if (act === '/submit') { if (a.status !== 'submitted') {
      a.status = 'submitted'; a.submittedAt = nowS(); a.updated = nowS(); await putDoc(K.att(a.id), a); } return J(await attState(a)); }
  }

  // cards
  const cards = async () => { await listKind('doc'); return cardsRaw(); };
  const cardsRaw = async () => (await listKind('card')).map((c) => ({ ...c, document_title: (cache.get(K.doc(c.document_id)) || {}).title }));
  if (path === '/api/cards/stats') { const cs = await cards(); const by = {}; cs.forEach((c) => { const o = (by[c.document_id] ||= { id: c.document_id, title: c.document_title, total: 0, known: 0, review: 0, new: 0, due: 0 }); o.total++; o[c.state]++; if (!c.due_at || c.due_at <= nowS()) o.due++; }); return J(Object.values(by)); }
  if (path === '/api/cards' && method === 'GET') { await listKind('doc'); let cs = await cards(); if (qs.get('document_id')) cs = cs.filter((c) => c.document_id === qs.get('document_id')); if (qs.get('state')) cs = cs.filter((c) => c.state === qs.get('state')); if (qs.get('due')) cs = cs.filter((c) => !c.due_at || c.due_at <= nowS());
    return J(cs.sort((a, c) => (a.due_at || 0) - (c.due_at || 0) || a.source_page - c.source_page)); }
  if ((m = path.match(/^\/api\/cards\/(\w+)\/state$/))) { const c = await getDoc(K.card(m[1])); if (!c) return ER(404, 'not_found', 'البطاقة غير موجودة.'); const prev = c.interval_days || 0;
    if (b.state === 'known') { c.interval_days = prev < 1 ? 1 : Math.min(180, Math.round(prev * 22) / 10); c.due_at = nowS() + c.interval_days * 86400; c.times_known++; } else if (b.state === 'review') { c.interval_days = 0; c.due_at = nowS() + 600; c.times_review++; } else { c.interval_days = 0; c.due_at = null; }
    c.state = b.state; c.last_reviewed_at = nowS(); await putDoc(K.card(c.id), c); return J({ saved: true, state: c.state, interval_days: c.interval_days, due_at: c.due_at, saved_at: nowS() }); }
  if ((m = path.match(/^\/api\/cards\/(\w+)$/)) && method === 'DELETE') { await delDoc(K.card(m[1])); return J({ ok: true }); }
  // the development track: the owner's only (it asks the viewer's own Claude for many rounds)
  if (path === '/api/dev' || path.startsWith('/api/dev/')) { if (!devAllowed(pl)) return ER(403, 'forbidden', 'مسار التطوير لصاحب هذه النسخة فقط.');
    try { if (path === '/api/dev' && method === 'GET') return J(await devStatus());
      if (path === '/api/dev/step' && method === 'POST') { const r = await devStep(b.lecture); return J({ ...r, status: await devStatus() }); }
      // «حدّث للجميع»: what the owner's quizzes taught the forms goes to every student's next quiz (the artifact's shared store; no new page version needed)
      if (path === '/api/dev/publish' && method === 'POST') { if (!H.sharedForms) return ER(501, 'unavailable', 'المشاركة غير متاحة في هذه النسخة.'); const own = await ownProfile();
        if (!own || !own.quizzes) return ER(409, 'nothing_learned', 'لم تتعلّم الصيغ شيئًا بعد: أنشئ كويزًا أو أكثر أولًا.');
        const m = E.mergeProfiles(bakedProfile(), own); await H.sharedForms.set({ kind: 'fshared', v: 1, cells: m.cells, quizzes: own.quizzes, updated_at: nowS() }); return J({ ok: true, status: await devStatus() }); } }
    catch (e) { return ER(e && e.code === 'quota' ? 429 : 502, (e && e.code) || 'dev_failed', (e && e.message) || String(e)); }
    return ER(404, 'not_found', 'غير متاح.'); }
  if (path.startsWith('/api/admin')) return ER(403, 'forbidden', 'الإدارة غير متاحة في هذه النسخة.');
  return ER(404, 'not_found', 'غير متاح.');
}
window.fetch = (url, init = {}) => { const u = new URL(typeof url === 'string' ? url : url.url, location.href); const i = u.pathname.indexOf('/api/'); if (i < 0) return realFetch(url, init);
  return handle((init.method || 'GET').toUpperCase(), u.pathname.slice(i), u.searchParams, init).catch((e) => (e && e.code === 'storage_full' ? ER(507, 'storage_full', STORAGE_FULL) : storageLost(e) ? ER(503, 'storage_unavailable', STORAGE_LOST) : ER(500, 'client_error', (e && e.message) || String(e)))); };

async function exportData(pl) {
  const out = { exported_at: nowS(), user: pl.user, documents: [], quizzes: await listKind('quiz'), attempts: await listKind('attempt'), flashcards: await listKind('card') };
  for (const d of await listKind('doc')) { const texts = await getMany(d.pages.map((p) => K.page(d.id, p.page_no))); out.documents.push({ ...docSummary(d), pages: d.pages.map((p) => ({ page_no: p.page_no, status: p.status, text: (texts[K.page(d.id, p.page_no)] || {}).text || '' })) }); }
  return out;
}
const toast = (msg) => { const t = document.createElement('div'); t.className = 'toast bad'; t.textContent = msg; (document.getElementById('toasts') || document.body).append(t); setTimeout(() => t.remove(), 3500); };
document.addEventListener('click', async (e) => {
  const a = e.target.closest && e.target.closest('a[href*="/pdf"], a[href*="/api/auth/export"]'); if (!a) return; e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (href.includes('/api/auth/export')) {
    const blob = new Blob([JSON.stringify(await exportData(await platform()))], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const dl = document.createElement('a'); dl.href = url; dl.download = 'quizzy-export.json'; document.body.append(dl); dl.click(); dl.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); return;
  }
  const m = href.match(/\/api\/quizzes\/(\w+)\/pdf/);
  if (H.printPdf && m) { location.hash = `#/print/${m[1]}?key=${/answer_key=false/.test(href) ? 0 : 1}`; return; }
  toast(H.pdfMessage || 'تنزيل PDF غير متاح في هذه النسخة.');
}, true);
const setBanner = (p, n = 0) => { const b = document.getElementById('ce-banner'); if (!b) { if (n < 60) setTimeout(() => setBanner(p, n + 1), 50); return; } const t = H.bannerText ? H.bannerText(p) : ''; b.textContent = t; b.style.display = t ? '' : 'none'; };
platform().then((p) => setBanner(p));
window.QZ_API = { handle, platform, resetCache: () => cache.clear(), exportData, _sections: lectureSections, _preRead: preRead, _readForAI: readForAI, _deleting: () => [...DELETING, ...GONE] };
})();
