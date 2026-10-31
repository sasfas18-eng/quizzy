// node test/engine_speed.test.js — parallel waves cut wall-time without changing what gets accepted (simulated latency).
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = ['Glucose', 'Membrane', 'Receptor', 'Enzyme', 'Ligand', 'Vesicle', 'Nucleus', 'Hormone', 'Antibody', 'Synapse', 'Capillary', 'Platelet'];
const V = ['stabilises', 'amplifies', 'suppresses', 'transports', 'degrades', 'binds', 'activates', 'filters', 'recruits', 'modulates', 'synthesises', 'releases'];
const N = ['sodium', 'calcium', 'oxygen', 'lactate', 'insulin', 'thyroxine', 'collagen', 'fibrin', 'myosin', 'cortisol', 'plasma', 'glucagon'];
const pagesList = Array.from({ length: 12 }, (_, i) => ({ ref: `d1p${i + 1}`, text: `Topic ${i}: ${W[i]} is the ${i % 2 ? 'rapid' : 'gradual'} regulator that ${V[i]} ${N[i]} inside ${N[(i + 5) % 12]} tissue.`, doc_id: 'd', page_no: i + 1 }));
const slots = pagesList.map((p, i) => ({ slot: i + 1, qtype: 'basic_recall', objective: 'o' + i, objective_id: 'o' + i, pages: [p.ref], difficulty: 'easy', task: null }));
const plan = { slots, requested: 12, feasible_count: 12 };
function llmFor(delay) { const calls = { generate: 0, verify: 0, explain: 0 }; let inflight = 0, maxInflight = 0;
  return { calls, get maxInflight() { return maxInflight; }, async json(task, sys, prompt) { inflight++; maxInflight = Math.max(maxInflight, inflight); await sleep(delay);
    try {
      if (task === 'generate') { calls.generate++; const slotsIn = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pages = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
        return { questions: slotsIn.map((s) => { const ref = s.pages[0]; const text = pages[ref]; const term = text.match(/^Topic \d+: (\w+)/)[1]; return { slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ' + text.replace(term, '_____'),
          options: [term, 'distractorOne', 'distractorTwo', 'distractorThree'], correct_index: 0, explanation: 'الإجابة مبنية على نص المحاضرة: «' + text + '». الخيارات الأخرى لا تظهر.', purpose: 'p' + ref + 'x', reasoning_pattern: 'r', evidence: [{ page: ref, quote: text }], uses_external: false }; }) }; }
      if (task === 'verify') { calls.verify++; const qs = JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' })) }; }
      calls.explain++; const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) };
    } finally { inflight--; } } }; }
(async () => {
  const st = { field: 'science', language: 'en', external_mode: 'source_only' }; const t = {};
  for (const w of [1, 4]) { const llm = llmFor(40); const t0 = Date.now(); const r = await E.generate(llm, plan, pagesList, st, () => {}, { concurrency: w }); t[w] = { ms: Date.now() - t0, n: r.accepted.length, calls: llm.calls, max: llm.maxInflight, order: r.accepted.map((c) => c.slot).join(',') }; }
  console.log('sequential', JSON.stringify({ ms: t[1].ms, n: t[1].n, max: t[1].max }), 'parallel x4', JSON.stringify({ ms: t[4].ms, n: t[4].n, max: t[4].max }));
  assert.strictEqual(t[1].n, 12); assert.strictEqual(t[4].n, 12); assert.strictEqual(t[1].order, t[4].order, 'same accepted set in the same order'); assert.strictEqual(t[1].max, 1); assert(t[4].max >= 3, 'batches overlap');
  assert(t[4].ms < t[1].ms * 0.6, `parallel must be clearly faster (${t[4].ms} vs ${t[1].ms})`); assert.strictEqual(t[4].calls.verify, 4, 'one batched verify per batch of 3'); assert.strictEqual(t[4].calls.explain, 4);
  console.log('engine speed tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
