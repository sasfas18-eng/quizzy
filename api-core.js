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
if (!H) throw new Error('QZ_HOST missing: load an edition host.js before api-core.js');
const platform = () => H.platform();
const store = () => H.store();
const llm = H.llm;
const cache = new Map(); // doc id -> object (reads are frequent: polling)
async function getDoc(k) { if (cache.has(k)) return cache.get(k); const v = await (await store()).get(k); if (v) cache.set(k, v); return v; }
async function putDoc(k, v) { cache.set(k, v); await (await store()).set(k, v); }
async function delDoc(k) { cache.delete(k); await (await store()).del(k); }
async function putMany(entries) { entries.forEach(([k, v]) => cache.set(k, v)); const st = await store(); if (st.setMany) await st.setMany(entries); else for (const [k, v] of entries) await st.set(k, v); }
async function delMany(keys) { keys.forEach((k) => cache.delete(k)); const st = await store(); if (st.delMany) await st.delMany(keys); else for (const k of keys) await st.del(k); }
/** read many documents with ONE round trip when the store can (network stores), cache-first */
async function getMany(keys) {
  const out = {}; const miss = []; keys.forEach((k) => (cache.has(k) ? (out[k] = cache.get(k)) : miss.push(k)));
  if (miss.length) { const st = await store(); if (st.getMany) Object.assign(out, await st.getMany(miss)); else for (const k of miss) { const v = await st.get(k); if (v) out[k] = v; } miss.forEach((k) => out[k] && cache.set(k, out[k])); }
  return out;
}
const K = { doc: (id) => 'doc_' + id, page: (id, n) => `page_${id}_${n}`, quiz: (id) => 'quiz_' + id, att: (id) => 'att_' + id, card: (id) => 'card_' + id };
async function listKind(kind) { const l = await (await store()).list(kind); const kf = { doc: K.doc, quiz: K.quiz, attempt: K.att, card: K.card }[kind]; if (kf) l.forEach((d) => cache.set(kf(d.id), d)); return l; }

