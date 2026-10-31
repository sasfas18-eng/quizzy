/* Quizzy · Claude edition — engine (browser port of the Python pipeline: taxonomy, support, planner, validators, prompts, generator).
 * Pure logic, no DOM/db: it receives an `llm.json(task, system, prompt)` function. */
(() => {
const QT = {
  basic_recall: ['الاسترجاع الأساسي', 'A single fact, definition, term, number or label stated in the source. No inference.'],
  understanding: ['فهم المفاهيم', "Tests grasp of a concept's meaning/role/why — not wording recall. Options differ in meaning, not phrasing."],
  mechanisms: ['الآليات والتفاصيل', 'How/why something works: causal steps, components, conditions, exact details the source gives.'],
  application: ['تطبيق المعلومات', 'Apply a rule/formula/principle from the source to a new concrete situation or numbers.'],
  critical_thinking: ['التفكير النقدي', "Evaluate, infer a consequence, spot a flaw, weigh evidence — reasoning the source's content supports."],
  scenarios: ['سيناريو تخصصي', "A realistic case vignette in the source's own field (clinical for health content, a domain case elsewhere)."],
  compare_contrast: ['المقارنة والتمييز', 'Distinguish two or more related items the source treats side by side.'],
  best_answer: ['أفضل إجابة', 'Several options are partly true; exactly one is the most complete/appropriate per the source. Say best/most appropriate in the stem.'],
  not_except: ['الاستثناء / غير الصحيح', 'Stem must contain NOT or EXCEPT (Arabic: ما عدا / غير صحيحة). Three options true per the source; the key is the false one.'],
  sequence: ['ترتيب الخطوات', "List items in the stem (numbered 1..n, shuffled). Each option is a COMPLETE ordering of the same items (e.g. '2 → 4 → 1 → 3'). Only an order the source states."],
};
const ORDER = Object.keys(QT);
const BASE_W = { basic_recall: .12, understanding: .14, mechanisms: .12, application: .12, critical_thinking: .08, scenarios: .10, compare_contrast: .10, best_answer: .08, not_except: .07, sequence: .07 };
const FOCUS = { balanced: {}, understand_apply: { understanding: 2, application: 2.2, mechanisms: 1.4, scenarios: 1.5, basic_recall: .5 },
  critical: { critical_thinking: 3, best_answer: 1.8, scenarios: 1.6, not_except: 1.3, basic_recall: .4 }, recall: { basic_recall: 3, not_except: 1.4, sequence: 1.4, compare_contrast: 1.2, critical_thinking: .4, scenarios: .4 } };
const FIELD_CUES = {
  health: /patient|clinical|diagnos|symptom|treatment|therapy|disease|cardiac|ventric|pharmac|anatom|physiolog|syndrome|مريض|سريري|تشخيص|أعراض|علاج|مرض|قلب|دواء|تشريح/gi,
  science: /experiment|molecule|chemical|reaction|organelle|mitochond|species|ecosystem|photosynth|atom|تجربة|جزيء|تفاعل|خلية|ذرة|كيمياء|أحياء|فيزياء/gi,
  engineering: /circuit|voltage|stress|beam|torque|thermodynamic|signal|turbine|دائرة|جهد|هندس|عزم|إشارة/gi,
  cs: /algorithm|function|variable|database|compiler|network|software|code|complexity|خوارزمية|برمج|قاعدة بيانات|شبكة/gi,
  math: /theorem|proof|integral|derivative|matrix|probability|variance|equation|نظرية|برهان|تكامل|مشتقة|مصفوفة|احتمال/gi,
  business: /market|revenue|profit|strategy|customer|accounting|inflation|supply|demand|سوق|إيراد|ربح|استراتيجية|محاسبة|اقتصاد/gi,
  law: /statute|contract|plaintiff|court|liability|jurisdiction|tort|قانون|عقد|محكمة|مسؤولية|دعوى/gi,
  humanities: /literature|philosoph|historical|society|culture|political|psycholog|أدب|فلسفة|تاريخ|مجتمع|ثقافة|سياسة|نفس/gi,
};
const FIELD_GUIDE = { health: 'Write a realistic CLINICAL vignette strictly using the concepts in the source.', other: 'Write a realistic applied case in the subject of the source. Do NOT use patients or clinical framing.' };
function detectField(t) { let best = 'other', sc = 2; for (const [k, rx] of Object.entries(FIELD_CUES)) { const n = (t.match(rx) || []).length; if (n > sc) { best = k; sc = n; } } return best; }

// ---------- heuristic support (same cues as the server edition)
const CUES = {
  mechanisms: [/\bmechanism/i, /\bbecause\b/i, /\bleads? to\b/i, /\bresults? in\b/i, /\bcauses?\b/i, /\bpathway/i, /آلية|بسبب|يؤدي إلى|ينتج عن|مسار/],
  application: [/\bformula/i, /\bequation/i, /\bcalculate/i, /\bexample/i, /\bapply/i, /=/, /\bsolve/i, /\bdose/i, /معادلة|قانون|مثال|احسب|تطبيق/, /\d+\s*(?:mg|kg|m|s|%|ml|mol|hz|v|a)\b/i],
  compare_contrast: [/\bvs\.?\b/i, /\bversus\b/i, /\bdiffer/i, /\bcompared? (?:to|with)/i, /\bwhereas\b/i, /\bunlike\b/i, /\bwhile\b/i, /\bsimilar/i, /بينما|بخلاف|الفرق|مقارنة|يختلف|على عكس/],
  sequence: [/\bstep\s*\d/i, /\bstages?\b/i, /\bphases?\b/i, /\bfollowed by\b/i, /\bnext\b/i, /\bfinally\b/i, /^\s*\d+[.)]\s/m, /مرحلة|خطوة|ثم |أولا|أولًا|تسلسل/],
  critical_thinking: [/\blimitation/i, /\bassum/i, /\badvantage/i, /\bdisadvantage/i, /\bhowever\b/i, /\bevidence/i, /\btrade-?off/i, /قيود|محدد|عيوب|مزايا|افتراض|دليل|لكن/],
  best_answer: [/\bmost (?:common|important|appropriate|likely)/i, /\bfirst[- ]line/i, /\bbest\b/i, /\bpreferred\b/i, /الأفضل|الأكثر|الأنسب/],
  not_except: [/\binclude[sd]?\b/i, /\btypes? of\b/i, /\bclassif/i, /\bcharacteristics/i, /\bcomponents?/i, /\bcriteria/i, /أنواع|تصنيف|خصائص|مكونات|معايير|^\s*[-•●▪]\s/m],
  understanding: [/\bdefin/i, /\bmeans?\b/i, /\brefers? to\b/i, /\bconcept/i, /\bprinciple/i, /تعريف|يعني|مفهوم|مبدأ/], basic_recall: [/\bdefin/i, /\d/, /تعريف|\d/],
  scenarios: [/\bcase\b/i, /\bpatient/i, /\bpresent(?:s|ing|ation)/i, /\bdiagnos/i, /\bsymptom/i, /\bscenario/i, /حالة|مريض|تشخيص|أعراض|سيناريو/],
};
function support(texts, field) {
  const text = texts.join('\n'); const words = Math.max(1, (text.match(/\w+/g) || []).length); const out = {};
  for (const code of ORDER) {
    const hits = (CUES[code] || []).reduce((a, rx) => a + (text.match(new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g')) || []).length, 0);
    let level, missing = null;
    const thr = { sequence: [6, 2], compare_contrast: [5, 2], application: [5, 2], scenarios: field === 'health' ? [6, 2] : [99, 3] }[code];
    if (code === 'scenarios' && field === 'health') { const c = (text.match(/patient|diagnos|symptom|clinical|treatment|مريض|تشخيص|أعراض|علاج/gi) || []).length; level = c >= 6 ? 'strong' : c >= 2 ? 'limited' : 'none'; }
    else if (thr) level = hits >= thr[0] ? 'strong' : hits >= thr[1] ? 'limited' : 'none';
    else level = hits / (words / 200) >= 1 ? 'strong' : hits >= 1 ? 'limited' : 'none';
    if (level === 'none') missing = { sequence: 'لا توجد عملية/خطوات مرتبة في النطاق.', compare_contrast: 'لا توجد عناصر متقابلة تُقارن.', application: 'لا توجد قوانين/أمثلة/أرقام.', scenarios: 'لا توجد مادة كافية لسيناريو تخصصي.' }[code] || 'إشارات النص لهذا النوع ضعيفة جدًا.';
    out[code] = { level, hits, missing };
  }
  out._meta = { words }; return out;
}

// ---------- planner
function lrm(weights, total) { const s = Object.values(weights).reduce((a, b) => a + b, 0); const o = {}; if (s <= 0 || total <= 0) { for (const k in weights) o[k] = 0; return o; }
  const raw = {}, base = {}; let used = 0; for (const k in weights) { raw[k] = weights[k] / s * total; base[k] = Math.floor(raw[k]); used += base[k]; }
  Object.keys(raw).sort((a, b) => (raw[b] - base[b]) - (raw[a] - base[a])).slice(0, total - used).forEach((k) => base[k]++); return base; }
function buildPlan(analysis, st, heur) {
  const requested = st.count || 20, focus = st.focus || 'balanced', objs = analysis.objectives, veto = {};
  if (heur) for (const c of ORDER) if (heur[c].level === 'none' && c !== 'basic_recall' && c !== 'understanding') veto[c] = heur[c].missing;
  const avail = Object.fromEntries(ORDER.map((c) => [c, []])); objs.forEach((o) => { for (const c in o.supports) if (avail[c] && !veto[c]) avail[c].push(o); });
  const cap = Object.fromEntries(objs.map((o) => [o.id, Math.max(1, o.capacity || 1)])); const totalCap = Object.values(cap).reduce((a, b) => a + b, 0);
  const pairCap = Object.fromEntries(ORDER.map((c) => [c, avail[c].length])); const feasible = Math.min(requested, totalCap, Object.values(pairCap).reduce((a, b) => a + b, 0));
  const mult = FOCUS[focus] || {}; const weights = {};
  ORDER.forEach((c) => { if (pairCap[c] > 0) weights[c] = BASE_W[c] * (mult[c] || 1) * (heur && heur[c].level === 'strong' && !['basic_recall', 'understanding'].includes(c) ? 1.8 : 1); });
  const quota = Object.keys(weights).length ? lrm(weights, feasible) : {};
  if (focus === 'balanced' && feasible >= Object.keys(weights).length) for (const c in weights) if (!quota[c]) { const d = Object.keys(quota).sort((a, b) => quota[b] - quota[a])[0]; if (quota[d] > 1) { quota[d]--; quota[c] = 1; } }
  for (let r = 0; r < 5; r++) { let over = 0; for (const c in quota) if (quota[c] > pairCap[c]) { over += quota[c] - pairCap[c]; quota[c] = pairCap[c]; }
    if (!over) break; const room = {}; for (const c in weights) if ((quota[c] || 0) < pairCap[c]) room[c] = weights[c]; const add = Object.keys(room).length ? lrm(room, over) : {}; for (const c in add) quota[c] = (quota[c] || 0) + add[c]; }
  const slots = [], used = new Set();
  const push = (c, o) => { const sup = o.supports[c] || {}; slots.push({ qtype: c, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages || [], task: sup.task || null }); cap[o.id]--; used.add(o.id + '|' + c); };
  Object.keys(quota).sort((a, b) => pairCap[a] - pairCap[b]).forEach((c) => { let want = quota[c];
    avail[c].slice().sort((a, b) => cap[b.id] - cap[a.id]).forEach((o) => { if (want > 0 && cap[o.id] > 0 && !used.has(o.id + '|' + c)) { push(c, o); want--; } }); });
  let deficit = feasible - slots.length;
  Object.keys(weights).sort((a, b) => weights[b] - weights[a]).forEach((c) => avail[c].forEach((o) => { if (deficit > 0 && cap[o.id] > 0 && !used.has(o.id + '|' + c)) { push(c, o); deficit--; } }));
  slots.forEach((s, i) => { s.difficulty = ['easy', 'medium', 'hard'].includes(st.difficulty) ? st.difficulty : ({ basic_recall: 'easy', understanding: 'easy', critical_thinking: 'hard', scenarios: 'hard', best_answer: 'hard' }[s.qtype] || 'medium'); });
  slots.sort((a, b) => (Math.min(...(a.pages.length ? a.pages.map(pn) : [9999])) - Math.min(...(b.pages.length ? b.pages.map(pn) : [9999]))) || ORDER.indexOf(a.qtype) - ORDER.indexOf(b.qtype)); slots.forEach((s, i) => (s.slot = i + 1));
  const dist = Object.fromEntries(ORDER.map((c) => [c, slots.filter((s) => s.qtype === c).length]));
  const unsupported = ORDER.filter((c) => !dist[c]).map((c) => ({ qtype: c, label: QT[c][0], reason: veto[c] || (pairCap[c] === 0 ? 'لا يدعمها أي هدف تعليمي في النطاق المختار.' : 'لم تتسع لها حصة هذا الطلب (التركيز المختار).'),
    suggestion: { scenarios: 'أضف صفحات فيها حالات/أمثلة تطبيقية.', sequence: 'أضف صفحات تشرح خطوات/مراحل مرتبة.', compare_contrast: 'أضف صفحات تقارن بين عناصر متشابهة.', application: 'أضف أمثلة محلولة أو قوانين.', not_except: 'أضف قوائم أو تصنيفات.' }[c] || 'وسّع المصدر.' }));
  return { requested, feasible_count: slots.length, slots, distribution: dist, unsupported_types: unsupported, focus, difficulty: st.difficulty, objective_count: objs.length,
    shortfall: slots.length < requested ? { requested, possible: slots.length, reason: 'المحتوى لا يكفي لعدد أكبر من الأسئلة الصحيحة غير المكررة.', suggestions: ['وسّع نطاق الصفحات أو أضف لكتشرًا آخر.', `أو اقبل ${slots.length} سؤالًا فقط بدل الحشو.`] } : null };
}
const pn = (ref) => +String(ref).replace(/^d\d+p/, '');

// ---------- validators
const STOP = new Set('the a an of in on to and or is are was were be by for with as at from that this these those it its which what how why when في من على إلى عن مع هو هي هذا هذه ذلك التي الذي ما ماذا كيف لماذا أو و ثم قد كان يكون'.split(' '));
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}\s%=<>.+*/^-]/gu, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => (norm(s).match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => !STOP.has(t) && t.length > 1);
const jac = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; A.forEach((x) => B.has(x) && i++); return i / (A.size + B.size - i); };
const iss = (code, message, severity = 'decisive') => ({ code, message, severity });
function quoteIn(quote, text) { const q = norm(quote), t = norm(text); if (q.length < 10) return false; if (t.includes(q)) return true; const qt = q.split(' '); if (qt.length < 4) return false;
  const tt = t.split(' '), ts = new Set(tt); if (qt.filter((w) => ts.has(w)).length / qt.length < .92) return false; const n = qt.length, qs = new Set(qt);
  for (let i = 0; i < Math.max(1, tt.length - n + 1); i++) { const w = new Set(tt.slice(i, i + n + 3)); let c = 0; qs.forEach((x) => w.has(x) && c++); if (c / n >= .9) return true; } return false; }
const arRatio = (s) => { const L = [...s].filter((c) => /\p{L}/u.test(c)); return L.length ? L.filter((c) => /[؀-ۿ]/.test(c)).length / L.length : 0; };
const CLIN = /\b(patient|patients|symptom|symptoms|diagnos\w*|clinical\w*|physician|nurse)\b|مريض|مرضى|أعراض|تشخيص|سريري/i;
const NOTRX = /\b(NOT|EXCEPT|FALSE|INCORRECT|LEAST)\b|ما عدا|عدا|غير صحيح|ليس|لا يُعد|لا يعد|خاطئة|الخاطئ/i;
const ALLNONE = /\b(all|none) of the above\b|\bboth [A-D] and [A-D]\b|جميع (?:ما سبق|الإجابات)|كل ما سبق|لا شيء مما سبق|كلاهما/i;
function validateQ(q, ctx) {
  const out = [], stem = (q.stem || '').trim(), opts = (q.options || []).map((o) => String(o).trim()), ci = q.correct_index;
  if (stem.length < 15) out.push(iss('stem_short', 'نص السؤال قصير جدًا.'));
  if (opts.length !== 4 || opts.some((o) => !o)) { out.push(iss('options_count', 'يجب 4 خيارات غير فارغة.')); return out; }
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) { out.push(iss('key_invalid', 'مفتاح غير صالح.')); return out; }
  const n = opts.map(norm); if (new Set(n).size < 4) out.push(iss('options_duplicate', 'خياران متطابقان.'));
  if (opts.some((o) => ALLNONE.test(o))) out.push(iss('all_none_above', 'خيارات «كل ما سبق/لا شيء» غير مسموحة.'));
  const lens = opts.map((o) => o.length), oth = lens.filter((_, i) => i !== ci); if (lens[ci] > 1.6 * Math.max(...oth) && lens[ci] > 40) out.push(iss('length_cue', 'الإجابة الصحيحة أطول بكثير (قرينة شكلية).', 'minor'));
  const ev = q.evidence || []; if (!ev.length) out.push(iss('no_evidence', 'لا يوجد دليل من المصدر.'));
  let ok = 0; for (const e of ev) { if (!ctx.pages[e.page]) { out.push(iss('evidence_out_of_scope', `الدليل يشير إلى صفحة خارج النطاق (${e.page}).`)); continue; }
    if (quoteIn(e.quote, ctx.pages[e.page])) ok++; else out.push(iss('evidence_not_found', `الاقتباس غير موجود حرفيًا في ${e.page}.`)); }
  if (ev.length && !ok && !(q.uses_external && ctx.allowExternal)) out.push(iss('unsupported', 'لا يوجد دليل نصي متحقق منه.'));
  if (q.uses_external && !ctx.allowExternal) out.push(iss('external_not_allowed', 'يستعين بمعلومة خارج المصدر.'));
  if ((q.explanation || '').trim().length < 25) out.push(iss('explanation_missing', 'التفسير مفقود أو قصير.'));
  if (q.qtype === 'not_except' && !NOTRX.test(stem)) out.push(iss('not_marker_missing', 'سؤال NOT/EXCEPT بلا صيغة نفي واضحة.'));
  if (q.qtype === 'sequence') { const sets = opts.map((o) => [...new Set(o.replace(/[→>\-,،]/g, ' ').match(/\d+|[A-Za-z؀-ۿ]+/g) || [])].sort().join('|'));
    if (new Set(sets).size !== 1 || sets[0].split('|').length < 3) out.push(iss('sequence_options_invalid', 'خيارات الترتيب يجب أن تكون ترتيبات كاملة لنفس العناصر.'));
    if (!/(?:^|\n)\s*[(\[]?\d+[)\].:]/.test(stem)) out.push(iss('sequence_items_missing', 'عناصر الترتيب غير مرقمة في السؤال.')); }
  if (ctx.field !== 'health') { const src = Object.values(ctx.pages).join(' '); const m = (stem + ' ' + opts.join(' ')).match(CLIN); if (m && !new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(src)) out.push(iss('cross_field_import', `مصطلح طبي «${m[0]}» غير موجود في المصدر.`)); }
  const ar = arRatio(stem), wantAr = ctx.language === 'ar' || (ctx.language === 'source' && ctx.sourceAr), wantEn = ctx.language === 'en' || (ctx.language === 'source' && !ctx.sourceAr);
  if (wantAr && ar < .3) out.push(iss('language_mismatch', 'السؤال ليس بالعربية كما طُلب.')); if (wantEn && ar > .15) out.push(iss('language_mismatch', 'السؤال ليس بالإنجليزية كما طُلب.'));
  return out;
}
const decisive = (l) => l.some((i) => i.severity === 'decisive');
function dupOf(c, acc) { const cs = toks(c.stem), cp = toks(c.purpose || ''), ck = norm(c.options[c.correct_index]); const cev = new Set((c.evidence || []).map((e) => norm(e.quote).slice(0, 80)));
  for (const a of acc) { const s = jac(cs, toks(a.stem)), p = cp.length ? jac(cp, toks(a.purpose || '')) : 0, same = ck === norm(a.options[a.correct_index]) && ck.length > 3;
    const sameEv = (a.evidence || []).some((e) => cev.has(norm(e.quote).slice(0, 80))) && c.qtype === a.qtype; if (s >= .62 || p >= .6 || (same && s >= .35) || sameEv) return a.slot; } return null; }
