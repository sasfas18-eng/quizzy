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
  const requested = st.count || 20, focus = st.focus || 'balanced', objs = analysis.objectives, veto = {}; const prof = analysis.profile && analysis.profile.types ? analysis.profile.types : null;
  if (heur) for (const c of ORDER) if (heur[c].level === 'none' && c !== 'basic_recall' && c !== 'understanding' && !(prof && prof[c] && prof[c].capacity > 0)) veto[c] = heur[c].missing;      // the profile (which read the lecture properly) overrules the keyword cues
  if (prof) for (const c of ORDER) if (prof[c] && prof[c].capacity <= 0 && c !== 'basic_recall' && c !== 'understanding') veto[c] = 'لا يدعم محتوى المحاضرة هذا النوع.';
  const avail = Object.fromEntries(ORDER.map((c) => [c, []])); objs.forEach((o) => { for (const c in o.supports) if (avail[c] && !veto[c]) avail[c].push(o); });
  const cap = Object.fromEntries(objs.map((o) => [o.id, Math.max(1, o.capacity || 1)])); const totalCap = Object.values(cap).reduce((a, b) => a + b, 0);
  const pairCap = Object.fromEntries(ORDER.map((c) => [c, avail[c].length])); const feasible = Math.min(requested, totalCap, Object.values(pairCap).reduce((a, b) => a + b, 0));
  // How many questions each type gets FOLLOWS THE LECTURE: with a profile, a type's weight is the square root of the questions its lecture can sustain (a type with four times the material gets
  // twice the share: lecture-driven, but never one type taking everything), and no type is asked for more than the lecture can sustain. Without a profile (an old analysis) the former recipe applies.
  const mult = FOCUS[focus] || {}; const weights = {}; const typeCap = Object.fromEntries(ORDER.map((c) => [c, prof && prof[c] ? Math.min(pairCap[c], Math.max(1, prof[c].capacity)) : pairCap[c]]));
  ORDER.forEach((c) => { if (pairCap[c] > 0) weights[c] = (prof && prof[c] ? Math.sqrt(Math.max(1, prof[c].capacity)) : BASE_W[c] * (heur && heur[c].level === 'strong' && !['basic_recall', 'understanding'].includes(c) ? 1.8 : 1)) * (mult[c] || 1); });
  const quota = Object.keys(weights).length ? lrm(weights, feasible) : {};
  if (focus === 'balanced' && feasible >= Object.keys(weights).length) for (const c in weights) if (!quota[c]) { const d = Object.keys(quota).sort((a, b) => quota[b] - quota[a])[0]; if (quota[d] > 1) { quota[d]--; quota[c] = 1; } }
  for (let r = 0; r < 5; r++) { let over = 0; for (const c in quota) if (quota[c] > typeCap[c]) { over += quota[c] - typeCap[c]; quota[c] = typeCap[c]; }
    if (!over) break; const room = {}; for (const c in weights) if ((quota[c] || 0) < typeCap[c]) room[c] = weights[c]; const add = Object.keys(room).length ? lrm(room, over) : {}; for (const c in add) quota[c] = (quota[c] || 0) + add[c]; }
  const slots = [], used = new Set();
  const push = (c, o) => { const sup = o.supports[c] || {}; slots.push({ qtype: c, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages || [], task: sup.task || null }); cap[o.id]--; used.add(o.id + '|' + c); };
  // COVER THE WHOLE LECTURE: each next question goes to the section with the fewest questions so far and, among those, the one FARTHEST from the sections already
  // asked about (so 10 questions over 14 pages reach the end of the lecture instead of piling up on its first pages); then the larger section.
  // a topic continued over several slides («… (continued_3)») is ONE topic: a short quiz reaches more topics before it returns to one
  const topicOf = (o) => String(o.statement || '').toLowerCase().replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').replace(/[^\p{L}\p{N} ]/gu, '').trim() || o.id; const nTopic = {}; const tUsed = (o) => nTopic[topicOf(o)] || 0;
  const posOf = Object.fromEntries(objs.map((o, i) => [o.id, i])), nUsed = {}; const far = (o) => { const taken = objs.filter((x) => nUsed[x.id]); return taken.length ? Math.min(...taken.map((x) => Math.abs(posOf[x.id] - posOf[o.id]))) : posOf[o.id] === 0 ? 1e3 : 0; };
  Object.keys(quota).sort((a, b) => pairCap[a] - pairCap[b]).forEach((c) => { let want = quota[c];
    while (want > 0) { const cand = avail[c].filter((o) => cap[o.id] > 0 && !used.has(o.id + '|' + c)); if (!cand.length) break;
      cand.sort((a, b) => (nUsed[a.id] || 0) - (nUsed[b.id] || 0) || tUsed(a) - tUsed(b) || far(b) - far(a) || cap[b.id] - cap[a.id]); const o = cand[0]; push(c, o); nUsed[o.id] = (nUsed[o.id] || 0) + 1; nTopic[topicOf(o)] = tUsed(o) + 1; want--; } });
  let deficit = feasible - slots.length;
  Object.keys(weights).sort((a, b) => weights[b] - weights[a]).forEach((c) => avail[c].slice().sort((a, b) => (nUsed[a.id] || 0) - (nUsed[b.id] || 0) || far(b) - far(a)).forEach((o) => { if (deficit > 0 && cap[o.id] > 0 && !used.has(o.id + '|' + c)) { push(c, o); nUsed[o.id] = (nUsed[o.id] || 0) + 1; deficit--; } }));
  // THE REQUESTED COUNT IS ALWAYS PLANNED. The slots above are the "natural" ones (distinct objective x type pairs within each objective's capacity). When the lecture
  // is thinner than the request, the rest are REINFORCEMENT slots: the same material asked from another angle / another fact / another direction, spread evenly over
  // the lecture. They are still verified against the source like any other question; they are just not required to be about a brand-new topic.
  const pool = objs.map((o) => ({ id: o.id, statement: o.statement, pages: o.pages, types: Object.fromEntries(ORDER.filter((c) => o.supports[c] && !veto[c]).map((c) => [c, { pages: o.supports[c].pages || o.pages, task: o.supports[c].task || null }])) }));
  const perObj = {}; slots.forEach((s) => { perObj[s.objective_id] = (perObj[s.objective_id] || 0) + 1; });
  const natural = slots.length; slots.push(...reinforcementSlots(pool, perObj, requested - natural, {}));
  slots.forEach((s) => { s.difficulty = difficultyFor(st, s.qtype); });
  slots.sort((a, b) => (Math.min(...(a.pages.length ? a.pages.map(pn) : [9999])) - Math.min(...(b.pages.length ? b.pages.map(pn) : [9999]))) || ORDER.indexOf(a.qtype) - ORDER.indexOf(b.qtype)); slots.forEach((s, i) => (s.slot = i + 1));
  const dist = Object.fromEntries(ORDER.map((c) => [c, slots.filter((s) => s.qtype === c).length]));
  const unsupported = ORDER.filter((c) => !dist[c]).map((c) => ({ qtype: c, label: QT[c][0], reason: veto[c] || (pairCap[c] === 0 ? 'لا يدعمها أي هدف تعليمي في النطاق المختار.' : 'لم تتسع لها حصة هذا الطلب (التركيز المختار).'),
    suggestion: { scenarios: 'أضف صفحات فيها حالات/أمثلة تطبيقية.', sequence: 'أضف صفحات تشرح خطوات/مراحل مرتبة.', compare_contrast: 'أضف صفحات تقارن بين عناصر متشابهة.', application: 'أضف أمثلة محلولة أو قوانين.', not_except: 'أضف قوائم أو تصنيفات.' }[c] || 'وسّع المصدر.' }));
  return { requested, feasible_count: slots.length, natural_count: natural, extra_count: slots.length - natural, slots, pool, distribution: dist, profile: prof ? Object.fromEntries(ORDER.map((c) => [c, { capacity: prof[c].capacity, level: prof[c].level }])) : null, unsupported_types: unsupported, focus, difficulty: st.difficulty, objective_count: objs.length,
    shortfall: slots.length < requested ? { requested, possible: slots.length, reason: 'لا يوجد في هذا النطاق ما يُبنى عليه أي سؤال.', suggestions: ['وسّع نطاق الصفحات أو أضف لكتشرًا آخر.'] } : null };
}
const difficultyFor = (st, qtype) => (['easy', 'medium', 'hard'].includes(st.difficulty) ? st.difficulty : ({ basic_recall: 'easy', understanding: 'easy', critical_thinking: 'hard', scenarios: 'hard', best_answer: 'hard' }[qtype] || 'medium'));
// the angles a reinforcement question may take (the generator is told which one; the local generator rotates its question forms the same way)
const ANGLES = ['reverse', 'other_fact', 'not_true', 'apply', 'compare', 'detail'];
/** `n` extra slots over the objectives of `pool`, always on the objective that has the fewest questions so far (so the whole lecture stays covered), rotating its supported
 *  types and the angle. `counts` (objective id -> questions already planned/accepted) and `tries` (earlier attempts that produced nothing) steer the choice. */