// ---------------------------------------------------------------- extraction (browser)
const OK_MIN = 80;
// PDFs often store Arabic as shaped presentation forms (U+FB50–FEFF): fold them back to base letters so terms/regexes/quotes match
const unshape = (s) => (/[\ufb50-\ufdff\ufe70-\ufeff]/.test(s) ? s.normalize('NFKC') : s.normalize('NFC'));
const cleanLines = (s) => s.replace(/\u0000/g, '').split('\n').map((l) => l.replace(/[ \t ​]+/g, ' ').trim()).reduce((o, l) => { if (l || (o.length && o[o.length - 1])) o.push(l); return o; }, []).join('\n').trim();
const clean = (s) => cleanLines(unshape(String(s || '')));
function classify(text, images) {
  const n = text.length; if (n) { const bad = [...text].filter((c) => c === '�' || (c >= '' && c <= '')).length; if (bad / n > .15) return ['garbled', ['النص المستخرج تالف؛ قد تحتاج الصفحة إلى OCR.']]; }
  if (!n) return images ? ['image_only', ['الصفحة صورة بلا نص قابل للاستخراج؛ تحتاج معالجة OCR.']] : ['empty', ['صفحة فارغة.']];
  if (n < OK_MIN) return ['low_text', [images ? 'نص قليل مع صور؛ محتوى الصور غير مقروء.' : 'نص قليل جدًا (قد تكون صفحة عنوان).']];
  return ['ok', images ? ['تحتوي على صور/أشكال لم تُقرأ؛ الأسئلة لن تعتمد عليها.'] : []];
}
function stripBoiler(pages) {
  if (pages.length < 4) return; const cnt = new Map(); pages.forEach((p) => new Set(p.text.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 80).map((l) => l.replace(/\d+/g, '#'))).forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1)));
  const thr = Math.max(3, Math.floor(pages.length * .6)); const rep = new Set([...cnt].filter(([, v]) => v >= thr).map(([k]) => k)); if (!rep.size) return;
  pages.forEach((p) => (p.text = clean(p.text.split('\n').filter((l) => !(l.trim() && rep.has(l.trim().replace(/\d+/g, '#')))).join('\n'))));
}
async function extractPdf(buf) {
  const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', document.baseURI).href;
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise; if (pdf.numPages > 400) throw new Error('عدد الصفحات يتجاوز 400.');
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i); const tc = await pg.getTextContent(); let text = '', lastY = null;
    for (const it of tc.items) { const y = it.transform ? it.transform[5] : 0; if (lastY !== null && Math.abs(y - lastY) > 3 && !text.endsWith('\n')) text += '\n'; text += it.str + (it.hasEOL ? '\n' : ''); lastY = y; }
    let images = 0; try { const ops = await pg.getOperatorList(); images = ops.fnArray.filter((f) => f === lib.OPS.paintImageXObject || f === lib.OPS.paintInlineImageXObject || f === lib.OPS.paintJpegXObject).length; } catch { /* ignore */ }
    pages.push({ page_no: i, text: clean(text), image_count: images });
  }
  return pages;
}
async function extractPptx(buf) {
  const zip = await window.JSZip.loadAsync(buf), names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  if (names.length > 400) throw new Error('عدد الشرائح يتجاوز 400.'); const pages = [];
  for (let i = 0; i < names.length; i++) {
    const xml = new DOMParser().parseFromString(await zip.files[names[i]].async('string'), 'application/xml'); const paras = [];
    xml.querySelectorAll('p, a\\:p').forEach((p) => { const t = [...p.getElementsByTagName('a:t')].map((x) => x.textContent).join('').trim(); if (t) paras.push(t); });
    const images = xml.getElementsByTagName('p:pic').length + xml.getElementsByTagName('c:chart').length;
    pages.push({ page_no: i + 1, text: clean([...new Set(paras.length ? paras : [])].length === paras.length ? paras.join('\n') : paras.join('\n')), image_count: images });
  }
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
    quality: { ok: ps.filter((p) => p.status === 'ok').length, low_text: by('low_text'), image_only: by('image_only'), empty: by('empty'), garbled: by('garbled'), figures_unread: ps.filter((p) => p.image_count && p.status === 'ok').map((p) => p.page_no) } };
  if (withPages) out.pages = ps; return out;
}
async function loadSource(sources) {
  const pages = [], excluded = [];
  for (let di = 0; di < sources.length; di++) { const s = sources[di]; const d = await getDoc(K.doc(s.document_id)); if (!d) throw new Error('ملف غير موجود.'); if (d.status !== 'ready') throw new Error(`الملف «${d.title}» لم تكتمل معالجته.`);
    const wanted = parseSpec(s.pages, d.page_count); const usable = wanted.filter((no) => { const meta = d.pages.find((p) => p.page_no === no); return meta && ['ok', 'low_text'].includes(meta.status); });
    const texts = await getMany(usable.map((no) => K.page(d.id, no)));
    for (const no of wanted) { const meta = d.pages.find((p) => p.page_no === no); const ref = `d${di + 1}p${no}`;
      if (!meta || !['ok', 'low_text'].includes(meta.status)) { excluded.push({ ref, document: d.title, page: no, status: meta ? meta.status : 'missing', reason: (meta && meta.notes) || 'غير مقروءة' }); continue; }
      const pg = texts[K.page(d.id, no)]; pages.push({ ref, doc_id: d.id, doc_title: d.title, page_no: no, text: pg ? pg.text : '', status: meta.status }); } }
  return { pages, excluded };
}
const typeSupportOut = (heur, field) => Object.fromEntries(E.ORDER.map((c) => [c, { label: E.QT[c][0], level: heur[c].level, missing: heur[c].missing }]));

