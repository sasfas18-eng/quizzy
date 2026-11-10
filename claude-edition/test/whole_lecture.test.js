// node claude-edition/test/whole_lecture.test.js — the quiz covers the whole lecture, and the Claude path's round fits its lanes.
//  1) a content page the AI analysis left out becomes an objective of its own (in its place; the model's objectives keep their order)
//  2) the planner gives every section a question when the count allows it
//  3) trimming the surplus never removes a section's only question
//  4) the batches of a round are packed by section (same number of requests), and the checks of two batches share one request when the checks would not fit the lanes
//  5) a SECTION of short slides (each under the 25 words a page needs on its own) that the first analysis skipped is analysed again and gets its objective - it
//     used to be neither asked nor reported; a short slide of a section that already has objectives is not sent again
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE; const assert = require('assert');
const page = (i, t) => ({ ref: 'd1p' + i, text: t });
const lecture = Array.from({ length: 9 }, (_, k) => page(k + 1, `Topic ${k + 1}\nThe structure number ${k + 1} produces the substance ${'abcdefghi'[k]}-ase, which acts on the cell membrane in step ${k + 1}. It is controlled by the hormone ${k + 1}-tropin released from the gland when levels fall. A deficiency of ${'abcdefghi'[k]}-ase causes the disorder number ${k + 1}.`));
(async () => {
  // 1) the model's first analysis names objectives for pages 1-3 and 7 only; asked again about the pages it left out, on their own, it names theirs
  const NAMED = [['d1p1', 'A'], ['d1p2', 'B'], ['d1p3', 'C'], ['d1p7', 'D']]; const ob = (r, n) => ({ statement: 'Objective ' + n, pages: [r], capacity: 2, supports: { basic_recall: { pages: [r] }, understanding: { pages: [r] } } });
  const seen = []; const model = (second) => ({ json: async (task, s, prompt) => { if (task === 'profile') return { types: {} };
    const pg = JSON.parse(prompt.slice(prompt.indexOf('PAGES:\n') + 7)).map((p) => p.ref); seen.push(pg); const named = NAMED.filter(([r]) => pg.includes(r));
    if (named.length) return { objectives: named.map(([r, n]) => ob(r, n)) };
    if (second === 'throw') { const e = new Error('service down'); throw e; } return { objectives: second === 'none' ? [] : pg.map((r) => ob(r, 'for ' + r)) }; } });
  const a = await E.analyse(model('names'), lecture, { field: 'science' }, { concurrency: 4, aiOnly: true });
  const cited = new Set(a.objectives.flatMap((o) => o.pages)); lecture.forEach((p) => assert(cited.has(p.ref), 'page ' + p.ref + ' has an objective'));
  assert.deepStrictEqual(a.objectives.filter((o) => !o.gapfill).map((o) => o.statement), ['Objective A', 'Objective B', 'Objective C', 'Objective D'], 'the model\'s objectives keep their order');
  const firstPage = (o) => Math.min(...o.pages.map((r) => +r.slice(3))); a.objectives.forEach((o, i) => { if (i) assert(firstPage(o) >= firstPage(a.objectives[i - 1]), 'objectives in lecture order'); });
  assert(a.objectives.filter((o) => o.gapfill).every((o) => /^Objective for d1p/.test(o.statement)), 'the added objectives are the model\'s own (asked about those pages), not stand-ins');
  assert(seen.some((pg) => pg.every((r) => !NAMED.some(([x]) => x === r))), 'the left-out pages were sent to the model on their own');
  // Claude only: when the model finds nothing to assess there, nothing is made up for them; elsewhere a failed second call still leaves a page-based stand-in
  const none = await E.analyse(model('none'), lecture, { field: 'science' }, { concurrency: 4, aiOnly: true }); assert.strictEqual(none.objectives.length, 4, 'Claude only: no stand-in objectives');
  const down = await E.analyse(model('throw'), lecture, { field: 'science' }, { concurrency: 4 }); assert(down.objectives.length > 4 && down.objectives.some((o) => o.gapfill), 'outside the Claude edition, a failed second call leaves a stand-in');
  console.log('1) analysis: ' + a.objectives.length + ' objectives, every content page cited (' + a.objectives.filter((o) => o.gapfill).length + ' named by the model when asked about the pages it had left out; none made up)');
  // 2) one question per section when the count equals the number of sections
  const st = { count: a.objectives.length, focus: 'balanced', difficulty: 'mixed', field: 'science' }; const plan = E.buildPlan(a, st, E.support(lecture.map((p) => p.text), 'science'));
  assert.strictEqual(new Set(plan.slots.map((s) => s.objective_id)).size, a.objectives.length, 'every section planned: ' + JSON.stringify(plan.slots.map((s) => s.objective_id)));
  console.log('2) planner: ' + plan.slots.length + ' questions over ' + a.objectives.length + ' sections - every section once');
  // 3) the surplus is dropped without losing a section: a model that writes every slot (12 planned on 9 sections, + spares)
  const write = { json: async (task, s, prompt) => {
    if (task === 'generate') { const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pages = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
      return { questions: slots.map((x) => { const t = pages[x.pages[0]] || ''; const sent = t.split('\n')[1].split('. ')[x.slot % 3].replace(/\.$/, '') + '.';
        return { slot: x.slot, stem: `Question ${x.slot} about ${x.pages[0]}: which statement matches the lecture's sentence on ${['production', 'control', 'deficiency'][x.slot % 3]} number ${x.slot}?`, options: ['alpha ' + x.slot, 'beta ' + x.slot, 'gamma ' + x.slot, 'delta ' + x.slot], correct_index: 0,
          explanation: 'Because the lecture says so: ' + sent, purpose: 'slot ' + x.slot + ' fact', evidence: [{ page: x.pages[0], quote: sent }], uses_external: false }; }) }; }
    if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 12, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' })) }; }
    const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null })) }; } };
  const plan12 = E.buildPlan(a, { ...st, count: 12 }, E.support(lecture.map((p) => p.text), 'science'));
  const r = await E.generateToCount(write, plan12, lecture, { ...st, count: 12, language: 'en', external_mode: 'source_only' }, () => {}, { concurrency: 4 });
  assert.strictEqual(r.accepted.length, 12, 'exactly the count'); const secs = new Set(r.accepted.map((c) => c.objective_id));
  assert.strictEqual(secs.size, a.objectives.length, 'after trimming the spares every section still has its question: ' + secs.size + '/' + a.objectives.length);
  console.log('3) trimming: ' + r.stats.asked_extra + ' spares asked, 12 kept, all ' + secs.size + ' sections still covered');
  // 4) packing by section: the slots of one section are written in one request; the request count is that of plain slicing
  const slots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ slot: i, objective: 'Section ' + (i <= 3 ? 'X' : i <= 7 ? 'Y' : 'Z'), pages: ['d1p' + (i <= 3 ? 1 : i <= 7 ? 2 : 3)] }));
  const extraX = { slot: 11, objective: 'Section X (continued)', pages: ['d1p1'] }; const all = slots.concat([extraX]);
  const calls = []; const spy = { json: async (task, s, prompt) => { if (task === 'generate') calls.push(JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))).map((x) => x.slot)); return write.json(task, s, prompt); } };
  const planP = { slots: all.map((s) => ({ ...s, qtype: 'basic_recall', objective_id: s.objective.replace(/ \(continued\)/, ''), difficulty: 'easy' })), requested: 11 };
  const g = await E.generate(spy, planP, lecture, { field: 'science', language: 'en' }, () => {}, { concurrency: 3 });
  const round1 = calls.slice(0, Math.ceil(11 / 4));      // the first round: the same number of write requests as slicing into batches of 4 (later calls are this simple model's retries)
  assert.deepStrictEqual(round1.flat().sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'round 1 writes every slot once in ' + round1.length + ' requests: ' + JSON.stringify(calls));
  const where = (n) => round1.findIndex((c) => c.includes(n)); assert(where(11) === where(1), 'the continued slide of section X is written with section X: ' + JSON.stringify(round1));
  assert(g.accepted.length >= 1);
  // 5) checks shared by two batches only when they would not fit the lanes at once
  // a model whose questions are all different (its own words per slot), so that no retry round blurs the count of checks
  const W = 'amber basil cedar delta ember fable garnet harbor indigo jasper kettle lumen meadow nectar onyx pepper quartz raven saffron timber umber velvet willow xenon yarrow zephyr arbor bramble cobalt dune'.split(' ');
  const distinct = { json: async (task, s, prompt) => { if (task !== 'generate') return write.json(task, s, prompt);
    const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pages = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
    return { questions: slots.map((x) => { const t = pages[x.pages[0]] || ''; const sent = t.split('\n')[1].split('. ')[0] + '.'; const w = (k) => W[(x.slot * 3 + k) % W.length];
      return { slot: x.slot, stem: `${w(0)} ${w(1)} ${w(2)}: choose the ${w(3)}`, options: [w(0) + ' one', w(1) + ' two', w(2) + ' three', w(3) + ' four'], correct_index: 0, explanation: 'The lecture states: ' + sent, purpose: w(4) + ' ' + w(5), evidence: [{ page: x.pages[0], quote: sent }], uses_external: false }; }) }; } };
  const counter = (lanes) => { const n = { verify: 0, generate: 0 }; return { n, llm: { json: async (task, s, prompt) => { if (task in n) n[task]++; return distinct.json(task, s, prompt); } } }; };
  const wide = counter(12), narrow = counter(2); const plan9 = { slots: Array.from({ length: 9 }, (_, i) => ({ slot: i + 1, qtype: 'basic_recall', objective: 'S' + i, objective_id: 'o' + i, pages: ['d1p' + (i + 1)], difficulty: 'easy' })), requested: 9 };
  await E.generate(wide.llm, plan9, lecture, { field: 'science', language: 'en' }, () => {}, { concurrency: 12 }); await E.generate(narrow.llm, plan9, lecture, { field: 'science', language: 'en' }, () => {}, { concurrency: 2 });
  assert.strictEqual(wide.n.verify, wide.n.generate, 'lanes to spare: one check per batch (' + wide.n.verify + ')'); assert(narrow.n.verify < narrow.n.generate, 'few lanes: checks shared (' + narrow.n.verify + ' for ' + narrow.n.generate + ' batches)');
  console.log('4) batches: ' + JSON.stringify(calls.slice(0, 3)) + ' (section X together); checks ' + wide.n.verify + '/' + wide.n.generate + ' with 12 lanes, ' + narrow.n.verify + '/' + narrow.n.generate + ' with 2');
  // 5) a section of short slides the first analysis skipped
  const longP = (k) => page(k, `Part ${k}\nThe organ number ${k} filters the fluid ${'abcdef'[k - 1]}-plasma and returns the solute ${k} to the blood when the pressure rises in segment ${k}. Its failure causes the condition number ${k}.`);
  const L5 = [longP(1), longP(2), page(3, 'Part 1 summary\nOrgan 1 filters plasma.'), longP(4), longP(5), longP(6),
    page(7, 'The Ureters\nTwo muscular tubes from kidney to bladder.'), page(8, 'Ureter wall\nPeristalsis moves urine downwards.'), page(9, 'Ureteric valves\nOblique entry prevents reflux of urine.')];
  const SEC5 = { d1p1: 'S1', d1p2: 'S1', d1p3: 'S1', d1p4: 'S2', d1p5: 'S2', d1p6: 'S2', d1p7: 'S3', d1p8: 'S3', d1p9: 'S3' };
  const asked5 = []; const m5 = { json: async (task, s, prompt) => { if (task === 'profile') return { types: {} };
    const pg = JSON.parse(prompt.slice(prompt.indexOf('PAGES:\n') + 7)).map((p) => p.ref); asked5.push(pg);
    const long = pg.filter((r) => ['d1p1', 'd1p2', 'd1p4', 'd1p5', 'd1p6'].includes(r)); if (long.length) return { objectives: long.map((r) => ob(r, 'long ' + r)) };      // the first reading: the long slides only
    const ure = pg.filter((r) => SEC5[r] === 'S3'); return { objectives: ure.length ? [{ ...ob(ure[0], 'The ureters carry urine by peristalsis'), pages: ure }] : [] }; } };
  const a5 = await E.analyse(m5, L5, { field: 'science' }, { concurrency: 4, aiOnly: true, sectionOf: (r) => SEC5[r] || '' });
  const cited5 = new Set(a5.objectives.flatMap((o) => o.pages)); assert(['d1p7', 'd1p8', 'd1p9'].every((r) => cited5.has(r)), 'the section of short slides has its objective: ' + JSON.stringify(a5.objectives.map((o) => o.pages)));
  assert(!asked5.some((pg) => pg.includes('d1p3') && pg.length < 6), 'a short slide of a section that already has objectives is not sent again: ' + JSON.stringify(asked5));
  const old5 = await E.analyse(m5, L5, { field: 'science' }, { concurrency: 4, aiOnly: true }); assert(!old5.objectives.some((o) => o.pages.includes('d1p7')), '(without the lecture\'s sections a short slide alone is still left as it was)');
  const plan5 = E.buildPlan({ ...a5, objectives: a5.objectives.map((o) => ({ ...o, section: SEC5[o.pages[0]], section_label: SEC5[o.pages[0]] })) }, { count: 6, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null);
  assert(plan5.slots.some((x) => (x.section_key || '') === 'S3'), 'and the plan gives it a question');
  console.log('5) a section of three short slides (8-9 words each) that the first reading skipped was read again and got its objective and a planned question');
  console.log('whole lecture ok');
})().catch((e) => { console.error(e); process.exit(1); });
