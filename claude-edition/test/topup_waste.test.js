// node claude-edition/test/topup_waste.test.js — THE ROUNDS ARE NOT SPENT WHERE NO QUESTION CAN BE (a real cardiology quiz, 50 asked: 48 delivered in ten minutes, 175
// requests - 57 slots refused by Claude, 39 of them «Every distinct fact on d1p8 is already covered», and two diagram slides of labels chased eight times each;
// two questions that each «gave away» the other were both rejected)
//  1) an objective Claude calls exhausted takes no more extra questions while another part of the lecture can take one
//  2) the refusals of the real quiz are read right: «already covered» is exhaustion; «no statement about what happens when a step is absent» is not
//  3) a slide that is a title over a picture's labels only (no line of five words) is not planned, chased or reinforced; a slide of its OWN short bullet points is
//  4) a giveaway between two items of one check request rejects only the later of the two; a giveaway of an accepted question rejects the item
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
(async () => {
  // 1)
  const pool = ['o1', 'o2', 'o3'].map((id, i) => ({ id, statement: 'Objective ' + i, pages: ['d1p' + (i + 1)], types: { basic_recall: {}, understanding: {} }, section: 's' + i }));
  let r = E.reinforcementSlots(pool, {}, 6, {}, { skip: new Set(['o2']) }); assert(r.length === 6 && r.every((s) => s.objective_id !== 'o2'), '1) the exhausted objective is skipped: ' + r.map((s) => s.objective_id));
  r = E.reinforcementSlots(pool, {}, 3, {}, { skip: new Set(['o1', 'o2', 'o3']) }); assert.strictEqual(r.length, 3, '1) when every objective is exhausted, the old order stands (nothing else to ask)');
  console.log('1) an exhausted objective takes no more extra questions while another can');
  // 2) the refusals of the real quiz
  const X = E._EXHAUSTED;
  ['Every distinct fact on d1p8 is already covered by accepted questions (conductivity applied to impulse passing to a', 'The only skeletal vs cardiac contrast on d1p6 (sarcoplasmic reticulum less abundant) is already covered by accepted questions', 'No other fact on these pages remains unasked']
    .forEach((t) => assert(X.test(t), '2) exhaustion: ' + t));
  ['Page d1p14 gives no statement about what happens when a step is absent; this would require outside knowledge.', 'Page d1p9 gives no explicit mapping of properties to cell types, so a three-true, one-false list cannot be built', 'Source pages contain no clinical findings, states or case information']
    .forEach((t) => assert(!X.test(t), '2) not exhaustion: ' + t));
  console.log('2) «already covered» refusals are read as exhaustion; a refusal of one form is not');
  // 3) a slide of a picture's labels only
  const text = (n) => `Heading ${n}\nThe cardiac muscle cells number ${n} conduct impulses through gap junctions to neighbouring cells quickly.\nPurkinje fibers have the fastest conducting velocity of all cells in the heart number ${n}.`;
  const pages = [{ ref: 'd1p1', text: text(1), doc_id: 'd', page_no: 1 },
    { ref: 'd1p2', text: 'FUNCTIONAL ANATOMY OF THE HEART\nValves of the Heart\nAorta\nMitral Valve\nLeft Ventricle', fig: ['Valves of the Heart', 'Aorta', 'Mitral Valve', 'Left Ventricle'], doc_id: 'd', page_no: 2 },
    { ref: 'd1p3', text: 'PARTS OF THE TUBE\n• Infundibulum\n• Ampulla\n• Isthmus\n• Interstitial part', doc_id: 'd', page_no: 3 },
    { ref: 'd1p4', text: text(4), doc_id: 'd', page_no: 4 }];
  const objs = [{ id: 'o1', statement: 'conduction', pages: ['d1p1'], section: 'conduction', types: { basic_recall: { pages: ['d1p1'] } } }, { id: 'fig_o1', statement: 'heart anatomy', pages: ['d1p2'], section: 'anatomy', types: { basic_recall: { pages: ['d1p2'] } } },
    { id: 'o3', statement: 'tube parts', pages: ['d1p3'], section: 'tube', types: { basic_recall: { pages: ['d1p3'] } } }, { id: 'o4', statement: 'purkinje', pages: ['d1p4'], section: 'purkinje', types: { basic_recall: { pages: ['d1p4'] } } }];
  const plan = { requested: 8, slots: objs.flatMap((o, i) => [0, 1].map((j) => ({ slot: i * 2 + j + 1, qtype: 'basic_recall', objective_id: o.id, objective: o.statement, pages: o.pages, section_key: o.section, difficulty: 'easy' }))), pool: objs };
  const asked = []; let n = 0;
  const llm = { async json(task, sys, prompt) {
    if (task === 'generate') { const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); slots.forEach((s) => asked.push(s.pages.join(',')));
      return { questions: slots.map((s) => { if (s.pages.includes('d1p2')) return { slot: s.slot, unwritable_reason: 'Page d1p2 holds only bare labels with no stated function' };
        const ref = s.pages[0], line = pages.find((p) => p.ref === ref).text.split('\n')[1]; n++;
        return { slot: s.slot, stem: `Question ${n} about ${ref}: which statement does the lecture make?`, options: [line.slice(0, 60) + ' #' + n, 'Option alpha ' + n, 'Option beta ' + n, 'Option gamma ' + n], correct_index: 0, explanation: 'The lecture says so: ' + line, evidence: [{ page: ref, quote: line }], uses_external: false, difficulty: 'easy' }; }) }; }
    if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' })) }; }
    const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false })) }; } };
  const st = { count: 8, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' };
  const res = await E.generateToCount(llm, plan, pages, st, () => {}, { concurrency: 2, aiOnly: true, topupRounds: 4, pageSection: { d1p1: 'conduction', d1p2: 'anatomy', d1p3: 'tube', d1p4: 'purkinje' } });
  assert(!asked.some((p) => p === 'd1p2'), '3) no slot is aimed at the slide of labels: ' + asked.join(' '));
  assert(asked.some((p) => p === 'd1p3'), '3) a slide of its own short bullet points is still asked');
  console.log(`3) the slide of a picture's labels was never asked (${asked.length} slots, none on it); a slide of its own short bullets was; ${res.accepted.length} questions`);
  // 4) a giveaway inside one check request
  const item = (id) => ({ id, c: { stem: 'Stem ' + id, options: ['a ' + id, 'b ' + id, 'c ' + id, 'd ' + id], correct_index: 0, explanation: 'x', qtype: 'basic_recall' } });
  const both = { async json(task) { if (task === 'verify') return { results: ['q1', 'q2', 'q3'].map((id) => ({ id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' })) };
    return { results: [{ id: 'q1', explanation_supported: true, reveals: 'q2' }, { id: 'q2', explanation_supported: true, reveals: 'q1' }, { id: 'q3', explanation_supported: true, reveals: '7' }] }; } };
  const out = await E.llmCheckBatch(both, [item('q1'), item('q2'), item('q3')], {}, {}, [{ n: 7, question: 'accepted' }]);
  const gave = out.map((v) => v.some((x) => x.code === 'cross_giveaway' && x.severity === 'decisive'));
  assert.deepStrictEqual(gave, [false, true, true], '4) only the later of the pair, and the item giving an accepted question away: ' + JSON.stringify(gave));
  console.log('4) two items that give each other away: the first is kept, the second rejected; an item giving an accepted question away is rejected');
  console.log('topup waste ok');
})().catch((e) => { console.error(e); process.exit(1); });
