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
// 3) ONE objective over five slides (the chain of infection's links, 44-51 in the real quiz, asked once or twice and always from its first slide): its questions
//    are aimed at its slides one by one - four or more of its five slides asked, never the same slide twice while another of them waits
{ const o2 = objs.filter((o) => o.section !== 'S45').slice(0, 30); const chain = { id: 'chain', statement: 'The six links of the chain of infection', pages: ['d1p50', 'd1p51', 'd1p52', 'd1p53', 'd1p54'], key_terms: [], capacity: 3,
    supports: { basic_recall: { pages: ['d1p50', 'd1p51', 'd1p52', 'd1p53', 'd1p54'] }, understanding: { pages: ['d1p50', 'd1p51', 'd1p52', 'd1p53', 'd1p54'] }, application: { pages: ['d1p50', 'd1p51', 'd1p52', 'd1p53', 'd1p54'] } }, section: 'SC', section_label: 'Chain of infection' };
  const p3 = E.buildPlan({ objectives: o2.concat([chain]) }, { ...st, count: 40 }, null); const mine = p3.slots.filter((s) => s.objective_id === 'chain');
  const slides = mine.flatMap((s) => s.pages); const distinct = new Set(slides);
  assert.strictEqual(p3.slots.length, 40, '3) the count'); assert(mine.every((s) => s.pages.length === 1), '3) each question aimed at one slide: ' + JSON.stringify(mine.map((s) => s.pages)));
  assert(distinct.size >= 4 && distinct.size === slides.length, '3) its questions on different slides: ' + JSON.stringify(slides));
  console.log(`3) one objective over five slides: ${mine.length} questions, each on its own slide (${[...distinct].map((r) => r.replace('d1p', '')).join(', ')})`); }
// 4) a slide INSIDE A LONG PART that the analysis gave several objectives of its own (pH: acidophiles, neutrophiles, alkaliphiles, pickling - slide 6, inside eight
//    pages of «growth requirements») took seven questions in a real quiz, two of them the same fact twice: the slide itself is weighed, at most two
{ const big = []; for (let p = 60; p <= 67; p++) if (p !== 63) big.push({ id: 'g' + p, statement: 'Growth requirement ' + p, pages: ['d1p' + p], key_terms: [], capacity: 2, supports: sup('d1p' + p), section: 'SG', section_label: 'Growth requirements' });
  ['Acidophiles', 'Neutrophiles', 'Alkaliphiles', 'Pickling inhibits growth'].forEach((x, i) => big.push({ id: 'ph' + i, statement: x, pages: ['d1p63'], key_terms: [], capacity: 2, supports: sup('d1p63'), section: 'SG', section_label: 'Growth requirements' }));
  const rest = objs.filter((o) => o.section !== 'S45').slice(0, 32); const p4 = E.buildPlan({ objectives: rest.concat(big) }, st, null);
  const on63 = p4.slots.filter((s) => s.pages.includes('d1p63')).length; const per4 = {}; p4.slots.forEach((s) => s.pages.forEach((r) => { per4[r] = (per4[r] || 0) + 1; }));
  assert.strictEqual(p4.slots.length, 50, '4) the count'); assert(on63 <= 2, '4) the slide with four objectives of its own: ' + on63 + ' ' + JSON.stringify(per4));
  assert(Math.max(...Object.values(per4)) <= 2, '4) no slide beyond two: ' + JSON.stringify(per4));
  const more4 = E.reinforcementSlots(big.map((o) => ({ id: o.id, statement: o.statement, pages: o.pages, section: o.section, types: { basic_recall: { pages: o.pages } } })), Object.fromEntries(big.map((o) => [o.id, 1])), 6, {}, { pageUse: { d1p63: 4, d1p60: 1, d1p61: 1, d1p62: 1, d1p64: 1, d1p65: 1, d1p66: 1, d1p67: 1 } });
  assert.strictEqual(more4.filter((x) => x.pages.includes('d1p63')).length, 0, '4) top-up questions do not go to the slide that already has four');
  console.log(`4) a slide with four objectives of its own inside an eight-page part: ${on63} question(s), no slide beyond two; top-ups go elsewhere`); }
