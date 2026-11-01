// node claude-edition/test/profile.test.js — the lecture PROFILER (an internal agent): which of the ten question types THIS lecture supports and how many questions of each it can sustain,
// and the planner distributing the questions from it. Nothing here is ever shown to the learner.
//  1) the structural reading (no AI): lectures of different character get different distributions - the plan follows the lecture
//  2) the AI agent: its counts drive the plan; a type it finds nothing for is taken off the objectives; a type it over-claims is bounded by what the text visibly shows;
//     it is merged with the structural reading; when it fails or answers with junk the structural reading stands and the analysis still succeeds
//  3) the agent runs BESIDE the objective analysis (no extra waiting) and the parts of a long lecture are analysed in parallel with the same result as one after the other
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert');
const mk = (arr) => arr.map((t, i) => ({ ref: `d1p${i + 1}`, text: t, doc_id: 'd', page_no: i + 1 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defs = mk(Array.from({ length: 10 }, (_, i) => `Topic ${i + 1} glossary\nAlpha${i}cyte: a specialised cell that stores energy for the organism during growth.\nBeta${i}zyme: an enzyme that breaks down complex sugars into simple units inside the gut.\nGamma${i}ine: a hormone that regulates the rate of metabolism in resting tissue.\nDelta${i}osis: the process in which a cell absorbs fluid from its surrounding environment.`));
const steps = mk(Array.from({ length: 10 }, (_, i) => `Procedure ${i + 1}\n1. Prepare the sample and label the tube ${i}.\n2. Add the buffer and mix gently for thirty seconds.\n3. Incubate the mixture at room temperature for ten minutes.\n4. Measure the absorbance and record the value.\nThe procedure ends after step 4 because the reaction is complete.`));
const mixed = mk(Array.from({ length: 10 }, (_, i) => `Unit ${i + 1}\nAlpha${i}cyte: a specialised cell that stores energy for the organism during growth.\nBeta${i}zyme: an enzyme that breaks down complex sugars into simple units inside the gut.\nThe reaction leads to a rise in temperature because the enzyme is active in the tissue.\nThe cart accelerates at ${i + 2}.5 m/s over a distance of ${i + 10} m during the first test.\n1. Prepare the sample.\n2. Add the buffer and mix.\n3. Measure the absorbance of the mixture.`));
const st = (n = 20, over = {}) => ({ count: n, focus: 'balanced', field: 'science', difficulty: 'mixed', language: 'source', external_mode: 'source_only', ...over });
const planOf = (pages, analysis, n = 20, over) => E.buildPlan(analysis, st(n, over), E.support(pages.map((p) => p.text), 'science'));
const share = (dist, types) => types.reduce((a, t) => a + (dist[t] || 0), 0) / Object.values(dist).reduce((a, b) => a + b, 0);
const caps = (prof) => Object.fromEntries(Object.entries(prof.types).map(([k, v]) => [k, v.capacity]));

(async () => {
  // ---------------------------------------------------------------- 1) the structural reading follows the lecture
  const aDefs = R.analyse(defs), aSteps = R.analyse(steps), aMixed = R.analyse(mixed);
  assert(aDefs.profile && aDefs.profile.types.basic_recall.capacity > 20 && aDefs.profile.types.sequence.capacity === 0, 'a glossary: lots of recall, no sequence');
  assert(aSteps.profile.types.sequence.capacity >= 8 && aSteps.profile.types.basic_recall.capacity === 0, 'numbered procedures: a sequence per page');
  assert(E.levelOf(0) === 'none' && E.levelOf(2) === 'limited' && E.levelOf(5) === 'good' && E.levelOf(6) === 'strong');
  const pDefs = planOf(defs, aDefs), pSteps = planOf(steps, aSteps), pMixed = planOf(mixed, aMixed);
  for (const p of [pDefs, pSteps, pMixed]) { assert.strictEqual(p.feasible_count, 20, 'the requested count is always planned'); assert(p.profile && p.profile.basic_recall, 'the plan keeps the profile (internal)'); }
  assert(share(pDefs.distribution, ['basic_recall', 'understanding']) === 1 && pDefs.distribution.sequence === 0, 'a glossary: recall + understanding only');
  assert(pSteps.distribution.sequence >= 8 && pSteps.distribution.basic_recall === 0, 'procedures: sequence questions, no recall of facts the lecture does not contain: ' + JSON.stringify(pSteps.distribution));
  const used = Object.entries(pMixed.distribution).filter(([, n]) => n > 0).map(([k]) => k); assert(used.length >= 5, 'a mixed lecture gets a mix of types: ' + JSON.stringify(pMixed.distribution));
  for (const t of used) assert(aMixed.profile.types[t].capacity > 0, t + ' is planned only where the lecture can sustain it');
  // the distribution is not one fixed recipe: the SAME requested count is distributed differently for different lectures
  assert(JSON.stringify(pDefs.distribution) !== JSON.stringify(pSteps.distribution) && JSON.stringify(pSteps.distribution) !== JSON.stringify(pMixed.distribution));
  // a type with more material gets a bigger share, but not all of it (square-root weighting)
  const fake = { objectives: Array.from({ length: 40 }, (_, i) => ({ id: 'o' + (i + 1), statement: 's' + i, pages: ['d1p1'], capacity: 1, supports: { basic_recall: { pages: ['d1p1'] }, mechanisms: { pages: ['d1p1'] }, sequence: { pages: ['d1p1'] } } })),
    profile: { types: Object.fromEntries(E.ORDER.map((c) => [c, { capacity: { basic_recall: 36, mechanisms: 9, sequence: 4 }[c] || 0, level: 'strong', pages: ['d1p1'] }])) } };
  const pw = E.buildPlan(fake, st(11), null); assert.deepStrictEqual([pw.distribution.basic_recall, pw.distribution.mechanisms, pw.distribution.sequence], [6, 3, 2], 'weights = sqrt(capacity): 6 : 3 : 2, got ' + JSON.stringify(pw.distribution));
  const pc = E.buildPlan({ ...fake, profile: { types: { ...fake.profile.types, sequence: { capacity: 1, level: 'limited', pages: ['d1p1'] } } } }, st(11), null); assert(pc.distribution.sequence <= 1, 'no type is asked for more than the lecture can sustain');
  // an analysis made before profiles existed still plans (the former recipe)
  const old = E.buildPlan({ ...fake, profile: undefined }, st(10), null); assert.strictEqual(old.feasible_count, 10); assert.strictEqual(old.profile, null);
  console.log('ok   1) structural profile: glossary -> recall/understanding, procedures -> sequence, mixed -> a mix; weights follow the material; old analyses still plan');

  // ---------------------------------------------------------------- 2) the AI agent
  const objectivesFor = (pages) => pages.map((p, i) => ({ id: 'o' + i, statement: p.text.split('\n')[0], pages: [p.ref], key_terms: [], capacity: 2, supports: Object.fromEntries(E.ORDER.map((c) => [c, { pages: [p.ref] }])) }));      // an over-claiming analysis: every type everywhere
  const model = (profile, opts = {}) => { const calls = { analyze: 0, profile: 0 }; return { calls, async json(task, sys, prompt) {
    if (opts.delay) await sleep(opts.delay);
    if (task === 'profile') { calls.profile++; if (opts.profileThrows) throw opts.profileThrows; return typeof profile === 'function' ? profile(prompt) : profile; }
    calls.analyze++; const pg = JSON.parse(prompt.slice(prompt.indexOf('PAGES:\n') + 7)); return { lecture_character: 'x', objectives: objectivesFor(pg) }; } }; };
  const agentSays = { types: { basic_recall: { capacity: 12, pages: ['d1p1', 'd1p2', 'd1p3'] }, understanding: { capacity: 8, pages: ['d1p2'] }, mechanisms: { capacity: 3, pages: ['d1p4'] }, application: { capacity: 0 }, critical_thinking: { capacity: 4, pages: ['d1p5'] }, scenarios: { capacity: 0 },
    compare_contrast: { capacity: 5, pages: ['d1p6', 'd1p7'] }, best_answer: { capacity: 0 }, not_except: { capacity: 0 }, sequence: { capacity: 0 } } };
  let m = model(agentSays); let a = await E.analyse(m, defs, st());
  assert.strictEqual(m.calls.profile, 1, 'one profiler call for a short lecture'); assert.strictEqual(a.profile.source, 'agent');
  const maxCap = Math.ceil(defs.reduce((n, p) => n + (p.text.match(/\S+/g) || []).length, 0) / 70);      // a lecture cannot sustain more questions of a type than it has words for (one per ~70 words)
  assert.deepStrictEqual(caps(a.profile), { basic_recall: Math.min(12, maxCap), understanding: Math.min(8, maxCap), mechanisms: 3, application: 0, not_except: 0, sequence: 0, compare_contrast: 5, critical_thinking: 4, best_answer: 0, scenarios: 0 }, 'the agent\'s counts');
  for (const c of ['application', 'scenarios', 'best_answer', 'not_except', 'sequence']) assert(a.objectives.every((o) => !o.supports[c]), c + ': the agent found nothing for it, so no objective carries it any more');
  assert(a.objectives.some((o) => o.supports.critical_thinking) && a.objectives.some((o) => o.supports.compare_contrast), 'what it supports stays');
  const plan = E.buildPlan(a, st(20), E.support(defs.map((p) => p.text), 'science')); assert.strictEqual(plan.feasible_count, 20);
  for (const c of ['application', 'scenarios', 'best_answer', 'not_except', 'sequence']) assert.strictEqual(plan.distribution[c], 0, c + ' is not planned');
  for (const c of ['basic_recall', 'understanding', 'mechanisms', 'critical_thinking', 'compare_contrast']) assert(plan.distribution[c] >= 1, c + ' is planned: ' + JSON.stringify(plan.distribution));
  assert(plan.distribution.basic_recall >= plan.distribution.mechanisms, 'more material -> a bigger share');
  // "adds what is supported": objectives that did not carry a type get it where the agent names its pages
  const sparse = { json: async (task, s, prompt) => (task === 'profile' ? { types: { ...agentSays.types, sequence: { capacity: 3, pages: ['d1p2', 'd1p3'] } } } : { objectives: [{ statement: 'a', pages: ['d1p2'], supports: ['recall'] }, { statement: 'b', pages: ['d1p3'], supports: ['recall'] }, { statement: 'c', pages: ['d1p9'], supports: ['recall'] }] }) };
  a = await E.analyse(sparse, steps, st()); assert(a.objectives[0].supports.sequence && a.objectives[1].supports.sequence && !a.objectives[2].supports.sequence, 'sequence was added to the objectives that overlap the pages the agent named');
  // an over-claim is bounded by what the text visibly shows: a model says 30 sequences where the lecture has no numbered steps / ordering at all
  a = await E.analyse(model({ types: { ...agentSays.types, sequence: { capacity: 30, pages: ['d1p1'] } } }), defs, st()); assert(a.profile.types.sequence.capacity <= 3, 'no steps in the text: at most 3, got ' + a.profile.types.sequence.capacity);
  // a strong structural signal is not erased by a model's zero
  a = await E.analyse(model({ types: { ...agentSays.types, sequence: { capacity: 0 } } }), steps, st()); assert(a.profile.types.sequence.capacity >= 2, 'ten numbered procedures: not zero');
  // no type can sustain more questions than the lecture has words for
  const tiny = mk(['Alpha: a short note about cells.\nBeta: another short note about tissue and organs in the body.']); a = await E.analyse(model({ types: Object.fromEntries(E.ORDER.map((c) => [c, { capacity: 40, pages: ['d1p1'] }])) }), tiny, st());
  assert(Object.values(a.profile.types).every((t) => t.capacity <= 2), 'a tiny lecture cannot sustain 40 of anything');
  // the agent fails / answers with junk: the analysis still succeeds on the structural reading
  for (const bad of [{ profileThrows: new Error('HTTP 500') }, { profileThrows: Object.assign(new Error('x'), { code: 'bad_json' }) }, { profileThrows: Object.assign(new Error('x'), { code: 'rate_limited' }) }]) {
    a = await E.analyse(model(agentSays, bad), mixed, st()); assert(a.objectives.length >= 1 && a.profile.source === 'rules', 'agent failure: ' + JSON.stringify(bad)); }
  for (const junk of [{}, null, 'not json', { types: 'none' }, { types: { basic_recall: 3 } }, [], { objectives: [] }]) { a = await E.analyse(model(junk), mixed, st()); assert.strictEqual(a.profile.source, 'rules', 'junk from the agent: ' + JSON.stringify(junk)); assert(a.objectives.length >= 1); }
  // tolerant parsing: names and shapes models drift to
  a = await E.analyse(model({ profile: [{ type: 'Recall', count: '7', pages: ['p1'] }, { name: 'Critical Thinking', capacity: 2 }, { key: 'compare & contrast', n: 3 }, { type: 'Sequence Ordering', capacity: 0 }] }), defs, st());
  assert.strictEqual(a.profile.types.basic_recall.capacity, 7); assert.strictEqual(a.profile.types.critical_thinking.capacity, 2); assert.strictEqual(a.profile.types.compare_contrast.capacity, 3);
  // a real service failure of the OBJECTIVE analysis is not hidden by the agent
  await assert.rejects(() => E.analyse({ json: async (task) => { if (task === 'profile') return agentSays; throw Object.assign(new Error('HTTP 401'), { code: 'auth' }); } }, defs, st()), (e) => e.code === 'auth');
  console.log('ok   2) agent: its counts drive the plan, zeros take a type away, supports are added where it names pages, over-claims are bounded, junk/failure -> structural reading, real failures still surface');

  // ---------------------------------------------------------------- 3) beside the analysis, and the parts of a long lecture in parallel
  const T0 = Date.now(); m = model(agentSays, { delay: 60 }); a = await E.analyse(m, defs, st()); const t1 = Date.now() - T0;
  assert(t1 < 60 * 2 - 10, `the agent runs BESIDE the analysis (one wait, not two): ${t1}ms`);
  const long = mk(Array.from({ length: 36 }, (_, i) => `Page ${i + 1} heading\n` + `Alpha${i}cyte: a specialised cell that stores energy for the organism during growth. `.repeat(1) + 'Filler sentence about the topic that makes this page long enough to matter. '.repeat(60)));
  const count = { analyze: 0, maxAnalyze: 0, running: 0 }; const slow = { json: async (task, sys, prompt) => { if (task === 'profile') { await sleep(5); return agentSays; } count.analyze++; count.running++; count.maxAnalyze = Math.max(count.maxAnalyze, count.running); await sleep(60);
    const pg = JSON.parse(prompt.slice(prompt.indexOf('PAGES:\n') + 7)); count.running--; return { lecture_character: 'x', objectives: objectivesFor(pg) }; } };
  let t = Date.now(); const seq = await E.analyse(slow, long, st()); const tSeq = Date.now() - t; const nChunks = count.analyze; assert(nChunks >= 4, 'a long lecture is analysed in several parts: ' + nChunks); assert.strictEqual(count.maxAnalyze, 1, 'without a width, one part at a time');
  count.analyze = 0; count.maxAnalyze = 0; t = Date.now(); const par = await E.analyse(slow, long, st(), { concurrency: 4 }); const tPar = Date.now() - t;
  assert(count.maxAnalyze >= 3 && count.maxAnalyze <= 4, 'parts are analysed in parallel (width 4): ' + count.maxAnalyze); assert(tPar < tSeq * 0.6, `faster in parallel: ${tPar}ms vs ${tSeq}ms`);
  assert.deepStrictEqual(par.objectives, seq.objectives, 'the result is identical to analysing the parts one after the other (same objectives, same ids, same order)'); assert.deepStrictEqual(par.profile, seq.profile);
  console.log(`ok   3) the agent runs beside the analysis (${t1}ms for a 60ms-per-call model); ${nChunks} parts of a long lecture: ${tSeq}ms one by one -> ${tPar}ms with width 4, identical result`);
  console.log('profile tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