function reinforcementSlots(pool, counts, n, tries) {
  const out = []; if (!pool.length || n <= 0) return out; const c = { ...counts }, t = tries || {}; const first = (o) => Math.min(...(o.pages.length ? o.pages.map(pn) : [9999]));
  for (let i = 0; i < n; i++) {
    const o = pool.slice().sort((a, b) => ((c[a.id] || 0) + .5 * (t[a.id] || 0)) - ((c[b.id] || 0) + .5 * (t[b.id] || 0)) || first(a) - first(b))[0];
    const types = Object.keys(o.types).length ? Object.keys(o.types) : ['basic_recall']; const k = (c[o.id] || 0) + (t[o.id] || 0); const type = types[k % types.length]; const sup = o.types[type] || {};
    out.push({ qtype: type, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages, task: sup.task || null, extra: true, variant: (c[o.id] || 0) + 1, angle: ANGLES[k % ANGLES.length] });
    c[o.id] = (c[o.id] || 0) + 1;
  }
  return out;
}
const pn = (ref) => +String(ref).replace(/^d\d+p/, '');
const pageKey = (pages) => Math.min(...((pages && pages.length) ? pages.map(pn) : [9999]));

// ---------- validators
const STOP = new Set('the a an of in on to and or is are was were be by for with as at from that this these those it its which what how why when في من على إلى عن مع هو هي هذا هذه ذلك التي الذي ما ماذا كيف لماذا أو و ثم قد كان يكون'.split(' '));
const normRaw = (s) => s.normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}\s%=<>.+*/^-]/gu, ' ').replace(/\s+/g, ' ').trim();
// the same page texts, stems and options are compared again and again while a quiz is built (evidence, duplicates, leaks): each text is normalised once (pure function, bounded cache)
const NORM = new Map(); const norm = (s) => { const x = String(s || ''); let r = NORM.get(x); if (r === undefined) { r = normRaw(x); if (NORM.size >= 20000) NORM.clear(); NORM.set(x, r); } return r; };
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
    const chains = opts.every((o) => /→/.test(o) && /\p{L}{2}/u.test(o));      // the options ARE the orders of named steps («Lag → Log → …»): nothing to number in the stem
    if (!chains && !/(?:^|\n)\s*[(\[]?\d+[)\].:]/.test(stem)) out.push(iss('sequence_items_missing', 'عناصر الترتيب غير مرقمة في السؤال.')); }
  if (ctx.field !== 'health') { const src = Object.values(ctx.pages).join(' '); const m = (stem + ' ' + opts.join(' ')).match(CLIN); if (m && !new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(src)) out.push(iss('cross_field_import', `مصطلح طبي «${m[0]}» غير موجود في المصدر.`)); }
  const ar = arRatio(stem), wantAr = ctx.language === 'ar' || (ctx.language === 'source' && ctx.sourceAr), wantEn = ctx.language === 'en' || (ctx.language === 'source' && !ctx.sourceAr);
  if (wantAr && ar < .3) out.push(iss('language_mismatch', 'السؤال ليس بالعربية كما طُلب.')); if (wantEn && ar > .15) out.push(iss('language_mismatch', 'السؤال ليس بالإنجليزية كما طُلب.'));
  return out;
}
const decisive = (l) => l.some((i) => i.severity === 'decisive');
/** `relaxed` = a REINFORCEMENT question: it may touch the same material as an accepted one (another direction, another detail), it may not be a copy of it. */
function dupOf(c, acc, relaxed) { const cs = toks(c.stem), cp = toks(c.purpose || ''), ck = norm(c.options[c.correct_index]); const cev = new Set((c.evidence || []).map((e) => norm(e.quote).slice(0, 80)));
  for (const a of acc) { const s = jac(cs, toks(a.stem)), p = cp.length ? jac(cp, toks(a.purpose || '')) : 0, same = ck === norm(a.options[a.correct_index]) && ck.length > 3;
    const sameEv = (a.evidence || []).some((e) => cev.has(norm(e.quote).slice(0, 80))) && c.qtype === a.qtype;
    if (relaxed) { if ((same && s >= .5) || s >= .95) return a.slot; continue; }      // a reinforcement question asks another word/fact/direction: the same answer to a similar stem is a copy, and so is the SAME QUESTION TEXT asked again (another item / combination of one list under one stem is padding)
    if (s >= .62 || p >= .6 || (same && s >= .35) || sameEv) return a.slot; } return null; }
