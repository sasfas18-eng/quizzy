/* Quizzy — browser "server" core. Implements the /api/* contract the UI uses, entirely in the page:
 * extraction (pdf.js/JSZip) · planning/validation engine (engine.js) · quizzes, attempts, cards.
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
function classify(text, images, p = {}) {
  const n = text.length; if (n) { const bad = [...text].filter((c) => c === '\ufffd' || (c >= '\u0000' && c < ' ' && c !== '\n' && c !== '\t')).length; if (bad / n > .15) return ['garbled', ['النص المستخرج تالف' + (p.ocr_tried ? ' والقراءة الضوئية لم تنجح.' : '؛ قد تحتاج الصفحة إلى OCR.')]]; }
  const ocrNote = 'قُرئ نص الصور بالتعرف الضوئي (OCR) وقد يحوي أخطاء بسيطة، فتُعلَّم الأسئلة المبنية عليه.';
  const partial = p.ocr && (p.ocr_rejected || 0) >= Math.max(2, p.ocr_lines || 0) ? ' ولم تُقرأ أسطر غير واضحة في الصفحة (قراءة جزئية).' : '';
  if (!n) return images ? ['image_only', [p.ocr_error && p.ocr_error !== 'skip' ? 'الصفحة صورة، وتعذّر تشغيل القراءة الضوئية في هذا المتصفح.' : p.ocr_tried ? 'الصفحة صورة ولم يُعثر فيها على نص مقروء حتى بالقراءة الضوئية.' : 'الصفحة صورة بلا نص قابل للاستخراج.']] : ['empty', ['صفحة فارغة.']];
  if (n < OK_MIN) return ['low_text', [p.ocr ? ocrNote + partial : (images ? 'نص قليل مع صور؛ محتوى الصور غير مقروء.' : 'نص قليل جدًا (قد تكون صفحة عنوان).')]];
  return ['ok', p.ocr ? [ocrNote + partial] : (images && !p.ocr_tried ? ['تحتوي على صور/أشكال لم تُقرأ؛ الأسئلة لن تعتمد عليها.'] : [])];
}
function stripBoiler(pages) {
  if (pages.length < 4) return; const cnt = new Map(); pages.forEach((p) => new Set(p.text.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 80).map((l) => l.replace(/\d+/g, '#'))).forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1)));
  const thr = Math.max(3, Math.floor(pages.length * .6)); const rep = new Set([...cnt].filter(([, v]) => v >= thr).map(([k]) => k)); if (!rep.size) return;
  pages.forEach((p) => (p.text = clean(p.text.split('\n').filter((l) => !(l.trim() && rep.has(l.trim().replace(/\d+/g, '#')))).join('\n'))));
}
const extractPdf = (buf, o) => window.QZ_READER.extractPdf(buf, o);
const extractPptx = (buf, o) => window.QZ_READER.extractPptx(buf, o);
function parseSpec(spec, total) {
  if (spec == null || spec === '' || (Array.isArray(spec) && !spec.length)) return Array.from({ length: total }, (_, i) => i + 1);
  const s = new Set(); if (Array.isArray(spec)) spec.forEach((x) => s.add(+x)); else for (const part of String(spec).trim().split(/[,،;\s]+/)) { if (!part) continue; const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let x = a; x <= b; x++) s.add(x); } else if (/^\d+$/.test(part)) s.add(+part); else throw new Error('نطاق صفحات غير صالح: ' + part); }
  const bad = [...s].filter((p) => p < 1 || p > total); if (bad.length) throw new Error(`صفحات خارج الملف (١–${total}): ${bad.slice(0, 5)}`); return [...s].sort((a, b) => a - b);
}
const DOCJOBS = new Map(); // doc id -> {phase,done,total} while a file is being read (text, tables, OCR)
function docSummary(d, withPages) {
  const ps = d.pages || []; const by = (st) => ps.filter((p) => p.status === st).map((p) => p.page_no);
  const out = { id: d.id, title: d.title, filename: d.filename, kind: d.kind_, status: d.status, error: d.error, page_count: d.page_count, created_at: d.created_at,
    progress: d.status === 'processing' ? (DOCJOBS.get(d.id) || null) : null,
    quality: { ok: ps.filter((p) => p.status === 'ok').length, low_text: by('low_text'), image_only: by('image_only'), empty: by('empty'), garbled: by('garbled'), figures_unread: ps.filter((p) => p.image_count && p.status === 'ok' && !p.ocr && !p.ocr_tried).map((p) => p.page_no),
      ocr_pages: ps.filter((p) => p.ocr).map((p) => p.page_no), table_pages: ps.filter((p) => p.tables).map((p) => p.page_no) } };
  if (withPages) out.pages = ps; return out;
}
async function loadSource(sources) {
  const pages = [], excluded = [];
  for (let di = 0; di < sources.length; di++) { const s = sources[di]; const d = await getDoc(K.doc(s.document_id)); if (!d) throw new Error('ملف غير موجود.'); if (d.status !== 'ready') throw new Error(`الملف «${d.title}» لم تكتمل معالجته.`);
    const wanted = parseSpec(s.pages, d.page_count); const usable = wanted.filter((no) => { const meta = d.pages.find((p) => p.page_no === no); return meta && ['ok', 'low_text'].includes(meta.status); });
    const texts = await getMany(usable.map((no) => K.page(d.id, no)));
    for (const no of wanted) { const meta = d.pages.find((p) => p.page_no === no); const ref = `d${di + 1}p${no}`;
      if (!meta || !['ok', 'low_text'].includes(meta.status)) { excluded.push({ ref, document: d.title, page: no, status: meta ? meta.status : 'missing', reason: (meta && meta.notes) || 'غير مقروءة' }); continue; }
      const pg = texts[K.page(d.id, no)]; pages.push({ ref, doc_id: d.id, doc_title: d.title, page_no: no, text: pg ? pg.text : '', status: meta.status, ocr: !!meta.ocr }); } }
  return { pages, excluded };
}
const typeSupportOut = (heur, field) => Object.fromEntries(E.ORDER.map((c) => [c, { label: E.QT[c][0], level: heur[c].level, missing: heur[c].missing }]));

// ---------------------------------------------------------------- quizzes
const JOBS = new Map(); // quiz id -> {stage,pct}
const QDEF = { count: 'auto', difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only', create_cards: false };
async function quizOut(q, full) {
  if (['analyzing', 'generating'].includes(q.status) && !JOBS.has(q.id)) { q.status = 'failed'; q.error = 'انقطعت المعالجة لأن الصفحة أُغلقت. أعد المحاولة (ابقَ في الصفحة أثناء التوليد).'; await putDoc(K.quiz(q.id), q); }
  const prog = JOBS.get(q.id) || { stage: q.progress_stage, pct: q.progress_pct || 0 };
  const o = { id: q.id, title: q.title, status: q.status, settings: q.settings, error: q.error, is_demo: false, generator: q.generator, progress: prog, created_at: q.created_at, updated_at: q.updated_at, scoring: SCORING };
  if (q.report) { o.report = q.report; o.question_count = q.report.delivered; }
  if (full) { o.plan = q.plan || null; if (q.analysis) o.analysis = { lecture_character: q.analysis.lecture_character, gaps: q.analysis.gaps, discipline_guess: q.analysis.discipline_guess, excluded_pages: q.analysis.excluded_pages, heuristic_support: q.analysis.heuristic_support, diagnostics: q.analysis.diagnostics, fallback: q.analysis.fallback,
      objectives: q.analysis.objectives.map((x) => ({ id: x.id, statement: x.statement, pages: x.pages, types: Object.keys(x.supports) })) }; o.source_preview = q.source_preview; }
  return o;
}
async function touch(q) { q.updated_at = nowS(); await putDoc(K.quiz(q.id), q); }
/** Say WHAT was found and what to do, instead of a dead-end sentence. */
const srcStats = (pages) => ({ pages: pages.length, words: pages.reduce((n, p) => n + String(p.text || '').split(/\s+/).filter(Boolean).length, 0) });
const noObjectivesMessage = (d) => `النص المقروء في هذا النطاق قليل جدًا لبناء أهداف (${d.pages} صفحة، نحو ${d.words} كلمة). وسّع نطاق الصفحات، أو تأكد أن الملف نصي لا صور ممسوحة.`;
/** Analyse the lecture and build the plan. With `auto` the same job carries on to generation (nobody confirms a plan; a smaller
 *  count is accepted and the shortfall is reported on the finished quiz, never padded). */
