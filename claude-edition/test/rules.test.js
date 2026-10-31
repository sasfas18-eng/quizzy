// node test/rules.test.js — the no-token generator: zero LLM calls, valid structure, verbatim evidence, honest about gaps.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert');
const p1 = `Cell Biology Basics
Mitochondria are the organelles that produce most of the cell's ATP through oxidative phosphorylation.
Ribosomes are small structures that assemble proteins from amino acids inside the cell.
The nucleus is the compartment that stores the genetic material of the cell.
Organelles in eukaryotic cells include the nucleus, mitochondria, ribosomes and lysosomes.
A drop in oxygen supply leads to reduced ATP production in the mitochondria.
Heat stress causes protein denaturation in the cytoplasm.
High calcium levels cause stronger muscle contraction in the fibre.
Resting membrane potential in a typical neuron is about -70 mV across the plasma membrane.`;
const p2 = `Protein Synthesis Steps
Protein synthesis proceeds in a fixed order:
1. Transcription copies the gene into messenger RNA inside the nucleus.
2. The messenger RNA leaves the nucleus through nuclear pores.
3. Translation at the ribosome builds the amino acid chain.
4. Folding converts the chain into a working protein.
Cell types include neurons, hepatocytes, myocytes and erythrocytes.
Lysosomes are vesicles that digest worn-out cell parts with acid hydrolases.
Insufficient folding results in loss of protein function in the cell.
Cardiac action potential lasts about 250 ms in a ventricular myocyte.`;
const pages = [{ ref: 'd1p1', text: p1 }, { ref: 'd1p2', text: p2 }];
(async () => {
  const a = R.analyse(pages); assert(a.objectives.length === 2);
  const types = new Set(a.objectives.flatMap((o) => Object.keys(o.supports))); ['basic_recall', 'understanding', 'mechanisms', 'application', 'not_except', 'sequence'].forEach((t) => assert(types.has(t), 'supports ' + t));
  ['critical_thinking', 'best_answer', 'scenarios', 'compare_contrast'].forEach((t) => assert(!types.has(t), 'must NOT claim ' + t));
  const st = { count: 20, focus: 'balanced', field: 'science', difficulty: 'mixed' }; const heur = E.support(pages.map((p) => p.text), 'science'); const plan = E.buildPlan(a, st, heur);
  const res = await R.generate(plan, pages, st, () => {});
  assert(res.accepted.length >= 5, 'delivered ' + res.accepted.length); const byType = {}; res.accepted.forEach((c) => (byType[c.qtype] = (byType[c.qtype] || 0) + 1)); console.log('delivered', res.accepted.length, 'of', plan.feasible_count, JSON.stringify(byType), 'dropped', res.dropped.length);
  const texts = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
  res.accepted.forEach((c) => { assert.strictEqual(c.options.length, 4); assert.strictEqual(new Set(c.options.map(E.norm)).size, 4);
    c.evidence.forEach((e) => assert(E.quoteIn(e.quote, texts[e.page]), 'verbatim evidence: ' + e.quote)); });
  const seq = res.accepted.find((c) => c.qtype === 'sequence'); if (seq) assert(/→/.test(seq.options[0]));
  const ne = res.accepted.find((c) => c.qtype === 'not_except'); if (ne) { assert(/NOT|ليس/.test(ne.stem)); assert(!p1.includes(ne.options[ne.correct_index]) || !ne.stem.includes('Organelles')); }
  const cards = R.cards(pages, 10); assert(cards.length >= 5 && cards.every((c) => E.quoteIn(c.quote, texts[c.page]))); console.log('cards', cards.length, 'rules tests ok');
})();
if (process.env.SHOW) (async () => { const a = R.analyse(pages), st = { count: 20, focus: 'balanced', field: 'science' }; const plan = E.buildPlan(a, st, E.support(pages.map((p) => p.text), 'science')); const r = await R.generate(plan, pages, st, () => {});
  r.accepted.forEach((c) => console.log(`\n[${c.qtype}] ${c.stem}\n  * ${c.options[0]}\n  - ${c.options.slice(1).join('\n  - ')}`)); console.log('DROPPED', JSON.stringify(r.dropped)); })();