// ---------------------------------------------------------------- quizzes
const JOBS = new Map(); // quiz id -> {stage,pct}
const LOCAL_LABEL = 'محلي (بدون ذكاء اصطناعي)';
const QDEF = { generator: 'claude', count: 20, difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only', create_cards: false };
async function quizOut(q, full) {
  if (['analyzing', 'generating'].includes(q.status) && !JOBS.has(q.id)) { q.status = 'failed'; q.error = 'انقطعت المعالجة لأن الصفحة أُغلقت. أعد المحاولة (ابقَ في الصفحة أثناء التوليد).'; await putDoc(K.quiz(q.id), q); }
  const prog = JOBS.get(q.id) || { stage: q.progress_stage, pct: q.progress_pct || 0 };
  const o = { id: q.id, title: q.title, status: q.status, settings: q.settings, error: q.error, is_demo: false, generator: q.generator, fallback: q.fallback || null, progress: prog, created_at: q.created_at, updated_at: q.updated_at, scoring: SCORING };
  if (q.report) { o.report = q.report; o.question_count = q.report.delivered; }
  if (full) { o.plan = q.plan || null; if (q.analysis) o.analysis = { lecture_character: q.analysis.lecture_character, gaps: q.analysis.gaps, discipline_guess: q.analysis.discipline_guess, excluded_pages: q.analysis.excluded_pages, heuristic_support: q.analysis.heuristic_support, diagnostics: q.analysis.diagnostics, fallback: q.analysis.fallback,
      objectives: q.analysis.objectives.map((x) => ({ id: x.id, statement: x.statement, pages: x.pages, types: Object.keys(x.supports) })) }; o.source_preview = q.source_preview; }
  return o;
}
async function touch(q) { q.updated_at = nowS(); await putDoc(K.quiz(q.id), q); }
/** Say WHAT was found and what to do, instead of a dead-end sentence. */
const srcStats = (pages) => ({ pages: pages.length, words: pages.reduce((n, p) => n + String(p.text || '').split(/\s+/).filter(Boolean).length, 0) });
function noObjectivesMessage(generator, d) {
  if (generator === 'rules') return `لم يجد التوليد المحلي ما يكفي لبناء أسئلة في هذا النطاق (${d.pages} صفحة، نحو ${d.words} كلمة؛ وُجد ${d.defs} تعريفًا و${d.lists} قائمة و${d.cloze} جملة صالحة لإكمال الفراغ). هذا الوضع يحتاج جملًا كاملة أو تعريفات بصيغة «مصطلح: شرح» أو قوائم تحت عنوان. جرّب نطاقًا أوسع، أو اربط ذكاءً اصطناعيًا ليفهم الملف مهما كانت صياغته.`;
  return `النص المقروء في هذا النطاق قليل جدًا لبناء أهداف (${d.pages} صفحة، نحو ${d.words} كلمة). وسّع نطاق الصفحات، أو تأكد أن الملف نصي لا صور ممسوحة.`;
}
/** Analyse the lecture and build the plan. With `auto` the same job carries on to generation (nobody confirms a plan; a smaller
 *  count is accepted and the shortfall is reported on the finished quiz, never padded). */
async function jobAnalyse(id, auto) {
  const q = await getDoc(K.quiz(id)); JOBS.set(id, { stage: 'reading_source', pct: 10 }); let chain = false, fb = null;
  try {
    const src = await loadSource(q.settings.sources); if (!src.pages.length) throw new Error('لا توجد صفحات مقروءة في النطاق المختار.');
    const heur = E.support(src.pages.map((p) => p.text), q.settings.field); JOBS.set(id, { stage: 'analyzing_lecture', pct: 30 });
    const rules = q.settings.generator === 'rules';
    const analysis = rules ? E.rules.analyse(src.pages) : await E.analyse(llm, src.pages, q.settings);
    if (!analysis.objectives.length) { const d = rules ? E.rules.diagnose(src.pages) : srcStats(src.pages); analysis.diagnostics = d; q.analysis = analysis; q.status = 'insufficient'; q.error = noObjectivesMessage(q.settings.generator, d); return; }
    if (E.detectField && analysis.discipline_guess && (analysis.discipline_guess in { health: 1, science: 1, engineering: 1, cs: 1, math: 1, business: 1, law: 1, humanities: 1 })) q.settings.field = analysis.discipline_guess;
    q.plan = E.buildPlan(analysis, q.settings, heur); analysis.heuristic_support = heur; analysis.excluded_pages = src.excluded; q.analysis = analysis; q.error = null;
    chain = !!(auto && q.plan.feasible_count > 0);
    q.status = chain ? 'generating' : 'planned'; q.progress_pct = chain ? 5 : 100; q.progress_stage = chain ? 'drafting' : 'planned';   // straight to 'generating': the UI never sees a 'planned' flicker
  } catch (e) { if (q.settings.generator === 'claude' && E.rules && aiUnavailable(e)) fb = e; else { q.status = 'failed'; q.error = (e.code === 'not_granted' ? 'لم تُمنح صلاحية استخدام Claude.' : e.message) || String(e); } }
  finally { if (!chain && !fb) JOBS.delete(id); await touch(q); }
  if (fb) return switchToLocal(id, fb, auto);
  if (chain) await jobGenerate(id);          // JOBS keeps the id the whole time, so the quiz stays "busy" between the two phases
}
/** Is the AI itself unavailable (down, unreachable, out of credit, not allowed) — as opposed to something about the file? Then the site still delivers:
 *  the quiz is rebuilt locally (no key, no AI) and says so. Whoever pays for the AI never takes the whole site down with an empty balance. */
const aiUnavailable = (e) => !!e && (e.fallback === true || ['not_granted', 'network', 'auth', 'rate_limited', 'keys_invalid', 'bad_request', 'llm_not_configured', 'llm_error'].includes(e.code)
  || /HTTP (4\d\d|5\d\d)|تعذّر الاتصال|فشل استدعاء|credit balance/i.test(String(e.message || '')));
async function switchToLocal(id, err, auto) {
  const q = await getDoc(K.quiz(id)); q.settings.generator = 'rules'; q.fallback = { from: 'claude', reason: String((err && err.message) || err || '').slice(0, 240) };
  q.plan = null; q.analysis = null; q.questions = undefined; q.report = undefined; q.error = null; q.status = 'analyzing'; q.progress_stage = 'reading_source'; q.progress_pct = 10; await touch(q);
  await jobAnalyse(id, auto);
}
function assignOptions(c, targetPos, rnd) {
  const opts = c.options.map((t) => ({ id: 'o' + rid().slice(0, 8), text: t })); const key = opts[c.correct_index]; const others = opts.filter((o) => o !== key);
  for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; } others.splice(targetPos, 0, key); return [others, key.id];
}
async function jobGenerate(id) {
  const q = await getDoc(K.quiz(id)); JOBS.set(id, { stage: 'drafting', pct: 5 }); let fb = null;
  try {
    const src = await loadSource(q.settings.sources);
    const prog = (s, p) => JOBS.set(id, { stage: s, pct: p }); const rules = q.settings.generator === 'rules'; const want = q.plan.requested; const res = rules ? await E.rules.generate(q.plan, src.pages, q.settings, prog) : await E.generateToCount(llm, q.plan, src.pages, q.settings, prog, { concurrency: H.concurrency || 1 });
    if (!rules && !res.accepted.length && E.rules) { const bad = (res.dropped || []).find((d) => (d.reasons || []).some((r) => /^خطأ في خدمة التوليد/.test(r))); if (bad) throw Object.assign(new Error(bad.reasons[0]), { fallback: true }); }   // every model call failed: not the file's fault
    // still short after the AI's top-up rounds (a thin lecture, or questions it could not make verifiable): the local generator makes up the rest from the lecture's own lines
    if (!rules && res.accepted.length < want && E.rules) { const f = await E.rules.fill(q.plan, res.accepted, want - res.accepted.length, src.pages, q.settings, prog); res.accepted.push(...f.accepted); res.dropped.push(...f.dropped); for (const k in f.stats) res.stats[k] = (res.stats[k] || 0) + f.stats[k]; res.stats.local_filled = f.accepted.length; }
    if (res.accepted.length >= want) res.dropped.forEach((d) => { d.replaced = true; });
    const acc = E.orderQuestions(res.accepted.slice(0, want)); const pos = acc.map((_, i) => i % 4); const rnd = Math.random; pos.sort(() => rnd() - .5);
    const labelOf = (r) => { const p = src.pages.find((x) => x.ref === r); return p ? { doc_id: p.doc_id, doc_title: p.doc_title, page: p.page_no, page_no: p.page_no, ref: r } : { ref: r }; };
    q.questions = acc.map((c, i) => { const [opts, key] = assignOptions(c, pos[i], rnd); const ev = c.evidence.map((e) => ({ ...e, ...labelOf(e.page) })); const minor = (c.issues || []).filter((x) => x.severity === 'minor');
      return { id: rid(), position: i + 1, qtype: c.qtype, type_label: E.QT[c.qtype][0], task: c.task, objective: c.objective, difficulty: c.difficulty, stem: c.stem, options: opts, correct_option_id: key, explanation: c.explanation, purpose: c.purpose,
        source_pages: [...new Set(ev.map((e) => e.page_no).filter(Boolean))].sort((a, b) => a - b), evidence: ev, version: 1, review_status: minor.length ? 'flagged' : 'machine_verified', validation: { issues: c.issues || [], verified: { static: true, blind_solver: !rules }, objective_id: c.objective_id }, prompt_version: rules ? 'rules-1.0' : 'web-p1.0' }; });
    const planned = Object.entries(q.plan.distribution).filter(([, n]) => n).map(([t]) => t), by = Object.fromEntries(E.ORDER.map((t) => [t, q.questions.filter((x) => x.qtype === t).length])); const objDone = new Set(acc.map((c) => c.objective_id));
    q.report = { requested: q.plan.requested, planned: q.plan.feasible_count, delivered: q.questions.length, by_type: by, identity_coverage: { numerator: planned.filter((t) => by[t]).length, denominator: planned.length, definition: 'أنواع الهوية المخطط لها التي سُلّم منها سؤال واحد على الأقل.' },
      objective_coverage: { numerator: objDone.size, denominator: q.analysis.objectives.length, definition: 'أهداف المصدر التي غطاها سؤال مُسلَّم واحد على الأقل.' }, dropped: res.dropped, stats: res.stats, excluded_pages: src.excluded, unsupported_types: q.plan.unsupported_types,
      flagged: q.questions.filter((x) => x.review_status === 'flagged').length, extra: acc.filter((c) => c.extra).length, local_filled: rules ? 0 : acc.filter((c) => c.local).length,
      shortfall: acc.length < want ? { requested: want, possible: acc.length, reason: 'نص هذا النطاق قصير جدًا: استُنفدت كل الصياغات الممكنة منه دون تكرار حرفي لسؤال.', suggestions: ['لزيادة العدد: وسّع نطاق الصفحات أو أضف لكتشرًا آخر.'] } : q.plan.shortfall, generator: rules ? LOCAL_LABEL : H.generatorLabel, prompt_version: rules ? 'rules-1.0' : 'web-p1.0' };
    const allLocal = !rules && acc.length > 0 && acc.every((c) => c.local);      // the AI contributed no usable question: this IS a local quiz, and it says so
    if (allLocal) { q.settings.generator = 'rules'; q.fallback = { from: 'claude', reason: 'لم ينتج الذكاء الاصطناعي أي سؤال اجتاز التحقق من المصدر' }; q.report.generator = LOCAL_LABEL; q.report.prompt_version = 'rules-1.0'; }
    q.generator = rules || allLocal ? LOCAL_LABEL : H.generatorLabel; q.status = q.questions.length ? 'ready' : 'insufficient'; q.error = q.questions.length ? null : 'لم ينجح أي سؤال في اجتياز التحقق.'; q.progress_pct = 100;
  } catch (e) { if (q.settings.generator === 'claude' && E.rules && aiUnavailable(e)) fb = e; else { q.status = 'failed'; q.error = (e.code === 'not_granted' ? 'لم تُمنح صلاحية استخدام Claude.' : e.message) || String(e); } }
  finally { if (!fb) JOBS.delete(id); await touch(q); }
  if (fb) return switchToLocal(id, fb, true);
}