async function jobAnalyse(id, auto) {
  const q = await getDoc(K.quiz(id)); JOBS.set(id, { stage: 'reading_source', pct: 10 }); let chain = false;
  try {
    const src = await loadSource(q.settings.sources); if (!src.pages.length) throw new Error('لا توجد صفحات مقروءة في النطاق المختار.');
    const heur = E.support(src.pages.map((p) => p.text), q.settings.field); JOBS.set(id, { stage: 'analyzing_lecture', pct: 30 });
    const analysis = await E.analyse(llm, src.pages, q.settings);
    if (!analysis.objectives.length) { const d = srcStats(src.pages); analysis.diagnostics = d; q.analysis = analysis; q.status = 'insufficient'; q.error = noObjectivesMessage(d); return; }
    if (E.detectField && analysis.discipline_guess && (analysis.discipline_guess in { health: 1, science: 1, engineering: 1, cs: 1, math: 1, business: 1, law: 1, humanities: 1 })) q.settings.field = analysis.discipline_guess;
    q.plan = E.buildPlan(analysis, q.settings, heur); analysis.heuristic_support = heur; analysis.excluded_pages = src.excluded; q.analysis = analysis; q.error = null;
    chain = !!(auto && q.plan.feasible_count > 0);
    q.status = chain ? 'generating' : 'planned'; q.progress_pct = chain ? 5 : 100; q.progress_stage = chain ? 'drafting' : 'planned';   // straight to 'generating': the UI never sees a 'planned' flicker
  } catch (e) { q.status = 'failed'; q.error = (e.code === 'not_granted' ? 'لم تُمنح صلاحية استخدام Claude.' : e.message) || String(e); }
  finally { if (!chain) JOBS.delete(id); await touch(q); }
  if (chain) await jobGenerate(id);          // JOBS keeps the id the whole time, so the quiz stays "busy" between the two phases
}
function assignOptions(c, targetPos, rnd) {
  const opts = c.options.map((t) => ({ id: 'o' + rid().slice(0, 8), text: t })); const key = opts[c.correct_index]; const others = opts.filter((o) => o !== key);
  for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; } others.splice(targetPos, 0, key); return [others, key.id];
}
async function jobGenerate(id) {
  const q = await getDoc(K.quiz(id)); JOBS.set(id, { stage: 'drafting', pct: 5 });
  try {
    const src = await loadSource(q.settings.sources);
    const prog = (s, p) => JOBS.set(id, { stage: s, pct: p }); const res = await E.generate(llm, q.plan, src.pages, q.settings, prog, { concurrency: H.concurrency || 1 });
    const acc = res.accepted.sort((a, b) => a.slot - b.slot); const pos = acc.map((_, i) => i % 4); const rnd = Math.random; pos.sort(() => rnd() - .5);
    const labelOf = (r) => { const p = src.pages.find((x) => x.ref === r); return p ? { doc_id: p.doc_id, doc_title: p.doc_title, page: p.page_no, page_no: p.page_no, ref: r } : { ref: r }; };
    q.questions = acc.map((c, i) => { const [opts, key] = assignOptions(c, pos[i], rnd); const ev = c.evidence.map((e) => ({ ...e, ...labelOf(e.page) })); const ocrEv = ev.some((e) => src.pages.find((x) => x.ref === e.ref && x.ocr)); const minor = (c.issues || []).filter((x) => x.severity === 'minor').concat(ocrEv ? [{ code: 'ocr_source', severity: 'minor', message: 'مبني على نص مقروء ضوئيًا (OCR) وقد يحوي أخطاء بسيطة؛ راجع الصفحة الأصلية.' }] : []);
      return { id: rid(), position: i + 1, qtype: c.qtype, type_label: E.QT[c.qtype][0], task: c.task, objective: c.objective, difficulty: c.difficulty, stem: c.stem, options: opts, correct_option_id: key, explanation: c.explanation, purpose: c.purpose,
        source_pages: [...new Set(ev.map((e) => e.page_no).filter(Boolean))].sort((a, b) => a - b), evidence: ev, version: 1, review_status: minor.length ? 'flagged' : 'machine_verified', validation: { issues: (c.issues || []).concat(ocrEv ? minor.filter((x) => x.code === 'ocr_source') : []), verified: { static: true, blind_solver: true }, objective_id: c.objective_id }, prompt_version: 'web-p1.0' }; });
    const planned = Object.entries(q.plan.distribution).filter(([, n]) => n).map(([t]) => t), by = Object.fromEntries(E.ORDER.map((t) => [t, q.questions.filter((x) => x.qtype === t).length])); const objDone = new Set(acc.map((c) => c.objective_id));
    // lecture coverage: a page counts as covered when a delivered question belongs to an objective that spans it, or cites it as evidence
    const objById = Object.fromEntries(q.analysis.objectives.map((o) => [o.id, o])); const covRefs = new Set([...objDone].flatMap((id) => (objById[id] ? objById[id].pages : [])).concat(acc.flatMap((c) => c.evidence.map((e) => e.page))));
    const substantial = src.pages.filter((p) => p.text.trim().length >= 160), missingPages = substantial.filter((p) => !covRefs.has(p.ref));
    q.report = { requested: q.plan.requested, planned: q.plan.feasible_count, delivered: q.questions.length, by_type: by, identity_coverage: { numerator: planned.filter((t) => by[t]).length, denominator: planned.length, definition: 'أنواع الهوية المخطط لها التي سُلّم منها سؤال واحد على الأقل.' },
      objective_coverage: { numerator: objDone.size, denominator: q.analysis.objectives.length, definition: 'محاور المحاضرة التي غطاها سؤال مُسلَّم واحد على الأقل.' },
      page_coverage: { numerator: substantial.length - missingPages.length, denominator: substantial.length, missing: missingPages.map((p) => ({ document: p.doc_title, page: p.page_no })), definition: 'الصفحات ذات النص الحقيقي التي يغطيها سؤال مُسلَّم.' },
      uncovered_objectives: (res.uncovered_objectives || []).map((id) => (objById[id] || {}).statement).filter(Boolean), auto: !!q.plan.auto, coverage_partial: !!q.plan.coverage_partial, dropped: res.dropped, stats: res.stats, excluded_pages: src.excluded, unsupported_types: q.plan.unsupported_types,
      flagged: q.questions.filter((x) => x.review_status === 'flagged').length, shortfall: q.plan.shortfall, generator: H.generatorLabel, prompt_version: 'web-p1.0' };
    q.generator = H.generatorLabel; q.status = q.questions.length ? 'ready' : 'insufficient'; q.error = q.questions.length ? null : 'لم ينجح أي سؤال في اجتياز التحقق.'; q.progress_pct = 100;
  } catch (e) { q.status = 'failed'; q.error = (e.code === 'not_granted' ? 'لم تُمنح صلاحية استخدام Claude.' : e.message) || String(e); }
  finally { JOBS.delete(id); await touch(q); }
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
  const d = await getDoc(K.doc(docId)); if (!d) return ER(404, 'not_found', 'الملف غير موجود.'); if (!(await platform()).aiAvailable) return ER(503, 'llm_not_configured', H.aiMissingMessage); const src = await loadSource([{ document_id: docId, pages: b.pages }]); if (!src.pages.length) return ER(422, 'cards_error', 'لا توجد صفحات مقروءة في النطاق المختار.');
  const existing = (await listKind('card')).filter((c) => c.document_id === docId); const seen = existing.map((c) => E.toks(c.front)); const fps = new Set(existing.map((c) => E.norm(c.front)));
  let created = 0; const rej = { quote_missing: 0, duplicate: 0, empty: 0, error: 0 }; const n = b.count || 20;
  for (const chunk of (function* () { let cur = [], len = 0; for (const p of src.pages) { cur.push(p); len += p.text.length; if (len > 14000) { yield cur; cur = []; len = 0; } } if (cur.length) yield cur; })()) {
    const pages = Object.fromEntries(chunk.map((p) => [p.ref, p.text.slice(0, 5000)])); const per = Math.max(3, Math.round(n * 1.3 / Math.max(1, Math.ceil(src.pages.length / 8)))); let r;
    try { const [s, p] = E.P.cards(pages, per, b.language); r = await llm.json('cards', s, p); } catch (e) { rej.error++; continue; }
    for (const c of r.cards || []) { if (created >= n) break; const front = String(c.front || '').trim(), back = String(c.back || '').trim();
      if (front.length < 8 || back.length < 2) { rej.empty++; continue; } if (!pages[c.page] || !E.quoteIn(c.quote || '', pages[c.page])) { rej.quote_missing++; continue; }
      const ft = E.toks(front); if (fps.has(E.norm(front)) || seen.some((t) => E.jac(ft, t) >= .7)) { rej.duplicate++; continue; } fps.add(E.norm(front)); seen.push(ft);
      const id = rid(); await putDoc(K.card(id), { kind: 'card', id, document_id: docId, front, back, source_page: chunk.find((p) => p.ref === c.page).page_no, evidence: String(c.quote).slice(0, 300), state: 'new', times_known: 0, times_review: 0, due_at: null, interval_days: 0, generator: H.generatorLabel, created_at: nowS() }); created++; }
  }
  return J({ created, requested: n, rejected: rej, excluded_pages: src.excluded });
}