function leaks(c, acc) { const cs = norm(c.stem), ck = norm(c.options[c.correct_index]); for (const a of acc) { const ak = norm(a.options[a.correct_index]), as = norm(a.stem);
  if (ak.split(' ').length >= 3 && ak.length >= 14 && cs.includes(ak)) return a.slot; if (ck.split(' ').length >= 3 && ck.length >= 14 && as.includes(ck)) return a.slot; } return null; }

// ---------- prompts (same content as backend/app/services/prompts.py)
const RULES = `You write exam-grade multiple-choice questions for university students from THEIR OWN lecture material.
Quality beats quantity: if a slot cannot be done correctly from the source, return it as unwritable with a reason instead of inventing content.
Hard rules
1. Source only (unless supplement is allowed): every fact needed for the key AND the explanation must be stated in the cited pages. No imported knowledge from other fields (no clinical framing outside health content).
2. Exactly 4 options, exactly 1 correct. Distractors plausible, from related concepts/common confusions in the same source, similar in length/grammar/specificity to the key. No "all/none of the above", no "both A and B".
3. Stem self-contained and unambiguous; never say "according to the slide"; never refer to other questions; do not leak other answers; do not put the answer's distinctive words in the stem.
4. Evidence: for each cited page copy a VERBATIM quote (<=300 chars). Quotes are machine-checked; paraphrases fail.
5. Explanation 2-4 sentences: why the key is right and why the closest distractor is wrong, using the source.
6. purpose = one sentence naming exactly what this question measures. Questions must not share purpose or reasoning route — no renamed copies.
7. Technical terms stay in their original language when writing Arabic; LaTeX in $...$ only for real formulas.
Difficulty: easy = one step from a statement; medium = 1-2 linked statements; hard = multi-step/close alternatives, still fully answerable from the source.`;
const stripDoc = (s) => s;
const P = {
  analyze(pages, field, supplement) { return [`You analyse lecture material to plan a quiz. Be conservative: only claim a task is supported if the pages contain the material. Pages are labelled by ref (e.g. d1p5). Never invent content.`,
    `Task: split the pages into learning OBJECTIVES (each a distinct teachable unit, 1-6 pages), and decide which quiz types the pages genuinely support.\nQuiz types:\n${ORDER.map((k) => `- "${k}": ${QT[k][1]}`).join('\n')}\nExternal knowledge allowed: ${supplement ? 'yes (flag it)' : 'NO'}.\nReturn JSON: {"lecture_character":"<2 sentences>","discipline_guess":"<one of ${Object.keys(FIELD_CUES).join('|')}|other>","objectives":[{"id":"o1","statement":"<in the source language>","pages":["d1p3"],"key_terms":["..."],"capacity":<int 1-4 distinct non-duplicative questions>,"supports":{"basic_recall":{"pages":["d1p3"]},"mechanisms":{"pages":["d1p3"],"task":null}}}],"gaps":["<important topic mentioned but not explained enough>"]}\nUse the page refs EXACTLY as written in PAGES (e.g. d1p3), never "page 3" or "3". The keys under supports must be exactly: ${ORDER.join(', ')}.\nOnly list a type under supports if the cited pages contain what it needs (sequence only if an explicit order exists; scenarios only if a correct case can be written).\nPAGES:\n${JSON.stringify(pages.map((p) => ({ ref: p.ref, text: p.text.slice(0, 6000) })))}`]; },
  generate(slots, pages, st, existing, fb) { const lang = { source: 'Write in the language of the source pages.', ar: 'Write the question text in Arabic (keep technical terms in English).', en: 'Write in English.' }[st.language || 'source'];
    return [`${RULES}\n\n${lang}\nScenario guidance: ${st.field === 'health' ? FIELD_GUIDE.health : FIELD_GUIDE.other}`,
      `Write one question per slot using ONLY the cited pages. External knowledge: ${st.external_mode === 'supplement' ? 'allowed but set uses_external=true' : 'NOT allowed'}.\nAlready accepted (do NOT repeat their purpose/fact/route; do not leak answers):\n${JSON.stringify(existing.slice(-40))}\nSLOTS:\n${JSON.stringify(slots.map((s) => ({ slot: s.slot, type: s.qtype, format: QT[s.qtype][1], difficulty: s.difficulty, objective: s.objective, pages: s.pages, retry_feedback: fb[s.slot] || null })))}\nPAGES:\n${JSON.stringify(pages)}\nReturn JSON: {"questions":[{"slot":<int>,"unwritable_reason":null,"stem":"...","options":["...","...","...","..."],"correct_index":<0-3>,"explanation":"...","purpose":"...","reasoning_pattern":"...","evidence":[{"page":"d1p3","quote":"<verbatim>"}],"uses_external":false}]}\nIf a slot cannot be written correctly: {"slot":n,"unwritable_reason":"<why>"}.`]; },
  verify(q, pages) { return ['You are a strict, independent exam reviewer and test-taker. You see only the source pages and one question WITHOUT its key. Solve it using only the source, then audit it. Be skeptical.',
    `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTION type=${q.qtype}:\n${q.stem}\n${JSON.stringify(q.options)}\nReturn JSON: {"chosen_index":<0-3 or null if undecidable from the source>,"answerable_from_source":<bool>,"single_best_answer":<bool: exactly one defensible option>,"sufficient_data":<bool>,"needs_outside_knowledge":<bool>,"flaws":["<concrete defects>"],"severity":"none"|"minor"|"decisive"}`]; },
  explain(q, pages) { return ['You check whether an explanation is correct and supported by the source pages only.', `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTION: ${q.stem}\nKEY: ${q.options[q.correct_index]}\nEXPLANATION: ${q.explanation}\nReturn JSON: {"explanation_supported":<bool>,"contradicts_source":<bool>,"notes":"<short>"}`]; },
  verifyBatch(items, pages) { return ['You are a strict, independent exam reviewer and test-taker. You see only the source pages and several questions WITHOUT their keys. For EACH question: solve it using only the source, then audit it. Be skeptical; judge each question independently.',
    `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTIONS:\n${JSON.stringify(items.map((x) => ({ id: x.id, type: x.c.qtype, stem: x.c.stem, options: x.c.options })))}\nReturn JSON: {"results":[{"id":<same id>,"chosen_index":<0-3 or null if undecidable from the source>,"answerable_from_source":<bool>,"single_best_answer":<bool>,"sufficient_data":<bool>,"needs_outside_knowledge":<bool>,"flaws":["<concrete defects>"],"severity":"none"|"minor"|"decisive"}]}`]; },
  explainBatch(items, pages) { return ['You check whether each explanation is correct and supported by the source pages only.', `SOURCE PAGES:\n${JSON.stringify(pages)}\nITEMS:\n${JSON.stringify(items.map((x) => ({ id: x.id, question: x.c.stem, key: x.c.options[x.c.correct_index], explanation: x.c.explanation })))}\nReturn JSON: {"results":[{"id":<same id>,"explanation_supported":<bool>,"contradicts_source":<bool>,"notes":"<short>"}]}`]; },
  cards(pages, n, lang) { return [`You create spaced-repetition flashcards from lecture pages. Each card tests ONE atomic idea; front is a clear self-contained question/concept prompt (no yes/no, no "what does the slide say"); back is a short precise answer (1-3 lines). Only use the pages. No duplicates, no trivia.`,
    `Write up to ${n} cards (fewer if the pages don't support ${n} distinct good ones). Language: ${{ source: 'same as the source', ar: 'Arabic (technical terms in English)', en: 'English' }[lang || 'source']}.\nReturn JSON: {"cards":[{"front":"...","back":"...","page":"d1p3","quote":"<verbatim from that page>"}]}\nPAGES:\n${JSON.stringify(pages)}`]; },
};