function leaks(c, acc, relaxed) { const cs = norm(c.stem), ck = norm(c.options[c.correct_index]); const cev = new Set((c.evidence || []).map((e) => norm(e.quote).slice(0, 80)));
  for (const a of acc) { if (relaxed && (a.evidence || []).some((e) => cev.has(norm(e.quote).slice(0, 80)))) continue;      // two questions about the same sentence necessarily share its words
    const ak = norm(a.options[a.correct_index]), as = norm(a.stem);
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
  profile(pages, field) { return ['You profile lecture material for a quiz generator. For EACH quiz type decide how many DISTINCT, fully answerable questions of that type the pages can sustain. Be conservative and literal: count only what the text itself supports (never outside knowledge), and give 0 when the pages give no real basis. Pages are labelled by ref (e.g. d1p5). Never invent content.',
    `Quiz types:\n${ORDER.map((k) => `- "${k}": ${QT[k][1]}`).join('\n')}\nSubject guess: ${field || 'other'}.\nReturn JSON: {"types":{${ORDER.map((k) => `"${k}":{"capacity":<integer 0-40>,"pages":["d1p3"]}`).join(',')}}}\nPAGES:\n${JSON.stringify(pages)}`]; },
  analyze(pages, field, supplement) { return [`You analyse lecture material to plan a quiz. Be conservative: only claim a task is supported if the pages contain the material. Pages are labelled by ref (e.g. d1p5). Never invent content.`,
    `Task: split the pages into learning OBJECTIVES (each a distinct teachable unit, 1-6 pages), and decide which quiz types the pages genuinely support.\nQuiz types:\n${ORDER.map((k) => `- "${k}": ${QT[k][1]}`).join('\n')}\nExternal knowledge allowed: ${supplement ? 'yes (flag it)' : 'NO'}.\nReturn JSON: {"lecture_character":"<2 sentences>","discipline_guess":"<one of ${Object.keys(FIELD_CUES).join('|')}|other>","objectives":[{"id":"o1","statement":"<in the source language>","pages":["d1p3"],"key_terms":["..."],"capacity":<int 1-4 distinct non-duplicative questions>,"supports":{"basic_recall":{"pages":["d1p3"]},"mechanisms":{"pages":["d1p3"],"task":null}}}],"gaps":["<important topic mentioned but not explained enough>"]}\nUse the page refs EXACTLY as written in PAGES (e.g. d1p3), never "page 3" or "3". The keys under supports must be exactly: ${ORDER.join(', ')}.\nOnly list a type under supports if the cited pages contain what it needs (sequence only if an explicit order exists; scenarios only if a correct case can be written).\nPAGES:\n${JSON.stringify(pages.map((p) => ({ ref: p.ref, text: p.text.slice(0, 6000) })))}`]; },
  generate(slots, pages, st, existing, fb) { const lang = { source: 'Write in the language of the source pages.', ar: 'Write the question text in Arabic (keep technical terms in English).', en: 'Write in English.' }[st.language || 'source'];
    return [`${RULES}\n\n${lang}\nScenario guidance: ${st.field === 'health' ? FIELD_GUIDE.health : FIELD_GUIDE.other}`,
      `Write one question per slot using ONLY the cited pages. External knowledge: ${st.external_mode === 'supplement' ? 'allowed but set uses_external=true' : 'NOT allowed'}.\nAlready accepted (do NOT repeat their purpose/fact/route; do not leak answers):\n${JSON.stringify(existing.slice(-40))}\n${slots.some((s) => s.extra) ? '\nSlots that carry "reinforcement" are EXTRA questions on material that may already have been asked. The topic may overlap with an accepted question, but ask a DIFFERENT specific fact or take the direction named by "angle" (reverse: start from the answer\'s side; other_fact: another fact stated on the pages; not_true: which statement is NOT true; apply: a short applied example of the same facts; compare: contrast two items from the pages; detail: a specific term, number or step) - never a reworded copy of an accepted question. Every other rule still holds: verbatim evidence from the cited pages, one correct option, source only. Do not return such a slot as unwritable just because the topic was covered: vary the angle.' : ''}${slots.some((s) => s.shape) ? '\nA slot\'s "shape" is the question form to use for it, chosen so that the quiz does not repeat one form: write the question in that shape when the cited pages support it (otherwise the closest form of the same type). "material" lists what on those pages supports deep reasoning (states and their findings, phases / groups and their features, statements that can be checked as claims): build scenario and critical-thinking questions on it, so the student has to reason (infer, predict, evaluate a claim), not recall a sentence.' : ''}\nSLOTS:\n${JSON.stringify(slots.map((s) => ({ slot: s.slot, type: s.qtype, format: QT[s.qtype][1], difficulty: s.difficulty, objective: s.objective, pages: s.pages, reinforcement: s.extra ? { variant: s.variant, angle: s.angle } : undefined, shape: s.shape || undefined, material: s.material || undefined, retry_feedback: fb[s.slot] || null })))}\nPAGES:\n${JSON.stringify(pages)}\nReturn JSON: {"questions":[{"slot":<int>,"unwritable_reason":null,"stem":"...","options":["...","...","...","..."],"correct_index":<0-3>,"explanation":"...","purpose":"...","reasoning_pattern":"...","evidence":[{"page":"d1p3","quote":"<verbatim>"}],"uses_external":false}]}\nIf a slot cannot be written correctly: {"slot":n,"unwritable_reason":"<why>"}.`]; },
  verify(q, pages) { return ['You are a strict, independent exam reviewer and test-taker. You see only the source pages and one question WITHOUT its key. Solve it using only the source, then audit it. Be skeptical.',
    `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTION type=${q.qtype}:\n${q.stem}\n${JSON.stringify(q.options)}\nReturn JSON: {"chosen_index":<0-3 or null if undecidable from the source>,"answerable_from_source":<bool>,"single_best_answer":<bool: exactly one defensible option>,"sufficient_data":<bool>,"needs_outside_knowledge":<bool>,"flaws":["<concrete defects>"],"severity":"none"|"minor"|"decisive"}`]; },
  explain(q, pages) { return ['You check whether an explanation is correct and supported by the source pages only.', `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTION: ${q.stem}\nKEY: ${q.options[q.correct_index]}\nEXPLANATION: ${q.explanation}\nReturn JSON: {"explanation_supported":<bool>,"contradicts_source":<bool>,"notes":"<short>"}`]; },
  verifyBatch(items, pages) { return ['You are a strict, independent exam reviewer and test-taker. You see only the source pages and several questions WITHOUT their keys. For EACH question: solve it using only the source, then audit it. Be skeptical; judge each question independently.',
    `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTIONS:\n${JSON.stringify(items.map((x) => ({ id: x.id, type: x.c.qtype, stem: x.c.stem, options: x.c.options })))}\nReturn JSON: {"results":[{"id":<same id>,"chosen_index":<0-3 or null if undecidable from the source>,"answerable_from_source":<bool>,"single_best_answer":<bool>,"sufficient_data":<bool>,"needs_outside_knowledge":<bool>,"flaws":["<concrete defects>"],"severity":"none"|"minor"|"decisive"}]}`]; },
  explainBatch(items, pages) { return ['You check whether each explanation is correct and supported by the source pages only.', `SOURCE PAGES:\n${JSON.stringify(pages)}\nITEMS:\n${JSON.stringify(items.map((x) => ({ id: x.id, question: x.c.stem, key: x.c.options[x.c.correct_index], explanation: x.c.explanation })))}\nReturn JSON: {"results":[{"id":<same id>,"explanation_supported":<bool>,"contradicts_source":<bool>,"notes":"<short>"}]}`]; },
  correction(c, fb) { return [`You are a warm, sharp Arabic-speaking tutor. A student got a multiple-choice question from THEIR OWN lecture wrong (or left it blank). Write the correction so that it sticks: clear, vivid, friendly Modern Standard Arabic.
Rules
1. Faithful: use ONLY what the lecture sentence and the lecture's explanation below say. Add no fact, number, example, cause or definition that is not in them. Creativity lives in the phrasing and in at most ONE short memory hook (a vivid image, a contrast or a tiny mnemonic) built only from the words and ideas of that sentence.
2. Keep the ORIGINAL: the correct answer and every technical term stay in their original language and spelling, exactly as in the lecture, each next to its Arabic meaning, for example: الكهربائية (electrical).
3. Name the correction first: begin with «الصواب: » followed by the correct answer exactly as given.
4. In one clause say why the student's choice does not fit - only if the lecture sentence shows it; otherwise skip it.
5. 2-4 short sentences. Plain text only: no markdown, no lists, no emojis, no greeting, no phrases like "according to the text". Encouraging, never mocking.`,
    `QUESTION: ${c.stem}\nOPTIONS: ${JSON.stringify(c.options)}\nTHE STUDENT ${c.chosen ? 'CHOSE (wrong): ' + c.chosen : 'LEFT IT BLANK'}\nCORRECT ANSWER: ${c.correct}\nTHE LECTURE'S EXPLANATION: ${c.explanation}\nLECTURE SENTENCE (verbatim): ${c.quote || '-'}\n${fb && fb.length ? 'YOUR PREVIOUS ATTEMPT WAS REJECTED: ' + fb.join(' ') + '\n' : ''}Return JSON: {"ar":"<the correction in Arabic>"}`]; },
  cards(pages, n, lang) { return [`You create spaced-repetition flashcards from lecture pages. Each card tests ONE atomic idea; front is a clear self-contained question/concept prompt (no yes/no, no "what does the slide say"); back is a short precise answer (1-3 lines). Only use the pages. No duplicates, no trivia.`,
    `Write up to ${n} cards (fewer if the pages don't support ${n} distinct good ones). Language: ${{ source: 'same as the source', ar: 'Arabic (technical terms in English)', en: 'English' }[lang || 'source']}.\nReturn JSON: {"cards":[{"front":"...","back":"...","page":"d1p3","quote":"<verbatim from that page>"}]}\nPAGES:\n${JSON.stringify(pages)}`]; },
};

// ---------- the ARABIC CORRECTION of a wrong answer: made on demand (never during generation, so a quiz costs nothing more), kept with the attempt.
// The model is free in its phrasing, never in its facts: what comes back is CHECKED - it must be Arabic, it must keep the ORIGINAL (the correct answer, verbatim, when it is short; otherwise one of its key terms),
// and it may not bring a number the lecture does not contain.
const asciiDigits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0);
const numbersIn = (s) => (asciiDigits(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));
const spaced = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cleanFix = (s) => String(s == null ? '' : s).replace(/\*\*|__|`+/g, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
const SHORT_ANSWER = 60;
/** is this explanation written in Arabic? What it QUOTES from the lecture does not count (the same rule as frontend/js/fix.js and services/correction.py) */
const isArabicText = (t) => { const raw = String(t == null ? '' : t), un = raw.replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ').replace(/“[^”]*”/g, ' '); return arRatio(/\p{L}/u.test(un) ? un : raw) > .5; };
function checkCorrection(ar, c) {
  const out = [], t = String(ar || '').trim(), low = spaced(t), correct = String(c.correct || '').trim();
  if (t.length < 30 || t.length > 900) out.push('length');
  if ([...t].filter((ch) => /[؀-ۿ]/.test(ch)).length < 15) out.push('not_arabic');
  if (/[A-Za-z]/.test(correct)) {
    if (correct.length <= SHORT_ANSWER) { if (!low.includes(spaced(correct))) out.push('original_missing'); }
    else { const keys = correct.match(/[A-Za-z][A-Za-z0-9'-]{3,}/g) || []; if (keys.length && !keys.some((k) => low.includes(k.toLowerCase()))) out.push('original_missing'); }
  }
  const known = new Set(numbersIn([c.stem, ...(c.options || []), c.explanation, c.quote].join(' '))); if (numbersIn(t).some((n) => !known.has(n))) out.push('invented_number');
  return out;
}
const CORRECTION_FEEDBACK = { length: 'Keep it between 30 and 900 characters.', not_arabic: 'Write it in Arabic.', original_missing: 'It must contain the correct answer EXACTLY as written in the lecture (original spelling), e.g. after «الصواب: ».', invented_number: 'It contains a number that the lecture sentence and explanation do not contain - remove it.' };
/** the correction in Arabic, or null when the model cannot give one that passes the checks (the page then keeps the plain slip). Errors of the provider are thrown to the caller. */
async function makeCorrection(llm, c) {
  let fb = null, last = null;
  for (let k = 0; k < 2; k++) {
    const [sys, pr] = P.correction(c, fb); let r; try { r = await llm.json('correction', sys, pr); } catch (e) { if (k === 0) throw e; break; }
    const ar = cleanFix(r && typeof r === 'object' ? (r.ar != null ? r.ar : (r.arabic != null ? r.arabic : r.correction)) : r); const bad = checkCorrection(ar, c);
    if (!bad.length) return ar; last = { ar, bad }; fb = bad.map((b) => CORRECTION_FEEDBACK[b]).filter(Boolean);
  }
  if (last && last.bad.length === 1 && last.bad[0] === 'original_missing' && String(c.correct || '').trim().length <= SHORT_ANSWER) { const right = String(c.correct).trim(), lead = /^الصواب\s*[:：]\s*/, fixed = lead.test(last.ar) ? `الصواب: «${right}» — ${last.ar.replace(lead, '')}` : `الصواب: «${right}». ${last.ar}`; if (!checkCorrection(fixed, c).length) return fixed; }      // only the original was forgotten: name it first
  return null;
}

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
/* Size control. Providers differ a lot in what one request may carry (a paid Claude: a lot; Groq's free tier: a few thousand tokens per MINUTE). The pool reports how much of a
 * full-size request the next endpoint can take (`llm.scale()`, 0-1) and answers `too_large` when a request was too big for the provider; the engine builds smaller pieces up front
 * and, when a piece is still refused, splits it (batches in halves, then shorter pages) instead of failing. A llm without scale() is simply "full size". */
const scaleOf = (llm) => { try { const k = llm && typeof llm.scale === 'function' ? +llm.scale() : 1; return k > 0 && k <= 1 ? k : 1; } catch (_) { return 1; } };
const isTooLarge = (e) => !!e && e.code === 'too_large';
const shrinkPages = (pages) => { let any = false; const out = {}; for (const [r, t] of Object.entries(pages)) { if (t.length > 1500) { out[r] = t.slice(0, Math.ceil(t.length / 2)); any = true; } else out[r] = t; } return any ? out : null; };
/* ---------- the lecture PROFILER (an internal agent; the learner never sees it)
 * Which of the ten question types does THIS lecture support, and how many distinct questions of each can it sustain? Two readings are merged: a deterministic one of the lecture's
 * structure (QZE.rules.profile: definitions, numbered steps, lists, numbers, contrasts...) and - when an AI is connected - a dedicated model call that reads the pages and counts
 * what each type can sustain. The planner distributes the questions from this profile (not from a fixed recipe), and the objectives that the profile says support a type carry it. */
const levelOf = (n) => (n <= 0 ? 'none' : n <= 2 ? 'limited' : n <= 5 ? 'good' : 'strong');
const STRUCT_BOUND = new Set(['sequence', 'application', 'not_except']);      // types that need visible structure: a model cannot claim many of them where the text shows none
function normProfile(r, chunk) {
  const raw = r && (r.types || r.profile || r.supported_types || r.capacities); if (!raw || typeof raw !== 'object') return null; const out = {};
  const put = (k, v) => { const t = normType(k); if (!t) return; const o = v && typeof v === 'object' ? v : { capacity: v };
    const n = o.capacity != null ? o.capacity : o.count != null ? o.count : o.n != null ? o.n : o.questions != null ? o.questions : (v === true ? 1 : 0);
    out[t] = { capacity: Math.max(0, Math.min(40, Math.round(+n) || 0)), pages: normRefs(o.pages || o.page || o.refs, chunk) }; };
  if (Array.isArray(raw)) raw.forEach((x) => x && typeof x === 'object' && put(x.type || x.name || x.key, x)); else Object.entries(raw).forEach(([k, v]) => put(k, v));
  return Object.keys(out).length >= 3 ? out : null;      // fewer than three of the ten types named: that is not a profile
}
function mergeAgentProfiles(list) {
  const out = {}; for (const p of list) { if (!p) continue; for (const [t, v] of Object.entries(p)) { const a = out[t] || (out[t] = { capacity: 0, pages: [] }); a.capacity += v.capacity; a.pages.push(...v.pages); } }
  for (const t in out) { out[t].capacity = Math.min(60, out[t].capacity); out[t].pages = [...new Set(out[t].pages)]; }
  return Object.keys(out).length ? out : null;
}
/** structural (deterministic) + agent (model) -> the profile the planner uses. Neither side is trusted blindly: structure-bearing types are bounded by what the text visibly shows,
 *  a strong structural signal is not erased by a model's zero, and no type can sustain more questions than the lecture has words for. */
function reconcileProfile(structural, agent, words) {
  const maxCap = Math.max(2, Math.ceil((words || 0) / 70)); const types = {};
  for (const c of ORDER) {
    const sv = structural && structural.types && structural.types[c], av = agent && agent[c]; let cap = av ? av.capacity : sv ? sv.capacity : 0;
    if (av && sv && STRUCT_BOUND.has(c)) cap = Math.min(cap, sv.capacity * 3 + 3);
    if (av && sv && cap === 0 && sv.capacity >= 6) cap = 2;
    if ((c === 'basic_recall' || c === 'understanding') && words >= 60) cap = Math.max(cap, 1);
    cap = Math.min(cap, maxCap); types[c] = { capacity: cap, level: levelOf(cap), by: av ? 'agent' : 'rules', pages: av && av.pages.length ? av.pages : sv ? (sv.pages || []) : [] };
  }
  return { types, source: agent ? 'agent' : 'rules' };
}
/** "adds what is supported": objectives overlapping the pages the profile names for a type carry that type (enough of them to match its capacity); a type the profile found nothing for is
 *  taken off every objective (when the AI agent, which read the pages, says so), so the planner never builds on it. */
function attachSupports(objectives, profile) {
  for (const c of ORDER) { const t = profile.types[c]; if (!t) continue;
    if (t.capacity <= 0) { if (t.by === 'agent') objectives.forEach((o) => { delete o.supports[c]; }); continue; }      // only the agent's explicit zero takes a type away (keyword cues alone never do)
    const need = Math.min(t.capacity, objectives.length) - objectives.filter((o) => o.supports[c]).length; if (need <= 0 || !(t.pages || []).length) continue; const ps = new Set(t.pages);
    objectives.map((o) => [o, o.pages.filter((p) => ps.has(p))]).filter(([o, ov]) => ov.length && !o.supports[c]).sort((a, b) => b[1].length - a[1].length).slice(0, need).forEach(([o, ov]) => { o.supports[c] = { pages: ov, task: null }; });
  }
  objectives.forEach((o) => { if (!Object.keys(o.supports).length) { o.supports.basic_recall = { pages: o.pages, task: null }; o.supports.understanding = { pages: o.pages, task: null }; } });
}
async function profileChunk(llm, chunk, st, depth = 0) {
  const pg = Object.fromEntries(chunk.map((p) => [p.ref, p.text.slice(0, 1100)])); const [sys, pr] = P.profile(pg, st.field);
  try { return [normProfile(await llm.json('profile', sys, pr), chunk)]; }
  catch (e) {
    if (isTooLarge(e) && depth < 3 && chunk.length > 1) { const mid = Math.ceil(chunk.length / 2); return [...(await profileChunk(llm, chunk.slice(0, mid), st, depth + 1)), ...(await profileChunk(llm, chunk.slice(mid), st, depth + 1))]; }
    return [null];      // the agent only refines: when it fails the structural reading stands (the objective analysis reports real service failures itself)
  }
}
async function profileAgent(llm, pages, st, opts = {}) {
  const k = scaleOf(llm);      // few, large pieces = few requests - but never larger than the provider can take (a provider that did not say is learned from its refusals, as in the analysis)
  const chunks = chunkPages(pages.map((p) => ({ ...p, text: p.text.slice(0, 1100) })), k >= 0.99 ? 30000 : Math.max(2500, Math.round(14000 * k)));
  const parts = await mapLimit(chunks, Math.max(1, opts.concurrency || 1), (chunk) => profileChunk(llm, chunk, st));
  return mergeAgentProfiles(parts.flat());
}
async function analyseChunk(llm, chunk, st, depth = 0) {
  const [sys, pr] = P.analyze(chunk, st.field, st.external_mode === 'supplement');
  try { return [{ r: await llm.json('analyze', sys, pr), chunk }]; }
  catch (e) {
    if (!isTooLarge(e) || depth >= 4) throw e;
    if (chunk.length > 1) { const mid = Math.ceil(chunk.length / 2); return [...(await analyseChunk(llm, chunk.slice(0, mid), st, depth + 1)), ...(await analyseChunk(llm, chunk.slice(mid), st, depth + 1))]; }
    const p = chunk[0]; if (p.text.length < 1200) throw e; return analyseChunk(llm, [{ ...p, text: p.text.slice(0, Math.ceil(p.text.length / 2)) }], st, depth + 1);
  }
}
async function analyse(llm, pages, st, opts = {}) {
  const width = Math.max(1, opts.concurrency || 1); const objectives = [], gaps = [], chars = [], disc = []; let degraded = false;
  const words = pages.reduce((n, p) => n + (p.text.match(/\S+/g) || []).length, 0);
  const agentP = profileAgent(llm, pages, st, opts).catch(() => null);       // runs beside the objective analysis: no extra waiting
  const chunks = chunkPages(pages, Math.max(3000, Math.round(18000 * scaleOf(llm))));
  // the parts of the lecture are independent: they are analysed IN PARALLEL (up to `width` at once) and merged in lecture order, so the result is the same as one after the other
  const done = await mapLimit(chunks, width, async (chunk) => {
    // The model answered, but never with a usable JSON (a thinking model out of room, prose, a cut reply — the pool has already asked again and tried the other providers): this part is split
    // by page instead of failing the whole quiz. Every question still has to pass the same evidence checks. Real service failures (network, keys, credit) are NOT hidden: they propagate.
    try { return { parts: await analyseChunk(llm, chunk, st), chunk }; } catch (e) { if (!e || e.code !== 'bad_json') throw e; return { degraded: true, chunk }; }
  });
  for (const d of done) {
    if (d.degraded) { degraded = true; objectives.push(...fallbackObjectives(d.chunk, st)); continue; }
    for (const { r, chunk: c } of d.parts) {
      objectives.push(...normObjectives(r, c));
      gaps.push(...((r && r.gaps) || []).slice(0, 5)); if (r && r.lecture_character) chars.push(r.lecture_character); if (r && r.discipline_guess) disc.push(r.discipline_guess); } }
  let fallback = degraded;
  if (!objectives.length) { objectives.push(...fallbackObjectives(pages, st)); fallback = objectives.length > 0; }
  objectives.forEach((o, i) => (o.id = 'o' + (i + 1)));
  const agent = await agentP; const R = window.QZE && window.QZE.rules; const structural = R && R.profile ? R.profile(pages, st.field, { semantic: true }) : null;
  const profile = reconcileProfile(structural, agent, words); attachSupports(objectives, profile);
  return { objectives, gaps: gaps.slice(0, 10), lecture_character: fallback ? 'تعذّر على النموذج تقسيم المحاضرة إلى أهداف بصيغة مفهومة، فقُسّمت تلقائيًا بحسب الصفحات؛ تُطبَّق نفس فحوص الدليل والتحقق على كل سؤال.' : chars.slice(0, 2).join(' '),
    discipline_guess: disc.sort((a, b) => disc.filter((x) => x === b).length - disc.filter((x) => x === a).length)[0] || null, fallback, profile };
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
/* Blind solve + explanation audit for a GROUP of questions in 2 LLM calls total (instead of 2 per question). A group the provider finds too large is split in halves
 * (then its source pages shortened) rather than failed. */
/** The blind solve (verify) and the explanation check run AT THE SAME TIME (two separate requests: the blind solver never sees the key or the explanation),
 *  so a batch costs two model round-trips in a row instead of three. The explanation verdict is applied only to questions the blind solve did not already reject. */
async function llmCheckBatch(llm, items, pages, st) {
  const res = items.map(() => []); const byId = (r) => Object.fromEntries((r.results || []).map((x) => [x.id, x])); const exp = items.map(() => []);
  const explain = async (list, pg) => {
    try { const [s, p] = P.explainBatch(list.map(([it]) => it), pg); const e = byId(await llm.json('verify_explanation', s, p));
      list.forEach(([it, k]) => { const r = e[it.id]; if (r && (r.contradicts_source || r.explanation_supported === false)) exp[k].push(iss('explanation_unsupported', 'التفسير غير مدعوم بالمصدر: ' + String(r.notes || '').slice(0, 150))); }); }
    catch (err) {
      if (isTooLarge(err)) { if (list.length > 1) { const mid = Math.ceil(list.length / 2); await explain(list.slice(0, mid), pg); await explain(list.slice(mid), pg); return; } const small = shrinkPages(pg); if (small) return explain(list, small); }
      list.forEach(([, k]) => exp[k].push(iss('verifier_error', 'تعذر تدقيق التفسير.', 'minor'))); }
  };
  const verify = async () => {
    try { const [s, p] = P.verifyBatch(items, pages); return { v: byId(await llm.json('verify', s, p)) }; }
    catch (e) {
      if (isTooLarge(e)) {
        if (items.length > 1) { const mid = Math.ceil(items.length / 2); const [a, b] = await Promise.all([llmCheckBatch(llm, items.slice(0, mid), pages, st), llmCheckBatch(llm, items.slice(mid), pages, st)]); return { done: a.concat(b) }; }
        const small = shrinkPages(pages); if (small) return { done: await llmCheckBatch(llm, items, small, st) };
      }
      return { err: e };
    }
  };
  const [vr] = await Promise.all([verify(), explain(items.map((it, k) => [it, k]), pages)]);
  if (vr.done) return vr.done;                       // the request was too large: the halves were checked (verify and explanation) on their own
  if (vr.err) return items.map(() => [iss('verifier_error', 'فشل التحقق الآلي: ' + (vr.err.message || vr.err))]);
  items.forEach((it, k) => { res[k] = vr.v[it.id] ? judge(vr.v[it.id], it.c, st) : [iss('verifier_error', 'لم يُرجع المدقق نتيجة لهذا السؤال.')]; if (!decisive(res[k])) res[k].push(...exp[k]); });
  return res;
}
/* Pipelined generation (same design as backend/app/services/generator.py): each wave runs up to `concurrency` batches IN
 * PARALLEL (draft -> static validation -> batched blind verification); the merge — duplicate/leak checks against what is
 * already accepted — is sequential, so acceptance order is deterministic. Rejected slots get one retry round. */
async function generate(llm, plan, pagesList, st, progress, opts = {}) {
  const width = Math.max(1, opts.concurrency || 1); const base = opts.base || [];       // base = questions already accepted by earlier rounds (context for duplicates, never returned)
  const pages = Object.fromEntries(pagesList.map((p) => [p.ref, p.text])); const ctx = { pages, field: st.field, language: st.language, allowExternal: st.external_mode === 'supplement', sourceAr: arRatio(pagesList.slice(0, 10).map((p) => p.text).join(' ')) > .4 };
  const acc = [], dropped = [], stats = { drafted: 0, rejected_validation: 0, rejected_verifier: 0, rejected_duplicate: 0, rejected_leak: 0, unwritable: 0, retries: 0 }, fb = {}; let pending = plan.slots.slice();
  const merge = (batch, a, b) => ({ batch, error: null, errBatches: [...(a.errBatches || []), ...(b.errBatches || [])], unwritable: [...a.unwritable, ...b.unwritable], rejected: [...a.rejected, ...b.rejected], survivors: [...a.survivors, ...b.survivors], checks: { ...a.checks, ...b.checks } });
  const work = async (batch, known, k = 1) => {
    const sc = Math.min(k, scaleOf(llm));                       // how much of a full-size request the endpoint that will serve this can take
    const res = { batch, error: null, errBatches: [], unwritable: [], rejected: [], survivors: [], checks: {} };
    const budget = Math.max(2500, Math.round(8000 * Math.max(3, batch.length) * sc)), per = Math.max(1200, Math.round(6000 * sc));      // room for every slot's pages, also in a batch of 5
    const pg = {}; let used = 0; batch.forEach((s) => s.pages.forEach((r) => { if (pages[r] && !pg[r] && used + Math.min(per, pages[r].length) <= budget) { pg[r] = pages[r].slice(0, per); used += pg[r].length; } }));
    const [sys, pr] = P.generate(batch, pg, st, known.slice(-Math.max(6, Math.round(40 * sc))).map((a) => ({ purpose: a.purpose, stem: a.stem.slice(0, 160), type: a.qtype })), fb); let resp;
    try { resp = await llm.json('generate', sys, pr); }
    catch (e) {
      if (isTooLarge(e)) {                                       // the provider refused this size: two smaller batches, or (one slot) shorter pages
        if (batch.length > 1) { const mid = Math.ceil(batch.length / 2); const a = await work(batch.slice(0, mid), known, sc), b = await work(batch.slice(mid), known, sc); return merge(batch, a, b); }
        if (sc > 0.15) return work(batch, known, sc / 2);
      }
      res.errBatches.push({ batch, error: e }); return res; }
    const bySlot = Object.fromEntries((resp.questions || []).map((q) => [q.slot, q]));
    for (const s of batch) { const raw = bySlot[s.slot];
      if (!raw || raw.unwritable_reason) { res.unwritable.push([s, raw ? 'المولّد رفض كتابة السؤال: ' + raw.unwritable_reason : 'لم يُرجع المولّد سؤالًا لهذه الخانة.']); continue; }
      const c = { slot: s.slot, qtype: s.qtype, task: s.task, objective: s.objective, objective_id: s.objective_id, difficulty: s.difficulty, stem: String(raw.stem || '').trim(), options: (raw.options || []).map((o) => String(o).trim()),
        correct_index: Number.isInteger(raw.correct_index) ? raw.correct_index : -1, explanation: String(raw.explanation || '').trim(), purpose: String(raw.purpose || '').trim(), reasoning_pattern: raw.reasoning_pattern || '',
        evidence: (raw.evidence || []).map((e) => ({ page: e.page, quote: String(e.quote || '').trim() })), uses_external: !!raw.uses_external, extra: !!s.extra, variant: s.variant || 0, angle: s.angle || null, pk: pageKey(s.pages) };
      const v = validateQ(c, ctx); let d;
      if (decisive(v)) res.rejected.push([s, 'rejected_validation', v.filter((i) => i.severity === 'decisive').map((i) => i.message)]);
      else if ((d = dupOf(c, known, c.extra)) != null) res.rejected.push([s, 'rejected_duplicate', [`مكرر للسؤال ${d}: ${c.extra ? 'غيّر الحقيقة المسؤول عنها أو اتجاه السؤال (لا نسخة بصياغة أخرى).' : 'غيّر الحقيقة المقيسة وطريقة الاستدلال.'}`]]);
      else if ((d = leaks(c, known, c.extra)) != null) res.rejected.push([s, 'rejected_leak', [`يكشف إجابة سؤال آخر (${d}). أعد الصياغة.`]]);
      else res.survivors.push([s, c, v]); }
    if (res.survivors.length) {
      const items = res.survivors.map(([s, c]) => ({ id: 'q' + s.slot, c, s })); const pgs = {};
      items.forEach((it) => [...it.c.evidence.map((e) => e.page), ...it.s.pages].forEach((r) => { if (pages[r] && !pgs[r] && Object.keys(pgs).length < Math.max(2, Math.round(10 * sc))) pgs[r] = pages[r].slice(0, Math.max(1500, Math.round(5000 * sc))); }));
      const checks = await llmCheckBatch(llm, items, pgs, st); items.forEach((it, k) => (res.checks[it.id] = checks[k]));
    }
    return res;
  };
  const want = opts.want || 0;
  for (let attempt = 1; attempt <= 2 && pending.length; attempt++) {
    if (attempt === 2 && want) {                     // the count is already met (the round asked for a few more than needed): no second round; otherwise retry only what is missing (+ a margin), planned slots first
      if (acc.length >= want) break; const need = want - acc.length, keep = need + Math.min(4, Math.ceil(need * .3)); if (pending.length > keep) { const order = pending.slice().sort((a, b) => (a.extra ? 1 : 0) - (b.extra ? 1 : 0) || a.slot - b.slot); const skip = new Set(order.slice(keep)); pending = pending.filter((x) => !skip.has(x)); skip.forEach((x) => dropped.push({ slot: x.slot, qtype: x.qtype, reasons: fb[x.slot] || ['فشل التحقق'], final: true })); }
    }
    // batch size: 3 slots per request when there are enough lanes to run them all at once; up to 5 when lanes are few (a provider with a low per-minute limit): fewer requests, same questions
    const bs = Math.max(1, Math.round(Math.min(5, Math.max(3, Math.ceil(pending.length / width))) * scaleOf(llm))); const batches = []; for (let i = 0; i < pending.length; i += bs) batches.push(pending.slice(i, i + bs)); pending = [];
    // A ROLLING pool: as soon as one of the `width` lanes finishes a batch it takes the next one (a wave used to wait for its slowest batch). Results are merged strictly in batch order
    // (a finished batch waits until the ones before it have been merged), so the questions accepted - and their order - do not depend on which call happened to be quicker.
    const results = new Array(batches.length); let next = 0, merged = 0;
    const mergeOne = (res) => {
      for (const eb of res.errBatches || []) eb.batch.forEach((s) => dropped.push({ slot: s.slot, qtype: s.qtype, reasons: ['خطأ في خدمة التوليد: ' + (eb.error.message || eb.error)], final: true }));
      stats.drafted += res.survivors.length + res.rejected.length;
      for (const [s, reason] of res.unwritable) { stats.unwritable++; dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [reason] }); }
      for (const [s, key, msgs] of res.rejected) { stats[key]++; fb[s.slot] = msgs; pending.push(s); }
      for (const [s, c, v] of res.survivors) { const vi = res.checks['q' + s.slot] || [];
        if (decisive(vi)) { stats.rejected_verifier++; fb[s.slot] = vi.filter((x) => x.severity === 'decisive').map((x) => x.message); pending.push(s); }
        else if (dupOf(c, base.concat(acc), c.extra) != null || leaks(c, base.concat(acc), c.extra) != null) { stats.rejected_duplicate++; fb[s.slot] = ['تعارض مع سؤال معتمد في الدفعة نفسها.']; pending.push(s); }
        else { c.issues = v.concat(vi); acc.push(c); } }
    };
    const drain = () => { while (merged < batches.length && results[merged]) { mergeOne(results[merged]); results[merged] = null; merged++; progress(attempt === 1 ? 'drafting' : 'retrying', Math.round(100 * acc.length / Math.max(1, plan.slots.length))); } };
    progress(attempt === 1 ? 'drafting' : 'retrying', Math.round(100 * acc.length / Math.max(1, plan.slots.length)));
    const lane = async () => { while (next < batches.length) { const k = next++; results[k] = await work(batches[k], base.concat(acc)); drain(); } };
    await Promise.all(Array.from({ length: Math.min(width, batches.length) }, lane));
    if (pending.length) stats.retries += pending.length;
  }
  pending.forEach((s) => dropped.push({ slot: s.slot, qtype: s.qtype, reasons: fb[s.slot] || ['فشل التحقق'], final: true }));
  return { accepted: acc, dropped, stats };
}
/** Lecture order (by page), but within a page the questions about DIFFERENT sentences come first and a second/third question about the same sentence only after them, so a
 *  reinforcement question never sits right next to the question it echoes. */
function orderQuestions(list) {
  const key = (c) => norm(((c.evidence || [])[0] || {}).quote || c.stem).slice(0, 60); const pages = [...new Set(list.map((c) => c.pk))].sort((a, b) => a - b); const out = [];
  for (const pk of pages) { const g = list.filter((c) => c.pk === pk).sort((a, b) => ORDER.indexOf(a.qtype) - ORDER.indexOf(b.qtype) || a.slot - b.slot); const by = new Map(); g.forEach((c) => { const k = key(c); if (!by.has(k)) by.set(k, []); by.get(k).push(c); });
    const lanes = [...by.values()]; for (let r = 0; lanes.some((l) => l.length > r); r++) lanes.forEach((l) => { if (l[r]) out.push(l[r]); }); }
  return out;
}
/** Deliver the REQUESTED count. The planned slots first; then, for whatever was rejected or unwritable, a top-up round of reinforcement slots (another angle, another fact,
 *  another direction on the least-covered parts of the lecture), each question verified like any other. It stops as soon as the count is met, when a round brings nothing, or when the
 *  service itself keeps failing (no calls wasted); the caller finishes locally if it is still short. */
const TOPUP_ROUNDS = 1;     // one bounded AI round for what was rejected (a little over-asked); anything still missing is finished locally, so the wait and the cost stay bounded
async function generateToCount(llm, plan, pagesList, st, progress, opts = {}) {
  const want = plan.requested || plan.slots.length; const tries = {}; let lastNo = Math.max(0, ...plan.slots.map((s) => s.slot));
  // ask a few more than requested IN THE FIRST ROUND (other angles on the least-covered parts): what the checks reject is usually made up at once, without a second and a third
  // round of requests one after the other (each round = write + check, the slowest part of a quiz). The surplus is dropped below, reinforcement questions first.
  const planned = {}; plan.slots.forEach((s) => { planned[s.objective_id] = (planned[s.objective_id] || 0) + 1; });
  const extra = want >= 5 ? reinforcementSlots(plan.pool || [], planned, Math.min(10, Math.ceil(want * .15)), tries) : [];
  extra.forEach((s) => { s.slot = ++lastNo; s.difficulty = difficultyFor(st, s.qtype); tries[s.objective_id] = (tries[s.objective_id] || 0) + 1; });
  const first = await generate(llm, extra.length ? { ...plan, slots: plan.slots.concat(extra) } : plan, pagesList, st, progress, { ...opts, want });
  const all = { accepted: first.accepted.slice(), dropped: first.dropped.slice(), stats: { ...first.stats, topup_rounds: 0, asked_extra: extra.length } };
  const down = (r) => r.dropped.length > 0 && r.accepted.length === 0 && r.dropped.every((d) => (d.reasons || []).some((x) => /^خطأ في خدمة التوليد/.test(x)));
  if (down(first) || !first.accepted.length) return all;               // the service failed, or nothing the model wrote was usable: more rounds would only repeat that (the caller finishes locally)
  for (let round = 1; round <= TOPUP_ROUNDS && all.accepted.length < want; round++) {
    const deficit = want - all.accepted.length, n = deficit + Math.min(5, Math.ceil(deficit * .3));     // ask a little more than is missing: some will be rejected
    const counts = {}; all.accepted.forEach((c) => { counts[c.objective_id] = (counts[c.objective_id] || 0) + 1; });
    const slots = reinforcementSlots(plan.pool || [], counts, n, tries); if (!slots.length) break;
    slots.sort((a, b) => pageKey(a.pages) - pageKey(b.pages) || ORDER.indexOf(a.qtype) - ORDER.indexOf(b.qtype));
    slots.forEach((s) => { s.slot = ++lastNo; s.difficulty = difficultyFor(st, s.qtype); tries[s.objective_id] = (tries[s.objective_id] || 0) + 1; });
    const sub = (stage, pct) => progress('retrying', Math.min(99, Math.round(100 * (all.accepted.length + (pct / 100) * deficit) / want)));
    const r = await generate(llm, { ...plan, slots, requested: want }, pagesList, st, sub, { ...opts, base: all.accepted });
    all.accepted.push(...r.accepted); all.dropped.push(...r.dropped); for (const k in r.stats) all.stats[k] = (all.stats[k] || 0) + r.stats[k]; all.stats.topup_rounds = round;
    if (down(r) || !r.accepted.length) break;
  }
  if (all.accepted.length > want) {            // exactly the count asked for: the surplus (from asking a little more) goes first among reinforcement questions that carry remarks, then the latest
    const rank = (c) => (c.extra ? ((c.issues || []).some((i) => i.severity === 'minor') ? 2 : 1) : 0); all.accepted.sort((a, b) => rank(a) - rank(b) || a.slot - b.slot); all.accepted = all.accepted.slice(0, want);
  }
  return all;
}
/* ---------------------------------------------------------------- reading a PDF page back into sentences
 * A PDF stores VISUAL lines: a sentence of a handout, a paper or a long bullet is cut at every line end ("are pop-" / "ular"), and the question builder - which reads line by
 * line, the way slides are written - then made questions out of half sentences. reflowLines() puts the visual lines of one page back into paragraphs:
 *  - a line that is cut by a hyphen and continues in lower case is joined without the hyphen ("activ-" + "ities" -> "activities"; "self-" + "aware" keeps its hyphen)
 *  - a line that is as wide as the text column, does not end a sentence and is followed by a lower-case (or digit) start is joined with a space
 *  - never joined: a bullet or a numbered item, a change of font size (a heading), a paragraph gap, and a short line (a slide title, a short bullet)
 *  lines: [{ text, x0, x1, y, h }] in reading order (y grows upwards, as in PDF space). Returns the page text, one paragraph per line. */
const LINE_BULLET = /^[\s ]*(?:[•●▪◦○■□▫‣⁃·*]|[-–—]\s|\(?\d{1,2}[.)]\s|\(?[a-zA-Z][.)]\s|[٠-٩]{1,2}[.)]\s)/;
const KEEP_HYPHEN = /(?:^|[\s(])(self|non|well|multi|co|pre|post|anti|semi|cross|long|short|high|low|full|half|two|three|four|five|first|second|third|real|time|state|trans|inter|intra|extra|over|under|ill|all|x|t|e)-$/i;
const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))] : 0; };
function reflowLines(lines) {
  const L = lines.map((l) => ({ ...l, text: String(l.text || '').replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
  // a bullet glyph alone on its line (Keynote/PowerPoint export) belongs to the line after it
  for (let i = 0; i < L.length - 1; i++) if (/^[•●▪◦○■□▫‣⁃·*–-]$/.test(L[i].text)) { L[i + 1] = { ...L[i + 1], text: L[i].text + ' ' + L[i + 1].text, x0: Math.min(L[i].x0, L[i + 1].x0) }; L.splice(i, 1); i--; }
  // the slide TITLE (the biggest type on the page) comes first, wherever the export put it: Keynote writes it LAST, and the questions then did not know what the slide is about
  const hs = L.map((l) => l.h).filter((x) => x > 0).sort((a, b) => a - b); const med = hs.length >= 3 ? hs[Math.floor(hs.length / 2)] : 0;
  if (med) { const maxH = Math.max(...L.map((l) => l.h || 0)); const big = L.filter((l) => l.h >= med * 1.12 && l.h >= maxH * 0.97 && l.text.split(/\s+/).length <= 12); const at = big.length ? L.indexOf(big[0]) : -1;      // (Keynote titles are only ~15% bigger than the text)
    if (big.length && big.length <= 3 && at > 0 && at >= L.length - 3) { const rest = L.filter((l) => !big.includes(l)); L.length = 0; L.push(...big, ...rest); } }
  if (L.length < 2) return L.map((l) => l.text).join('\n');
  const wide = L.filter((l) => l.text.length >= 25).map((l) => l.x1 - l.x0); const ref = wide.length >= 4 ? pct(wide, 0.85) : 0, maxW = wide.length ? Math.max(...wide) : 0;
  const gaps = []; for (let i = 1; i < L.length; i++) { const g = L[i - 1].y - L[i].y; if (g > 0) gaps.push(g); } const gap = pct(gaps, 0.5) || 0;
  const out = [L[0].text]; let prev = L[0];
  for (let i = 1; i < L.length; i++) {
    const l = L[i], t = out[out.length - 1]; let join = null;
    const sameSize = !prev.h || !l.h || Math.abs(prev.h - l.h) <= Math.max(prev.h, l.h) * 0.15;
    // a line that reaches the edge of the text column: judged against the page's usual line width; on a page of only a few lines (a slide, a short note) only a LONG line
    // that reaches the widest line counts - a short bullet ("filtration of blood plasma") is not a wrapped sentence
    const wPrev = prev.x1 - prev.x0, full = prev.text.length >= 25 && ((ref > 0 && wPrev >= ref * 0.72) || (prev.text.length >= 55 && maxW > 0 && wPrev >= maxW * 0.85));
    const g = prev.y - l.y, paraGap = gap > 0 && g > gap * 1.7, colJump = g < -2;      // a paragraph gap / the next column (or a figure above)
    const ends = /[.!?؟:;؛]["”’)\]]?$/.test(t), lower = /^[a-z]/.test(l.text), latinTail = /[A-Za-z0-9%)\]'’"”,]$/.test(t) && /[A-Za-z]/.test(t.slice(-30));
    if (sameSize && !LINE_BULLET.test(l.text) && !ends) {
      if (/[A-Za-z]{2}-$/.test(t) && lower && (full || !paraGap)) join = KEEP_HYPHEN.test(t) ? '' : 'dehyphen';
      else if (latinTail && (lower || /^[0-9(]/.test(l.text)) && full && !paraGap && (!colJump || lower)) join = ' ';
      else if (/,$/.test(t) && lower && !paraGap && !colJump) join = ' ';
      else if (!/[A-Za-z]/.test(t.slice(-12)) && /[؀-ۿ]/.test(t) && /[؀-ۿ]/.test(l.text.slice(0, 3)) && full && !paraGap && !colJump && l.text.length >= 2) join = ' ';      // Arabic has no case: a full-width line that does not end a sentence continues
    }
    if (join === null) out.push(l.text);
    else out[out.length - 1] = join === 'dehyphen' ? t.slice(0, -1) + l.text : t + join + l.text;
    prev = l;
  }
  return out.join('\n');
}

window.QZE = { reflowLines, checkCorrection, makeCorrection, cleanFix, isArabicText, normRefs, normType, normObjectives, fallbackObjectives, normProfile, mergeAgentProfiles, reconcileProfile, attachSupports, profileAgent, levelOf, STOP, llmCheckBatch, QT, ORDER, detectField, support, buildPlan, analyse, generate, generateToCount, reinforcementSlots, difficultyFor, pageKey, orderQuestions, validateQ, quoteIn, norm, toks, jac, P, mapLimit, arRatio, pn, dupOf, leaks };
})();
