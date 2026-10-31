// node claude-edition/test/planner_v2.test.js — planner v2: coverage first, the requested count is always honoured through variants,
// the ten internal types are chosen from what each objective supports, and generation tops up / rescues instead of falling short.
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const mkObj = (i, types, over = {}) => ({ id: 'o' + i, statement: 'Objective ' + i, pages: ['d1p' + i], key_terms: [], capacity: 1 + (i % 3), supports: Object.fromEntries(types.map((t) => [t, { pages: ['d1p' + i], task: null }])), ...over });
const objs = (n, types = ['basic_recall', 'understanding']) => Array.from({ length: n }, (_, k) => mkObj(k + 1, typeof types === 'function' ? types(k + 1) : types));
const per = (plan) => { const m = {}; plan.slots.forEach((s) => (m[s.objective_id] = (m[s.objective_id] || 0) + 1)); return m; };

// ---- 1) the requested count is honoured with variants; every objective is covered
{ const plan = E.buildPlan({ objectives: objs(6) }, { count: 20 }, null);
  assert.strictEqual(plan.slots.length, 20); assert.strictEqual(plan.requested, 20); assert.strictEqual(plan.shortfall, null, 'no shortfall: variants fill the count');
  const c = per(plan); assert.strictEqual(Object.keys(c).length, 6, 'every objective asked'); Object.values(c).forEach((n) => assert(n >= 3 && n <= 4, 'spread evenly: ' + JSON.stringify(c)));
  const v0 = plan.slots.filter((s) => s.variant === 0); assert.strictEqual(v0.length, 6); assert(plan.slots.slice(0, 6).every((s) => s.variant === 0), 'first pass over the lecture comes first');
  assert(v0.every((s, i, a) => !i || E.pn(a[i - 1].pages[0]) <= E.pn(s.pages[0])), 'first pass is in lecture order');
  plan.slots.filter((s) => s.variant > 0).forEach((s) => assert(s.angle, 'a variant carries an angle'));
  const angles = {}; plan.slots.filter((s) => s.variant > 0).forEach((s) => ((angles[s.objective_id] ||= []).push(s.angle))); Object.values(angles).forEach((a) => assert.strictEqual(new Set(a).size, a.length, 'variants of one objective use different angles'));
  assert.deepStrictEqual(plan.slots.map((s) => s.slot), plan.slots.map((_, i) => i + 1)); }

// ---- 2) "auto" = enough questions to cover everything (about 1.3 per objective, 10..40, never fewer than the objectives up to 60)
{ assert.strictEqual(E.buildPlan({ objectives: objs(6) }, { count: 'auto' }, null).requested, 10);
  assert.strictEqual(E.buildPlan({ objectives: objs(20) }, { count: 'auto' }, null).requested, 26);
  const p30 = E.buildPlan({ objectives: objs(30) }, { count: 'auto' }, null); assert.strictEqual(p30.requested, 39); assert.strictEqual(Object.keys(per(p30)).length, 30, 'all 30 objectives covered');
  const p70 = E.buildPlan({ objectives: objs(70) }, { count: 'auto' }, null); assert.strictEqual(p70.requested, 60); assert.strictEqual(p70.coverage_partial, true);
  assert.strictEqual(E.buildPlan({ objectives: objs(6) }, {}, null).auto, true, 'no count = auto'); }

// ---- 3) a tiny lecture cannot be repeated forever: capped per objective, reported softly
{ const plan = E.buildPlan({ objectives: objs(2) }, { count: 30 }, null); assert.strictEqual(plan.slots.length, 2 * E.MAX_PER_OBJ); assert(plan.shortfall && plan.shortfall.possible === 12 && plan.shortfall.requested === 30); }

// ---- 4) fewer questions than objectives: an even spread over the WHOLE lecture, not the first pages
{ const plan = E.buildPlan({ objectives: objs(40) }, { count: 10 }, null); assert.strictEqual(plan.slots.length, 10); assert.strictEqual(plan.coverage_partial, true);
  const pages = plan.slots.map((s) => E.pn(s.pages[0])).sort((a, b) => a - b); assert(pages[0] <= 4 && pages[9] >= 37, 'spans the lecture: ' + pages.join(',')); assert.strictEqual(new Set(plan.slots.map((s) => s.objective_id)).size, 10); }

