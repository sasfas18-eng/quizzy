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
  const secOf = (o) => ({ section_key: o.section || '', section_label: o.section_label || '' });
  const push = (c, o) => { const sup = o.supports[c] || {}; slots.push({ qtype: c, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages || [], task: sup.task || null, ...secOf(o) }); cap[o.id]--; used.add(o.id + '|' + c); };
  // COVER THE WHOLE LECTURE: each next question goes to the section with the fewest questions so far and, among those, the one FARTHEST from the sections already
  // asked about (so 10 questions over 14 pages reach the end of the lecture instead of piling up on its first pages); then the larger section.
  // a topic continued over several slides («… (continued_3)») is ONE topic: a short quiz reaches more topics before it returns to one
  const topicOf = (o) => o.section || String(o.statement || '').toLowerCase().replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').replace(/[^\p{L}\p{N} ]/gu, '').trim() || o.id; const nTopic = {}; const tUsed = (o) => nTopic[topicOf(o)] || 0;      // the lecture's own section when known (its headings)
  const posOf = Object.fromEntries(objs.map((o, i) => [o.id, i])), nUsed = {}; const far = (o) => { const taken = objs.filter((x) => nUsed[x.id]); return taken.length ? Math.min(...taken.map((x) => Math.abs(posOf[x.id] - posOf[o.id]))) : posOf[o.id] === 0 ? 1e3 : 0; };
  Object.keys(quota).sort((a, b) => pairCap[a] - pairCap[b]).forEach((c) => { let want = quota[c];
    while (want > 0) { const cand = avail[c].filter((o) => cap[o.id] > 0 && !used.has(o.id + '|' + c)); if (!cand.length) break;
      cand.sort((a, b) => (nUsed[a.id] || 0) - (nUsed[b.id] || 0) || tUsed(a) - tUsed(b) || far(b) - far(a) || cap[b.id] - cap[a.id]); const o = cand[0]; push(c, o); nUsed[o.id] = (nUsed[o.id] || 0) + 1; nTopic[topicOf(o)] = tUsed(o) + 1; want--; } });
  // EVERY SECTION ONCE when the count allows it: a section (topic) still without a slot takes one from the section with the most slots (never that section's last one),
  // as a type the uncovered section supports (the same type when it can, else the basic ones)
  { const tSlots = (t) => slots.filter((s) => topicOf(objs.find((o) => o.id === s.objective_id) || {}) === t);
    const topics = [...new Set(objs.map(topicOf))]; const uncovered = topics.filter((t) => !tSlots(t).length);
    for (const t of uncovered) { const donorT = topics.map((x) => [x, tSlots(x).length]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]; if (!donorT) break;
      const o = objs.find((x) => topicOf(x) === t && Object.keys(x.supports || {}).some((c) => avail[c] && !veto[c])); if (!o) continue;
      const give = tSlots(donorT[0]).sort((a, b) => (b.qtype === 'basic_recall' ? 1 : 0) - (a.qtype === 'basic_recall' ? 1 : 0))[0];
      const c = o.supports[give.qtype] && !veto[give.qtype] ? give.qtype : ['basic_recall', 'understanding'].find((x) => o.supports[x] && !veto[x]) || Object.keys(o.supports).find((x) => avail[x] && !veto[x]);
      const sup = o.supports[c] || {}; slots.splice(slots.indexOf(give), 1, { qtype: c, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages || [], task: sup.task || null, ...secOf(o) });
      cap[give.objective_id]++; cap[o.id]--; nUsed[give.objective_id]--; nUsed[o.id] = (nUsed[o.id] || 0) + 1; } }
  let deficit = feasible - slots.length;
  Object.keys(weights).sort((a, b) => weights[b] - weights[a]).forEach((c) => avail[c].slice().sort((a, b) => (nUsed[a.id] || 0) - (nUsed[b.id] || 0) || far(b) - far(a)).forEach((o) => { if (deficit > 0 && cap[o.id] > 0 && !used.has(o.id + '|' + c)) { push(c, o); nUsed[o.id] = (nUsed[o.id] || 0) + 1; deficit--; } }));
  // THE REQUESTED COUNT IS ALWAYS PLANNED. The slots above are the "natural" ones (distinct objective x type pairs within each objective's capacity). When the lecture
  // is thinner than the request, the rest are REINFORCEMENT slots: the same material asked from another angle / another fact / another direction, spread evenly over
  // the lecture. They are still verified against the source like any other question; they are just not required to be about a brand-new topic.
  const pool = objs.map((o) => ({ id: o.id, statement: o.statement, pages: o.pages, section: o.section || '', section_label: o.section_label || '', types: Object.fromEntries(ORDER.filter((c) => o.supports[c] && !veto[c]).map((c) => [c, { pages: o.supports[c].pages || o.pages, task: o.supports[c].task || null }])) }));
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
// (Claude only) the types a short lecture page carries best - the extra and top-up questions take these first: a real 50-question quiz of short slides had 15 of its
// slots refused, all of the demanding kinds (a case, a best answer, an inference) on pages of one-line descriptions, and ended short
const PRODUCTIVE = ['basic_recall', 'understanding', 'mechanisms', 'not_except', 'compare_contrast', 'application'];
function reinforcementSlots(pool, counts, n, tries, opts = {}) {
  const out = []; if (!pool.length || n <= 0) return out; const c = { ...counts }, t = tries || {}; const first = (o) => Math.min(...(o.pages.length ? o.pages.map(pn) : [9999]));
  for (let i = 0; i < n; i++) {
    const o = pool.slice().sort((a, b) => ((c[a.id] || 0) + .5 * (t[a.id] || 0)) - ((c[b.id] || 0) + .5 * (t[b.id] || 0)) || first(a) - first(b))[0];
    let types = Object.keys(o.types).length ? Object.keys(o.types) : ['basic_recall'];
    if (opts.easy) { const no = (opts.refused && opts.refused[o.id]) || new Set(); const ok = types.filter((x) => !no.has(x)); const easy = PRODUCTIVE.filter((x) => ok.includes(x)); types = easy.length ? easy : ok.length ? ok : ['basic_recall']; }
    const k = (c[o.id] || 0) + (t[o.id] || 0); const type = types[k % types.length]; const sup = o.types[type] || {};
    out.push({ qtype: type, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages, task: sup.task || null, extra: true, variant: (c[o.id] || 0) + 1, angle: ANGLES[k % ANGLES.length], section_key: o.section || '', section_label: o.section_label || '' });
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
/** the owner's rules (shared/owner_rules.js: lecture_reader + quiz_engine), when the page loaded them */
const ownerRules = () => { try { const g = typeof window !== 'undefined' ? window : globalThis; return (g && g.QZ_OWNER) || null; } catch (_) { return null; } };
// the same characters in the same order once spaces and punctuation are set aside: a superscript or a hyphenated word the PDF split onto its own line («Ca» «2+» «and…»,
// «Excitation-» «Contraction coupling») is still the lecture's own text, word for word
const SQZ = new Map(); const squeeze = (s) => { const x = String(s || ''); let r = SQZ.get(x); if (r === undefined) { r = norm(x).replace(/[^\p{L}\p{N}%+=<>]/gu, ''); if (SQZ.size >= 5000) SQZ.clear(); SQZ.set(x, r); } return r; };
function quoteIn(quote, text) { const q = norm(quote), t = norm(text); if (q.length < 10) return false; if (t.includes(q)) return true; const qz = squeeze(quote); if (qz.length >= 16 && squeeze(text).includes(qz)) return true; const qt = q.split(' '); if (qt.length < 4) return false;
  const tt = t.split(' '), ts = new Set(tt); if (qt.filter((w) => ts.has(w)).length / qt.length < .92) return false; const n = qt.length, qs = new Set(qt);
  for (let i = 0; i < Math.max(1, tt.length - n + 1); i++) { const w = new Set(tt.slice(i, i + n + 3)); let c = 0; qs.forEach((x) => w.has(x) && c++); if (c / n >= .9) return true; } return false; }
const arRatio = (s) => { const L = [...s].filter((c) => /\p{L}/u.test(c)); return L.length ? L.filter((c) => /[؀-ۿ]/.test(c)).length / L.length : 0; };
const CLIN = /\b(patient|patients|symptom|symptoms|diagnos\w*|clinical\w*|physician|nurse)\b|مريض|مرضى|أعراض|تشخيص|سريري/i;
const NOTRX = /\b(NOT|EXCEPT|FALSE|INCORRECT|LEAST)\b|ما عدا|عدا|غير صحيح|ليس|لا يُعد|لا يعد|خاطئة|الخاطئ/i;
// an option that talks ABOUT the question or the statement (error types, «nothing is wrong», «only student A») instead of being lecture content
const META_OPT = /^(?:it|this|that)\s+(?:negates|swaps|replaces|turns|matches|reverses|contradicts|misstates|over-?generali[sz]es)\b.*\b(?:statement|lecture|claim|key word|sentence|two things|qualified)\b|\badds or drops\b|\b(?:the|this|that)\s+(?:statement|claim|note|sentence)\s+(?:is|was|has|negates|swaps|matches|contains)\b|^nothing\b|\bthe lecture\b|\bmatches the (?:lecture|source|text)\b|^(?:only|both|neither)\s+(?:student|statement|claim)s?\b|^(?:both|neither)\s*$|العبارة|المحاضرة|لا خطأ|الطالب\s*\((?:أ|ب)\)|^(?:كلاهما|لا أحد منهما)/i;
const ALLNONE = /\b(all|none) of the above\b|\bboth [A-D] and [A-D]\b|جميع (?:ما سبق|الإجابات)|كل ما سبق|لا شيء مما سبق|كلاهما/i;
// a word and its family, so that «integrates» meets «integration» and «reflexes» meets «reflex» (a light stemmer: enough to see that a stem names its key)
const SUF = ['ations', 'ation', 'ators', 'ator', 'ating', 'ated', 'ates', 'ate', 'itions', 'ition', 'ions', 'ion', 'ments', 'ment', 'ings', 'ing', 'ies', 'ied', 'ive', 'ory', 'ors', 'or', 'ers', 'er', 'ed', 'es', 'al', 'ly', 's', 'y', 'e'];
const stemW = (w) => { if (/[؀-ۿ]/.test(w)) { const b = w.replace(/^(?:وال|بال|كال|فال|لل|ال)(?=\p{L}{3})/u, ''); const s = b.replace(/(?:ات|ون|ين|ان|يه|ه|ي)$/, ''); return s.length >= 3 ? s : b; }
  for (const s of SUF) if (w.length - s.length >= 4 && w.endsWith(s)) return w.slice(0, -s.length); return w; };
const famToks = (s) => toks(s).filter((t) => t.length > 2 || /^\d+$/.test(t)).map(stemW);
/** the stem names its own key: every word that sets the key apart from the distractors is in the stem, in some form, and so is most of the key («…a nerve pathway called a
 * reflex arc?» → «Reflex»; «…the cortex that integrates and associates sensory information?» → «Integration and association of sensory information»). The words the options
 * share tell nothing, and a number in the stem is context (an age, a count), not the key. */
function keyInStem(stem, opts, ci) { const key = [...new Set(famToks(opts[ci]).filter((t) => !/^\d+$/.test(t)))], others = new Set(opts.filter((_, i) => i !== ci).flatMap(famToks));
  const own = key.filter((t) => !others.has(t)); if (!own.length) return null; const st = new Set(famToks(stem));
  return own.every((t) => st.has(t)) && key.filter((t) => st.has(t)).length >= key.length / 2 ? own : null; }
// the same option twice, but for an article or a full stop («The thalamus» / «Thalamus»)
const optKey = (o) => norm(o).replace(/\.+$/, '').replace(/^(?:the|a|an)\s+/, '').trim();
function validateQ(q, ctx) {
  const out = [], stem = (q.stem || '').trim(), opts = (q.options || []).map((o) => String(o).trim()), ci = q.correct_index;
  if (stem.length < 15) out.push(iss('stem_short', 'نص السؤال قصير جدًا.'));
  if (opts.length !== 4 || opts.some((o) => !o)) { out.push(iss('options_count', 'يجب 4 خيارات غير فارغة.')); return out; }
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) { out.push(iss('key_invalid', 'مفتاح غير صالح.')); return out; }
  const n = opts.map(optKey); if (new Set(n).size < 4) out.push(iss('options_duplicate', 'خياران متطابقان.'));
  if (keyInStem(stem, opts, ci)) out.push(iss('key_in_stem', `نص السؤال يكشف الإجابة: كلمات الخيار الصحيح «${opts[ci].slice(0, 60)}» (أو مشتقاتها) مذكورة في السؤال نفسه. صِف المفهوم دون أن تذكر اسمه أو كلمات الإجابة.`));
  if (opts.some((o) => ALLNONE.test(o))) out.push(iss('all_none_above', 'خيارات «كل ما سبق/لا شيء» غير مسموحة.'));
  if (opts.some((o) => META_OPT.test(o))) out.push(iss('meta_options', 'خيار يصف السؤال أو العبارة بدل أن يكون من محتوى المحاضرة: اكتب الخيارات مصطلحات أو قيمًا أو عبارات من مادة هذا القسم.'));
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
// common(phrase): the lecture uses it on many pages - naming such a phrase gives nothing away
function leaks(c, acc, relaxed, common) { const cs = norm(c.stem), ck = norm(c.options[c.correct_index]); const cev = new Set((c.evidence || []).map((e) => norm(e.quote).slice(0, 80)));
  for (const a of acc) { if (relaxed && (a.evidence || []).some((e) => cev.has(norm(e.quote).slice(0, 80)))) continue;      // two questions about the same sentence necessarily share its words
    const ak = norm(a.options[a.correct_index]), as = norm(a.stem);
    if (ak.split(' ').length >= 3 && ak.length >= 14 && cs.includes(ak) && !(common && common(ak))) return a.slot; if (ck.split(' ').length >= 3 && ck.length >= 14 && as.includes(ck) && !(common && common(ck))) return a.slot; } return null; }

// ---------- prompts (same content as backend/app/services/prompts.py)
const RULES = `You write exam-grade multiple-choice questions for university students from THEIR OWN lecture material.
Quality beats quantity: never invent content. But a slot is a request for a good question on its pages, not a fixed recipe: adapt its form or type to what the pages support (see the slot instructions) before you return it as unwritable.
Hard rules
1. Source only (unless supplement is allowed): every fact needed for the key AND the explanation must be stated in the cited pages. No imported knowledge from other fields (no clinical framing outside health content).
2. Exactly 4 options, exactly 1 correct. THE OPTIONS ARE LECTURE CONTENT: every option is a term, value, finding, mechanism or statement of the SAME KIND as the key (a hormone among hormones, a value among plausible values, a structure among its sibling structures, a phase among phases), taken from this lecture - the same section or a neighbouring one - so that only a student who knows the lecture can rule each one out. Each distractor is a near-miss that is wrong for a reason the lecture itself gives (a sibling concept, a reversed direction, a swapped pair, a neighbouring value); never absurd, never off-topic, never true as well. Options are parallel in grammar, length and specificity. NEVER an option about the question or the statement itself ("it negates the statement", "it swaps two things", "nothing is wrong", "the lecture does not say"), never "all/none of the above", "both", "neither", "only A".
3. Stem self-contained and unambiguous; never say "according to the slide"; never refer to other questions; do not leak other answers; do not put the answer's distinctive words in the stem.
4. Evidence: for each cited page copy ONE VERBATIM quote - the sentence that proves the key (<=220 chars), a line of content, never a heading or a bare label («Astrocytes:»). Quotes are machine-checked; paraphrases fail.
5. Explanation: two or three sentences (<=70 words): why the key is right and why the tempting distractors are wrong, using the source.
6. purpose = a short phrase (<=12 words) naming exactly what this question measures. Questions must not share purpose or reasoning route — no renamed copies.
7. Technical terms stay in their original language when writing Arabic; LaTeX in $...$ only for real formulas.
Difficulty: easy = one step from a statement; medium = 1-2 linked statements; hard = multi-step/close alternatives, still fully answerable from the source.`;
const stripDoc = (s) => s;
// how the blind solver judges the options (a reviewer's taste is a remark, see judge())
const AUDIT_TEXT = "\nweak_options: judge every option as a teacher would; most good questions have none. List an option only when it is clearly weak: about_question = it talks about the question or the statement itself (\"it negates the statement\", \"nothing is wrong\") instead of naming something from the subject - an option that states a fact, a term or a pairing is NOT this; off_topic = nothing to do with this lecture's subject at all (an option from another part of the lecture, which you are not shown, is NOT off_topic); absurd = no student who read the lecture at all would choose it; not_parallel = clearly a different kind from the other options; also_correct = it is also defensible from the source; same_as_other = it means the same as another option. [] when the options are fine.";
const P = {
  profile(pages, field) { return ['You profile lecture material for a quiz generator. For EACH quiz type decide how many DISTINCT, fully answerable questions of that type the pages can sustain. Be conservative and literal: count only what the text itself supports (never outside knowledge), and give 0 when the pages give no real basis. Pages are labelled by ref (e.g. d1p5). Never invent content.',
    `Quiz types:\n${ORDER.map((k) => `- "${k}": ${QT[k][1]}`).join('\n')}\nSubject guess: ${field || 'other'}.\nReturn JSON: {"types":{${ORDER.map((k) => `"${k}":{"capacity":<integer 0-40>,"pages":["d1p3"]}`).join(',')}}}\nPAGES:\n${JSON.stringify(pages)}`]; },
  analyze(pages, field, supplement) { return [`You analyse lecture material to plan a quiz. Be conservative: only claim a task is supported if the pages contain the material. Pages are labelled by ref (e.g. d1p5). Never invent content.`,
    `Task: split the pages into learning OBJECTIVES (each a distinct teachable unit, 1-6 pages), and decide which quiz types the pages genuinely support.\nQuiz types:\n${ORDER.map((k) => `- "${k}": ${QT[k][1]}`).join('\n')}\nExternal knowledge allowed: ${supplement ? 'yes (flag it)' : 'NO'}.\nReturn JSON: {"lecture_character":"<2 sentences>","discipline_guess":"<one of ${Object.keys(FIELD_CUES).join('|')}|other>","objectives":[{"id":"o1","statement":"<in the source language>","pages":["d1p3"],"key_terms":["..."],"capacity":<int 1-4 distinct non-duplicative questions>,"supports":{"basic_recall":{"pages":["d1p3"]},"mechanisms":{"pages":["d1p3"],"task":null}}}],"gaps":["<important topic mentioned but not explained enough>"]}\nUse the page refs EXACTLY as written in PAGES (e.g. d1p3), never "page 3" or "3". The keys under supports must be exactly: ${ORDER.join(', ')}.\nOnly list a type under supports if the cited pages contain what it needs (sequence only if an explicit order exists; scenarios only if a correct case can be written).\nPAGES:\n${JSON.stringify(pages.map((p) => ({ ref: p.ref, text: p.text.slice(0, 6000) })))}`]; },
  generate(slots, pages, st, existing, fb, compact, alongside) { const O = ownerRules(); const guides = O ? `\n\nCATEGORY GUIDES (the owner's quiz_engine; vary the reasoning, not just the opening words):\n${JSON.stringify(Object.fromEntries([...new Set(slots.map((s) => O.TYPE_TO_STYLE[s.type || s.qtype]).filter(Boolean))].map((k) => [k, O.STYLES[k]])))}\nMETHOD:\n${O.METHOD}\n${O.ASSESSMENT_RULES}` : ''; const lang = { source: 'Write in the language of the source pages.', ar: 'Write the question text in Arabic (keep technical terms in English).', en: 'Write in English.' }[st.language || 'source'];
    return [`${RULES}\n\n${lang}\nScenario guidance: ${st.field === 'health' ? FIELD_GUIDE.health : FIELD_GUIDE.other}${guides}`,
      `Write one question per slot using ONLY the cited pages. External knowledge: ${st.external_mode === 'supplement' ? 'allowed but set uses_external=true' : 'NOT allowed'}.\nAlready accepted (do NOT repeat their purpose/fact/route; do not leak answers):\n${JSON.stringify(existing.slice(-40))}\n${alongside && alongside.length ? `Written AT THE SAME TIME by other writers, one question each (you do not see them: do not ask the point of any of these - take another fact of your pages):\n${JSON.stringify(alongside.slice(0, 40))}\n` : ''}${slots.some((s) => s.extra) ? '\nSlots that carry "reinforcement" are EXTRA questions on material that may already have been asked. The topic may overlap with an accepted question, but ask a DIFFERENT specific fact or take the direction named by "angle" (reverse: start from the answer\'s side; other_fact: another fact stated on the pages; not_true: which statement is NOT true; apply: a short applied example of the same facts; compare: contrast two items from the pages; detail: a specific term, number or step) - never a reworded copy of an accepted question. Every other rule still holds: verbatim evidence from the cited pages, one correct option, source only. Do not return such a slot as unwritable just because the topic was covered: vary the angle.' : ''}${slots.some((s) => s.shape) ? '\nA slot\'s "shape" is the SUGGESTED question form, chosen so that the quiz does not repeat one form: use it when the cited pages support it; otherwise use another form of the same type from FORMS that they do support. Name the form you used in "form" (its text, as given). Slots with the same "section" are about one part of the lecture: give each of them a different form AND a different opening (never two stems of one section that start with the same words or differ only in wording), and make each ask about a different point of that section. "material" lists what on those pages supports deep reasoning (states and their findings, phases / groups and their features, statements that can be checked as claims): build scenario and critical-thinking questions on it, so the student has to reason (infer, predict, evaluate a claim), not recall a sentence.' : ''}${slots.some((s) => s.form_tip) ? '\nA slot\'s "form_tip" is a reminder for its form, drawn from what failed before with that form in lectures like this one: follow it.' : ''}${slots.some((s) => s.shape) && !compact ? `\nFORMS (by type):\n${JSON.stringify(Object.fromEntries([...new Set(slots.map((s) => s.qtype))].filter((t) => AI_FORMS[t]).map((t) => [t, AI_FORMS[t]])))}` : ''}${compact ? '\nIf a slot\'s form or type does not fit its pages, adapt it (another form, or another type named in "type"); unwritable only when nothing is assessable.' : '\nNever return a slot as unwritable only because its suggested form, its type or its difficulty does not fit the pages: take another form of the same type; if no form of that type fits, write the best question of ANOTHER type those pages support and name it in "type". The facts of a slot are on its "pages"; PAGES may also hold the other pages of its section, which you may use too. Quote a slot\'s evidence from those pages only: a page of another slot belongs to that slot (each slot asks about its own part of the lecture). Return unwritable only when there is nothing assessable at all.\nBefore you return a question, solve it yourself from the cited pages only, as a careful student who has not seen your key: if a second option is also defensible, or the key needs a fact that is not on the pages, fix the question first - an independent reviewer will do exactly this. Fix it too when the key gives itself away: when it is clearly longer or more detailed than the other options, or when it is the only option that repeats a word of the stem.'}\nSLOTS:\n${JSON.stringify(slots.map((s) => ({ slot: s.slot, type: s.qtype, format: QT[s.qtype][1], difficulty: s.difficulty, objective: s.objective, pages: s.pages, reinforcement: s.extra ? { variant: s.variant, angle: s.angle } : undefined, shape: s.shape || undefined, form_tip: s.form_tip || undefined, section: s.section || undefined, material: s.material || undefined, retry_feedback: fb[s.slot] || null })))}\nPAGES:\n${JSON.stringify(pages)}\nReturn JSON: {"questions":[{"slot":<int>,"unwritable_reason":null,"stem":"...","options":["...","...","...","..."],"correct_index":<0-3>,"explanation":"...","purpose":"...","type":"<the type you wrote>","form":"<the form used>","evidence":[{"page":"d1p3","quote":"<verbatim>"}],"uses_external":false}]}\nIf a slot cannot be written correctly: {"slot":n,"unwritable_reason":"<why>"}.`]; },
  verify(q, pages) { return ['You are a strict, independent exam reviewer and test-taker. You see only the source pages and one question WITHOUT its key. Solve it using only the source, then audit it. Be skeptical.',
    `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTION type=${q.qtype}:\n${q.stem}\n${JSON.stringify(q.options)}\nReturn JSON: {"chosen_index":<0-3 or null if undecidable from the source>,"answerable_from_source":<bool>,"single_best_answer":<bool: exactly one defensible option>,"sufficient_data":<bool>,"needs_outside_knowledge":<bool>,"flaws":["<concrete defects>"],"severity":"none"|"minor"|"decisive"}`]; },
  explain(q, pages) { return ['You check whether an explanation is correct and supported by the source pages only.', `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTION: ${q.stem}\nKEY: ${q.options[q.correct_index]}\nEXPLANATION: ${q.explanation}\nReturn JSON: {"explanation_supported":<bool>,"contradicts_source":<bool>,"notes":"<short>"}`]; },
  verifyBatch(items, pages, compact) { return ['You are a strict, independent exam reviewer and test-taker. You see only the source pages and several questions WITHOUT their keys. For EACH question: solve it using only the source, then audit it. Be skeptical; judge each question independently.' + (ownerRules() ? '\n' + ownerRules().REVIEW_CRITERIA : ''),
    `SOURCE PAGES:\n${JSON.stringify(pages)}\nQUESTIONS:\n${JSON.stringify(items.map((x) => ({ id: x.id, type: x.c.qtype, stem: x.c.stem, options: x.c.options })))}\nReturn JSON: {"results":[{"id":<same id>,"chosen_index":<0-3 or null if undecidable from the source>,"answerable_from_source":<bool>,"single_best_answer":<bool>,"sufficient_data":<bool>,"needs_outside_knowledge":<bool>,"flaws":["<concrete defects>"],"severity":"none"|"minor"|"decisive","weak_options":[{"index":<0-3>,"why":"about_question"|"off_topic"|"absurd"|"not_parallel"|"also_correct"|"same_as_other"}]}]}${compact ? '\nweak_options: only clearly weak options ([] when fine).' : AUDIT_TEXT}`]; },
  explainBatch(items, pages, accepted = []) { return ['You check whether each explanation is correct and supported by the source pages only.' + (accepted.length || items.length > 1 ? ' Also find REPETITION: an item that asks the same fact as an ALREADY ACCEPTED question, or as an earlier item, only in other words (a trivial rewording, the same fact from the other side) - name it in duplicate_of. A different fact about the same topic is NOT a duplicate.' : ''),
    `SOURCE PAGES:\n${JSON.stringify(pages)}${accepted.length ? `\nALREADY ACCEPTED:\n${JSON.stringify(accepted)}` : ''}\nITEMS:\n${JSON.stringify(items.map((x) => ({ id: x.id, question: x.c.stem, key: x.c.options[x.c.correct_index], explanation: x.c.explanation })))}\nReturn JSON: {"results":[{"id":<same id>,"explanation_supported":<bool>,"contradicts_source":<bool>,"corrected_explanation":<null, or - when the explanation is unsupported but the key itself is right by the source - a corrected explanation of two or three sentences from the source only>,"duplicate_of":<null, or the accepted number / earlier item id it repeats>,"notes":"<short>"}]}`]; },
  correction(c, fb) { return [`You are a warm, sharp Arabic-speaking tutor. A student got a multiple-choice question from THEIR OWN lecture wrong (or left it blank). Write the correction so that it sticks: clear, vivid, friendly Modern Standard Arabic.
Rules
1. Faithful: use ONLY what the lecture sentence and the lecture's explanation below say. Add no fact, number, example, cause or definition that is not in them. Creativity lives in the phrasing and in at most ONE short memory hook (a vivid image, a contrast or a tiny mnemonic) built only from the words and ideas of that sentence.
2. Keep the ORIGINAL: the correct answer and every technical term stay in their original language and spelling, exactly as in the lecture, each next to its Arabic meaning, for example: الكهربائية (electrical).
3. Name the correction first: begin with «الصواب: » followed by the correct answer exactly as given.
4. Diagnose the slip: say in one clause what the student's choice really is in the lecture (where the pages name it) and why it does not answer THIS question - the confusion behind it, not a vague "it is wrong". Only if the pages show it; otherwise skip it.
5. 2-4 short sentences. Plain text only: no markdown, no lists, no emojis, no greeting, no phrases like "according to the text". Encouraging, never mocking.`,
    `QUESTION: ${c.stem}\nOPTIONS: ${JSON.stringify(c.options)}\nTHE STUDENT ${c.chosen ? 'CHOSE (wrong): ' + c.chosen : 'LEFT IT BLANK'}\nCORRECT ANSWER: ${c.correct}\nTHE LECTURE'S EXPLANATION: ${c.explanation}\nLECTURE SENTENCE (verbatim): ${c.quote || '-'}\n${c.pages && Object.keys(c.pages).length ? 'LECTURE PAGES (the only other source you may use):\n' + JSON.stringify(c.pages) + '\n' : ''}${fb && fb.length ? 'YOUR PREVIOUS ATTEMPT WAS REJECTED: ' + fb.join(' ') + '\n' : ''}Return JSON: {"ar":"<the correction in Arabic>"}`]; },
  // THE TUTOR AFTER A QUESTION: the student asks about ONE question of their own lecture (why their choice is wrong, a simpler explanation, anything about it) and is
  // answered from that lecture's pages only - an answer the pages do not hold is said to be absent, never supplied from elsewhere
  tutor(c, ask, history, fb) { return [`You are a warm, sharp Arabic-speaking tutor. A student is reviewing ONE multiple-choice question from THEIR OWN lecture and asks you about it.
Rules
1. Use ONLY the lecture pages, the question and its explanation below. Add no fact, number, example, cause or definition that is not in them. If the pages do not answer what the student asks, say so plainly in one sentence and point to what the pages do say on it.
2. Keep every technical term in its original language and spelling, next to its Arabic meaning where useful, for example: الكهربائية (electrical).
3. Answer exactly what was asked, like a good teacher: concrete, step by step when it helps, at most ONE short memory hook built from the lecture's own words.
4. 2-5 short sentences of clear Modern Standard Arabic. Plain text only: no markdown, no lists, no emojis, no greeting. Encouraging, never mocking.`,
    `QUESTION: ${c.stem}\nOPTIONS: ${JSON.stringify(c.options)}\nCORRECT ANSWER: ${c.correct}\nTHE STUDENT ${c.chosen ? (c.chosen === c.correct ? 'CHOSE (correct): ' : 'CHOSE (wrong): ') + c.chosen : 'LEFT IT BLANK'}\nTHE LECTURE'S EXPLANATION: ${c.explanation}\nLECTURE SENTENCE (verbatim): ${c.quote || '-'}\nLECTURE PAGES:\n${JSON.stringify(c.pages || {})}\n${(history || []).length ? 'THE CONVERSATION SO FAR:\n' + history.map((t) => `STUDENT: ${t.q}\nTUTOR: ${t.a}`).join('\n') + '\n' : ''}STUDENT ASKS: ${ask}\n${fb && fb.length ? 'YOUR PREVIOUS ANSWER WAS REJECTED: ' + fb.join(' ') + '\n' : ''}Return JSON: {"ar":"<your answer in Arabic>"}`]; },
  // A SIMILAR QUESTION TO CHECK ONESELF: the same idea from another angle, from the same pages, answered on the spot
  similar(c, fb) { return [`You write ONE new multiple-choice question for a student who has just studied a question from THEIR OWN lecture. It checks the SAME idea from a DIFFERENT angle (another direction, another related fact of the same point, a short case) - never a rewording of the original, never the same answer asked the same way.
Rules: ONLY from the lecture pages below; exactly 4 options, one clearly correct; the 3 wrong options are close, plausible terms or ideas from the same lecture (no "all/none of the above", no jokes); the question in the SAME language as the original question; "quote": copy, word for word, the line of the pages that proves the answer; "page": that page's key; "explanation": 1-2 sentences in Arabic, technical terms in their original language.`,
    `ORIGINAL QUESTION: ${c.stem}\nORIGINAL OPTIONS: ${JSON.stringify(c.options)}\nORIGINAL ANSWER: ${c.correct}\nLECTURE PAGES:\n${JSON.stringify(c.pages || {})}\n${fb && fb.length ? 'YOUR PREVIOUS QUESTION WAS REJECTED: ' + fb.join(' ') + '\n' : ''}Return JSON: {"stem":"...","options":["...","...","...","..."],"correct_index":0,"explanation":"...","quote":"...","page":"<page key>"}`]; },
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
const knownNumbers = (c) => new Set(numbersIn([c.stem, ...(c.options || []), c.explanation, c.quote, ...Object.values(c.pages || {})].join(' ')));      // what the lecture itself contains
function checkCorrection(ar, c) {
  const out = [], t = String(ar || '').trim(), low = spaced(t), correct = String(c.correct || '').trim();
  if (t.length < 30 || t.length > 900) out.push('length');
  if ([...t].filter((ch) => /[؀-ۿ]/.test(ch)).length < 15) out.push('not_arabic');
  if (/[A-Za-z]/.test(correct)) {
    if (correct.length <= SHORT_ANSWER) { if (!low.includes(spaced(correct))) out.push('original_missing'); }
    else { const keys = correct.match(/[A-Za-z][A-Za-z0-9'-]{3,}/g) || []; if (keys.length && !keys.some((k) => low.includes(k.toLowerCase()))) out.push('original_missing'); }
  }
  const known = knownNumbers(c); if (numbersIn(t).some((n) => !known.has(n))) out.push('invented_number');
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

// ---------- THE TUTOR and THE SIMILAR QUESTION after any question: asked on demand (never during generation), checked like the correction - Arabic, no number the
// lecture does not contain; the similar question must quote its pages word for word and be a new question, not the original reworded.
function checkTutor(ar, c) { const out = [], t = String(ar || '').trim(); if (t.length < 20 || t.length > 1200) out.push('length'); if ([...t].filter((ch) => /[؀-ۿ]/.test(ch)).length < 15) out.push('not_arabic');
  const known = knownNumbers(c); if (numbersIn(t).some((n) => !known.has(n))) out.push('invented_number'); return out; }
const TUTOR_FEEDBACK = { length: 'Keep it between 20 and 1200 characters.', not_arabic: 'Write it in Arabic.', invented_number: 'It contains a number that the lecture pages do not contain - remove it.' };
async function makeTutorReply(llm, c, ask, history) {
  let fb = null; const hist = (history || []).slice(-4).map((t) => ({ q: String(t.q || '').slice(0, 300), a: String(t.a || '').slice(0, 600) })); const q = String(ask || '').trim().slice(0, 300); if (!q) return null;
  for (let k = 0; k < 2; k++) { const [sys, pr] = P.tutor(c, q, hist, fb); let r; try { r = await llm.json('tutor', sys, pr); } catch (e) { if (k === 0) throw e; break; }
    const ar = cleanFix(r && typeof r === 'object' ? (r.ar != null ? r.ar : r.answer) : r); const bad = checkTutor(ar, c); if (!bad.length) return ar; fb = bad.map((b) => TUTOR_FEEDBACK[b]).filter(Boolean); }
  return null;
}
// ---------- THE FIGURE READER (reading a lecture): Claude SEES a slide that carries a large picture and judges, with great care, whether the picture holds lecture
// information the slide's text does not (a labelled diagram, a table, a chart, a flowchart, text set in an image) - and then copies ONLY what is written in it.
// Two independent looks: the reader, then a checker that confirms every line is really written in the image; the code then drops credits, links, logos and what
// the slide's text already says. Nothing from Claude's own knowledge: an unlabelled part stays unnamed. Precision before recall: in any doubt, nothing is added.
const FIG = { MIN_CONF: 0.75, MAX_LINES: 16, MAX_LEN: 160 };
const FIG_SKIP_KIND = new Set(['decorative', 'logo']);
const FIG_CREDIT = /©|\bcopyright\b|\ball rights reserved\b|\bsource\s*:|\badapted from\b|\bcourtesy of\b|\breprinted\b|https?:\/\/|www\.|\.(com|org|net|edu)\b|\bshutterstock\b|\bgetty images\b|\bwikimedia\b|\bpearson\b|\bmcgraw|\belsevier\b|\bwiley\b/i;
const FIG_SYS = `You are the figure reader of a quiz app for university lectures. You SEE one slide (page) of a lecture as an image, with the text already extracted from it.
Decide, with extreme care, whether a figure on this slide (a labelled diagram or drawing, a table, a chart, a flowchart, a photo with labels, text set inside a picture) carries lecture information that the extracted text does NOT already contain and that belongs to this lecture's subject - and transcribe exactly that information.
Rules:
- Transcribe ONLY words and numbers you can actually read in the image: labels, callouts, table cells, axis titles, legends, steps of a flowchart. Copy them exactly as written, in the image's language and spelling.
- NEVER name or describe anything from your own knowledge: a part with no label stays unnamed; do not explain the figure; add no fact; do not guess a label that is blurred, cut off or hidden - leave it out.
- Leave out: what the extracted text already says, logos, institution or lecturer names, slide numbers, watermarks, copyright lines, source credits, decorative pictures, and anything unrelated to this lecture's subject.
- Keep the figure's own structure: one line per label; a table row by row, its cells joined with " — "; a flowchart step by step in its order, joined with " → "; a chart as its written title and its categories with their written values.
- "important" is true only when the written content of the figure teaches something of this slide's topic (parts, names, steps, values, comparisons) that the text lacks. A picture with no readable lecture text, a decoration, or one that only repeats the slide's text is NOT important.
Return JSON: {"important": true|false, "kind": "labelled_diagram|table|chart|flowchart|text_image|photo|decorative|logo|other", "title": "the figure's own title only if it is written in the figure, else null", "lines": ["..."], "confidence": 0.0-1.0, "reason": "one short sentence"}`;
const FIG_CHECK_SYS = `You check, strictly, another reader's transcription of a figure in a lecture slide (the slide is attached as an image).
For each numbered candidate line answer: "written" - is this text (the same words; small differences of spacing, case or punctuation allowed) actually written in the image and clearly legible? and "lecture" - is it lecture content (not a logo, credit, watermark, slide number or decoration)?
If you cannot clearly read it in the image, "written" is false. Do not judge whether it is true - only whether it is written there.
Return JSON: {"checks": [{"i": 0, "written": true|false, "lecture": true|false}]}`;
// THE LAYOUT READING (same reader, another task): a slide whose text the PDF gave back in scattered pieces - a diagram of text boxes, a table, two columns - says
// what it says by its ARRANGEMENT (which cause goes with which disorder, the order of a flow). Claude, seeing the slide, writes that arrangement back in lines made
// ONLY of the slide's own words; the code refuses any line with a word the slide does not carry, and the second look confirms each pairing / order on the image.
const LAYOUT_SYS = `You are the layout reader of a quiz app for university lectures. You SEE one slide of a lecture as an image. Its text was extracted from the file in scattered pieces (given below), because the slide is a diagram of text boxes, a table, or text in columns - so the pieces lose what the arrangement says.
Write the slide's content back as the arrangement shows it, with extreme care:
- Use ONLY words written on the slide (the extracted pieces are those words). Add no word of your own, no explanation, no fact from your own knowledge.
- A table: one line per row, its cells joined with " — " (e.g. "Respiratory Acidosis — inadequate ventilation"), the header row first if there is one.
- A diagram or flowchart: one line per relation it draws, parts joined with " → " in the order of the arrows, or "A: B, C" for a box and what it contains.
- Text in columns or beside a figure: each column's sentence or point whole, as one line.
- Leave out logos, slide numbers, credits, and any piece you cannot place with certainty.
"important" is true only when the arrangement says something the scattered pieces alone do not (pairings, order, grouping). If the slide is a plain list or plain sentences, it is false.
Return JSON: {"important": true|false, "kind": "table|diagram|flowchart|columns|other", "title": null, "lines": ["..."], "confidence": 0.0-1.0, "reason": "one short sentence"}`;
const FIG_CHECK_LAYOUT = `\nThese lines RESTATE the slide's own words in its arrangement: "written" is true only when every word of the line is on the slide AND the pairing, grouping or order the line states is exactly what the slide shows (the same row, the same box, the same arrow).`;
const figPrompt = (c) => [`LECTURE: ${String(c.title || '').slice(0, 160)}`, `SLIDE ${c.page_no} - ITS EXTRACTED TEXT:\n${String(c.text || '(none)').slice(0, 2500)}`,
  c.before ? `PREVIOUS SLIDE TEXT:\n${String(c.before).slice(0, 1200)}` : '', c.after ? `NEXT SLIDE TEXT:\n${String(c.after).slice(0, 1200)}` : '', `The image of slide ${c.page_no} is attached.`].filter(Boolean).join('\n\n');
/** what of a figure reading may be added to its slide: the lines that pass the code's own checks (never what the slide says already, never a credit) - [] when nothing.
 *  layout: the slide's own words re-arranged - every word of a line must be on the slide, and a line that is just one of its extracted lines adds nothing */
function checkFigure(r, c, layout) {
  if (!r || typeof r !== 'object' || r.important !== true || FIG_SKIP_KIND.has(String(r.kind || '').toLowerCase())) return [];
  const conf = Number(r.confidence); if (!(conf >= FIG.MIN_CONF)) return [];
  const have = norm(c.text || ''), haveT = new Set(toks(c.text || '')); const seen = new Set(), out = [];
  for (const raw of [r.title, ...(Array.isArray(r.lines) ? r.lines : [])]) {
    const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim(); if (!t || t.length > (layout ? 2 * FIG.MAX_LEN : FIG.MAX_LEN) || !/\p{L}{2}/u.test(t) || FIG_CREDIT.test(t)) continue;
    const n = norm(t); if (!n || seen.has(n)) continue; const tt = toks(t);
    if (layout) { const own = new Set((String(c.text || '').split('\n')).map(norm)); if (own.has(n) || !tt.length || tt.some((w) => !haveT.has(w)) || tt.length < 2) continue; }      // only the slide's words, and more than one of its pieces
    else { if (have.includes(n)) continue; if (tt.length && tt.every((w) => haveT.has(w))) continue; }      // every word of it is on the slide already: nothing new
    seen.add(n); out.push(t); if (out.length >= FIG.MAX_LINES) break; }
  return out;
}
/** read the figure of one slide (images: the slide's picture), then have every line confirmed by a second look; resolves the lines to add ([] when nothing) */
async function readFigure(llm, c, images, mode) { const layout = mode === 'layout';
  const r = await llm.json('figure', layout ? LAYOUT_SYS : FIG_SYS, figPrompt(c), { images }); const lines = checkFigure(r, c, layout); if (!lines.length) return { lines: [], kind: r && r.kind, reason: (r && r.reason) || '' };
  let v; try { v = await llm.json('figure_check', FIG_CHECK_SYS + (layout ? FIG_CHECK_LAYOUT : ''), `SLIDE ${c.page_no} TEXT:\n${String(c.text || '(none)').slice(0, 1500)}\n\nCANDIDATE LINES:\n${lines.map((l, i) => `${i}. ${l}`).join('\n')}`, { images }); }
  catch (e) { return { lines: [], kind: r.kind, reason: 'not confirmed' }; }      // no second look: nothing is added (precision before recall)
  const ok = new Set(((v && v.checks) || []).filter((x) => x && x.written === true && x.lecture !== false).map((x) => Number(x.i)));
  return { lines: lines.filter((_, i) => ok.has(i)), kind: r.kind, reason: r.reason || '' };
}
// ---------- THE LECTURE EXPLAINED, SLIDE BY SLIDE (on demand): a good teacher's explanation of ONE slide, in Arabic with every technical term kept in English -
// its big idea, its points each tied to the slide line it explains, the terms, what to remember for the exam, and one quick question to check oneself (retrieval
// is what fixes understanding). Free in its words, never in its facts: every point quotes its slide, no number the slides do not hold, nothing from outside.
const EXPLAIN_LEVEL = {
  simple: 'LEVEL: SIMPLE - for a student meeting this for the first time: plain words, short sentences, one idea at a time, an everyday comparison only when it truly helps (marked as a comparison, and never adding a fact).',
  deep: 'LEVEL: DEEP - for a student who wants to understand WHY: the mechanism and the relations between the points (cause -> effect, structure -> function, step -> next step), as far as the slide itself states them.',
  exam: 'LEVEL: EXAM - for a student revising before an exam: crisp, high-yield, the distinctions, numbers and lists that are typically asked, how not to confuse look-alike terms - all from the slide.' };
P.explain = (c, level, fb) => [`You are an outstanding university teacher who explains a lecture SLIDE BY SLIDE to an Arabic-speaking student, the way the best tutors do: clear, warm, precise, engaging.
You explain ONE slide (its text below; the slides before and after are given only so the explanation connects).
Rules
1. Use ONLY what the slide says (and, for connection, the neighbouring slides). Add no fact, number, cause, example, definition or clinical detail that is not on them. If the slide is only a title, say what part of the lecture it opens.
2. Write the explanation in clear Modern Standard Arabic, keeping EVERY technical term in its original English spelling, with its Arabic meaning next to it where helpful, e.g. الترشيح (filtration).
3. "points": 2-6 points in teaching order. Each point explains ONE line or idea of the slide and gives "quote": that line copied EXACTLY from the slide text (a whole line or an exact part of it). Explain, do not just translate.
4. "terms": the slide's key English terms (copied exactly as on the slide) with a short Arabic meaning.
5. "remember": 1-2 short Arabic sentences - what a student must remember from this slide for the exam.
6. "check": ONE quick multiple-choice question that checks the slide's most important idea, written in the language of the slide, 4 options, one clearly correct from the slide; "quote" = the exact slide line that answers it; "why" = one Arabic sentence. Use null if the slide has nothing to ask.
7. Plain text inside the fields: no markdown, no emojis.
8. PICTURES. ${c.images && c.images.length ? `The slide itself is attached as an image. Judge its pictures: where a picture carries WRITTEN lecture content (labels, a table, values, the steps of a diagram), explain that content as part of the slide - such a point has "from_picture": true and "quote": the words as written in the picture. Ignore decorative pictures, photos without labels, logos and credits. Never describe what a picture shows beyond what is written in it.` : `You do not see the slide's pictures: never describe, explain or refer to a picture, figure, diagram or image of the slide, even if its text mentions one.`}
9. The check question must be answerable from the slide's TEXT${c.images && c.images.length ? ' and the words written in its pictures' : ''} - never a question that needs looking at a picture (no "in the figure", "the image shows", "which structure is labelled", "what does the arrow point to").
${EXPLAIN_LEVEL[level] || EXPLAIN_LEVEL.simple}`,
  `LECTURE: ${String(c.title || '').slice(0, 160)}\nSLIDE ${c.page_no}${c.total ? ' OF ' + c.total : ''}:\n${String(c.text || '').slice(0, 3500)}${c.before ? `\n\nPREVIOUS SLIDE (for connection only):\n${String(c.before).slice(0, 900)}` : ''}${c.after ? `\n\nNEXT SLIDE (for connection only):\n${String(c.after).slice(0, 900)}` : ''}${fb ? `\n\nYOUR PREVIOUS ANSWER WAS REFUSED: ${fb}` : ''}
Return JSON: {"idea": "the slide's big idea in one Arabic sentence", "points": [{"ar": "...", "quote": "...", "from_picture": false}], "terms": [{"en": "...", "ar": "..."}], "remember": ["..."], "check": {"stem": "...", "options": ["...", "...", "...", "..."], "correct_index": 0, "quote": "...", "why": "..."} }`];
const inSlide = (q, text) => { const a = plainWords(q); return a.split(' ').filter(Boolean).length >= 2 && plainWords(text).includes(a); };
// a check question the student could answer only by looking at a picture (the explanation page shows the slide's text; a picture may be missing on their device)
const PICTURE_Q = /\b(figure|fig\.|image|picture|photo|diagram|illustration|shown|labell?ed|label|arrow|the drawing|micrograph|this graph)\b|الصورة|الشكل|الرسم|المخطط|السهم|الموضح|المبين/i;
/** a slide's explanation, checked: what is wrong is listed (sent back once), what is merely unusable (a term not on the slide) is dropped. Returns {x, bad} */
function checkExplain(r, c) {
  const bad = []; const known = knownNumbers({ pages: { a: c.text, b: c.before || '', d: c.after || '' } }); const invented = (t) => numbersIn(t).some((n) => !known.has(n));
  const clean = (t) => String(t == null ? '' : t).replace(/[*#`_]{1,3}/g, '').replace(/\s+/g, ' ').trim();
  if (!r || typeof r !== 'object') return { x: null, bad: ['shape'] };
  const idea = clean(r.idea); if (idea.length < 8 || !isArabicText(idea) || invented(idea)) bad.push('idea');
  const thin = (String(c.text || '').match(/\p{L}+/gu) || []).length < 8;
  const pic = !!(c.images && c.images.length);      // the slide was seen as an image: a point may explain what is WRITTEN in its picture (no number the slides' text does not hold)
  const points = (Array.isArray(r.points) ? r.points : []).map((p) => ({ ar: clean(p && p.ar), quote: clean(p && p.quote), ...(pic && p && p.from_picture === true ? { pic: true } : {}) })).filter((p) => p.ar);
  const okPoints = points.filter((p) => p.ar.length >= 12 && p.ar.length <= 600 && isArabicText(p.ar) && !invented(p.ar) && (p.pic ? p.quote.length >= 2 && !invented(p.quote) : inSlide(p.quote, c.text)));
  if (!thin && okPoints.length < Math.min(2, points.length || 2)) bad.push(points.some((p) => !inSlide(p.quote, c.text)) ? 'quote' : points.some((p) => invented(p.ar)) ? 'number' : 'points');
  const terms = (Array.isArray(r.terms) ? r.terms : []).map((t) => ({ en: clean(t && t.en), ar: clean(t && t.ar) })).filter((t) => t.en && t.ar && t.en.length <= 80 && plainWords(c.text).includes(plainWords(t.en)) && !invented(t.ar)).slice(0, 10);
  const remember = (Array.isArray(r.remember) ? r.remember : [r.remember]).map(clean).filter((t) => t && isArabicText(t) && !invented(t)).slice(0, 2);
  let check = null; const k = r.check;
  if (k && typeof k === 'object') { const o = (Array.isArray(k.options) ? k.options : []).map(clean); const ci = Number(k.correct_index);
    if (clean(k.stem).length >= 8 && !PICTURE_Q.test(clean(k.stem)) && o.length === 4 && o.every(Boolean) && new Set(o.map(plainWords)).size === 4 && Number.isInteger(ci) && ci >= 0 && ci <= 3 && inSlide(k.quote, c.text) && !invented([k.stem, o[ci]].join(' ')))      /* (a wrong option may carry a wrong number: that is what makes it wrong) */
      check = { stem: clean(k.stem), options: o, correct_index: ci, quote: clean(k.quote), why: isArabicText(clean(k.why)) && !invented(clean(k.why)) ? clean(k.why) : '' }; }
  return { x: { idea, points: okPoints.slice(0, 6), terms, remember, check }, bad };
}
const EXPLAIN_FEEDBACK = { shape: 'Return the JSON object asked for.', idea: 'Give the big idea as one Arabic sentence, with no number the slide does not hold.', quote: 'Every point must quote a line copied EXACTLY from the slide text.', number: 'A point contains a number the slide does not hold - remove it.', points: 'Give 2-6 Arabic points, each explaining a line of the slide and quoting it exactly.' };
/** the explanation of one slide at one level (one retry with the reason); null when no sound explanation came */
async function makeExplain(llm, c, level) {
  let fb = null, last = null;
  for (let k = 0; k < 2; k++) { const [sys, pr] = P.explain(c, level, fb); let r; try { r = await llm.json('explain_slide', sys, pr, c.images && c.images.length ? { images: c.images } : undefined); } catch (e) { if (k === 0) throw e; break; }
    const { x, bad } = checkExplain(r, c); if (x && !bad.length) return x; if (x && x.idea && !bad.includes('idea')) last = x; fb = bad.map((b) => EXPLAIN_FEEDBACK[b]).join(' '); }
  return last && (last.points.length || (String(c.text || '').match(/\p{L}+/gu) || []).length < 8) ? last : null;      // the second try still short: what passed is kept (never a point that failed its check)
}
/** a student's question about a slide (or a phrase they selected on it): the tutor's answer, from that slide and its neighbours only */
P.slideAsk = (c, ask, history, sel) => [`You are a warm, sharp Arabic-speaking tutor. A student is studying ONE slide of THEIR OWN lecture and asks you about it${sel ? ', about a phrase they selected on it' : ''}.
Rules
1. Use ONLY the slide and its neighbouring slides below. Add no fact, number, example, cause or definition that is not in them. If they do not answer it, say so plainly in one sentence and point to what the slide does say.
2. Keep every technical term in its original language and spelling, next to its Arabic meaning where useful.
3. Answer exactly what was asked, like a good teacher: concrete, step by step when it helps.
4. 2-5 short sentences of clear Modern Standard Arabic. Plain text only: no markdown, no lists, no emojis, no greeting.`,
  `SLIDE ${c.page_no}:\n${String(c.text || '').slice(0, 3500)}${c.before ? `\n\nPREVIOUS SLIDE:\n${String(c.before).slice(0, 900)}` : ''}${c.after ? `\n\nNEXT SLIDE:\n${String(c.after).slice(0, 900)}` : ''}
${(history || []).map((t) => `STUDENT: ${t.q}\nTUTOR: ${t.a}`).join('\n')}${sel ? `\nSELECTED ON THE SLIDE: «${sel}»` : ''}\nSTUDENT ASKS: ${ask}\nReturn JSON: {"ar": "..."}`];
async function makeSlideAnswer(llm, c, ask, history, sel) {
  const q = String(ask || '').trim().slice(0, 300), s = String(sel || '').trim().slice(0, 300); if (!q && !s) return null;
  const hist = (history || []).slice(-4).map((t) => ({ q: String(t.q || '').slice(0, 300), a: String(t.a || '').slice(0, 600) })); const ctx = { pages: { a: c.text, b: c.before || '', d: c.after || '' } };
  let fb = null;
  for (let k = 0; k < 2; k++) { const [sys, pr0] = P.slideAsk(c, q || 'اشرح لي هذا', hist, s); const pr = fb ? pr0 + `\n\nYOUR PREVIOUS ANSWER WAS REFUSED: ${fb}` : pr0; let r; try { r = await llm.json('slide_ask', sys, pr); } catch (e) { if (k === 0) throw e; break; }
    const ar = cleanFix(r && typeof r === 'object' ? (r.ar != null ? r.ar : r.answer) : r); const bad = checkTutor(ar, ctx); if (!bad.length) return ar; fb = bad.map((b) => TUTOR_FEEDBACK[b]).filter(Boolean).join(' '); }
  return null;
}
const plainWords = (s) => String(s || '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function checkSimilar(x, c) {
  const out = []; if (!x || typeof x.stem !== 'string' || x.stem.trim().length < 10) return ['stem'];
  const o = Array.isArray(x.options) ? x.options.map((v) => String(v == null ? '' : v).trim()) : []; if (o.length !== 4 || o.some((v) => !v) || new Set(o.map(plainWords)).size !== 4) out.push('options');
  const k = Number(x.correct_index); if (!(Number.isInteger(k) && k >= 0 && k <= 3)) out.push('key');
  const a = new Set(plainWords(x.stem).split(' ')), b = new Set(plainWords(c.stem).split(' ')); let same = 0; a.forEach((w) => b.has(w) && same++);
  if (same / Math.max(1, Math.min(a.size, b.size)) > 0.8 && plainWords(o[k] || '') === plainWords(c.correct)) out.push('same_question');
  const nq = plainWords(x.quote); const pages = c.pages || {}; const hit = Object.entries(pages).find(([, t]) => nq.split(' ').length >= 4 && plainWords(t).includes(nq));
  if (!hit) out.push('quote'); else x.page = hit[0];
  if (!String(x.explanation || '').trim()) out.push('explanation');
  const known = knownNumbers(c); if (numbersIn([x.stem, ...o, x.explanation].join(' ')).some((n) => !known.has(n))) out.push('invented_number');
  if (!out.length) { x.options = o; x.correct_index = k; } return out;
}
const SIMILAR_FEEDBACK = { stem: 'Write a real question stem.', options: 'Give exactly 4 different, non-empty options.', key: 'correct_index must be 0-3.', same_question: 'That is the original question reworded: check the same idea from another angle.',
  quote: 'The quote must be copied word for word from one of the lecture pages (at least 4 words).', explanation: 'Add the explanation.', invented_number: 'It contains a number the lecture pages do not contain.' };
async function makeSimilar(llm, c) {
  let fb = null;
  for (let k = 0; k < 2; k++) { const [sys, pr] = P.similar(c, fb); let r; try { r = await llm.json('similar', sys, pr); } catch (e) { if (k === 0) throw e; break; }
    const x = r && typeof r === 'object' ? (r.question || r) : null; const bad = checkSimilar(x, c);
    if (!bad.length) return { stem: String(x.stem).trim(), options: x.options, correct_index: x.correct_index, explanation: cleanFix(x.explanation), quote: String(x.quote).trim(), page: x.page };
    fb = bad.map((b) => SIMILAR_FEEDBACK[b]).filter(Boolean); }
  return null;
}

// ---------- pipeline
async function mapLimit(items, n, fn) { const res = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } })); return res; }
/* Pages in lecture order, in as FEW parts as the size limit allows - and those parts EVEN (a 57-page lecture: two parts of ~28 pages, not 45 + 12), because the parts are
 * read side by side and the reading ends with its longest part. Same limit, same number of parts as filling each to the brim. */
// minPage: a short slide still weighs something (on a slide deck each slide is often a topic of its own, and an objective in the answer)
function chunkPages(pages, max = 18000, minPage = 0, secOf = null) { const len = (p) => Math.max(minPage, Math.min(p.text.length, 6000)); const total = pages.reduce((n, p) => n + len(p), 0); const parts = Math.max(1, Math.ceil(total / max)); const target = total / parts;
  const out = []; let cur = [], n = 0, before = 0;
  for (const p of pages) { const L = len(p); const same = !!(secOf && cur.length && secOf(p.ref) && secOf(p.ref) === secOf(cur[cur.length - 1].ref));      // the next page continues the lecture's section: keep it in this part
    if (cur.length && (n + L > max * (same ? 1.6 : 1) || (!same && out.length < parts - 1 && before + n + L / 2 > target * (out.length + 1)))) { out.push(cur); before += n; cur = []; n = 0; } cur.push(p); n += L; }
  if (cur.length) out.push(cur); return out; }
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
  const chunks = opts.chunkChars ? chunkPages(pages, Math.max(1500, Math.round(opts.chunkChars * scaleOf(llm))), 400, opts.sectionOf) : chunkPages(pages, Math.max(3000, Math.round(18000 * scaleOf(llm))), 0, opts.sectionOf);      // a host with many lanes asks for smaller parts: read side by side, each answered sooner
  // the parts of the lecture are independent: they are analysed IN PARALLEL (up to `width` at once) and merged in lecture order, so the result is the same as one after the other
  const done = await mapLimit(chunks, width, async (chunk) => {
    // The model answered, but never with a usable JSON (a thinking model out of room, prose, a cut reply — the pool has already asked again and tried the other providers): this part is split
    // by page instead of failing the whole quiz. Every question still has to pass the same evidence checks. Real service failures (network, keys, credit) are NOT hidden: they propagate.
    try { return { parts: await analyseChunk(llm, chunk, st), chunk }; } catch (e) { if (!e || e.code !== 'bad_json') throw e;
      if (opts.aiOnly && chunk.length > 1) { const mid = Math.ceil(chunk.length / 2);      // Claude only: the part is asked again in two halves - never a stand-in made by rules
        const halves = await Promise.all([chunk.slice(0, mid), chunk.slice(mid)].map((c) => analyseChunk(llm, c, st).catch(() => []))); return { parts: halves.flat(), chunk }; }
      return { degraded: true, chunk }; }
  });
  for (const d of done) {
    if (d.degraded) { degraded = true; if (!opts.aiOnly) objectives.push(...fallbackObjectives(d.chunk, st)); continue; }
    for (const { r, chunk: c } of d.parts) {
      objectives.push(...normObjectives(r, c));
      gaps.push(...((r && r.gaps) || []).slice(0, 5)); if (r && r.lecture_character) chars.push(r.lecture_character); if (r && r.discipline_guess) disc.push(r.discipline_guess); } }
  let fallback = degraded && !opts.aiOnly;
  if (!objectives.length) { if (!opts.aiOnly) { objectives.push(...fallbackObjectives(pages, st)); fallback = objectives.length > 0; } }      // Claude only: no objectives = nothing to plan (the job says so)
  else {      // THE WHOLE LECTURE: the content pages no objective cites (the model skipped them) are given to the model once more, on their own: it names their objectives
    const cited = new Set(objectives.flatMap((o) => o.pages || [])), wc = (p) => (p.text.match(/\S+/g) || []).length;
    // ...and the pages of a lecture SECTION none of whose pages is cited, however short its slides: a section of a few short slides (each under the 25 words a page
    // needs on its own) was neither asked nor reported - nothing of it reached the plan
    const secOf = opts.sectionOf || null, citedSec = new Set(secOf ? [...cited].map(secOf).filter(Boolean) : []), secWords = {};
    if (secOf) pages.forEach((p) => { const k = secOf(p.ref); if (k) secWords[k] = (secWords[k] || 0) + wc(p); });
    const bareSec = (p) => { const k = secOf ? secOf(p.ref) : ''; return !!k && !citedSec.has(k) && secWords[k] >= 15 && wc(p) >= 3; };
    const left = pages.filter((p) => !cited.has(p.ref) && (wc(p) >= 25 || bareSec(p)));
    let add = [];      // (or none, when those pages hold nothing to assess); only if that call fails, and only outside the Claude-only edition, a page-based stand-in
    if (left.length) { try { const parts = await mapLimit(chunkPages(left, Math.max(1500, Math.round((opts.chunkChars || 18000) * scaleOf(llm))), 400), width, (c) => analyseChunk(llm, c, st));
        add = parts.flat().flatMap(({ r, chunk: c }) => normObjectives(r, c)).map((o) => ({ ...o, gapfill: true })); }
      catch (_) { if (!opts.aiOnly) add = fallbackObjectives(left, st).map((o) => ({ ...o, gapfill: true, supports: { basic_recall: { pages: o.pages, task: null }, understanding: { pages: o.pages, task: null } } })); } }
    if (add.length) { const first = (o) => Math.min(...((o.pages || []).length ? o.pages.map(pn) : [9999]));
      for (const g of add) { const at = objectives.findIndex((o) => !o.gapfill && first(o) > first(g)); objectives.splice(at < 0 ? objectives.length : at, 0, g); } } }      // the model's own objectives keep their order
  objectives.forEach((o, i) => (o.id = 'o' + (i + 1)));
  const agent = await agentP; const R = !opts.aiOnly && window.QZE && window.QZE.rules; const structural = R && R.profile ? R.profile(pages, st.field, { semantic: true }) : null;      // Claude only: Claude's own profile, no rules
  const profile = opts.aiOnly && !agent ? null : reconcileProfile(structural, agent, words); if (profile) attachSupports(objectives, profile);      // no profile from Claude: the types Claude named per objective are the plan's
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
  // the options: one generic, also-correct or repeated option, or two weak ones, and the question is written again (with this feedback); one weak one is a remark
  const weak = (Array.isArray(r.weak_options) ? r.weak_options : []).filter((w) => w && Number.isInteger(+w.index) && +w.index >= 0 && +w.index <= 3 && +w.index !== c.correct_index);
  // a reviewer's taste must not empty the quiz: an option that is ALSO right (two answers), or two plainly junk distractors, and the question is written again;
  // anything else is a remark (the deterministic check already refuses options that talk about the question instead of the subject)
  // two distractors that say the same thing (the reviewer names both: «…dorsal roots» / «…dorsal roots of the spinal cord») leave three real options: written again too
  // «off topic» is not decisive: the reviewer sees only the question's own pages, and an option taken from a neighbouring section looks foreign to it (a real quiz lost
  // three sound questions whose options were the thalamus, the hypothalamus and the brain stem - all of them in the lecture)
  const also = weak.filter((w) => w.why === 'also_correct'), junk = weak.filter((w) => w.why === 'absurd'), same = weak.filter((w) => w.why === 'same_as_other');
  const WHY = { about_question: 'يتكلم عن السؤال لا المادة', generic: 'يتكلم عن السؤال لا المادة', off_topic: 'خارج مادة المحاضرة', absurd: 'لا يختاره أحد', not_parallel: 'من نوع مختلف', also_correct: 'صحيح أيضًا', same_as_other: 'مكرر لخيار آخر' };
  if (weak.length) { const what = weak.map((w) => `«${String(c.options[+w.index] || '').slice(0, 40)}» (${WHY[w.why] || w.why})`).join('، ');
    out.push(Object.assign(iss('weak_options', `خيارات ضعيفة: ${what}. اجعل كل خيار خاطئ من نوع الإجابة نفسه ومن مادة هذا القسم، قريبًا ومقنعًا، وخطؤه مبيَّن في المحاضرة.`, also.length || junk.length >= 2 || same.length >= 2 ? 'decisive' : 'minor'),
      { kind: also.length ? 'also' : same.length >= 2 ? 'same' : 'junk' })); }      // why it was decisive (the development track files the failure by it)
  return out;
}
/* Blind solve + explanation audit for a GROUP of questions in 2 LLM calls total (instead of 2 per question). A group the provider finds too large is split in halves
 * (then its source pages shortened) rather than failed. */
