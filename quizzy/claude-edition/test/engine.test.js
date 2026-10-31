// node test/engine.test.js — batched verification keeps its strictness and uses 2 calls per group.
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
(async () => {
  let calls = 0; const mk = (i) => ({ qtype: 'understanding', stem: 'q' + i, options: ['a', 'b', 'c', 'd'], correct_index: 1, explanation: 'e', evidence: [], uses_external: false });
  const items = [0, 1, 2].map((i) => ({ id: 'q' + i, c: mk(i) }));
  const llm = { async json(task) { calls++; if (task === 'verify') return { results: [
    { id: 'q0', chosen_index: 1, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' },
    { id: 'q1', chosen_index: 2, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' },   // solver disagrees
    { id: 'q2', chosen_index: 1, answerable_from_source: true, single_best_answer: false, sufficient_data: true, flaws: [], severity: 'none' } ] };       // ambiguous
    return { results: [{ id: 'q0', explanation_supported: false, contradicts_source: true, notes: 'x' }] }; } };
  const r = await E.llmCheckBatch(llm, items, {}, {});
  assert.strictEqual(calls, 2);
  assert(r[0].some((i) => i.code === 'explanation_unsupported'), 'bad explanation caught');
  assert(r[1].some((i) => i.code === 'solver_disagrees'), 'wrong key caught');
  assert(r[2].some((i) => i.code === 'ambiguous_key'), 'ambiguity caught');
  const missing = await E.llmCheckBatch({ async json() { return { results: [] }; } }, items, {}, {});
  assert(missing.every((x) => x.some((i) => i.code === 'verifier_error' && i.severity === 'decisive')), 'missing result is a rejection, never a silent pass');
  console.log('engine tests ok');
})();