// ---------------------------------------------------------------- attempts
const qStateItem = (x, ans, reveal, i) => { const it = { id: x.id, position: i + 1, qtype: x.qtype, type_label: x.type_label, stem: x.stem, options: [], selected_option_id: ans.sel || null, flagged: !!ans.flag, answered: !!ans.sel, source_pages: x.source_pages };
  if (reveal) Object.assign(it, { correct_option_id: x.correct_option_id, explanation: x.explanation, is_correct: ans.sel === x.correct_option_id, evidence: x.evidence }); return it; };
async function attState(a) {
  const q = await getDoc(K.quiz(a.quiz_id)); const by = Object.fromEntries(q.questions.map((x) => [x.id, x])); const sub = a.status === 'submitted', practice = a.mode === 'practice';
  const items = a.order.map((qid, i) => { const x = by[qid], ans = a.answers[qid] || {}; const it = qStateItem(x, ans, sub || (practice && ans.revealed), i); it.options = a.optOrder[qid].map((id) => x.options.find((o) => o.id === id)); return it; });
  const score = items.filter((i) => i.is_correct).length;
  return { id: a.id, quiz_id: q.id, quiz_title: q.title, mode: a.mode, status: a.status, current_index: a.idx, elapsed_seconds: a.elapsed || 0, time: { limit: a.timer, remaining: a.timer ? Math.max(0, a.timer - Math.floor(nowS() - a.started)) : null },
    score: sub ? score : null, max_score: sub ? items.length : null, questions: items, scoring: SCORING, answered: items.filter((i) => i.answered).length, total: items.length, generator: q.generator, is_demo: false, started_at: a.started, submitted_at: a.submittedAt };
}
const attRow = async (a) => { const s = await attState(a); return { id: a.id, quiz_id: a.quiz_id, quiz_title: s.quiz_title, mode: a.mode, status: a.status, answered: s.answered, total: s.total, score: s.score, max_score: s.max_score, started_at: a.started, updated_at: a.updated, submitted_at: a.submittedAt }; };
async function expire(a) { if (a.status === 'in_progress' && a.mode === 'exam' && a.timer && nowS() - a.started > a.timer + 2) { a.status = 'submitted'; a.submittedAt = nowS(); a.updated = nowS(); await putDoc(K.att(a.id), a); } return a; }