// ---------------------------------------------------------------- reading an uploaded lecture (background)
/** why nothing could be read, and what to do about it (never turn unclear pictures into text: wrong text would become wrong questions) */
function unreadableWhy(pages) {
  const bad = pages.find((p) => p.ocr_error && p.ocr_error !== 'skip');
  const why = bad ? 'تعذّر تشغيل القراءة الضوئية' + (bad.ocr_error === 'unavailable' ? ' (يلزم متصفح حديث)' : '') + '.'
    : pages.some((p) => p.ocr_tried) ? 'قرأنا الصور بالقراءة الضوئية لكن النص فيها غير واضح بما يكفي (دقة منخفضة أو ضجيج أو إمالة شديدة)، ولا نبني أسئلة على نص مشكوك فيه.'
      : 'لا يحتوي الملف على نص ولا على صور يمكن قراءتها.';
  return why + ' جرّب مسحًا أوضح (200–300 نقطة/بوصة) أو نسخة نصية من اللكتشر.';
}
async function readDoc(id, kind, buf) {
  const d = await getDoc(K.doc(id));
  try {
    const onProgress = (p) => DOCJOBS.set(id, p); const pages = kind === 'pdf' ? await extractPdf(buf, { onProgress }) : await extractPptx(buf, { onProgress });
    stripBoiler(pages); const meta = [], rows = [];
    for (const p of pages) { const [status, notes] = classify(p.text, p.image_count, p);
      meta.push({ page_no: p.page_no, status, char_count: p.text.length, notes: notes.join(' '), image_count: p.image_count, ocr: !!p.ocr, ocr_tried: !!p.ocr_tried, tables: p.tables || 0, snippet: p.text.slice(0, 160) });
      rows.push([K.page(id, p.page_no), { kind: 'page', doc: id, page_no: p.page_no, text: p.text }]); }
    await putMany(rows); const usable = meta.filter((p) => ['ok', 'low_text'].includes(p.status)).length;
    Object.assign(d, { status: usable ? 'ready' : 'unreadable', error: usable ? null : unreadableWhy(pages), page_count: pages.length, pages: meta });
  } catch (e) { d.status = 'failed'; d.error = 'تعذّرت قراءة الملف: ' + (e.message || e); }
  await putDoc(K.doc(id), d); DOCJOBS.delete(id);
}
async function checkDoc(d) { if (d && d.status === 'processing' && !DOCJOBS.has(d.id)) { d.status = 'failed'; d.error = 'انقطعت قراءة الملف لأن الصفحة أُغلقت. أعد رفعه.'; await putDoc(K.doc(d.id), d); } return d; }