/** The blind solve (verify) and the explanation check run AT THE SAME TIME (two separate requests: the blind solver never sees the key or the explanation),
 *  so a batch costs two model round-trips in a row instead of three. The explanation verdict is applied only to questions the blind solve did not already reject. */
async function llmCheckBatch(llm, items, pages, st, accepted = []) {
  const res = items.map(() => []); const byId = (r) => Object.fromEntries((r.results || []).map((x) => [x.id, x])); const exp = items.map(() => []);
  const explain = async (list, pg) => {
    try { const [s, p] = P.explainBatch(list.map(([it]) => it), pg, accepted); const e = byId(await llm.json('verify_explanation', s, p));
      list.forEach(([it, k]) => { const r = e[it.id]; const fix = r && typeof r.corrected_explanation === 'string' && r.corrected_explanation.trim().length >= 25 ? r.corrected_explanation.trim().slice(0, 700) : null;
        if (r && (r.contradicts_source || r.explanation_supported === false)) exp[k].push(fix ? Object.assign(iss('explanation_fixed', 'صُحِّح التفسير من المصدر.', 'minor'), { fix }) : iss('explanation_unsupported', 'التفسير غير مدعوم بالمصدر: ' + String(r.notes || '').slice(0, 150)));      // the question is sound: its explanation is repaired, not the question thrown away
        if (r && r.duplicate_of != null && r.duplicate_of !== '' && r.duplicate_of !== false && String(r.duplicate_of) !== it.id) {
          const prev = accepted.find((x) => String(x.n) === String(r.duplicate_of)) || ((list.find(([y]) => y.id === String(r.duplicate_of)) || [])[0] || {}).c;
          const other = it.c.extra && prev && (prev.type || prev.qtype) && (prev.type || prev.qtype) !== it.c.qtype;      // a reinforcement question asking it through another kind of thinking
          exp[k].push(iss('semantic_duplicate', 'يكرر سؤالًا سابقًا بصياغة أخرى (' + String(r.duplicate_of).slice(0, 20) + '): اسأل حقيقة أخرى أو بطريقة تفكير أخرى.', other ? 'minor' : 'decisive')); } }); }
    catch (err) {
      if (isTooLarge(err)) { if (list.length > 1) { const mid = Math.ceil(list.length / 2); await explain(list.slice(0, mid), pg); await explain(list.slice(mid), pg); return; } const small = shrinkPages(pg); if (small) return explain(list, small); }
      list.forEach(([, k]) => exp[k].push(iss('verifier_error', 'تعذر تدقيق التفسير.', 'minor'))); }
  };
  const verify = async () => {
    try { const [s, p] = P.verifyBatch(items, pages, scaleOf(llm) < 0.6); return { v: byId(await llm.json('verify', s, p)) }; }
    catch (e) {
      if (isTooLarge(e)) {
        if (items.length > 1) { const mid = Math.ceil(items.length / 2); const [a, b] = await Promise.all([llmCheckBatch(llm, items.slice(0, mid), pages, st, accepted), llmCheckBatch(llm, items.slice(mid), pages, st, accepted)]); return { done: a.concat(b) }; }
        const small = shrinkPages(pages); if (small) return { done: await llmCheckBatch(llm, items, small, st, accepted) };
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
  const tries = {}, early = new Set(); let okSeen = 0;
  // (the development track) how each suggested form fared on its FIRST attempt: written as suggested and passed every check, or failed - and why. A retry (with its
  // feedback), a reinforcement slot (its angle steers the form) and a failure of the checking service itself say nothing about the form, and are not recorded.
  const outcomes = [], seenOut = new Set(), why = {};      /* why: what refused each slot last - the checks' own codes, or 'unfit' when Claude declined to write it (the caller tells unusable text from a fixable miss) */
  const outcome = (s, c, ok, fams) => { if (ok) delete why[s.slot]; else why[s.slot] = (fams || []).filter(Boolean); if (seenOut.has(s.slot)) return; seenOut.add(s.slot); const f = (AI_FORMS[s.qtype] || []).indexOf(s.shape); if (s.extra || f < 0) return;
    if (c && c.switched) { ok = false; fams = ['unfit']; }      // Claude wrote another form or type: the suggested one did not fit these pages
    const fm = [...new Set((fams || []).filter(Boolean))]; if (!ok && !fm.length) return; outcomes.push({ type: s.qtype, form: f, ok: !!ok, fams: ok ? [] : fm }); };
  const pagesN = Object.values(pages).map(norm); const commonCache = new Map();
  const common = (k) => { if (!commonCache.has(k)) commonCache.set(k, pagesN.filter((t) => t.includes(k)).length >= Math.max(3, Math.ceil(pagesN.length * 0.15))); return commonCache.get(k); };      // (pipeline) how often each slot was sent back, which were sent back early, how many passed so far
  const merge = (batch, a, b) => ({ batch, error: null, errBatches: [...(a.errBatches || []), ...(b.errBatches || [])], unwritable: [...a.unwritable, ...b.unwritable], rejected: [...a.rejected, ...b.rejected], survivors: [...a.survivors, ...b.survivors], checks: { ...a.checks, ...b.checks } });
  // CHECKS OF NEIGHBOURING BATCHES TOGETHER: batches written side by side finish together; their questions are checked in one blind-solve request and one explanation
  // request (the same checks, the same rules - only fewer, slightly longer requests), so the checks of a whole round fit the lanes at once instead of queueing behind each other.
  let genActive = 0; let CHECK_MIN = 8; let queue = []; let timer = null; let coalesce = false;      // only when the round's checks would not fit the lanes at once
  // ...but never one long request for a whole round: a shared check takes at most CHECK_MAX questions (a real-time run checked 22 in one request - 33 s, the round's
  // slowest part); what was queued is sent as several requests side by side
  const CHECK_MAX = 10;
  const send = (groups) => { const items = groups.flatMap((g) => g.items); const pgs = {};
    for (const g of groups) for (const [r, t] of Object.entries(g.pgs)) if (!pgs[r]) pgs[r] = t;      // every page of every group (check() keeps a shared request within MERGED_PAGES)
    llmCheckBatch(llm, items, pgs, st, groups[0].accepted).then((checks) => { let i = 0; for (const g of groups) { g.done(checks.slice(i, i + g.items.length)); i += g.items.length; } },
      (e) => groups.forEach((g) => g.fail(e))); };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } if (!queue.length) return; const groups = queue; queue = [];
    let pack = [], n = 0; for (const g of groups) { if (pack.length && n + g.items.length > CHECK_MAX) { send(pack); pack = []; n = 0; } pack.push(g); n += g.items.length; } if (pack.length) send(pack); };
  const MERGED_PAGES = 14;      // a shared check request carries the source pages of all its questions - never fewer: a group that would not fit is checked on its own
  const check = (items, pgs, accepted, sc) => new Promise((done, fail) => { if (queue.length) { const u = new Set(queue.flatMap((g) => Object.keys(g.pgs))); Object.keys(pgs).forEach((r) => u.add(r)); if (u.size > MERGED_PAGES) flush(); }
    queue.push({ items, pgs, accepted, sc, done, fail });
    const n = queue.reduce((x, g) => x + g.items.length, 0); if (!coalesce || n >= CHECK_MIN || genActive === 0) flush(); else if (!timer) timer = setTimeout(flush, 2500); });
  const genEnded = () => { genActive--; if (genActive === 0) setTimeout(flush, 0); };      // deferred: the batch that just ended joins the group first (its own check is queued right after)
  let roundSlots = [];      // the slots of the round being written (see alongside)
  const work = async (batch, known, k = 1) => {
    const sc = Math.min(k, scaleOf(llm));                       // how much of a full-size request the endpoint that will serve this can take
    const res = { batch, error: null, errBatches: [], unwritable: [], rejected: [], survivors: [], checks: {} };
    const budget = Math.max(2500, Math.round(8000 * Math.max(3, batch.length) * sc)), per = Math.max(1200, Math.round(6000 * sc));      // room for every slot's pages, also in a batch of 5
    const pg = {}; let used = 0; batch.forEach((s) => s.pages.forEach((r) => { if (pages[r] && !pg[r] && used + Math.min(per, pages[r].length) <= budget) { pg[r] = pages[r].slice(0, per); used += pg[r].length; } }));
    if (opts.sectionPages) batch.forEach((s) => (opts.sectionPages[s.section_key] || []).forEach((r) => { if (pages[r] && !pg[r] && used + Math.min(per, pages[r].length) <= budget) { pg[r] = pages[r].slice(0, per); used += pg[r].length; } }));      // then the rest of each slot's section
    // CROSS-REQUEST REPEATS: the requests of a round are written side by side and blind to one another - a real quiz lost 7 of its 47 drafts to the reviewer as
    // repeats of each other. Each request is told what the others are asking (section, type, objective): another writer takes those points
    const alongside = sc >= 1 ? (roundSlots || []).filter((x) => !batch.includes(x)).map((x) => ({ section: x.section || undefined, type: x.qtype, objective: String(x.objective || '').slice(0, 120) })) : [];      // (a provider that takes only small requests: left out, the request keeps its size)
    const [sys, pr] = P.generate(batch, pg, st, known.slice(-Math.max(6, Math.round(40 * sc))).map((a) => ({ purpose: a.purpose, stem: a.stem.slice(0, 160), type: a.qtype })), fb, sc < 0.6, alongside); let resp;      // a small provider: the compact prompt
    genActive++; try { resp = await llm.json('generate', sys, pr); genEnded(); }
    catch (e) { genEnded();
      if (isTooLarge(e)) {                                       // the provider refused this size: two smaller batches, or (one slot) shorter pages
        if (batch.length > 1) { const mid = Math.ceil(batch.length / 2); const a = await work(batch.slice(0, mid), known, sc), b = await work(batch.slice(mid), known, sc); return merge(batch, a, b); }
        if (sc > 0.15) return work(batch, known, sc / 2);
      }
      res.errBatches.push({ batch, error: e }); return res; }
    const bySlot = Object.fromEntries((resp.questions || []).map((q) => [q.slot, q]));
    for (const s of batch) { const raw = bySlot[s.slot];
      if (!raw || raw.unwritable_reason) { res.unwritable.push([s, raw ? 'المولّد رفض كتابة السؤال: ' + raw.unwritable_reason : 'لم يُرجع المولّد سؤالًا لهذه الخانة.']); continue; }
      const c = { slot: s.slot, qtype: ORDER.includes(raw.type) ? raw.type : s.qtype, task: s.task,      /* the type the model actually wrote (it may adapt it to the pages) */ objective: s.objective, objective_id: s.objective_id, section_key: s.section_key || '', ai_form: String(raw.form || s.shape || '').slice(0, 160), difficulty: s.difficulty, stem: String(raw.stem || '').trim(), options: (raw.options || []).map((o) => String(o).trim()),
        correct_index: Number.isInteger(raw.correct_index) ? raw.correct_index : -1, explanation: String(raw.explanation || '').trim(), purpose: String(raw.purpose || '').trim(), reasoning_pattern: raw.reasoning_pattern || '',
        evidence: (raw.evidence || []).map((e) => ({ page: e.page, quote: String(e.quote || '').trim() })), uses_external: !!raw.uses_external, extra: !!s.extra, variant: s.variant || 0, angle: s.angle || null, pk: pageKey(s.pages) };
      const fi = (AI_FORMS[s.qtype] || []).indexOf(s.shape), used = c.qtype === s.qtype ? formIndex(c.qtype, raw.form) : -1;      // (the development track) the suggested form, and the one Claude says it wrote
      c.switched = fi >= 0 && (c.qtype !== s.qtype || (used >= 0 && used !== fi));
      const v = validateQ(c, ctx); if (opts.evidenceCheck) { const why = opts.evidenceCheck(c); if (why) v.push(iss('owner_evidence', why)); } let d;
      if (decisive(v)) { const dv = v.filter((i) => i.severity === 'decisive'); res.rejected.push([s, 'rejected_validation', dv.map((i) => i.message), dv.map(famOf), c, dv.map((i) => i.code)]); }
      else if ((d = dupOf(c, known, c.extra)) != null) res.rejected.push([s, 'rejected_duplicate', [`مكرر للسؤال ${d}: ${c.extra ? 'غيّر الحقيقة المسؤول عنها أو اتجاه السؤال (لا نسخة بصياغة أخرى).' : 'غيّر الحقيقة المقيسة وطريقة الاستدلال.'}`], ['repeat'], c]);
      else if ((d = leaks(c, known, c.extra, common)) != null) res.rejected.push([s, 'rejected_leak', [`يكشف إجابة سؤال آخر (${d}). أعد الصياغة.`], ['repeat'], c]);
      else res.survivors.push([s, c, v]); }
    if (res.survivors.length) {
      const items = res.survivors.map(([s, c]) => ({ id: 'q' + s.slot, c, s })); const pgs = {};
      items.forEach((it) => [...it.c.evidence.map((e) => e.page), ...it.s.pages].forEach((r) => { if (pages[r] && !pgs[r] && Object.keys(pgs).length < Math.max(2, Math.round(10 * sc))) pgs[r] = pages[r].slice(0, Math.max(1500, Math.round(5000 * sc))); }));
      const accepted = known.slice(-40).map((a, i) => ({ n: i + 1, purpose: a.purpose, stem: String(a.stem).slice(0, 160), type: a.qtype }));
      const checks = await check(items, pgs, accepted, sc); items.forEach((it, k) => (res.checks[it.id] = checks[k]));
    }
    return res;
  };
  const want = opts.want || 0;
  let tAttempt = Date.now();
  for (let attempt = 1; attempt <= (opts.oneRound ? 1 : 2) && pending.length; attempt++) {      // oneRound: the development track measures first attempts only
    tAttempt = Date.now();
    if (attempt === 2 && want) {                     // the count is already met (the round asked for a few more than needed): no second round; otherwise retry only what is missing (+ a margin), planned slots first
      // ...unless a section of the plan is still without a question: the quiz covers the whole lecture, so its slots are retried, or replaced IN that section
      const miss = opts.uncovered ? opts.uncovered(acc) : new Set(); const inMiss = (x) => miss.has(x.section_key || '');
      const dl = typeof opts.deadline === 'function' ? opts.deadline() : opts.deadline, hard = typeof opts.hardDeadline === 'function' ? opts.hardDeadline() : opts.hardDeadline;
      // THE COUNT IS NEVER CUT BY THE CLOCK (Claude only): a real 50-question quiz on a slow day ended at 21 because its first round ran past 100 s and this retry round
      // (33 slots) was skipped. Past the time, a round runs only for questions still missing - a section still uncovered waits for no one - and never past the hard limit
      if ((acc.length >= want && (!miss.size || (!opts.aiOnly && dl && Date.now() > dl))) || (dl && Date.now() > dl && !opts.aiOnly) || (hard && Date.now() > hard)) break;      // (Claude only: a section with text still unasked is retried whatever the time; the web edition finishes a short count locally)
      const need = Math.max(0, want - acc.length), keep = need ? Math.max(need + Math.min(4, Math.ceil(need * .3)), Math.min(width, 2 * need + 1)) : 0;      // one question per request, side by side: asking a few more costs no time and spares a third round
      const drop = (list) => list.forEach((x) => dropped.push({ slot: x.slot, qtype: x.qtype, reasons: fb[x.slot] || ['فشل التحقق'], final: true }));
      if (!need) { drop(pending.filter((x) => !inMiss(x))); pending = pending.filter(inMiss); }
      if (opts.refill && (pending.length < keep || miss.size)) { const add = opts.refill(Math.max(0, keep - pending.length), acc, pending); pending.push(...add); }      // what round 1 could not write is replaced IN this round (not in a third one after it)
      const cap = keep + pending.filter(inMiss).length;
      if (pending.length > cap) { const order = pending.slice().sort((a, b) => (inMiss(a) ? 0 : 1) - (inMiss(b) ? 0 : 1) || (a.extra ? 1 : 0) - (b.extra ? 1 : 0) || a.slot - b.slot); const skip = new Set(order.slice(cap)); pending = pending.filter((x) => !skip.has(x)); drop([...skip]); }
    }
    // batch size: the SMALLEST that lets the whole round be written at once by the lanes (3-5 slots; a model's answer time grows with what it writes in one request);
    // the retry round, small by design, one question per request while the lanes allow it, so that it ends quickly
    if (attempt === 2) pending.forEach((x) => { tries[x.slot] = (tries[x.slot] || 0) + 1; });
    const bs = Math.max(1, Math.round(Math.min(5, Math.max(attempt === 1 ? 3 : 1, Math.ceil(pending.length / width))) * scaleOf(llm))); const batches = packBySection(pending, bs); roundSlots = batches.flat(); pending = []; coalesce = scaleOf(llm) >= 1 && 2 * batches.length > width;      /* a provider that takes full-size requests only (a small one gets its checks as before) */ CHECK_MIN = Math.min(CHECK_MAX, Math.max(6, Math.ceil(batches.reduce((n, b) => n + b.length, 0) / Math.max(1, Math.floor(width / 2)))));      // one verify + one explanation request per group: the round's checks fit the lanes at once
    // A ROLLING pool: as soon as one of the `width` lanes finishes a batch it takes the next one (a wave used to wait for its slowest batch). Results are merged strictly in batch order
    // (a finished batch waits until the ones before it have been merged), so the questions accepted - and their order - do not depend on which call happened to be quicker.
    const results = new Array(batches.length); let next = 0, merged = 0, inflight = 0; const waiters = []; const wake = () => { while (waiters.length) waiters.shift()(); };
    const pipe = !!opts.pipeline && attempt === 1;
    // a slot already sent back early is not queued again at merge time; a slot rejected a second time is final (attempt 2 handles the rest, as before)
    let fromRetry = false;      // set while the result of a batch that was itself sent back is merged
    const requeue = (s, atMerge) => { if (pipe && early.has(s.slot) && !atMerge && !fromRetry) return; if (tries[s.slot] >= 2) { dropped.push({ slot: s.slot, qtype: s.qtype, reasons: fb[s.slot] || ['فشل التحقق'], final: true }); return; } pending.push(s); };
    const mergeOne = (res) => { fromRetry = !!(res.batch && res.batch.retry);
      for (const eb of res.errBatches || []) eb.batch.forEach((s) => { seenOut.add(s.slot); dropped.push({ slot: s.slot, qtype: s.qtype, reasons: ['خطأ في خدمة التوليد: ' + (eb.error.message || eb.error)], final: true }); });
      stats.drafted += res.survivors.length + res.rejected.length;
      for (const [s, reason] of res.unwritable) { stats.unwritable++; outcome(s, null, false, ['unfit']); if (opts.onRefused) opts.onRefused(s.objective_id, s.qtype); if (!early.has(s.slot)) dropped.push({ slot: s.slot, qtype: s.qtype, final: true, reasons: [reason] }); else dropped.push({ slot: s.slot, qtype: s.qtype, final: true, replaced: true, reasons: [reason] }); }
      for (const [s, key, msgs, fams, c, codes] of res.rejected) { stats[key]++; outcome(s, c, false, fams); why[s.slot] = codes || [key]; fb[s.slot] = msgs; requeue(s); }
      for (const [s, c, v] of res.survivors) { const vi = res.checks['q' + s.slot] || [];
        if (decisive(vi)) { stats.rejected_verifier++; const dv = vi.filter((x) => x.severity === 'decisive'); dv.forEach((x) => { stats['rej_' + x.code] = (stats['rej_' + x.code] || 0) + 1; }); outcome(s, c, false, dv.map(famOf)); why[s.slot] = dv.map((x) => x.code); fb[s.slot] = dv.map((x) => x.message); requeue(s); }
        else if (dupOf(c, base.concat(acc), c.extra) != null || leaks(c, base.concat(acc), c.extra, common) != null) { stats.rejected_duplicate++; outcome(s, c, false, ['repeat']); fb[s.slot] = ['تعارض مع سؤال معتمد في الدفعة نفسها.']; requeue(s, true); }
        else { const fx = vi.find((x) => x.fix); if (fx) c.explanation = fx.fix; c.issues = v.concat(vi).map((x) => (x.fix ? { code: x.code, message: x.message, severity: x.severity } : x)); outcome(s, c, true, []); acc.push(c); if (opts.onAccept) opts.onAccept(c); } }
    };
    const drain = () => { while (merged < batches.length && results[merged]) { mergeOne(results[merged]); results[merged] = null; merged++; progress(attempt === 1 ? 'drafting' : 'retrying', Math.round(100 * acc.length / Math.max(1, plan.slots.length))); } };
    progress(attempt === 1 ? 'drafting' : 'retrying', Math.round(100 * acc.length / Math.max(1, plan.slots.length)));
    const sendBack = (res) => {      // (pipeline) what this batch's own checks refused goes back at once - only while the round still needs questions
      if (!pipe) return; const ok = res.survivors.filter(([s]) => !decisive(res.checks['q' + s.slot] || [])).length; okSeen += ok; if (want && okSeen >= want + 2) return;
      const again = []; const note = (s, msgs) => { if ((tries[s.slot] || 0) >= 1 || early.has(s.slot)) return; tries[s.slot] = 1; early.add(s.slot); fb[s.slot] = msgs; again.push(s); };
      for (const [s, , msgs] of res.rejected) note(s, msgs);
      for (const [s] of res.survivors) { const vi = res.checks['q' + s.slot] || []; if (decisive(vi)) note(s, vi.filter((x) => x.severity === 'decisive').map((x) => x.message)); }
      if (res.unwritable.length && opts.refill && (!want || okSeen + again.length < want + 2)) { const add = opts.refill(res.unwritable.length, acc, again, false); add.forEach((x) => { tries[x.slot] = 1; early.add(x.slot); }); again.push(...add); res.unwritable.forEach(([s]) => early.add(s.slot)); }
      if (again.length) { const nb = packBySection(again, Math.max(1, Math.min(3, Math.ceil(again.length / width)))); nb.forEach((b) => { b.retry = true; }); batches.push(...nb); results.length = batches.length; stats.early_retries = (stats.early_retries || 0) + again.length; wake(); } };
    const lane = async () => { while (true) {
      if (next < batches.length) { const k = next++; inflight++; const res = await work(batches[k], base.concat(acc)); inflight--; results[k] = res; sendBack(res); drain(); wake(); continue; }
      if (!pipe || inflight === 0) break; await new Promise((r) => waiters.push(r)); } };
    await Promise.all(Array.from({ length: Math.min(width, batches.length) }, lane)); wake();
    stats['round' + attempt + '_ms'] = Date.now() - tAttempt;
    if (pending.length) stats.retries += pending.length;
  }
  pending.forEach((s) => dropped.push({ slot: s.slot, qtype: s.qtype, reasons: fb[s.slot] || ['فشل التحقق'], final: true }));
  stats.last_round_ms = Date.now() - tAttempt;      // how long its last round took (a top-up round of small requests takes about as long)
  return { accepted: acc, dropped, stats, outcomes, why };
}
/* QUESTION FORMS for the AI path: for each type, four forms whose options are lecture content (never descriptions of the question). Each slot is given one as a
 * SUGGESTION, rotated inside its section so a section is asked in several forms; the model reads the pages and, where a form does not fit them, takes another
 * form of the same type. Nothing here reads the lecture: the planning is Claude's (its analysis) and the lecture's own sections. */
const AI_FORMS = {
  basic_recall: ['term from its meaning (options: four terms of the same kind from this lecture)', 'complete a key statement with one decisive term blanked (options: four terms of the same kind)',
    'which item belongs to a group the lecture lists (options: one member and three items from other groups of the lecture)', 'what a named structure / item does, as stated (options: four functions named in this lecture)'],
  understanding: ['meaning in other words (options: four paraphrases, three of them wrong in one detail)', 'which statement about this section is true (options: four statements, three altered in one detail)',
    'what an abbreviation used in the pages stands for (options: four expansions)', 'why: which explanation of a stated point is correct (options: four explanations)'],
  mechanisms: ['cause -> effect (options: four effects)', 'effect -> cause (options: four causes)', 'purpose of a step / structure (options: four purposes)', 'what follows when a stated step / factor is absent, only as the lecture states it (options: four outcomes)'],
  application: ['classify a new example into the lecture\'s categories (options: four categories of the lecture)', 'apply a value / range from the lecture (options: four values or ranges)',
    'which member of a family fits a description (options: four members)', 'which finding is expected in a described example (options: four findings)'],
  critical_thinking: ['inference: two findings from the pages; which state / group / conclusion follows (options: four states or conclusions from this lecture)',
    'prediction: a stated condition; which combination of findings follows (options: four combinations; wrong ones reverse or swap one element)',
    'correct the claim: a claim with one detail altered; which corrected version matches the lecture (options: four versions of the claim, each changing a different detail; only one restores the lecture)',
    'best-supported conclusion from the lecture\'s evidence (options: four conclusions; wrong ones over-reach, reverse or misattribute)'],
  scenarios: ['vignette: a short case through two findings from the pages; which state / phase / category explains them (options: four sibling states)', 'prediction in a case: which further finding is expected (options: four findings)',
    'decision in context: the interpretation the lecture supports (options: four interpretations)', 'two cases: which pairing of states / groups is correct (options: four pairings of named states)'],
  compare_contrast: ['difference between two items (options: four contrasts)', 'match items to their groups (options: four pairings of named items)', 'which feature distinguishes A from B (options: four features)', 'which feature is shared by both (options: four features)'],
  best_answer: ['best description (options: four descriptions)', 'most accurate statement (options: four statements)', 'best example (options: four examples)', 'best justification for a stated point (options: four justifications)'],
  not_except: ['all of the following EXCEPT (options: three true items of one list and one item from elsewhere in the lecture)', 'which is NOT true (options: three true statements and one altered)', 'which is LEAST related (options: four items)', 'which pairing is INCORRECT (options: four pairings)'],
  sequence: ['correct order (options: four orders of the same steps)', 'what comes next (options: four steps)', 'what comes first (options: four steps)', 'which step is missing from the sequence (options: four steps)'] };
/** give each slot a suggested form: inside its section the forms of its type rotate (least used there first, then least used in the quiz); `prior` = slots of earlier
 *  rounds, so the rotation continues. Also the section's name for the writer (the lecture's own heading when known).
 *  `guide` (the development track, formGuide()): what the quizzes so far taught about each form in lectures like this one - a form that rarely works costs a little
 *  more (at most FL.W, below one use inside the section: the rotation and the four forms stay), and a form with a recurring failure carries its fixed reminder. */
function assignForms(slots, prior, guide) {
  const label = (s) => s.section_label || String(s.objective || '').replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').slice(0, 80);
  const global = {}, inSec = {}; const count = (s) => { if (!s.shape) return; const k = secKey(s); global[s.shape] = (global[s.shape] || 0) + 1; ((inSec[k] ||= {})[s.shape] = (inSec[k][s.shape] || 0) + 1); };
  (prior || []).forEach(count);
  for (const s of slots || []) { const list = AI_FORMS[s.qtype]; s.section = label(s); if (!list) continue; const here = inSec[secKey(s)] || {};
    const cost = (i) => (guide ? Math.min(FL.W, Math.max(0, guide.cost(s.qtype, i))) : 0);
    const [f, , i] = list.map((f, i) => [f, 10 * (here[f] || 0) + (global[f] || 0) + cost(i) + i * 0.01, i]).reduce((b, c) => (c[1] < b[1] ? c : b));
    s.shape = f; const tip = guide ? guide.tip(s.qtype, i) : null; if (tip) s.form_tip = tip; else delete s.form_tip; count(s); }
  return slots;
}
/* ---------------------------------------------------------------- THE DEVELOPMENT TRACK: the forms learn from many quizzes
 * Every AI quiz tells how each suggested form fared on its FIRST attempt (generate(): written as suggested and passed every check, or failed - and why, in the checks'
 * own codes, grouped below). The record is kept per type x form x lecture density (a heavy, a medium or a light lecture - they carry different forms):
 * 10 types x 4 forms x 3 densities. What it may change, and only this - so the track never leaves the forms plan or the options rules:
 *  - which of a type's FOUR FIXED forms (AI_FORMS) a slot is given: a form that rarely works in such lectures costs a little more (at most FL.W = 3, below the
 *    rotation inside a section, 10 - a section is still asked in different forms, and no form is ever removed or rewritten);
 *  - ONE reminder for that form, taken from a FIXED catalogue (FORM_TIPS: each restates a rule the checks already enforce), when one failure keeps coming back.
 * Bounded: a cell stops counting at FL.MAX = 30 first attempts (it is settled: no later run of odd quizzes can move it); it is LEARNED at FL.READY = 4. The track is
 * READY when all 120 cells are learned or shown unfit (Claude refused that form three times on such lectures and never wrote it) - beyond that nothing is left to learn. */
const FL = { READY: 4, MAX: 30, W: 3, DENS: ['heavy', 'medium', 'light'], STEP: 12, MAX_STEPS: 120 };
const FAM = { key_in_stem: 'giveaway', length_cue: 'giveaway', options_duplicate: 'options_same', meta_options: 'options_meta', all_none_above: 'options_meta',
  ambiguous_key: 'ambiguous', solver_disagrees: 'ambiguous', insufficient_data: 'ambiguous', verifier_flaw: 'ambiguous',
  not_answerable: 'evidence', outside_knowledge: 'evidence', unsupported: 'evidence', evidence_not_found: 'evidence', evidence_out_of_scope: 'evidence', no_evidence: 'evidence', owner_evidence: 'evidence', explanation_unsupported: 'evidence', external_not_allowed: 'evidence', cross_field_import: 'evidence',
  not_marker_missing: 'negation', sequence_options_invalid: 'order', sequence_items_missing: 'order', semantic_duplicate: 'repeat',
  stem_short: 'format', options_count: 'format', key_invalid: 'format', explanation_missing: 'format', language_mismatch: 'format' };
// a decisive weak_options has one of three causes: an option also correct (two answers), two options alike, two plainly junk (judge() says which)
const famOf = (i) => (!i ? null : i.code === 'weak_options' ? ({ also: 'ambiguous', same: 'options_same', junk: 'options_weak' })[i.kind] || 'options_weak' : FAM[i.code] || null);
// THE FIXED REMINDERS - each one a rule the prompt and the checks already hold (RULES 1-4, the options rules, the type formats), said where that form keeps failing it
const FORM_TIPS = {
  giveaway: 'Name the concept by what the lecture says about it, never by its own words: no word of the key (nor a form of it) may appear in the stem.',
  options_same: 'Four options that are four different things of one kind: no two may mean the same (a term and its abbreviation, a reworded copy).',
  options_meta: 'Every option is lecture content of the key\'s kind (a term, value, finding or statement) - never a sentence about the question, the statement or the lecture.',
  options_weak: 'Each distractor is a near-miss of the key\'s kind from this section or a neighbouring one, wrong for a reason the lecture gives - never absurd, never also true.',
  ambiguous: 'Put in the stem every condition the key depends on, so that exactly one option follows from the pages; rule out each distractor from the pages before you return it.',
  evidence: 'Build the key on one content sentence of the cited pages and quote that sentence verbatim (not a heading or a label); nothing beyond the pages.',
  negation: 'Write the negation in capitals in the stem (NOT / EXCEPT / LEAST); the three true options are stated facts of one list.',
  order: 'Number the items in the stem (1-4, shuffled) and make every option a complete order of the same numbers.',
  repeat: 'Ask a point of this section that no accepted question asks, and keep their answers out of the stem.',
  format: 'A full stem, four non-empty options, one key (0-3) and an explanation of two or three sentences, in the language of the pages.' };
const cellKey = (t, f, d) => t + '|' + f + '|' + d;
const formHead = (f) => norm(String(f).split(' (options:')[0]);
/** which of the type's forms the writer's «form» names (its text, its head, or close enough; word order breaks a tie - «cause -> effect» / «effect -> cause»); -1: cannot tell */
function formIndex(type, text) { const list = AI_FORMS[type]; const t = norm(text || ''); if (!list || t.length < 4) return -1;
  let i = list.findIndex((f) => norm(f) === t || formHead(f) === t); if (i >= 0) return i;
  i = list.findIndex((f) => t.startsWith(formHead(f)) || (t.length >= 6 && formHead(f).startsWith(t))); if (i >= 0) return i;
  const tt = toks(t); let best = -1, bs = 0; list.forEach((f, k) => { const ft = toks(formHead(f)); const s = jac(tt, ft) + (tt[0] && tt[0] === ft[0] ? 0.05 : 0); if (s > bs) { bs = s; best = k; } });
  return bs >= 0.34 ? best : -1; }
/** how much a lecture says: the words of the pages a quiz is written from (heavy >= 500, medium >= 200, light below) */
/* a lecture's density is how much text its slides carry (the words of a page with text, on average), not its length: by the total, every real lecture
 * (30 slides and more) was «heavy», and the medium and light columns of the track never learned from a quiz. Calibrated on the study files (heavy 47-61 words
 * a page, medium 37-47, light 18-25). */
const densityOf = (pages) => { const ws = (pages || []).map((p) => (String(p.text || '').match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).length).filter((w) => w >= 8); if (!ws.length) return 'light';
  const avg = ws.reduce((a, b) => a + b, 0) / ws.length; return avg >= 45 ? 'heavy' : avg >= 30 ? 'medium' : 'light'; };
const blankProfile = () => ({ v: 1, cells: {}, quizzes: 0 });
/** add a quiz's first attempts to a profile (in place): a cell that reached FL.MAX no longer moves */
function learnForms(profile, outcomes, dens) { const p = profile && profile.cells ? profile : Object.assign(profile || {}, blankProfile()); if (!FL.DENS.includes(dens)) return p; let n = 0;
  for (const o of outcomes || []) { const list = AI_FORMS[o && o.type]; if (!list || !(o.form >= 0 && o.form < list.length)) continue;
    const c = (p.cells[cellKey(o.type, o.form, dens)] ||= { n: 0, ok: 0, f: {} }); if (c.n >= FL.MAX) continue;
    c.n++; n++; if (o.ok) c.ok++; else (o.fams && o.fams.length ? o.fams : ['other']).forEach((x) => { c.f[x] = (c.f[x] || 0) + 1; }); }
  if (n) p.quizzes = (p.quizzes || 0) + 1; return p; }
/** profiles added together (the one shipped with the app + this account's own), each cell scaled back to FL.MAX */
function mergeProfiles(...ps) { const out = blankProfile();
  for (const p of ps) for (const [k, c] of Object.entries((p && p.cells) || {})) { const o = (out.cells[k] ||= { n: 0, ok: 0, f: {} }); o.n += +c.n || 0; o.ok += +c.ok || 0; for (const [x, v] of Object.entries(c.f || {})) o.f[x] = (o.f[x] || 0) + (+v || 0); }
  for (const c of Object.values(out.cells)) if (c.n > FL.MAX) { const s = FL.MAX / c.n; c.n = FL.MAX; c.ok = Math.round(c.ok * s); for (const x in c.f) c.f[x] = Math.round(c.f[x] * s); }
  return out; }
const isUnfit = (c) => !!c && (c.f && c.f.unfit || 0) >= 3 && !c.ok;
const topFail = (c) => { const e = Object.entries((c && c.f) || {}).sort((a, b) => b[1] - a[1])[0]; return e ? { fam: e[0], n: e[1] } : null; };
/** what a profile says for one density, as assignForms() reads it: cost(type, form) in [0, FL.W] (Laplace: an untried form sits in the middle; a cell with little data of
 *  its own borrows half of the other densities'), tip(type, form) = the reminder of its recurring failure (at least twice, a quarter of its attempts) or null */
function formGuide(profile, dens) { const cells = (profile && profile.cells) || {};
  const stat = (t, i) => { const c = cells[cellKey(t, i, dens)] || { n: 0, ok: 0 }; if (c.n >= FL.READY) return c; let n = 0, ok = 0;
    FL.DENS.filter((d) => d !== dens).forEach((d) => { const x = cells[cellKey(t, i, d)]; if (x) { n += x.n; ok += x.ok; } }); return { n: c.n + n / 2, ok: c.ok + ok / 2 }; };
  return { cost: (t, i) => { const c = stat(t, i); return FL.W * (1 - (c.ok + 1) / (c.n + 2)); },
    tip: (t, i) => { const c = cells[cellKey(t, i, dens)]; const top = c && topFail({ f: Object.fromEntries(Object.entries(c.f || {}).filter(([k]) => FORM_TIPS[k])) });
      return top && top.n >= 2 && top.n >= 0.25 * c.n ? FORM_TIPS[top.fam] : null; } }; }
/** how far the track is: ALL TEN TYPES x four forms x each density (`dens`, default the three) - a type the lectures do not seem to support is still a cell: it is
 *  tried, and only Claude's own refusals can settle it (unfit). Each cell: new / learning / learned (FL.READY) / settled (FL.MAX) / unfit (refused three times,
 *  never passed); pct counts a cell in learning by its share of FL.READY. Ready = every one of them learned or unfit. */
function formsProgress(profile, dens) { const cells = (profile && profile.cells) || {}; const rows = []; let need = 0, got = 0; const ds = (dens && dens.length ? dens : FL.DENS).filter((d) => FL.DENS.includes(d));
  const guides = Object.fromEntries(ds.map((x) => [x, formGuide(profile, x)]));
  for (const d of ds) for (const t of ORDER) AI_FORMS[t].forEach((form, i) => {
    const c = cells[cellKey(t, i, d)] || { n: 0, ok: 0, f: {} }; const st = c.n >= FL.MAX ? 'settled' : c.n >= FL.READY ? 'learned' : isUnfit(c) ? 'unfit' : c.n ? 'learning' : 'new';
    need++; got += st === 'new' || st === 'learning' ? c.n / FL.READY : 1; rows.push({ type: t, form: i, dens: d, n: c.n, ok: c.ok, status: st, top: topFail(c), tip: !!guides[d].tip(t, i) }); });
  return { cells: rows, need, pct: need ? Math.floor(100 * got / need) : 0, ready: need > 0 && got >= need }; }
/** the slots of ONE step of the track on one lecture: the cells of its density with the fewest first attempts (form 1 of every type first, then form 2...), each on
 *  an objective of the lecture whose type it is (spread over the sections: at most `perSec` in one), at most n. A type no objective here supports is asked only when
 *  it is in opts.force (no lecture of this density supports it): then on the objective used least - Claude writes it if the pages carry it, or refuses, and three
 *  refusals settle the cell as unfit. Only the four fixed forms; nothing new. */
function exploreSlots(pool, profile, dens, n, opts = {}) { const cells = (profile && profile.cells) || {}, perSec = opts.perSec || 3, force = new Set(opts.force || []);
  const has = (t) => (pool || []).some((o) => o.types && o.types[t]);
  const want = []; ORDER.filter((t) => has(t) || force.has(t)).forEach((t) => AI_FORMS[t].forEach((f, i) => { const c = cells[cellKey(t, i, dens)];
    if (!c || (c.n < FL.READY && !isUnfit(c))) want.push({ t, i, n: c ? c.n : 0 }); }));
  want.sort((a, b) => a.n - b.n || a.i - b.i || ORDER.indexOf(a.t) - ORDER.indexOf(b.t));
  const out = [], inSec = {}, useObj = {}; const sk = (o) => o.section || o.id;
  for (const w of want) { if (out.length >= n) break; const natural = has(w.t);
    const o = (pool || []).filter((x) => (!natural || (x.types && x.types[w.t])) && (inSec[sk(x)] || 0) < perSec && !out.some((s) => s.objective_id === x.id && s.qtype === w.t))
      .sort((a, b) => (inSec[sk(a)] || 0) - (inSec[sk(b)] || 0) || (useObj[a.id] || 0) - (useObj[b.id] || 0) || pageKey(a.pages) - pageKey(b.pages))[0]; if (!o) continue;
    const sup = (o.types && o.types[w.t]) || {}; inSec[sk(o)] = (inSec[sk(o)] || 0) + 1; useObj[o.id] = (useObj[o.id] || 0) + 1;
    out.push({ qtype: w.t, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages, task: sup.task || null, section_key: o.section || '', section_label: o.section_label || '', shape: AI_FORMS[w.t][w.i], section: String(o.section_label || o.statement || '').slice(0, 80), ...(natural ? {} : { forced: true }) }); }
  out.forEach((s, k) => { s.slot = k + 1; }); return out; }
/* BATCHES BY SECTION. The batches of a round are written at the same moment, each blind to the others: two questions on one part of the lecture written in two batches
 * easily ask the same thing (and one is then rejected and written again - a whole extra round). So the slots of one section are written in ONE request, where the model
 * sees them side by side and gives each a different point and form. Same number of requests (the same batch count); a section larger than a batch is cut into pieces. */
const secKey = (s) => s.section_key || String(s.objective || s.objective_id || '').toLowerCase().replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '').trim() || 'p' + pageKey(s.pages);
function packBySection(slots, bs) {
  if (slots.length <= bs) return slots.length ? [slots.slice()] : [];
  const B = Math.ceil(slots.length / bs); const groups = new Map(); slots.forEach((s) => { const k = secKey(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
  const pieces = []; for (const g of groups.values()) for (let i = 0; i < g.length; i += bs) pieces.push(g.slice(i, i + bs));
  pieces.sort((a, b) => b.length - a.length || pageKey(a[0].pages) - pageKey(b[0].pages));
  const bins = Array.from({ length: B }, () => []);
  for (const pc of pieces) {
    const fit = bins.filter((b) => b.length + pc.length <= bs).sort((a, b) => b.length - a.length)[0];      // the fullest batch it still fits (keeps the batch count)
    if (fit) { fit.push(...pc); continue; }
    let rest = pc.slice(); for (const b of bins.slice().sort((a, c) => a.length - c.length)) { while (rest.length && b.length < bs) b.push(rest.shift()); if (!rest.length) break; }      // no room for it whole: spread it
    if (rest.length) bins.push(rest);
  }
  const first = (b) => Math.min(...b.map((s) => pageKey(s.pages)));
  return bins.filter((b) => b.length).map((b) => b.sort((x, y) => pageKey(x.pages) - pageKey(y.pages) || x.slot - y.slot)).sort((a, b) => first(a) - first(b));
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
/* How many spare questions the FIRST round asks for, written side by side with the planned ones: what the checks reject is replaced at once from the spares, instead of by
 * a second and a third round written one after the other (each round = write + check, the slow part). The spares that are not needed are dropped, reinforcement
 * questions first, so the quiz keeps its planned questions; a spare is checked exactly like any other question. */
const EXTRA_SHARE = 0.15;
const TOPUP_ROUNDS = 1;     // one bounded AI round for what was rejected (a little over-asked); anything still missing is finished locally, so the wait and the cost stay bounded
async function generateToCount(llm, plan, pagesList, st, progress, opts = {}) {
  const want = plan.requested || plan.slots.length; const tries = {};
  // RESUMING A QUIZ (its page was closed or reloaded while it was being made - a phone does that to a page left in the background): the questions the interrupted run
  // had already written and checked are kept, their slots are not written again, and only what is still missing is asked
  const prior = (opts.resume || []).filter((c) => c && c.stem && Array.isArray(c.options) && Array.isArray(c.evidence)); const plan0 = plan;      // plan0: the whole plan (what the coverage is measured on)
  if (prior.length) { const done = new Set(prior.map((c) => c.slot)); plan = { ...plan, slots: plan.slots.filter((s) => !done.has(s.slot)) }; }
  let lastNo = Math.max(0, ...plan0.slots.map((s) => s.slot), ...prior.map((c) => +c.slot || 0)); const left = Math.max(0, want - prior.length);
  // ask a few more than requested IN THE FIRST ROUND (other angles on the least-covered parts): what the checks reject is usually made up at once, without a second and a third
  // round of requests one after the other (each round = write + check, the slowest part of a quiz). The surplus is dropped below, reinforcement questions first.
  const planned = {}; plan.slots.forEach((s) => { planned[s.objective_id] = (planned[s.objective_id] || 0) + 1; });
  const lanes = Math.max(1, opts.concurrency || 1), bsz = Math.min(5, Math.max(3, Math.ceil(plan.slots.length / lanes))); const room = lanes * bsz - plan.slots.length;      // what the lanes can write in ONE wave
  // spares that fit the same wave cost no time and spare a second round. Claude only: up to 40% more (a real quiz lost 26 of 68 drafts) - but only as many as fit
  // the waves the round needs anyway: a spare that opens one more wave costs a whole wave of waiting (30 questions on 7 lanes: 48 s became 86 s). Pipelined
  // retries make up a rejected slot as soon as its batch is checked: they keep the spares of one wave.
  const fit = Math.min(opts.aiOnly ? 24 : 20, Math.ceil(left * (opts.aiOnly ? 0.4 : 0.25)), Math.max(Math.ceil(left * EXTRA_SHARE), room));
  const wave = lanes * 5, waveRoom = Math.max(1, Math.ceil(plan.slots.length / wave)) * wave - plan.slots.length;      // (a batch writes at most 5)
  const nExtra = opts.aiOnly && !opts.pipeline ? Math.max(fit, Math.min(24, Math.ceil(left * 0.4), waveRoom)) : fit;
  const extra = left >= 5 ? reinforcementSlots(plan.pool || [], planned, nExtra, tries, { easy: !!opts.aiOnly }) : [];
  extra.forEach((s) => { s.slot = ++lastNo; s.difficulty = difficultyFor(st, s.qtype); tries[s.objective_id] = (tries[s.objective_id] || 0) + 1; });
  // THE WHOLE LECTURE, NOT ONLY THE COUNT: every section the plan gave a slot must end with a question (a real quiz of 20 for 20 sections had 4 slots refused or
  // rejected, and their replacements went to sections that already had one - 16/20). A question covers the section of its objective and the sections of the
  // pages it quotes; a slot that fails is replaced in ITS section first (another objective of it, the easiest type Claude has not refused there).
  const pool = plan.pool || [], secOfObj = {}; pool.forEach((o) => { secOfObj[o.id] = o.section || ''; }); const pageSec = opts.pageSection || {};
  const target = new Set(plan0.slots.map((s) => s.section_key || secOfObj[s.objective_id] || '').filter(Boolean));
  // A SECTION IS COVERED BY A QUESTION THAT QUOTES IT: the sections of the pages a question quotes - where its fact really is - not the section it was asked for (a
  // question written for one section can quote a page of another one; it covered that other one). The objective's section counts only when its quotes name none.
  const secsOf = (c) => { const out = new Set(); (c.evidence || []).forEach((e) => { const x = pageSec[e.page]; if (x) out.add(x); });
    if (!out.size) { const k = c.section_key || secOfObj[c.objective_id]; if (k) out.add(k); } return out; };
  const covered = (list) => { const k = new Set(); list.forEach((c) => secsOf(c).forEach((x) => k.add(x))); return k; };
  const refusedT = {}, coverTries = {};
  // a section still without a question is asked again in up to COVER_TRIES tries in all (each a slot of its own), then reported. The tries left for it go out
  // SIDE BY SIDE in the next top-up round: four rounds of two, one after the other, cost a 50-question quiz a minute at its end for one section; the same
  // eight tries in one round cost the same requests (at most) and a quarter of that time
  const COVER_TRIES = 8, COVER_AT_ONCE = COVER_TRIES;
  const EASY = ['basic_recall', 'understanding', 'mechanisms', 'compare_contrast', 'not_except', 'best_answer', 'application', 'scenarios', 'critical_thinking', 'sequence'];
  const coverSlots = (secs, per) => { const out = [];
    for (const sec of secs) { const objs = pool.filter((o) => (o.section || '') === sec); const n = Math.min(per, COVER_TRIES - (coverTries[sec] || 0)); if (!objs.length || n <= 0) continue; coverTries[sec] = (coverTries[sec] || 0) + n;
      const ranked = objs.slice().sort((a, b) => (tries[a.id] || 0) - (tries[b.id] || 0) || pageKey(a.pages) - pageKey(b.pages));
      for (let j = 0; j < n; j++) { const o = ranked[j % ranked.length]; const types = Object.keys(o.types || {}); const avail = (types.length ? types : ['basic_recall']).filter((t) => !(refusedT[o.id] && refusedT[o.id].has(t)));
        const t = EASY.find((x) => avail.includes(x) && !out.some((y) => y.objective_id === o.id && y.qtype === x)) || avail[0] || 'basic_recall'; const sup = (o.types || {})[t] || {};
        out.push({ qtype: t, objective_id: o.id, objective: o.statement, pages: sup.pages || o.pages, task: sup.task || null, variant: 1, section_key: sec, section_label: o.section_label || '', cover: true });
        tries[o.id] = (tries[o.id] || 0) + 1; } }
    return out; };
  // A SECTION WHOSE TEXT CANNOT CARRY A QUESTION IS NOT CHASED: when its tries fail because the line they quote is not teaching text (a heading, a fragment the
  // reading set aside), more tries meet the same answer - a real 30-question quiz spent two minutes on eight such tries at one section ("Its divided into 4
  // parts"), round after round, and never covered it. After two such failures, and no more failures of another kind, the section is reported as not covered and
  // the rounds stop chasing it. A section that fails otherwise (Claude declining a type, a wrong option, a duplicate) keeps all its tries, as before.
  const slotSec = {}, secBad = {}, secOther = {}; const UNUSABLE = new Set(['owner_evidence']);      /* the quoted line is not teaching text (Claude declining a type is not: another type can still be written - a hard section once took six tries) */
  const noteSlots = (list) => (list || []).forEach((x) => { const k = x.section_key || secOfObj[x.objective_id] || ''; if (k) slotSec[x.slot] = k; });
  const judge = (r) => { const have = covered(base0.concat(r.accepted || [])); const failed = new Set((r.dropped || []).map((d) => d.slot));
    for (const [slot, fams] of Object.entries(r.why || {})) { const k = slotSec[slot]; if (!k || !failed.has(+slot) || have.has(k) || !target.has(k)) continue;
      if (fams.length && fams.every((f) => UNUSABLE.has(f))) secBad[k] = (secBad[k] || 0) + 1; else secOther[k] = (secOther[k] || 0) + 1; }
    for (const k of target) if (!have.has(k) && (secBad[k] || 0) >= 2 && (secBad[k] || 0) >= (secOther[k] || 0) && (coverTries[k] || 0) < COVER_TRIES) { coverTries[k] = COVER_TRIES; (judge.gaveUp ||= []).push(k); } };
  noteSlots(plan.slots);
  let base0 = prior.slice();      // what earlier rounds accepted (the sections they cover count) - an interrupted run's questions too
  const kept = prior.slice();      // every question accepted so far, also by an interrupted run: the caller keeps it as a checkpoint (opts.checkpoint)
  opts = { ...opts, onAccept: opts.checkpoint ? (c) => { kept.push(c); opts.checkpoint(kept); } : null, onRefused: (oid, qtype) => { if (oid) { tries[oid] = (tries[oid] || 0) + 3; (refusedT[oid] ||= new Set()).add(qtype); } },      // a refused part of the lecture is asked again only after the others (for the count)
    uncovered: (acc) => { const have = covered(base0.concat(acc)); return new Set([...target].filter((k) => !have.has(k) && (coverTries[k] || 0) < COVER_TRIES)); } };
  const shapeUp = (slots, prior) => { if (opts.shape && slots.length) try { opts.shape(slots, prior); } catch (_) { /* guidance only */ } };      // the composer gives the new slots their forms, continuing each section's rotation
  shapeUp(extra, plan.slots); noteSlots(extra);
  // (mid-round, while other batches are still out, `cover` is false: a section whose slot is still being written is not missing)
  const refill = (n, acc, pending, cover = true) => { const busy = new Set((pending || []).map((x) => x.section_key || secOfObj[x.objective_id] || '')); const have = covered(base0.concat(acc));
    const cov = cover ? coverSlots([...target].filter((k) => !have.has(k) && !busy.has(k)), COVER_AT_ONCE) : [];      /* the retry round of a round: all the tries left for a section still without a question, at once (not one per round) */ const counts = {}; base0.concat(acc).forEach((c) => { counts[c.objective_id] = (counts[c.objective_id] || 0) + 1; });
    const rest = n > cov.length ? reinforcementSlots(pool, counts, n - cov.length, tries, { easy: !!opts.aiOnly, refused: refusedT }) : []; rest.forEach((x) => { tries[x.objective_id] = (tries[x.objective_id] || 0) + 1; });
    const slots = cov.concat(rest); slots.forEach((x) => { x.slot = ++lastNo; x.difficulty = difficultyFor(st, x.qtype); }); noteSlots(slots); shapeUp(slots, plan.slots.concat(extra)); return slots; };
  const tRound = Date.now();
  const until = () => (opts.until ? opts.until() : opts.budgetMs ? tRound + opts.budgetMs : 0);      // the quiz's own deadline (Claude only: 100 s, the hidden time not counted), else a budget from now
  const hardUntil = () => (opts.hardUntil ? opts.hardUntil() : 0);      // never past this (Claude only): a quiz that cannot finish is delivered as it is, never left waiting
  const first = await generate(llm, extra.length ? { ...plan, slots: plan.slots.concat(extra) } : plan, pagesList, st, progress, { ...opts, want: left, base: prior, refill, pipeline: !!opts.pipeline, deadline: until, hardDeadline: hardUntil });
  const roundMs = Date.now() - tRound; const budget = opts.budgetMs || 0;      // a further AI round only when it still fits the time the student is promised; otherwise the rest is finished locally
  const all = { accepted: prior.concat(first.accepted), dropped: first.dropped.slice(), stats: { ...first.stats, topup_rounds: 0, asked_extra: extra.length, ...(prior.length ? { resumed_with: prior.length } : {}) }, outcomes: (first.outcomes || []).slice() };
  const down = (r) => r.dropped.length > 0 && r.accepted.length === 0 && r.dropped.every((d) => (d.reasons || []).some((x) => /^خطأ في خدمة التوليد/.test(x)));
  if (down(first) || (left > 0 && !first.accepted.length)) return all;               // the service failed, or nothing the model wrote was usable: more rounds would only repeat that (the caller finishes locally)
  judge(first); base0 = all.accepted;
  for (let round = 1; round <= (opts.topupRounds || TOPUP_ROUNDS) && (all.accepted.length < want || opts.uncovered([]).size); round++) {      // (Claude only: up to four rounds - nothing is finished locally there)
    const est = first.stats.last_round_ms && first.stats.last_round_ms < roundMs ? first.stats.last_round_ms : roundMs / 2;      // a top-up of small requests lasts about as long as the retry round did
    // THE COUNT AND THE WHOLE LECTURE ARE NEVER CUT BY THE CLOCK (Claude only): on a slow day (answers of 26 s, up to 52 s) a real 50-question quiz reached 206 s
    // after two rounds, and the round that would have finished it was skipped for a 240 s limit - it ended at 42. A round for questions still missing, or a section
    // with text still unasked, runs whatever the time; only a safety ceiling (10 minutes) stops one. (The web edition finishes a short count locally, as before.)
    if (opts.aiOnly ? (hardUntil() && Date.now() > hardUntil()) : (until() && Date.now() + est > until())) { all.stats.topup_skipped_for_time = 1; break; }
    const deficit = Math.max(0, want - all.accepted.length), n = deficit ? Math.min(40, deficit + (opts.aiOnly ? Math.max(4, Math.ceil(deficit * .8)) : Math.min(5, Math.ceil(deficit * .3)))) : 0;     // ask more than is missing: some will be rejected (Claude only: nothing is filled locally, so more)
    const cov = coverSlots([...opts.uncovered([])], COVER_AT_ONCE); cov.forEach((x) => { x.slot = ++lastNo; x.difficulty = difficultyFor(st, x.qtype); });      // the tries for a section still without a question, side by side (they cost no extra time)
    const counts = {}; all.accepted.forEach((c) => { counts[c.objective_id] = (counts[c.objective_id] || 0) + 1; });
    const more = n > cov.length ? reinforcementSlots(pool, counts, n - cov.length, tries, { easy: !!opts.aiOnly, refused: refusedT }) : [];
    more.sort((a, b) => pageKey(a.pages) - pageKey(b.pages) || ORDER.indexOf(a.qtype) - ORDER.indexOf(b.qtype));
    more.forEach((s) => { s.slot = ++lastNo; s.difficulty = difficultyFor(st, s.qtype); tries[s.objective_id] = (tries[s.objective_id] || 0) + 1; });
    const slots = cov.concat(more); if (!slots.length) break; noteSlots(slots); all.stats.cover_slots = (all.stats.cover_slots || 0) + cov.length;
    shapeUp(slots, plan.slots.concat(extra));
    const sub = (stage, pct) => progress('retrying', Math.min(99, Math.round(100 * (all.accepted.length + (pct / 100) * deficit) / want)));
    const r = await generate(llm, { ...plan, slots, requested: want }, pagesList, st, sub, { ...opts, base: all.accepted, want: deficit, pipeline: !!opts.pipeline, deadline: until, hardDeadline: hardUntil });
    all.accepted.push(...r.accepted); all.dropped.push(...r.dropped); all.outcomes.push(...(r.outcomes || [])); for (const k in r.stats) all.stats[k] = (all.stats[k] || 0) + r.stats[k]; all.stats.topup_rounds = round;
    judge({ ...r, accepted: all.accepted });
    // nothing usable from a round for the count: more would only repeat that. A round that only tried a section still without a question goes on (once the count
    // was met, one failed try used to end the rounds and leave that section out with tries to spare); its tries are counted, so it still ends
    if (down(r) || (!r.accepted.length && more.length)) break;
  }
  if (judge.gaveUp) all.stats.cover_unaskable = judge.gaveUp.length;
  if (all.accepted.length > want) {            // exactly the count asked for: the surplus (from asking a little more) goes first among reinforcement questions that carry remarks, then the latest
    const was = new Set(prior);      // a question an interrupted run had already written and checked is kept first (it is paid for)
    const rank = (c) => (was.has(c) ? -1 : c.extra ? ((c.issues || []).some((i) => i.severity === 'minor') ? 2 : 1) : 0); const secOf = (c) => c.section_key || String(c.objective || c.objective_id || '').toLowerCase().replace(/\s*\((?:cont(?:inued)?[^)]*)\)\s*$/i, '');
    all.accepted.sort((a, b) => rank(a) - rank(b) || a.slot - b.slot);
    // drop from the end, but never a section's only question (the quiz keeps covering the whole lecture) - first where the objective too keeps a question, then
    // where only the section does; then, if still over, the plain order
    const keep = all.accepted.slice(); const n = {}, m = {}; const ks = (c) => { const k = [...secsOf(c)]; return k.length ? k : [secOf(c)]; };
    keep.forEach((c) => { ks(c).forEach((k) => { n[k] = (n[k] || 0) + 1; }); m[c.objective_id] = (m[c.objective_id] || 0) + 1; });
    for (const strict of [true, false]) for (let i = keep.length - 1; i >= 0 && keep.length > want; i--) { const c = keep[i];
      if (ks(c).every((k) => n[k] > 1) && (!strict || m[c.objective_id] > 1)) { ks(c).forEach((k) => { n[k]--; }); m[c.objective_id]--; keep.splice(i, 1); } }
    all.accepted = keep.slice(0, want);
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

window.QZE = { makeExplain, checkExplain, makeSlideAnswer, readFigure, checkFigure, FIG, makeTutorReply, makeSimilar, checkTutor, checkSimilar, assignForms, AI_FORMS, FL, FORM_TIPS, formIndex, densityOf, learnForms, mergeProfiles, formGuide, formsProgress, exploreSlots, famOf, META_OPT, _judge: judge, reflowLines, checkCorrection, makeCorrection, cleanFix, isArabicText, normRefs, normType, normObjectives, fallbackObjectives, normProfile, mergeAgentProfiles, reconcileProfile, attachSupports, profileAgent, levelOf, STOP, llmCheckBatch, QT, ORDER, detectField, support, buildPlan, analyse, generate, generateToCount, reinforcementSlots, difficultyFor, pageKey, orderQuestions, validateQ, quoteIn, norm, toks, jac, P, mapLimit, arRatio, pn, dupOf, leaks };
})();