// ---------------------------------------------------------------- cards
async function genCards(docId, b) {
  const d = await getDoc(K.doc(docId)); if (!d) return ER(404, 'not_found', 'الملف غير موجود.'); const local = !!b.rules || !(await platform()).aiAvailable; const src = await loadSource([{ document_id: docId, pages: b.pages }]); if (!src.pages.length) return ER(422, 'cards_error', 'لا توجد صفحات مقروءة في النطاق المختار.');
  const existing = (await listKind('card')).filter((c) => c.document_id === docId); const seen = existing.map((c) => E.toks(c.front)); const fps = new Set(existing.map((c) => E.norm(c.front)));
  let created = 0; const rej = { quote_missing: 0, duplicate: 0, empty: 0, error: 0 }; const n = b.count || 20;
  for (const chunk of (function* () { let cur = [], len = 0; for (const p of src.pages) { cur.push(p); len += p.text.length; if (len > 14000) { yield cur; cur = []; len = 0; } } if (cur.length) yield cur; })()) {
    const pages = Object.fromEntries(chunk.map((p) => [p.ref, p.text.slice(0, 5000)])); const per = Math.max(3, Math.round(n * 1.3 / Math.max(1, Math.ceil(src.pages.length / 8)))); let r;
    try { if (local) r = { cards: E.rules.cards(chunk, n * 2) }; else { const [s, p] = E.P.cards(pages, per, b.language); r = await llm.json('cards', s, p); } } catch (e) { rej.error++; continue; }
    for (const c of r.cards || []) { if (created >= n) break; const front = String(c.front || '').trim(), back = String(c.back || '').trim();
      if (front.length < 8 || back.length < 2) { rej.empty++; continue; } if (!pages[c.page] || !E.quoteIn(c.quote || '', pages[c.page])) { rej.quote_missing++; continue; }
      const ft = E.toks(front); if (fps.has(E.norm(front)) || seen.some((t) => E.jac(ft, t) >= .7)) { rej.duplicate++; continue; } fps.add(E.norm(front)); seen.push(ft);
      const id = rid(); await putDoc(K.card(id), { kind: 'card', id, document_id: docId, front, back, source_page: chunk.find((p) => p.ref === c.page).page_no, evidence: String(c.quote).slice(0, 300), state: 'new', times_known: 0, times_review: 0, due_at: null, interval_days: 0, generator: local ? 'rules' : H.generatorLabel, created_at: nowS() }); created++; }
  }
  return J({ created, requested: n, rejected: rej, excluded_pages: src.excluded });
}

