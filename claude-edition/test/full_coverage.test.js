// node claude-edition/test/full_coverage.test.js — the quiz covers EVERY section of the lecture that has text, not only the count (Claude path).
// The real case: 20 questions for a lecture of 20 sections, one slot each; 4 slots were refused or rejected and their replacements went to a section that
// already had questions (Neurons got 3) - «16 of 20 sections». Now:
//  1) a slot that fails is replaced IN its section (the retry round, even when the count is already met by the spares), with the easiest type not refused there
//  2) a section whose text cannot give a question (always refused) is tried a bounded number of times, then reported - the count is still exact
//  3) the surplus is trimmed without ever taking a section's only question
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const N = 20, REFUSE_ONCE = new Set([6, 8, 12, 20]), NEVER = 15;
const pages = Array.from({ length: N }, (_, i) => ({ ref: 'd1p' + (i + 1), text: `Topic ${i + 1}\n` + [1, 2, 3, 4].map((k) => `Fact ${k} of topic ${i + 1}: the structure S${i + 1}x${k} performs the role R${i + 1}x${k} in the body.`).join('\n') }));
// 20 sections, one page each; section 7 has three objectives (the spares go there first, as they went to «Neurons»)
const objs = []; pages.forEach((p, i) => { const n = i + 1, per = n === 7 ? 3 : 1;
  for (let j = 0; j < per; j++) objs.push({ id: `o${n}${'abc'[j]}`, statement: `Topic ${n} part ${j + 1}`, pages: [p.ref], capacity: 3, section: 'S' + n, section_label: 'Topic ' + n,
    supports: { understanding: { pages: [p.ref] }, application: { pages: [p.ref] }, basic_recall: { pages: [p.ref] }, compare_contrast: { pages: [p.ref] } } }); });
const between = (s, a, b) => s.slice(s.indexOf(a) + a.length, s.indexOf(b, s.indexOf(a) + a.length));
const secOfRef = (r) => +String(r).replace(/^d1p/, '');
let calls = 0; const seenSec = new Set(); const written = [];
const llm = { json: async (task, sys, prompt) => {
  calls++;
  if (task === 'generate') { const slots = JSON.parse(between(prompt, 'SLOTS:\n', '\nPAGES:\n')); const pg = JSON.parse(between(prompt, '\nPAGES:\n', '\nReturn JSON'));
    return { questions: slots.map((x) => { const sec = secOfRef(x.pages[0]);
      if (sec === NEVER) return { slot: x.slot, unwritable_reason: 'The page is a figure: its facts are not in the text.' };
      if (REFUSE_ONCE.has(sec) && !seenSec.has(sec)) { seenSec.add(sec); return { slot: x.slot, unwritable_reason: 'The page text is fragmentary for this type.' }; }
      const lines = (pg[x.pages[0]] || '').split('\n').slice(1); const k = written.filter((w) => w === sec).length; written.push(sec); const fact = lines[k % lines.length]; const w = (j) => `w${x.slot}q${j}`;
      return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)}: which item does the lecture name here?`, options: [w(3) + ' alpha', w(4) + ' beta', w(5) + ' gamma', w(6) + ' delta'], correct_index: 0,
        explanation: 'The lecture states it in this sentence: ' + fact, purpose: `${w(7)} ${w(8)} ${w(9)}`, evidence: [{ page: x.pages[0], quote: fact }] }; }) }; }
  if (task === 'verify') { const qs = JSON.parse(between(prompt, '\nQUESTIONS:\n', '\nReturn JSON')); return { results: qs.map((x) => ({ id: x.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none', weak_options: [] })) }; }
  const it = JSON.parse(between(prompt, 'ITEMS:\n', '\nReturn JSON')); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null })) }; } };
(async () => {
  const plan = E.buildPlan({ objectives: objs, profile: null }, { count: N, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null); E.assignForms(plan.slots);
  const planned = new Set(plan.slots.map((s) => s.section_key)); assert.strictEqual(planned.size, N, 'the plan gives every section a slot: ' + planned.size);
  const pageSection = Object.fromEntries(pages.map((p, i) => [p.ref, 'S' + (i + 1)]));
  const res = await E.generateToCount(llm, plan, pages, { count: N, field: 'science', language: 'en' }, () => {}, { concurrency: 7, aiOnly: true, topupRounds: 4, pageSection, shape: (sl, pr) => E.assignForms(sl, pr) });
  const secs = {}; res.accepted.forEach((c) => { const k = c.section_key; secs[k] = (secs[k] || 0) + 1; });
  const covered = Object.keys(secs).length, missing = [...planned].filter((k) => !secs[k]);
  console.log(`${res.accepted.length} questions, ${covered}/${N} sections; missing: ${missing.join(', ') || 'none'}; ${calls} requests; stats ${JSON.stringify({ unwritable: res.stats.unwritable, cover_slots: res.stats.cover_slots, topup_rounds: res.stats.topup_rounds })}`);
  assert.strictEqual(res.accepted.length, N, '3) the count is exact');
  for (const n of REFUSE_ONCE) assert(secs['S' + n] >= 1, `1) section ${n}, refused once, is replaced in its own section`);
  assert.deepStrictEqual(missing, ['S' + NEVER], '2) only the section whose text gives no question is missing');
  assert(calls < 40, '2) a section that always refuses is tried a bounded number of times: ' + calls + ' requests');
  assert(Object.values(secs).every((v) => v >= 1) && secs.S7 <= 3, '3) the surplus came off the over-asked section, never a section\'s only question');
  console.log('1-3) every section with text got a question (4 refused slots replaced in their own sections), the figure-only section is reported, the count exact');
  console.log('full coverage ok');
})().catch((e) => { console.error(e); process.exit(1); });