// ---- 5) the internal identity: only supported types, none that the heuristics vetoed, and variety across the quiz
{ const sup = (i) => [['basic_recall', 'understanding'], ['mechanisms', 'understanding'], ['sequence', 'basic_recall'], ['compare_contrast', 'understanding'], ['application', 'critical_thinking', 'basic_recall']][i % 5];
  const analysis = { objectives: objs(10, sup) }; const heur = Object.fromEntries(E.ORDER.map((c) => [c, { level: c === 'sequence' ? 'none' : 'strong', missing: 'no steps in the lecture' }]));
  const plan = E.buildPlan(analysis, { count: 20 }, heur); const by = Object.fromEntries(analysis.objectives.map((o) => [o.id, o]));
  plan.slots.forEach((s) => { assert(s.qtype in by[s.objective_id].supports, `${s.qtype} is not supported by ${s.objective_id}`); assert.notStrictEqual(s.qtype, 'sequence', 'vetoed type never used'); });
  assert(new Set(plan.slots.map((s) => s.qtype)).size >= 5, 'variety: ' + JSON.stringify(plan.distribution)); }

// ---- 6) duplicates: variants of the SAME objective may re-test a fact; different objectives may not
{ const q = (o, stem, key, opts, ev = 'The enzyme binds the receptor firmly.') => ({ slot: 1, qtype: 'basic_recall', objective_id: o, stem, purpose: 'p ' + stem, options: [key, ...opts], correct_index: 0, evidence: [{ page: 'd1p1', quote: ev }] });
  const a = q('o1', 'Which molecule binds the receptor firmly in this lecture?', 'Enzyme', ['Ligand', 'Vesicle', 'Platelet']); a.slot = 1;
  const reworded = q('o1', 'Fill the gap: the _____ is the one that attaches to the receptor tightly.', 'Enzyme', ['Hormone', 'Synapse', 'Nucleus']);
  assert.strictEqual(E.dupOf(reworded, [a]), null, 'same objective + same fact + same evidence but another wording/distractors is a legitimate variant');
  const copy = q('o1', 'Which molecule binds the receptor firmly in this lecture?', 'Enzyme', ['Ligand', 'Vesicle', 'Platelet']); assert.strictEqual(E.dupOf(copy, [a]), 1, 'a copy is rejected');
  const sameOpts = q('o1', 'Pick the binder of the receptor from the options below please.', 'Enzyme', ['Ligand', 'Vesicle', 'Platelet']); assert.strictEqual(E.dupOf(sameOpts, [a]), 1, 'identical option set is a copy');
  const other = q('o2', 'Fill the gap: the _____ is the one that attaches to the receptor tightly.', 'Enzyme', ['Hormone', 'Synapse', 'Nucleus']); assert.strictEqual(E.dupOf(other, [a]), 1, 'different objective sharing fact + evidence + type is still a duplicate');
  assert.strictEqual(E.leaks(reworded, [{ ...a, options: ['the enzyme binds the receptor', 'x', 'y', 'z'] }]), null, 'no leak check inside one objective'); }

