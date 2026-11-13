// node claude-edition/test/full_coverage.test.js — the quiz covers EVERY section of the lecture that has text, not only the count (Claude path).
// The real case: 20 questions for a lecture of 20 sections, one slot each; 4 slots were refused or rejected and their replacements went to a section that
// already had questions (Neurons got 3) - «16 of 20 sections». Now:
//  1) a slot that fails is replaced IN its section (the retry round, even when the count is already met by the spares), with the easiest type not refused there
//  2) a section whose text cannot give a question (always refused) is tried a bounded number of times, then reported - the count is still exact
//  3) the surplus is trimmed without ever taking a section's only question
//  4) a HARD section (its first five tries refused) still ends with a question: once the count was met by the spares, one failed round of tries used to end the
//     rounds and leave it out with tries to spare (it was tried 4 times) - now each round tries it twice side by side, for up to four rounds
//  5) A SECTION IS COVERED BY A QUESTION THAT QUOTES IT: a question written for section 2 that quotes a page of section 1 used to count section 2 as covered (by
//     its objective) - the quiz had no question from section 2 and said it covered everything. Now section 2 is asked again until a question quotes it
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
  // 4) a hard section: its first five tries refused, the count met by the spares meanwhile
  const M = 6, HARD = 3; let hardTries = 0, calls4 = 0; const pages4 = pages.slice(0, M);
  const objs4 = []; pages4.forEach((p, i) => { const n = i + 1; for (let j = 0; j < (n === HARD ? 2 : 1); j++) objs4.push({ id: `h${n}${'ab'[j]}`, statement: `Topic ${n} part ${j + 1}`, pages: [p.ref], capacity: 4, section: 'S' + n, section_label: 'Topic ' + n,
    supports: { understanding: { pages: [p.ref] }, application: { pages: [p.ref] }, basic_recall: { pages: [p.ref] }, compare_contrast: { pages: [p.ref] } } }); });
  const llm4 = { json: async (task, sys, prompt) => { calls4++;
    if (task === 'generate') { const slots = JSON.parse(between(prompt, 'SLOTS:\n', '\nPAGES:\n')); const pg = JSON.parse(between(prompt, '\nPAGES:\n', '\nReturn JSON'));
      return { questions: slots.map((x) => { const sec = secOfRef(x.pages[0]);
        if (sec === HARD && hardTries++ < 5) return { slot: x.slot, unwritable_reason: 'The slide is a short fragment for this type.' };
        const lines = (pg[x.pages[0]] || '').split('\n').slice(1); const k = written.filter((w) => w === 'h' + sec).length; written.push('h' + sec); const fact = lines[k % lines.length]; const w = (j) => `v${x.slot}q${j}`;
        return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)}: which item does the lecture name here?`, options: [w(3) + ' alpha', w(4) + ' beta', w(5) + ' gamma', w(6) + ' delta'], correct_index: 0,
          explanation: 'The lecture states it in this sentence: ' + fact, purpose: `${w(7)} ${w(8)} ${w(9)}`, evidence: [{ page: x.pages[0], quote: fact }] }; }) }; }
    return llm.json(task, sys, prompt); } };
  const plan4 = E.buildPlan({ objectives: objs4, profile: null }, { count: M, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null); E.assignForms(plan4.slots);
  const res4 = await E.generateToCount(llm4, plan4, pages4, { count: M, field: 'science', language: 'en' }, () => {}, { concurrency: 7, aiOnly: true, topupRounds: 6, pageSection: Object.fromEntries(pages4.map((p, i) => [p.ref, 'S' + (i + 1)])), shape: (sl, pr) => E.assignForms(sl, pr) });
  const secs4 = new Set(res4.accepted.map((c) => c.section_key));
  assert.strictEqual(res4.accepted.length, M, '4) the count is exact'); assert(secs4.has('S' + HARD), `4) the hard section ends with a question (tried ${hardTries} times)`); assert.strictEqual(secs4.size, M, '4) every section');
  console.log(`4) a hard section refused five times got its question on try ${hardTries} (${calls4} requests, ${res4.stats.topup_rounds} top-up rounds); every section covered, the count exact`);
  // 5) a question asked for one section that quotes another
  const K = 5, MIS = 2; let misled = 0; const pages5 = pages.slice(0, K); const ref5 = (n) => 'd1p' + n;
  const objs5 = pages5.map((p, i) => ({ id: 'q' + (i + 1), statement: `Topic ${i + 1}`, pages: [p.ref], capacity: 3, section: 'S' + (i + 1), section_label: 'Topic ' + (i + 1),
    supports: { understanding: { pages: [p.ref] }, basic_recall: { pages: [p.ref] }, application: { pages: [p.ref] } } }));
  const used5 = {}; const llm5 = { json: async (task, sys, prompt) => {
    if (task === 'generate') { const slots = JSON.parse(between(prompt, 'SLOTS:\n', '\nPAGES:\n'));
      return { questions: slots.map((x) => { let sec = secOfRef(x.pages[0]); if (sec === MIS && !misled++) sec = 1;      // the first question asked for section 2 quotes section 1
        const lines = pages5[sec - 1].text.split('\n').slice(1); const k = (used5[sec] = (used5[sec] || 0) + 1) - 1; const fact = lines[k % lines.length]; const w = (j) => `m${x.slot}q${j}`;
        return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)}: which item does the lecture name here?`, options: [w(3) + ' alpha', w(4) + ' beta', w(5) + ' gamma', w(6) + ' delta'], correct_index: 0,
          explanation: 'The lecture states it in this sentence: ' + fact, purpose: `${w(7)} ${w(8)} ${w(9)}`, evidence: [{ page: ref5(sec), quote: fact }] }; }) }; }
    return llm.json(task, sys, prompt); } };
  const plan5 = E.buildPlan({ objectives: objs5, profile: null }, { count: K, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null); E.assignForms(plan5.slots);
  const res5 = await E.generateToCount(llm5, plan5, pages5, { count: K, field: 'science', language: 'en' }, () => {}, { concurrency: 7, aiOnly: true, topupRounds: 6, pageSection: Object.fromEntries(pages5.map((p, i) => [p.ref, 'S' + (i + 1)])), shape: (sl, pr) => E.assignForms(sl, pr) });
  const quoted = new Set(res5.accepted.flatMap((c) => c.evidence.map((e) => e.page)));
  assert.strictEqual(res5.accepted.length, K, '5) the count is exact'); assert(misled >= 1, '5) a question for section 2 did quote section 1');
  for (let n = 1; n <= K; n++) assert(quoted.has(ref5(n)), `5) section ${n} has a question that quotes it: ${[...quoted].join(', ')}`);
  console.log(`5) a question asked for section 2 quoted section 1: section 2 was asked again, and every section ends with a question that quotes it (${[...quoted].sort().join(', ')})`);
  // 6) A SECTION WHOSE ONLY TEXT IS NOT TEACHING TEXT IS NOT CHASED (the real case: «Its divided into 4 parts», a fragment the reading set aside; eight tries in a
  //    row quoted it, each refused because the line is not teaching text, round after round - two minutes of a 30-question quiz, and still not covered). Two such
  //    refusals and the section is reported as not covered; the rounds stop chasing it, the count is still exact and every other section is covered
  const L = 10, BAD = 4; const pages6 = Array.from({ length: L }, (_, i) => ({ ref: 'd1p' + (i + 1), text: `Topic ${i + 1}\n` + [1, 2, 3, 4].map((k) => `Fact ${k} of topic ${i + 1}: the structure T${i + 1}y${k} performs the role Q${i + 1}y${k} in the body.`).join('\n') }));
  const objs6 = pages6.map((p, i) => ({ id: 'o6_' + (i + 1), statement: 'Topic ' + (i + 1), pages: [p.ref], capacity: 3, section: 'S' + (i + 1), section_label: 'Topic ' + (i + 1),
    supports: { understanding: { pages: [p.ref] }, application: { pages: [p.ref] }, basic_recall: { pages: [p.ref] }, compare_contrast: { pages: [p.ref] } } }));
  let badTries = 0, gen6 = 0; const used6 = {};
  const llm6 = { json: async (task, sys, prompt) => {
    if (task === 'generate') { gen6++; const slots = JSON.parse(between(prompt, 'SLOTS:\n', '\nPAGES:\n'));
      return { questions: slots.map((x) => { const sec = secOfRef(x.pages[0]); if (sec === BAD) badTries++;
        const lines = pages6[sec - 1].text.split('\n').slice(1); const k = (used6[sec] = (used6[sec] || 0) + 1) - 1; const fact = lines[k % lines.length]; const w = (j) => `z${x.slot}q${j}`;
        return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)}: which item does the lecture name here?`, options: [w(3) + ' alpha', w(4) + ' beta', w(5) + ' gamma', w(6) + ' delta'], correct_index: 0,
          explanation: 'The lecture states it in this sentence: ' + fact, purpose: `${w(7)} ${w(8)} ${w(9)}`, evidence: [{ page: x.pages[0], quote: fact }] }; }) }; }
    return llm.json(task, sys, prompt); } };
  // the reading's own check: nothing on page 4 is teaching text (it was set aside as a fragment), so a question quoting it is refused - exactly as on the real lecture
  const evidenceCheck = (c) => (c.evidence.some((e) => e.page === 'd1p' + BAD) ? 'الاقتباس ليس من جزء معتمد للأسئلة (عنوان أو هدف أو بيانات محاضر أو جزء غير محسوم). استشهد بجملة تعليمية من الصفحة.' : null);
  const plan6 = E.buildPlan({ objectives: objs6, profile: null }, { count: L, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null); E.assignForms(plan6.slots);
  const res6 = await E.generateToCount(llm6, plan6, pages6, { count: L, field: 'science', language: 'en' }, () => {}, { concurrency: 7, aiOnly: true, topupRounds: 6, evidenceCheck, pageSection: Object.fromEntries(pages6.map((p, i) => [p.ref, 'S' + (i + 1)])), shape: (sl, pr) => E.assignForms(sl, pr) });
  const secs6 = new Set(res6.accepted.map((c) => c.section_key));
  assert.strictEqual(res6.accepted.length, L, '6) the count is exact'); assert(!secs6.has('S' + BAD), '6) the section without teaching text has no question');
  for (let n = 1; n <= L; n++) if (n !== BAD) assert(secs6.has('S' + n), `6) section ${n} is covered`);
  assert.strictEqual(res6.stats.cover_unaskable, 1, '6) it is reported as not askable');
  assert(badTries <= 4, `6) the section is not chased round after round: ${badTries} tries (eight before)`); assert((res6.stats.topup_rounds || 0) <= 1, '6) at most one round after the first: ' + res6.stats.topup_rounds);
  console.log(`6) a section whose only text is not teaching text: ${badTries} tries, then reported (${res6.stats.topup_rounds || 0} top-up round, ${gen6} writing requests); the count exact, every other section covered`);
  console.log('full coverage ok');
})().catch((e) => { console.error(e); process.exit(1); });
