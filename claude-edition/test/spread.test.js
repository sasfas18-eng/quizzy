// node claude-edition/test/spread.test.js — a quiz spread by the LECTURE, not by how the analysis split it.
// The real case (microbiology, 50 questions, 49 slides with content): «Pathogenic properties of helminths» - one slide, a list of five - came back from the
// analysis as five objectives and took five questions (one per item), another slide four, while six slides had none. Now each question goes to the part of the
// lecture with the fewest questions for its number of pages: the one-slide list is one slide; a part of three slides takes about three times a one-slide part.
global.window = {}; require(require('path').join(__dirname, '..', 'engine.js')); const E = window.QZE; const assert = require('assert');
const sup = (r) => ({ basic_recall: { pages: [r] }, understanding: { pages: [r] }, best_answer: { pages: [r] } });
const objs = [];
for (let p = 3; p <= 44; p++) { if (p === 31) continue; const r = 'd1p' + p; objs.push({ id: 'o' + p, statement: 'Slide ' + p + ' fact', pages: [r], key_terms: [], capacity: 2, supports: sup(r), section: 'S' + p, section_label: 'Part ' + p }); }
['Cellular damage evokes symptoms', 'Use host tissue for their own growth', 'Produce large parasitic masses', 'Presence of parasite interferes with host function', "Parasite's metabolic waste can cause symptoms"]
  .forEach((s, i) => objs.push({ id: 'h' + i, statement: s, pages: ['d1p31'], key_terms: [], capacity: 2, supports: sup('d1p31'), section: 'S31', section_label: 'Pathogenic Properties of Helminths' }));
['d1p45', 'd1p46', 'd1p47'].forEach((r, i) => objs.push({ id: 'big' + i, statement: 'Chain of infection ' + i, pages: [r], key_terms: [], capacity: 2, supports: sup(r), section: 'S45', section_label: 'Chain of infection' }));      // one part over three slides
const st = { count: 50, focus: 'balanced', difficulty: 'mixed', field: 'health' };
const plan = E.buildPlan({ objectives: objs }, st, null);
const per = {}; plan.slots.forEach((s) => { const k = s.section_key || s.objective_id; per[k] = (per[k] || 0) + 1; });
assert.strictEqual(plan.slots.length, 50, 'the count is planned: ' + plan.slots.length);
assert((per.S31 || 0) <= 2, 'the one-slide list is one slide: ' + per.S31 + ' ' + JSON.stringify(per));
const parts = Object.keys(per).length, all = new Set(objs.map((o) => o.section)).size;
assert.strictEqual(parts, all, 'every part of the lecture has a question: ' + parts + '/' + all);
assert((per.S45 || 0) >= 2 && (per.S45 || 0) >= (per.S31 || 0), 'a part of three slides takes more than a one-slide list: ' + per.S45 + ' vs ' + per.S31);
const max = Math.max(...Object.entries(per).filter(([k]) => k !== 'S45').map(([, n]) => n));
assert(max <= 2, 'no one-slide part beyond two: ' + JSON.stringify(per));
console.log(`1) 50 questions over ${all} parts: every part asked, the five-item list on one slide ${per.S31} question(s), the three-slide part ${per.S45}, no one-slide part beyond ${max}`);
// the top-up questions (reinforcement) follow the same rule: with every part already asked once, the next ones go to the least-asked part for its pages
const pool = objs.map((o) => ({ id: o.id, statement: o.statement, pages: o.pages, section: o.section, types: { basic_recall: { pages: o.pages } } }));
const counts = Object.fromEntries(objs.map((o) => [o.id, 1]));      // every objective asked once: the list's slide has five questions already
const more = E.reinforcementSlots(pool, counts, 10, {}, {}); const into31 = more.filter((s) => s.section_key === 'S31').length;
assert.strictEqual(into31, 0, 'the list that already has five questions takes no more: ' + into31);
console.log('2) top-up questions go to the parts with the fewest questions for their pages - none to the list that already has five');
console.log('spread ok');