// ---- 7) generation honours the count, rescues uncovered objectives and tops up shortfalls (fake model, real validators)
const TERMS = ['Glucose', 'Membrane', 'Receptor', 'Enzyme', 'Ligand', 'Vesicle', 'Nucleus', 'Hormone', 'Antibody', 'Synapse'];
const VERBS = ['stabilises', 'amplifies', 'suppresses', 'transports', 'degrades', 'binds', 'activates', 'filters', 'recruits', 'modulates'];
const NOUNS = ['sodium', 'calcium', 'oxygen', 'lactate', 'insulin', 'thyroxine', 'collagen', 'fibrin', 'myosin', 'cortisol'];
const V2 = ['lowers', 'elevates', 'delays', 'prevents', 'restores', 'shortens', 'prolongs', 'balances', 'reduces', 'enhances'], N3 = ['renal', 'hepatic', 'neural', 'vascular', 'muscular', 'thyroid', 'cardiac', 'immune', 'skeletal', 'pancreatic'], N4 = ['fasting', 'exercise', 'infection', 'dehydration', 'fever', 'hypoxia', 'trauma', 'starvation', 'pregnancy', 'altitude'];
// every page uses its own vocabulary (as real lectures do), so only genuine near-copies reach the duplicate thresholds
const pagesList = Array.from({ length: 10 }, (_, i) => ({ ref: `d1p${i + 1}`, text: `Topic ${i}: ${TERMS[i]} is the ${i % 2 ? 'rapid' : 'gradual'} regulator that ${VERBS[i]} ${NOUNS[i]} inside ${NOUNS[(i + 5) % 10]} tissue and also ${V2[i]} the ${N3[i]} pathway during ${N4[i]} stress.`, doc_id: 'd', page_no: i + 1 }));
const LEAD = ['Complete according to the lecture:', 'Select the missing word that finishes this statement:', 'Choose the term that fits the blank below:', 'Identify the word hidden in this lecture sentence:'];
function fakeLLM(rule) { const calls = { generate: 0, verify: 0, explain: 0 }; return { calls, async json(task, sys, prompt) {
  if (task === 'generate') { calls.generate++; const slotsIn = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pages = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
    return { questions: slotsIn.map((s) => { if (rule && rule(s)) return { slot: s.slot, unwritable_reason: 'cannot write this one' }; const ref = s.pages[0], text = pages[ref], term = text.match(/^Topic \d+: (\w+)/)[1], v = s.variant || 0;
      return { slot: s.slot, unwritable_reason: null, stem: `${LEAD[(v + s.slot) % 4]} ${text.replace(term, '_____')}`, options: [term, `${term}AltA${s.slot}`, `${term}AltB${s.slot}`, `${term}AltC${s.slot}`], correct_index: 0,
        explanation: 'الإجابة مبنية على نص المحاضرة: «' + text + '». الخيارات الأخرى لا تظهر في هذا السياق.', purpose: 'p' + ref + 'v' + v + 's' + s.slot, reasoning_pattern: 'r', evidence: [{ page: ref, quote: text }], uses_external: false }; }) }; }
  if (task === 'verify') { calls.verify++; const qs = JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' })) }; }
  calls.explain++; const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) }; } }; }
(async () => {
  const st = { field: 'science', language: 'en', external_mode: 'source_only' }; const noop = () => {};
  const analysis = { objectives: objs(10) };
  // (a) a thin lecture still gives the full count, and every objective is covered
  { const plan = E.buildPlan(analysis, { ...st, count: 25 }, null); const r = await E.generate(fakeLLM(), plan, pagesList, st, noop, { concurrency: 3 });
    assert.strictEqual(r.accepted.length, 25, 'the requested count is delivered'); assert.strictEqual(r.uncovered_objectives.length, 0); assert.strictEqual(r.covered_objectives.length, 10);
    assert(r.accepted.some((c) => c.variant > 0), 'variants were used'); const stems = r.accepted.map((c) => c.stem); assert.strictEqual(new Set(stems).size, stems.length, 'no identical stems'); }
  // (b) an objective the model cannot write in the normal rounds is rescued by the final round (different slot, coverage first)
  { const plan = E.buildPlan(analysis, { ...st, count: 12 }, null); const N = plan.slots.length; const llm = fakeLLM((s) => s.objective === 'Objective 2' && s.slot <= N);
    const r = await E.generate(llm, plan, pagesList, st, noop, { concurrency: 2 }); assert(r.covered_objectives.includes('o2'), 'o2 covered by the top-up round'); assert.strictEqual(r.uncovered_objectives.length, 0); assert(r.stats.topup >= 1); assert.strictEqual(r.accepted.length, 12, 'count still honoured'); }
  // (c) an objective that can never be written: the count is still met through the others and the gap is REPORTED, not hidden
  { const plan = E.buildPlan(analysis, { ...st, count: 14 }, null); const r = await E.generate(fakeLLM((s) => s.objective === 'Objective 3'), plan, pagesList, st, noop, { concurrency: 2 });
    assert.strictEqual(r.accepted.length, 14, 'count met by variants on other objectives'); assert.deepStrictEqual(r.uncovered_objectives, ['o3']); assert(!r.accepted.some((c) => c.objective_id === 'o3')); }
  console.log('planner v2 tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