// ---------------------------------------------------------------- router
async function handle(method, path, qs, init) {
  const pl = await platform(); let b = {}; let m;
  if (init && init.body && !(init.body instanceof FormData)) { try { b = JSON.parse(init.body); } catch { /* ignore */ } }
  const me = pl.user || null;
  const R = (o) => (o instanceof Response ? o : J(o.body === undefined ? { ok: true } : o.body, o.status || 200));
  const A = H.auth || {};
  const UNAUTH = () => ER(401, 'unauthenticated', 'سجّل الدخول للمتابعة.');
  if (path === '/api/auth/capabilities') return J({ password_reset: false, llm: true, claude_ok: !!pl.aiAvailable, ai_missing: H.aiMissingMessage || '', registration: 'open', llm_is_test: false, ...(H.capabilities ? await H.capabilities(pl) : {}) });
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
    // the file is read in the BACKGROUND (text, tables, speaker notes, charts and the text inside images by OCR) while the UI shows progress
    const id = rid(); const d = { kind: 'doc', id, title: ((init.body.get('title') || name.replace(/\.[^.]+$/, '')) + '').slice(0, 120) || 'ملف', filename: name.slice(0, 200), kind_: kind, status: 'processing', error: null, page_count: 0, pages: [], created_at: nowS() };
    await putDoc(K.doc(id), d); DOCJOBS.set(id, { phase: 'text', done: 0, total: 0 }); readDoc(id, kind, buf); return J(docSummary(d));
  }
  if (path === '/api/documents') return J((await Promise.all((await listKind('doc')).map(checkDoc))).sort((a, b) => b.created_at - a.created_at).map((d) => docSummary(d)));
  if ((m = path.match(/^\/api\/documents\/(\w+)\/pages\/(\d+)$/))) { const d = await getDoc(K.doc(m[1])); if (!d) return ER(404, 'not_found', 'الملف غير موجود.'); const p = await getDoc(K.page(m[1], +m[2])); const meta = d.pages.find((x) => x.page_no === +m[2]); return p ? J({ page_no: +m[2], text: p.text, status: meta.status, notes: meta.notes, image_count: meta.image_count }) : ER(404, 'not_found', 'الصفحة غير موجودة.'); }
  if ((m = path.match(/^\/api\/documents\/(\w+)\/cards\/generate$/))) return genCards(m[1], b);
  if ((m = path.match(/^\/api\/documents\/(\w+)$/))) { const d = await checkDoc(await getDoc(K.doc(m[1]))); if (!d) return ER(404, 'not_found', 'الملف غير موجود.');
    if (method === 'DELETE') { await delMany([...d.pages.map((p) => K.page(d.id, p.page_no)), K.doc(d.id)]); return J({ ok: true }); } if (method === 'PATCH') { if (b.title) d.title = String(b.title).slice(0, 120); await putDoc(K.doc(d.id), d); } return J(docSummary(d, true)); }

  // quizzes
  if (path === '/api/quizzes/options') return J({ counts: [10, 20, 30], default_count: 20, difficulty: { easy: 'سهلة', medium: 'متوسطة', hard: 'متقدمة', mixed: 'متنوعة' }, focus: { balanced: 'متوازن', understand_apply: 'فهم وتطبيق', critical: 'تفكير نقدي', recall: 'استرجاع' }, types: Object.fromEntries(E.ORDER.map((c) => [c, { ar: E.QT[c][0], en: c }])), scoring: SCORING });
  if (path === '/api/quizzes' && method === 'POST') {
    const st = { ...QDEF, ...(b.settings || {}) }; st.count = (st.count === 'auto' || st.count == null || st.count === '') ? 'auto' : Math.max(5, Math.min(80, parseInt(st.count, 10) || 20)); if (!(b.sources || []).length) return ER(422, 'validation', 'اختر ملفًا.');
    let src; try { src = await loadSource(b.sources); } catch (e) { return ER(422, 'source_error', e.message); }
    if (!src.pages.length) return ER(422, 'no_readable_pages', 'لا توجد صفحات مقروءة في النطاق المختار.', { excluded: src.excluded });
    st.sources = b.sources.map((s) => ({ document_id: s.document_id, pages: s.pages || null })); st.field = E.detectField(src.pages.map((p) => p.text).join(' ')); const heur = E.support(src.pages.map((p) => p.text), st.field);
    const id = rid(); const doc = await getDoc(K.doc(b.sources[0].document_id));
    const q = { kind: 'quiz', id, title: (b.title || doc.title).slice(0, 120), settings: st, status: 'draft', created_at: nowS(), updated_at: nowS(), progress_pct: 0, source_preview: { readable_pages: src.pages.length, excluded_pages: src.excluded, words: heur._meta.words, type_support: typeSupportOut(heur) } };
    await putDoc(K.quiz(id), q); return J(await quizOut(q, true));
  }
  if (path === '/api/quizzes') return J(await Promise.all((await listKind('quiz')).sort((a, b) => b.created_at - a.created_at).map((q) => quizOut(q))));
  if ((m = path.match(/^\/api\/quizzes\/(\w+)\/(analyze|generate)$/))) {
    const q = await getDoc(K.quiz(m[1])); if (!q) return ER(404, 'not_found', 'الكويز غير موجود.'); if (!pl.aiAvailable) return ER(503, 'llm_not_configured', H.aiMissingMessage);
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