// ---------- pipeline
async function mapLimit(items, n, fn) { const res = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } })); return res; }
function chunkPages(pages, max = 18000) { const out = []; let cur = [], n = 0; for (const p of pages) { const L = Math.min(p.text.length, 6000); if (cur.length && n + L > max) { out.push(cur); cur = []; n = 0; } cur.push(p); n += L; } if (cur.length) out.push(cur); return out; }
// ---- tolerant parsing of model output: small/free models drift from the exact format (refs like "p3", "D1P3", 3; types like "Recall")
const TYPE_ALIASES = { recall: 'basic_recall', basic: 'basic_recall', 'basic recall': 'basic_recall', concept: 'understanding', concepts: 'understanding', mechanism: 'mechanisms', 'mechanisms detail': 'mechanisms', detail: 'mechanisms', details: 'mechanisms', apply: 'application', 'application of knowledge': 'application',
  critical: 'critical_thinking', 'critical thinking': 'critical_thinking', clinical: 'scenarios', 'clinical scenarios': 'scenarios', 'clinical scenario': 'scenarios', scenario: 'scenarios', case: 'scenarios', 'case study': 'scenarios', compare: 'compare_contrast', 'compare contrast': 'compare_contrast', comparison: 'compare_contrast',
  best: 'best_answer', 'best answer': 'best_answer', 'most correct': 'best_answer', 'most correct best answer': 'best_answer', not: 'not_except', except: 'not_except', 'not except': 'not_except', ordering: 'sequence', order: 'sequence', 'sequence ordering': 'sequence', steps: 'sequence' };
