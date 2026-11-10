// node claude-edition/test/resume.test.js — A QUIZ RESUMED AFTER ITS PAGE WAS CLOSED (Claude path). A quiz is written inside the page; a phone that puts the app in
// the background, or a closed tab, stops it. The questions it had written and checked are kept as they are accepted (a checkpoint), and the next run takes up
// from them:
//  1) the checkpoint grows with every accepted question
//  2) resumed from 9 of 20, the quiz ends with exactly 20: the 9 are kept as they were, their slots are never written again, no question twice, and far fewer
//     questions are written than by a run from the start
//  3) a checkpoint that already holds the count asks nothing more
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const N = 12, COUNT = 20;
const pages = Array.from({ length: N }, (_, i) => ({ ref: 'd1p' + (i + 1), text: `Topic ${i + 1}\n` + [1, 2, 3, 4, 5].map((k) => `Fact ${k} of topic ${i + 1}: the structure S${i + 1}x${k} performs the role R${i + 1}x${k} in the body.`).join('\n') }));
const objs = pages.map((p, i) => ({ id: 'o' + (i + 1), statement: 'Topic ' + (i + 1), pages: [p.ref], capacity: 4, section: 'S' + (i + 1), section_label: 'Topic ' + (i + 1),
  supports: { basic_recall: { pages: [p.ref] }, understanding: { pages: [p.ref] }, application: { pages: [p.ref] } } }));
const between = (s, a, b) => s.slice(s.indexOf(a) + a.length, s.indexOf(b, s.indexOf(a) + a.length));
function model() { const stats = { written: 0, slots: [] }; const used = {};
  return { stats, json: async (task, sys, prompt) => {
    if (task === 'generate') { const slots = JSON.parse(between(prompt, 'SLOTS:\n', '\nPAGES:\n')); stats.slots.push(...slots.map((x) => x.slot));
      return { questions: slots.map((x) => { stats.written++; const ref = x.pages[0]; const lines = pages.find((p) => p.ref === ref).text.split('\n').slice(1); const k = (used[ref] = (used[ref] || 0) + 1) - 1; const fact = lines[k % lines.length]; const w = (j) => `r${x.slot}q${j}`;
        return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)}: which item does the lecture name here?`, options: [w(3) + ' alpha', w(4) + ' beta', w(5) + ' gamma', w(6) + ' delta'], correct_index: 0,
          explanation: 'The lecture states it in this sentence: ' + fact, purpose: `${w(7)} ${w(8)} ${w(9)}`, evidence: [{ page: ref, quote: fact }] }; }) }; }
    if (task === 'verify') { const qs = JSON.parse(between(prompt, '\nQUESTIONS:\n', '\nReturn JSON')); return { results: qs.map((x) => ({ id: x.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none', weak_options: [] })) }; }
    const it = JSON.parse(between(prompt, 'ITEMS:\n', '\nReturn JSON')); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null })) }; } };
}
const opts = (m, extra) => ({ concurrency: 7, aiOnly: true, topupRounds: 6, pageSection: Object.fromEntries(pages.map((p, i) => [p.ref, 'S' + (i + 1)])), shape: (sl, pr) => E.assignForms(sl, pr), ...extra });
const planOf = () => { const plan = E.buildPlan({ objectives: JSON.parse(JSON.stringify(objs)), profile: null }, { count: COUNT, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null); E.assignForms(plan.slots); return plan; };
(async () => {
  // 1) a run from the start: the checkpoint grows with every accepted question
  const plan = planOf(); const m1 = model(); const ck = []; let calls = 0;
  const r1 = await E.generateToCount(m1, plan, pages, { count: COUNT, field: 'science', language: 'en' }, () => {}, opts(m1, { checkpoint: (list) => { calls++; ck.splice(0, ck.length, ...list); } }));
  assert.strictEqual(r1.accepted.length, COUNT); assert(calls >= COUNT && ck.length >= COUNT, `1) the checkpoint grew with each accepted question (${calls} updates, ${ck.length} kept)`);
  console.log(`1) from the start: ${r1.accepted.length} questions, ${m1.stats.written} written; the checkpoint was updated ${calls} times`);
  // 2) the page was closed after 9 accepted questions: the next run takes up from them
  const prior = JSON.parse(JSON.stringify(ck.slice(0, 9))); const m2 = model(); const ck2 = [];
  const r2 = await E.generateToCount(m2, planOf(), pages, { count: COUNT, field: 'science', language: 'en' }, () => {}, opts(m2, { resume: prior, checkpoint: (list) => { ck2.splice(0, ck2.length, ...list); } }));
  const stems = r2.accepted.map((c) => c.stem);
  assert.strictEqual(r2.accepted.length, COUNT, '2) the count is exact'); assert.strictEqual(new Set(stems).size, COUNT, '2) no question twice');
  prior.forEach((c) => assert(stems.includes(c.stem), '2) a question of the interrupted run is kept as it was: ' + c.stem));
  const priorSlots = new Set(prior.map((c) => c.slot)); assert(!m2.stats.slots.some((s) => priorSlots.has(s)), '2) no slot already answered is written again');
  assert(m2.stats.written < m1.stats.written, `2) fewer questions written than from the start (${m2.stats.written} vs ${m1.stats.written})`);
  assert(ck2.length >= COUNT && prior.every((c, i) => ck2[i].stem === c.stem), '2) the new checkpoint starts with the questions it resumed from');
  assert.strictEqual(new Set(r2.accepted.map((c) => c.section_key)).size, N, '2) every section still covered');
  console.log(`2) resumed from ${prior.length} of ${COUNT}: ${r2.accepted.length} questions (${m2.stats.written} written, not ${m1.stats.written}), none of the ${prior.length} rewritten, every section covered`);
  // 3) a checkpoint that already holds the count: nothing more is asked
  const m3 = model(); const r3 = await E.generateToCount(m3, planOf(), pages, { count: COUNT, field: 'science', language: 'en' }, () => {}, opts(m3, { resume: JSON.parse(JSON.stringify(r1.accepted)) }));
  assert.strictEqual(r3.accepted.length, COUNT); assert.strictEqual(m3.stats.written, 0, '3) nothing written: ' + m3.stats.written);
  console.log('3) a checkpoint that already holds the whole quiz: delivered as it is, no request');
  console.log('resume ok');
})().catch((e) => { console.error(e); process.exit(1); });