// ---------------------------------------------------------------- router
async function handle(method, path, qs, init) {
  const pl = await platform(); let b = {}; let m;
  if (init && init.body && !(init.body instanceof FormData)) { try { b = JSON.parse(init.body); } catch { /* ignore */ } }
  const me = pl.user || null;
  const R = (o) => (o instanceof Response ? o : J(o.body === undefined ? { ok: true } : o.body, o.status || 200));
  const A = H.auth || {};
  const UNAUTH = () => ER(401, 'unauthenticated', 'سجّل الدخول للمتابعة.');
  if (path === '/api/auth/capabilities') return J({ password_reset: false, llm: true, rules_mode: true, claude_ok: !!pl.aiAvailable, ai_missing: H.aiMissingMessage || '', registration: 'open', llm_is_test: false, ...(H.capabilities ? await H.capabilities(pl) : {}) });
  if (path === '/api/auth/me') return me ? J(me) : UNAUTH();
  const authName = (path.match(/^\/api\/auth\/(login|register|logout|forgot|reset|password|delete)$/) || [])[1];
  if (authName) {
    if (A[authName]) { const r = R(await A[authName](b, pl)); if (['login', 'register', 'logout', 'delete', 'reset'].includes(authName)) cache.clear(); return r; }
    if (authName === 'login' || authName === 'register') return me ? J(me) : UNAUTH();
    if (authName === 'logout') return J({ ok: true });
    return ER(503, 'unavailable', 'غير متاح في هذه النسخة.');
  }
  if (path.startsWith('/api/auth/')) return ER(404, 'not_found', 'غير متاح.');
  if (H.requireAuth && !me) return UNAUTH();
  if (H.handle) { const r = await H.handle(method, path, qs, b, init, pl); if (r) return R(r); }
  if (path === '/api/events') return J({ ok: true });
  if (path === '/api/reports') { const id = rid(); await putDoc('report_' + id, { kind: 'report', id, ...b, status: 'open', created_at: nowS() }); return J({ id }); }

  // documents
  if (path === '/api/documents' && method === 'POST') {
    const f = init.body.get('file'); if (!f) return ER(422, 'validation', 'لا يوجد ملف.'); const name = f.name || 'file', lower = name.toLowerCase(); const buf = await f.arrayBuffer(); const head = new Uint8Array(buf.slice(0, 4)); const sig = String.fromCharCode(...head);
    const kind = sig.startsWith('%PDF') && lower.endsWith('.pdf') ? 'pdf' : sig.startsWith('PK') && lower.endsWith('.pptx') ? 'pptx' : null; if (!kind) return ER(415, 'unsupported_type', 'الملف غير مدعوم أو تالف. المدعوم: PDF وPPTX فقط.');
    if (buf.byteLength > 25 * 1024 * 1024) return ER(413, 'too_large', 'الحجم يتجاوز 25MB في هذه النسخة.');
    const id = rid(); let pages; try { pages = kind === 'pdf' ? await extractPdf(buf) : await extractPptx(buf); } catch (e) { return ER(422, 'extract_failed', 'تعذّرت قراءة الملف: ' + e.message); }
    stripBoiler(pages); const meta = [];
    const pageRows = []; for (const p of pages) { const [status, notes] = classify(p.text, p.image_count); meta.push({ page_no: p.page_no, status, char_count: p.text.length, notes: notes.join(' '), image_count: p.image_count, snippet: p.text.slice(0, 160) }); pageRows.push([K.page(id, p.page_no), { kind: 'page', doc: id, page_no: p.page_no, text: p.text }]); } await putMany(pageRows);
    const usable = meta.filter((p) => ['ok', 'low_text'].includes(p.status)).length;
    const d = { kind: 'doc', id, title: ((init.body.get('title') || name.replace(/\.[^.]+$/, '')) + '').slice(0, 120) || 'ملف', filename: name.slice(0, 200), kind_: kind, status: usable ? 'ready' : 'unreadable', error: usable ? null : 'لم يُستخرج أي نص قابل للقراءة (قد يكون ممسوحًا ضوئيًا). OCR غير مفعّل.', page_count: pages.length, pages: meta, created_at: nowS() };
    await putDoc(K.doc(id), d); return J(docSummary(d));
  }
  if (path === '/api/documents') return J((await listKind('doc')).sort((a, b) => b.created_at - a.created_at).map((d) => docSummary(d)));
  if ((m = path.match(/^\/api\/documents\/(\w+)\/pages\/(\d+)$/))) { const d = await getDoc(K.doc(m[1])); if (!d) return ER(404, 'not_found', 'الملف غير موجود.'); const p = await getDoc(K.page(m[1], +m[2])); const meta = d.pages.find((x) => x.page_no === +m[2]); return p ? J({ page_no: +m[2], text: p.text, status: meta.status, notes: meta.notes, image_count: meta.image_count }) : ER(404, 'not_found', 'الصفحة غير موجودة.'); }
  if ((m = path.match(/^\/api\/documents\/(\w+)\/cards\/generate$/))) return genCards(m[1], b);
  if ((m = path.match(/^\/api\/documents\/(\w+)$/))) { const d = await getDoc(K.doc(m[1])); if (!d) return ER(404, 'not_found', 'الملف غير موجود.');
    if (method === 'DELETE') { await delMany([...d.pages.map((p) => K.page(d.id, p.page_no)), K.doc(d.id)]); return J({ ok: true }); } if (method === 'PATCH') { if (b.title) d.title = String(b.title).slice(0, 120); await putDoc(K.doc(d.id), d); } return J(docSummary(d, true)); }

  // quizzes
  if (path === '/api/quizzes/options') return J({ counts: [10, 20, 30], default_count: 20, difficulty: { easy: 'سهلة', medium: 'متوسطة', hard: 'متقدمة', mixed: 'متنوعة' }, focus: { balanced: 'متوازن', understand_apply: 'فهم وتطبيق', critical: 'تفكير نقدي', recall: 'استرجاع' }, types: Object.fromEntries(E.ORDER.map((c) => [c, { ar: E.QT[c][0], en: c }])), scoring: SCORING });
  if (path === '/api/quizzes' && method === 'POST') {
    const st = { ...QDEF, ...(b.settings || {}) }; st.count = Math.max(5, Math.min(60, +st.count || 20)); st.generator = !pl.aiAvailable || st.generator === 'rules' ? 'rules' : 'claude'; if (!(b.sources || []).length) return ER(422, 'validation', 'اختر ملفًا.');
    let src; try { src = await loadSource(b.sources); } catch (e) { return ER(422, 'source_error', e.message); }
    if (!src.pages.length) return ER(422, 'no_readable_pages', 'لا توجد صفحات مقروءة في النطاق المختار.', { excluded: src.excluded });
    st.sources = b.sources.map((s) => ({ document_id: s.document_id, pages: s.pages || null })); st.field = E.detectField(src.pages.map((p) => p.text).join(' ')); const heur = E.support(src.pages.map((p) => p.text), st.field);
    const id = rid(); const doc = await getDoc(K.doc(b.sources[0].document_id));
    const q = { kind: 'quiz', id, title: (b.title || doc.title).slice(0, 120), settings: st, status: 'draft', created_at: nowS(), updated_at: nowS(), progress_pct: 0, source_preview: { readable_pages: src.pages.length, excluded_pages: src.excluded, words: heur._meta.words, type_support: typeSupportOut(heur) } };
    await putDoc(K.quiz(id), q); return J(await quizOut(q, true));
  }
  if (path === '/api/quizzes') return J(await Promise.all((await listKind('quiz')).sort((a, b) => b.created_at - a.created_at).map((q) => quizOut(q))));
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/(analyze|generate)$/))) {
    const q = await getDoc(K.quiz(m[1])); if (!q) return ER(404, 'not_found', 'الكويز غير موجود.'); if (!pl.aiAvailable && q.settings.generator !== 'rules') return ER(503, 'llm_not_configured', H.aiMissingMessage);
    if (JOBS.has(q.id)) return ER(409, 'busy', 'المعالجة جارية بالفعل.');
    if (m[2] === 'analyze') { if (q.status === 'ready') return ER(409, 'already_ready', 'الكويز جاهز بالفعل (ومحاولاتك مرتبطة بأسئلته). أنشئ كويزًا جديدًا.'); JOBS.set(q.id, { stage: 'queued', pct: 0 }); q.status = 'analyzing'; q.error = null; await touch(q); jobAnalyse(q.id, !!b.auto_generate); return J({ ok: true }); }
    if (q.status === 'ready') return ER(409, 'already_ready', 'الكويز جاهز بالفعل؛ أنشئ كويزًا جديدًا.'); if (!['planned', 'failed', 'insufficient'].includes(q.status) || !q.plan) return ER(409, 'not_planned', 'حلّل المحتوى وأكّد الخطة أولًا.');
    if (!q.plan.feasible_count) return ER(409, 'nothing_feasible', 'المصدر لا يدعم أي سؤال؛ وسّع المصدر.');
    if (q.plan.feasible_count < q.plan.requested && !b.accept_reduced) return ER(409, 'shortfall', `المصدر يدعم ${q.plan.feasible_count} سؤالًا فقط من أصل ${q.plan.requested}. وافق على العدد الأقل أو وسّع المصدر.`, { shortfall: q.plan.shortfall });
    JOBS.set(q.id, { stage: 'queued', pct: 0 }); q.status = 'generating'; q.error = null; await touch(q); jobGenerate(q.id); return J({ ok: true });
  }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/questions$/))) { const q = await getDoc(K.quiz(m[1])); return q ? J(q.questions || []) : ER(404, 'not_found', 'الكويز غير موجود.'); }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/attempts$/))) {
    const q = await getDoc(K.quiz(m[1])); if (!q || q.status !== 'ready') return ER(409, 'not_ready', 'الكويز غير جاهز.'); let order = q.questions.map((x) => x.id); if (b.only_question_ids) order = order.filter((x) => b.only_question_ids.includes(x));
    if (b.shuffle_questions) order.sort(() => Math.random() - .5); const optOrder = {}; q.questions.forEach((x) => { const ids = x.options.map((o) => o.id); if (b.shuffle_options !== false && q.settings.shuffle_options !== false) ids.sort(() => Math.random() - .5); optOrder[x.id] = ids; });
    const tm = b.timer_minutes != null ? b.timer_minutes : q.settings.timer_minutes; const a = { kind: 'attempt', id: rid(), quiz_id: q.id, mode: b.mode || q.settings.mode || 'practice', order, optOrder, answers: {}, idx: 0, elapsed: 0, status: 'in_progress', started: nowS(), updated: nowS(), timer: tm ? tm * 60 : null };
    await putDoc(K.att(a.id), a); return J(await attState(a));
  }
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/pdf$/))) return ER(501, 'pdf_unavailable', H.pdfMessage || 'تنزيل PDF غير متاح في هذه النسخة.');
  if ((m = path.match(/^\/api\/quizzes\/(\w+)$/))) { const q = await getDoc(K.quiz(m[1])); if (!q) return ER(404, 'not_found', 'الكويز غير موجود.');
    if (method === 'DELETE') { for (const a of (await listKind('attempt')).filter((x) => x.quiz_id === q.id)) await delDoc(K.att(a.id)); await delDoc(K.quiz(q.id)); return J({ ok: true }); }
    if (method === 'PATCH') {
      if (b.title) q.title = String(b.title).slice(0, 120);
      if (b.settings && ['claude', 'rules'].includes(b.settings.generator) && !JOBS.has(q.id) && q.status !== 'ready') { q.settings.generator = b.settings.generator; q.status = 'draft'; q.plan = null; q.analysis = null; q.error = null; }
      await touch(q); return J({ ok: true }); } return J(await quizOut(q, true)); }

  // attempts
  if (path === '/api/attempts' && method === 'GET') { let l = await listKind('attempt'); if (qs.get('quiz_id')) l = l.filter((a) => a.quiz_id === qs.get('quiz_id')); l = await Promise.all(l.map(expire)); if (qs.get('status')) l = l.filter((a) => a.status === qs.get('status'));
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
    if (act === '/position') { if (a.status === 'submitted') return J({ saved: false, status: 'submitted' }); a.idx = Math.min(b.index, a.order.length - 1); a.elapsed = Math.max(a.elapsed, b.elapsed_seconds); a.updated = nowS(); await putDoc(K.att(a.id), a); return J({ saved: true, saved_at: nowS() }); }
    if (act === '/submit') { if (a.status !== 'submitted') { a.status = 'submitted'; a.submittedAt = nowS(); a.updated = nowS(); await putDoc(K.att(a.id), a); } return J(await attState(a)); }
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
  if (path.startsWith('/api/admin')) return ER(403, 'forbidden', 'الإدارة غير متاحة في هذه النسخة.');
  return ER(404, 'not_found', 'غير متاح.');
}
window.fetch = (url, init = {}) => { const u = new URL(typeof url === 'string' ? url : url.url, location.href); const i = u.pathname.indexOf('/api/'); if (i < 0) return realFetch(url, init);
  return handle((init.method || 'GET').toUpperCase(), u.pathname.slice(i), u.searchParams, init).catch((e) => ER(500, 'client_error', e.message || String(e))); };

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
window.QZ_API = { handle, platform, resetCache: () => cache.clear(), exportData };
})();
