// node claude-edition/test/analysis_robust.test.js — small/free models drift from the exact format: the analysis must still produce objectives.
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const pages = [1, 2, 3, 4].map((n) => ({ ref: `d1p${n}`, text: `Topic ${n} heading\nThe ${['mitochondria', 'ribosome', 'nucleus', 'lysosome'][n - 1]} performs an important function inside the cell during stage ${n}. Another sentence gives more detail about it.` }));
const multi = [{ ref: 'd1p1', text: 'a' }, { ref: 'd2p1', text: 'b' }, { ref: 'd2p2', text: 'c' }];

// ---- page refs
assert.deepStrictEqual(E.normRefs(['p3', 'Page 2', 4, 'D1P1', 'slide 9', 'd1p7', '1-2'], pages), ['d1p3', 'd1p2', 'd1p4', 'd1p1']);
assert.deepStrictEqual(E.normRefs('d1p2', pages), ['d1p2']); assert.deepStrictEqual(E.normRefs(null, pages), []);
assert.deepStrictEqual(E.normRefs(['p1'], multi), ['d1p1', 'd2p1'], 'ambiguous page number across documents keeps every candidate');
assert.deepStrictEqual(E.normRefs(['d2p2'], multi), ['d2p2']);
// ---- type names
assert.strictEqual(E.normType('Recall'), 'basic_recall'); assert.strictEqual(E.normType('Critical Thinking'), 'critical_thinking'); assert.strictEqual(E.normType('compare & contrast'), 'compare_contrast'); assert.strictEqual(E.normType('NOT/EXCEPT'), 'not_except');
assert.strictEqual(E.normType('Most Correct / Best Answer'), 'best_answer'); assert.strictEqual(E.normType('Clinical Scenarios'), 'scenarios'); assert.strictEqual(E.normType('sequence'), 'sequence'); assert.strictEqual(E.normType('banana'), null);

const st = { field: 'science', language: 'en' };
(async () => {
  const run = (resp) => E.analyse({ json: async () => resp }, pages, st);
  // 1) sloppy refs + supports as an array of names
  let a = await run({ objectives: [{ statement: 'Organelles', pages: ['p1', 'Page 2'], supports: ['Recall', 'Understanding', 'Critical Thinking'] }] });
  assert.strictEqual(a.objectives.length, 1); assert.deepStrictEqual(a.objectives[0].pages, ['d1p1', 'd1p2']); assert.deepStrictEqual(Object.keys(a.objectives[0].supports).sort(), ['basic_recall', 'critical_thinking', 'understanding']); assert(!a.fallback);
  // 2) top-level array, singular "page", supports as [{type,pages}]
  a = await run([{ title: 'Ribosomes', page: 'd1p2', supports: [{ type: 'application', pages: ['p2'] }, { type: 'nonsense' }] }]);
  assert.strictEqual(a.objectives.length, 1); assert.deepStrictEqual(Object.keys(a.objectives[0].supports), ['application']); assert.strictEqual(a.objectives[0].statement, 'Ribosomes');
  // 3) no supports at all => default recall + understanding (validators still gate every question)
  a = await run({ objectives: [{ statement: 'Nucleus', pages: [3] }] }); assert.deepStrictEqual(Object.keys(a.objectives[0].supports).sort(), ['basic_recall', 'understanding']);
  // 4) page refs invalid but the statement matches page text
  a = await run({ objectives: [{ statement: 'Lysosome performs an important function', pages: ['chapter nine'], key_terms: ['lysosome'] }] }); assert.deepStrictEqual(a.objectives[0].pages.length >= 1, true);
  // 5) model returns junk / nothing usable => deterministic per-page fallback, flagged
  for (const junk of [{}, { objectives: [] }, { objectives: [{ statement: 'x', pages: ['z99'] }] }, 'not json at all', null, [], { objectives: 'none' }]) {
    a = await run(junk); assert(a.objectives.length >= 1, 'fallback for ' + JSON.stringify(junk)); assert.strictEqual(a.fallback, true);
    assert(a.objectives.every((o) => o.pages.every((r) => pages.some((p) => p.ref === r)) && Object.keys(o.supports).includes('basic_recall') && o.capacity >= 1)); assert(/تلقائيًا/.test(a.lecture_character)); }
  // 6) the whole plan is then buildable
  a = await run({}); const plan = E.buildPlan(a, { count: 10, focus: 'balanced', field: 'science' }, E.support(pages.map((p) => p.text), 'science')); assert(plan.feasible_count >= 4, 'plan feasible: ' + plan.feasible_count);
  // 6b) the model never answers in JSON (a thinking model out of room, prose... the pool already asked again and tried the others): the quiz is NOT failed, the lecture is split by page.
  //     Real service failures (network, keys, credit) still propagate, so the caller can fall back to the local generator and say why.
  { const bad = Object.assign(new Error('Groq (m): لم يلتزم النموذج بالرد بصيغة JSON'), { code: 'bad_json' });
    a = await E.analyse({ json: async () => { throw bad; } }, pages, st); assert(a.objectives.length >= 4 && a.fallback === true, 'fallback objectives for every page'); assert(a.objectives.every((o) => o.pages.length === 1 && Object.keys(o.supports).includes('basic_recall')));
    // one chunk fails, the others are understood: the AI's objectives are kept, the failed part is split by page
    const big = [1, 2, 3, 4, 5, 6].map((n) => ({ ref: `d1p${n}`, text: `Topic ${n} heading\n` + `The structure number ${n} performs an important function inside the system during stage ${n}. `.repeat(220) })); let calls = 0;
    const mixed = await E.analyse({ json: async () => { if (++calls === 2) throw bad; return { objectives: [{ statement: 'AI objective ' + calls, pages: ['d1p1'], supports: ['Recall'] }], lecture_character: 'ok' }; } }, big, st);
    assert(calls >= 2, 'several chunks: ' + calls); assert(mixed.objectives.some((o) => /AI objective/.test(o.statement)) && mixed.objectives.length > 1 && mixed.fallback === true, 'kept what the AI understood, split the rest');
    for (const code of ['network', 'auth', 'keys_invalid', 'rate_limited']) await assert.rejects(() => E.analyse({ json: async () => { throw Object.assign(new Error('x'), { code }); } }, pages, st), (e) => e.code === code, code + ' is not hidden'); }
  // 7) pages without real text are not turned into objectives
  a = await E.analyse({ json: async () => ({}) }, [{ ref: 'd1p1', text: 'x' }], st); assert.strictEqual(a.objectives.length, 0);
  console.log('analysis robustness tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