function normType(t) {
  const raw = String(t == null ? '' : t).trim().toLowerCase(); const k = raw.replace(/[\s\-/&]+/g, '_'); if (QT[k]) return k;
  const sp = raw.replace(/[_\-/&]+/g, ' ').replace(/\s+/g, ' ').trim(); return TYPE_ALIASES[sp] || null;
}
/** accept d1p3 / D1P3 / p3 / page 3 / slide 3 / 3 / "3-5" and keep only refs that exist in `pagesList` */
function normRefs(list, pagesList) {
  const have = new Set(pagesList.map((p) => p.ref)); const docs = [...new Set(pagesList.map((p) => p.ref.match(/^d(\d+)p/)[1]))]; const out = [];
  const add = (doc, no) => { if (doc || docs.length === 1) { const r = `d${doc || docs[0]}p${no}`; if (have.has(r)) out.push(r); } else docs.forEach((dd) => { const r = `d${dd}p${no}`; if (have.has(r)) out.push(r); }); };
  const arr = Array.isArray(list) ? list : list == null ? [] : [list];
  for (const x of arr) {
    const t = String(x).trim().toLowerCase(); let m;
    if ((m = t.match(/^d(\d+)\s*[-_ ]?\s*p(?:age)?\s*[-_ ]?(\d+)$/))) add(m[1], +m[2]);
    else if ((m = t.match(/^(?:p|page|slide|pg|ص|صفحة|شريحة)?\s*[-_.:]?\s*(\d+)\s*[-–—]\s*(?:p|page|slide|pg)?\s*(\d+)$/)) && +m[2] >= +m[1] && +m[2] - +m[1] < 60) { for (let n = +m[1]; n <= +m[2]; n++) add(null, n); }
    else if ((m = t.match(/^(?:p|page|slide|pg|ص|صفحة|شريحة)?\s*[-_.:]?\s*(\d+)$/))) add(null, +m[1]);
    else if (have.has(t)) out.push(t);
  }
  return [...new Set(out)];
}
const E_toks = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter((t) => !STOP.has(t));
/** objectives with usable pages + supports from whatever the model returned; supports may be an object, an array of names, or an array of {type,pages} */
function normObjectives(r, chunk) {
  const raw = Array.isArray(r) ? r : (r && (r.objectives || r.learning_objectives || r.units)) || []; const out = [];
  (Array.isArray(raw) ? raw : Object.values(raw)).forEach((ob) => {
    if (!ob || typeof ob !== 'object') return;
    let pg = normRefs(ob.pages || ob.page || ob.refs || ob.page_refs, chunk);
    if (!pg.length && chunk.length <= 3) pg = chunk.map((p) => p.ref);                      // the model named no valid page: a short chunk is unambiguous
    if (!pg.length) { const kt = E_toks([ob.statement, ...(ob.key_terms || [])].join(' ')); if (kt.length) { const best = chunk.map((p) => [p.ref, kt.filter((t) => p.text.toLowerCase().includes(t)).length]).sort((a, b) => b[1] - a[1])[0]; if (best && best[1] >= 2) pg = [best[0]]; } }
    if (!pg.length) return;
    const sup = {}; const put = (type, v) => { const t = normType(type); if (!t) return; const vp = normRefs(v && (v.pages || v.page || v.refs), chunk); sup[t] = { pages: vp.length ? vp : pg, task: (v && v.task) || null }; };
    const sp = ob.supports || ob.support || ob.types || ob.supported_types;
    if (Array.isArray(sp)) sp.forEach((x) => (typeof x === 'string' ? put(x, null) : x && put(x.type || x.name || x.key, x))); else if (sp && typeof sp === 'object') Object.entries(sp).forEach(([k, v]) => { if (v !== false && v !== null) put(k, v && typeof v === 'object' ? v : null); });
    if (!Object.keys(sup).length) { sup.basic_recall = { pages: pg, task: null }; sup.understanding = { pages: pg, task: null }; }    // a unit the model found but did not classify: the generator + validators still decide per question
    out.push({ id: '', statement: String(ob.statement || ob.title || ob.objective || '').trim().slice(0, 300) || chunk.find((p) => p.ref === pg[0]).text.split('\n')[0].slice(0, 120), pages: pg, key_terms: (ob.key_terms || []).slice(0, 10),
      capacity: Math.max(1, Math.min(4, parseInt(ob.capacity, 10) || 1)), supports: sup });
  });
  return out;
}
/** deterministic units when the model produced nothing usable: one objective per page that has real text */
function fallbackObjectives(pagesList, st) {
  return pagesList.filter((p) => p.text.trim().length >= 40).map((p) => {
    const h = support([p.text], st.field); const sup = { basic_recall: { pages: [p.ref], task: null }, understanding: { pages: [p.ref], task: null } };
    ORDER.forEach((t) => { if (!sup[t] && h[t].level !== 'none') sup[t] = { pages: [p.ref], task: null }; });
    return { id: '', statement: p.text.split('\n').find((l) => l.trim()).trim().slice(0, 120), pages: [p.ref], key_terms: [], capacity: Math.max(1, Math.min(3, Math.round(p.text.length / 450))), supports: sup };
  });
}
async function analyse(llm, pages, st) {
  const objectives = [], gaps = [], chars = [], disc = [];
  for (const chunk of chunkPages(pages)) { const [sys, pr] = P.analyze(chunk, st.field, st.external_mode === 'supplement'); const r = await llm.json('analyze', sys, pr);
    objectives.push(...normObjectives(r, chunk));
    gaps.push(...((r && r.gaps) || []).slice(0, 5)); if (r && r.lecture_character) chars.push(r.lecture_character); if (r && r.discipline_guess) disc.push(r.discipline_guess); }
  let fallback = false;
  if (!objectives.length) { objectives.push(...fallbackObjectives(pages, st)); fallback = objectives.length > 0; }
  objectives.forEach((o, i) => (o.id = 'o' + (i + 1)));
  return { objectives, gaps: gaps.slice(0, 10), lecture_character: fallback ? 'تعذّر على النموذج تقسيم المحاضرة إلى أهداف بصيغة مفهومة، فقُسّمت تلقائيًا بحسب الصفحات؛ تُطبَّق نفس فحوص الدليل والتحقق على كل سؤال.' : chars.slice(0, 2).join(' '),
    discipline_guess: disc.sort((a, b) => disc.filter((x) => x === b).length - disc.filter((x) => x === a).length)[0] || null, fallback };
}
function judge(r, c, st) {
  const out = [];
  if (r.chosen_index !== c.correct_index) out.push(iss('solver_disagrees', 'المحلل المستقل اختار إجابة مختلفة أو لم يحسم من المصدر.'));
  if (!r.answerable_from_source && !(c.uses_external && st.external_mode === 'supplement')) out.push(iss('not_answerable', 'لا يُجاب من المصدر وحده.'));
  if (!r.single_best_answer) out.push(iss('ambiguous_key', 'أكثر من إجابة مقبولة أو لا إجابة أرجح بوضوح.'));
  if (r.sufficient_data === false) out.push(iss('insufficient_data', 'المعطيات غير كافية.'));
  if (r.needs_outside_knowledge && st.external_mode !== 'supplement') out.push(iss('outside_knowledge', 'يحتاج معلومة من خارج المصدر.'));
  (r.flaws || []).slice(0, 3).forEach((f) => out.push(iss('verifier_flaw', String(f).slice(0, 200), r.severity === 'decisive' ? 'decisive' : 'minor')));
  return out;
}
/* Blind solve + explanation audit for a GROUP of questions in 2 LLM calls total (instead of 2 per question). */
async function llmCheckBatch(llm, items, pages, st) {
  const res = items.map(() => []); const byId = (r) => Object.fromEntries((r.results || []).map((x) => [x.id, x]));
  let v; try { const [s, p] = P.verifyBatch(items, pages); v = byId(await llm.json('verify', s, p)); } catch (e) { return items.map(() => [iss('verifier_error', 'فشل التحقق الآلي: ' + (e.message || e))]); }
  items.forEach((it, k) => { res[k] = v[it.id] ? judge(v[it.id], it.c, st) : [iss('verifier_error', 'لم يُرجع المدقق نتيجة لهذا السؤال.')]; });
  const todo = items.map((it, k) => [it, k]).filter(([, k]) => !decisive(res[k])); if (!todo.length) return res;
  try { const [s, p] = P.explainBatch(todo.map(([it]) => it), pages); const e = byId(await llm.json('verify_explanation', s, p));
    todo.forEach(([it, k]) => { const r = e[it.id]; if (r && (r.contradicts_source || r.explanation_supported === false)) res[k].push(iss('explanation_unsupported', 'التفسير غير مدعوم بالمصدر: ' + String(r.notes || '').slice(0, 150))); }); }
  catch (_) { todo.forEach(([, k]) => res[k].push(iss('verifier_error', 'تعذر تدقيق التفسير.', 'minor'))); }
  return res;
}
/* Pipelined generation (same design as backend/app/services/generator.py): each wave runs up to `concurrency` batches IN
 * PARALLEL (draft -> static validation -> batched blind verification); the merge — duplicate/leak checks against what is
 * already accepted — is sequential, so acceptance order is deterministic. Rejected slots get one retry round. */