// 5) the same line and the same answer is the same question, whatever its form (a real quiz asked «the patient dies if not treated» twice, as two types)
{ const line = 'If the disease is not successfully overcome (successfully treated), the patient dies during this period.';
  const a5 = { slot: 44, stem: 'During which phase does the patient die if the disease is not overcome?', options: ['Period of decline', 'Period of illness', 'Incubation period', 'Prodromal period'], correct_index: 1, qtype: 'basic_recall', evidence: [{ page: 'd1p55', quote: line }] };
  const b5 = { slot: 47, stem: 'A patient whose disease is not treated successfully dies. Which phase of disease is this?', options: ['Incubation period', 'Period of illness', 'Convalescence', 'Prodromal period'], correct_index: 1, qtype: 'application', evidence: [{ page: 'd1p55', quote: line }] };
  assert.strictEqual(E.dupOf(b5, [a5], false), 44, '5) same line, same answer, another type: the same question'); assert.strictEqual(E.dupOf(b5, [a5], true), 44, '5) also as a top-up question');
  const c5 = { ...b5, options: ['Incubation period', 'Period of decline', 'Convalescence', 'Prodromal period'], stem: 'In which phase may secondary infections occur?', evidence: [{ page: 'd1p55', quote: line }] };
  assert.strictEqual(E.dupOf(c5, [a5], false), null, '5) the same line asked for another answer is another question');
  console.log('5) one line and one answer is one question, whatever its form; the same line asked for another answer is not'); }
// 6) a question quoting none of its slot's pages (the writer sees every page of its batch and went to the richest) is written again from its own
(async () => { const pages6 = ['d1p54', 'd1p55'].map((r, i) => ({ ref: r, text: i ? 'The period of illness is when the disease is most severe and signs are most visible.' : 'The incubation period is the interval between the initial infection and the first signs or symptoms.' }));
  let calls = 0; const mk = (slot, pg) => ({ slot, unwritable_reason: null, stem: 'Which phase is described as ' + (pg === 'd1p55' ? 'the most severe one?' : 'the interval before the first signs?'), options: pg === 'd1p55' ? ['Period of illness', 'Incubation period', 'Convalescence', 'Prodromal period'] : ['Incubation period', 'Period of illness', 'Convalescence', 'Prodromal period'], correct_index: 0,
    explanation: 'من المحاضرة: «' + pages6.find((p) => p.ref === pg).text + '».', purpose: 'p' + slot, reasoning_pattern: 'x', evidence: [{ page: pg, quote: pages6.find((p) => p.ref === pg).text }], uses_external: false });
  const llm = { async json(task, sys, prompt) {
    if (task === 'generate') { calls++; const S = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); return { questions: S.map((x) => mk(x.slot, calls === 1 ? 'd1p55' : x.pages[0])) }; }
    if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' })) }; }
    const it = JSON.parse(prompt.slice(prompt.indexOf('\nITEMS:\n') + 8, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null, notes: '' })) }; } };
  const plan6 = { slots: [{ slot: 1, qtype: 'basic_recall', objective_id: 'inc', objective: 'Incubation period', pages: ['d1p54'], difficulty: 'medium' }], pool: [] };
  const r = await E.generate(llm, plan6, pages6, { count: 1, field: 'health', language: 'en', external_mode: 'none' }, () => {}, { concurrency: 1 });
  assert.strictEqual(r.accepted.length, 1, '6) written'); assert.strictEqual(r.accepted[0].evidence[0].page, 'd1p54', '6) from its own slide: ' + r.accepted[0].evidence[0].page); assert(calls >= 2 && r.stats.rejected_validation >= 1, '6) the first, from another slide, was sent back: ' + JSON.stringify(r.stats));
  console.log('6) a question written from another slide than its own is sent back and written from its own');
  console.log('spread ok'); })().catch((e) => { console.error(e); process.exit(1); });