async function generate(llm, plan, pagesList, st, progress, opts = {}) {
  const width = Math.max(1, opts.concurrency || 1);
  const pages = Object.fromEntries(pagesList.map((p) => [p.ref, p.text])); const ctx = { pages, field: st.field, language: st.language, allowExternal: st.external_mode === 'supplement', sourceAr: arRatio(pagesList.slice(0, 10).map((p) => p.text).join(' ')) > .4 };
  const acc = [], dropped = [], stats = { drafted: 0, rejected_validation: 0, rejected_verifier: 0, rejected_duplicate: 0, rejected_leak: 0, unwritable: 0, retries: 0 }, fb = {}; let pending = plan.slots.slice();
  const work = async (batch, known) => {
    const res = { batch, error: null, unwritable: [], rejected: [], survivors: [], checks: {} };
    const pg = {}; let used = 0; batch.forEach((s) => s.pages.forEach((r) => { if (pages[r] && !pg[r] && used + Math.min(6000, pages[r].length) <= 24000) { pg[r] = pages[r].slice(0, 6000); used += pg[r].length; } }));
    const [sys, pr] = P.generate(batch, pg, st, known.map((a) => ({ purpose: a.purpose, stem: a.stem.slice(0, 160), type: a.qtype })), fb); let resp;
    try { resp = await llm.json('generate', sys, pr); } catch (e) { res.error = e; return res; }
    const bySlot = Object.fromEntries((resp.questions || []).map((q) => [q.slot, q]));
    for (const s of batch) { const raw = bySlot[s.slot];
      if (!raw || raw.unwritable_reason) { res.unwritable.push([s, raw ? 'المولّد رفض كتابة السؤال: ' + raw.unwritable_reason : 'لم يُرجع المولّد سؤالًا لهذه الخانة.']); continue; }
      const c = { slot: s.slot, qtype: s.qtype, task: s.task, objective: s.objective, objective_id: s.objective_id, difficulty: s.difficulty, stem: String(raw.stem || '').trim(), options: (raw.options || []).map((o) => String(o).trim()),
        correct_index: Number.isInteger(raw.correct_index) ? raw.correct_index : -1, explanation: String(raw.explanation || '').trim(), purpose: String(raw.purpose || '').trim(), reasoning_pattern: raw.reasoning_pattern || '',
        evidence: (raw.evidence || []).map((e) => ({ page: e.page, quote: String(e.quote || '').trim() })), uses_external: !!raw.uses_external };
      const v = validateQ(c, ctx); let d;
      if (decisive(v)) res.rejected.push([s, 'rejected_validation', v.filter((i) => i.severity === 'decisive').map((i) => i.message)]);
      else if ((d = dupOf(c, known)) != null) res.rejected.push([s, 'rejected_duplicate', [`مكرر للسؤال ${d}: غيّر الحقيقة المقيسة وطريقة الاستدلال.`]]);
      else if ((d = leaks(c, known)) != null) res.rejected.push([s, 'rejected_leak', [`يكشف إجابة سؤال آخر (${d}). أعد الصياغة.`]]);
      else res.survivors.push([s, c, v]); }
    if (res.survivors.length) {
      const items = res.survivors.map(([s, c]) => ({ id: 'q' + s.slot, c, s })); const pgs = {};
      items.forEach((it) => [...it.c.evidence.map((e) => e.page), ...it.s.pages].forEach((r) => { if (pages[r] && !pgs[r] && Object.keys(pgs).length < 10) pgs[r] = pages[r].slice(0, 5000); }));
      const checks = await llmCheckBatch(llm, items, pgs, st); items.forEach((it, k) => (res.checks[it.id] = checks[k]));
    }
    return res;
  };
  for (let attempt = 1; attempt <= 2 && pending.length; attempt++) {
    const batches = []; for (let i = 0; i < pending.length; i += 3) batches.push(pending.slice(i, i + 3)); pending = [];
    for (let w = 0; w < batches.length; w += width) {
      progress(attempt === 1 ? 'drafting' : 'retrying', Math.round(100 * acc.length / Math.max(1, plan.slots.length)));
      const known = acc.slice(); const results = await Promise.all(batches.slice(w, w + width).map((b) => work(b, known)));
      for (const res of results) {   // sequential merge
        if (res.error) { res.batch.forEach((s) => dropped.push({ slot: s.slot, qtype: s.qtype, reasons: ['خطأ في خدمة التوليد: ' + (res.error.message || res.error)], final: true })); continue; }
        stats.drafted += res.survivors.length + res.rejected.length;
        for (const [s, reason] of res.unwritable) { stats.unwritable++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [reason] }); }
        for (const [s, key, msgs] of res.rejected) { stats[key]++; fb[s.slot] = msgs; pending.push(s); }
        for (const [s, c, v] of res.survivors) { const vi = res.checks['q' + s.slot] || [];
          if (decisive(vi)) { stats.rejected_verifier++; fb[s.slot] = vi.filter((x) => x.severity === 'decisive').map((x) => x.message); pending.push(s); }
          else if (dupOf(c, acc) != null || leaks(c, acc) != null) { stats.rejected_duplicate++; fb[s.slot] = ['تعارض مع سؤال معتمد في الدفعة نفسها.']; pending.push(s); }
          else { c.issues = v.concat(vi); acc.push(c); } }
      }
    }
    if (pending.length) stats.retries += pending.length;
  }
  pending.forEach((s) => dropped.push({ slot: s.slot, qtype: s.qtype, reasons: fb[s.slot] || ['فشل التحقق'], final: true }));
  return { accepted: acc, dropped, stats };
}
window.QZE = { normRefs, normType, normObjectives, fallbackObjectives, STOP, llmCheckBatch, QT, ORDER, detectField, support, buildPlan, analyse, generate, validateQ, quoteIn, norm, toks, jac, P, mapLimit, arRatio, pn, dupOf, leaks };
})();
