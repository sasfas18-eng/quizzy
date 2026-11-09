// node claude-edition/test/options_quality.test.js — the options of a question are LECTURE CONTENT, close and plausible (the Claude path).
//  1) options that describe the question or the statement (the reported case: «It negates what the lecture states», «Nothing; it matches the lecture»…) are refused
//  2) content options of the same kind pass
//  3) the blind solver's audit of the options: one generic / also-correct / repeated option, or two weak ones -> written again; one weak one -> a remark
//  4) end to end: a model that first writes generic options is told why and writes lecture options in the retry; no generic option reaches the quiz
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const page = 'Atrial systole pushes the last fifth of ventricular filling into the ventricles. Isovolumetric contraction begins when the atrioventricular valves close. The second heart sound is produced by closure of the semilunar valves.';
const ctx = { pages: { d1p1: page }, field: 'health', language: 'en', allowExternal: false, sourceAr: false };
const q = (options, stem = 'A classmate writes: "Isovolumetric contraction begins when the semilunar valves close." What, if anything, is wrong with this statement?') => ({ qtype: 'critical_thinking', stem, options, correct_index: 0,
  explanation: 'The lecture says isovolumetric contraction begins when the atrioventricular valves close, not the semilunar valves.', evidence: [{ page: 'd1p1', quote: 'Isovolumetric contraction begins when the atrioventricular valves close.' }] });
(async () => {
  // 1) the reported options
  const reported = q(['It swaps two things the lecture keeps apart', 'It negates what the lecture states (adds or drops a "not")', 'Nothing; it matches the lecture', 'It replaces a key word with its opposite']);
  const v1 = E.validateQ(reported, ctx); assert(v1.some((i) => i.code === 'meta_options' && i.severity === 'decisive'), 'the reported generic options are refused: ' + JSON.stringify(v1.map((i) => i.code)));
  for (const bad of [['Only Student A', 'Only Student B', 'Both students', 'Neither student'], ['The statement is correct', 'x valves', 'y valves', 'z valves'], ['العبارة صحيحة', 'الصمامات الأذينية البطينية', 'الصمامات الهلالية', 'الصمام التاجي'], ['لا خطأ فيها', 'أ', 'ب', 'ج']])
    assert(E.validateQ(q(bad), ctx).some((i) => i.code === 'meta_options'), 'refused: ' + bad[0]);
  console.log('1) generic options refused: the reported question, «only student A», «the statement is correct», «العبارة…», «لا خطأ فيها»');
  // 2) content options of one kind (the corrected claim, in four versions)
  const good = q(['It begins when the atrioventricular valves close', 'It begins when the semilunar valves open', 'It begins when the aortic valve closes', 'It begins when the atria contract'],
    'A classmate writes: "Isovolumetric contraction begins when the semilunar valves close." Which correction makes it match the lecture?');
  const v2 = E.validateQ(good, ctx); assert(!v2.some((i) => i.code === 'meta_options') && !v2.some((i) => i.severity === 'decisive'), 'content options pass: ' + JSON.stringify(v2));
  for (const ok of [['Heart sounds', 'Cardiac output', 'Stroke volume', 'Heart rate'], ['Both atria', 'Sinoatrial node', 'Purkinje fibres', 'Bundle of His']]) assert(!E.META_OPT.test(ok.join('\n')), 'not generic: ' + ok);
  console.log('2) lecture-content options pass (a corrected claim in four versions; «Both atria», «Heart sounds»… are content)');
  // 3) the audit of the options by the blind solver
  const base = { chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' }; const st = { external_mode: 'source_only' };
  assert(E._judge, 'judge exported for tests');
  const d = (weak) => E._judge({ ...base, weak_options: weak }, good, st).filter((i) => i.code === 'weak_options');
  // (measured on a real quiz: a reviewer called content options «generic» - «Bacteria: peptidoglycan; Archaea: pseudomurein» - and 11 good questions were lost;
  //  so a reviewer's taste is a remark, and only an option that is also right, or two plainly junk ones, sends a question back)
  assert.strictEqual(d([]).length, 0);
  assert.strictEqual(d([{ index: 2, why: 'about_question' }, { index: 3, why: 'generic' }])[0].severity, 'minor', 'a reviewer\'s «about the question» is a remark (the static check refuses the real ones)');
  assert.strictEqual(d([{ index: 1, why: 'also_correct' }])[0].severity, 'decisive', 'an option that is also right: written again');
  assert.strictEqual(d([{ index: 3, why: 'absurd' }])[0].severity, 'minor', 'one weak option: a remark'); assert.strictEqual(d([{ index: 2, why: 'not_parallel' }, { index: 3, why: 'absurd' }])[0].severity, 'minor', 'not parallel + absurd: a remark');
  assert.strictEqual(d([{ index: 2, why: 'off_topic' }, { index: 3, why: 'absurd' }])[0].severity, 'decisive', 'two plainly junk options: written again');
  assert.strictEqual(d([{ index: 0, why: 'absurd' }]).length, 0, 'the key itself is not judged as a distractor');
  assert(/من نوع الإجابة نفسه ومن مادة هذا القسم/.test(d([{ index: 1, why: 'also_correct' }])[0].message), 'the feedback says how to fix the options');
  for (const ok of [['It replaces sodium with potassium in the tubule', 'It turns angiotensin I into angiotensin II', 'It adds a phosphate group to ADP', 'It reverses the direction of flow']]) assert(!E.META_OPT.test(ok.join('\n')), 'content verbs are not meta: ' + ok[0]);
  console.log('3) option audit: also-correct or two junk -> rewrite; a reviewer\'s taste (incl. «about the question») -> remark; «It replaces sodium…» is content');
  // 4) end to end: the first draft has generic options, the retry (told why) has lecture options
  let round = 0; const prompts = []; const llm = { json: async (task, s, prompt) => {
    if (task === 'generate') { round++; prompts.push(prompt); const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n')));
      return { questions: slots.map((x) => ({ slot: x.slot, ...(round === 1 ? reported : good), form: x.shape })) }; }
    if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 12, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((x) => ({ id: x.id, ...base })) }; }
    const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null })) }; } };
  const plan = { slots: [{ slot: 1, qtype: 'critical_thinking', objective: 'Cardiac cycle', objective_id: 'o1', pages: ['d1p1'], difficulty: 'hard' }], requested: 1 }; E.assignForms(plan.slots);
  const r = await E.generate(llm, plan, [{ ref: 'd1p1', text: page }], { field: 'health', language: 'en' }, () => {}, { concurrency: 2 });
  assert.strictEqual(r.accepted.length, 1); assert(!E.META_OPT.test(r.accepted[0].options.join('\n')), 'the accepted question has lecture options: ' + r.accepted[0].options);
  assert(/retry_feedback/.test(prompts[1]) && /الخيارات مصطلحات أو قيمًا أو عبارات/.test(prompts[1]), 'the retry is told why the options were refused');
  assert(r.accepted[0].ai_form, 'the form Claude used is kept');
  console.log('4) a draft with generic options is rewritten (told why) - the quiz gets: ' + r.accepted[0].options.join(' | '));
  // 5) the real failure (a 50-question quiz that delivered 9): half the slots refused in round 1 and a strict reviewer - Claude only, no local fill, no time cut:
  //    the refused slots are replaced, the reviewer's remarks do not reject, and the full count is delivered by the model
  const facts = (i) => [`The enzyme E${i} converts substrate S${i} into product P${i} in the cytoplasm.`, `Activity of E${i} rises when the cofactor C${i} is present.`, `Deficiency of E${i} causes the disorder D${i}.`, `The gene G${i} encodes the enzyme E${i}.`];
  const pagesN = Array.from({ length: 12 }, (_, i) => ({ ref: 'd1p' + (i + 1), text: `Topic ${i + 1}\n` + facts(i + 1).join('\n') }));
  let call = 0; const usedFact = {}; const refusedOnce = new Set(); const W = (slot, j) => 'q' + slot + 'x' + 'abcdefgh'[j];      // every question its own words
  const strict = { json: async (task, s, prompt) => {
    if (task === 'generate') { call++; const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
      return { questions: slots.map((x, k) => { if (x.slot % 2 === 0 && !refusedOnce.has(x.slot)) { refusedOnce.add(x.slot); return { slot: x.slot, unwritable_reason: 'The cited page contains no abbreviation to expand.' }; }      // every even slot refused the first time (half of round 1)
        const ref = x.pages[0]; const t = (pg[ref] || '').split('\n').slice(1); const k2 = (usedFact[ref] = (usedFact[ref] || 0) + 1) - 1; const sent = t[k2 % t.length]; const w = (j) => W(x.slot, j);      // the next fact of the page
        return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)} ${w(3)}: which item fits?`, options: [w(0) + ' alpha', w(1) + ' beta', w(2) + ' gamma', w(3) + ' delta'], correct_index: 0, explanation: 'The lecture states: ' + sent, purpose: w(4) + ' ' + w(5) + ' ' + w(6), evidence: [{ page: x.pages[0], quote: sent }] }; }) }; }
    if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 12, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((x) => ({ id: x.id, ...base, weak_options: [{ index: 1, why: 'about_question' }, { index: 2, why: 'not_parallel' }] })) }; }      // a picky reviewer
    const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null })) }; } };
  const objs = pagesN.map((p, i) => ({ id: 'o' + (i + 1), statement: 'Topic ' + (i + 1), pages: [p.ref], capacity: 3, section: 'S' + (i + 1), section_label: 'Topic ' + (i + 1), supports: { basic_recall: { pages: [p.ref] }, understanding: { pages: [p.ref] }, mechanisms: { pages: [p.ref] } } }));
  const plan50 = E.buildPlan({ objectives: objs, profile: null }, { count: 30, focus: 'balanced', difficulty: 'mixed', field: 'science' }, null); E.assignForms(plan50.slots);
  const res = await E.generateToCount(strict, plan50, pagesN, { count: 30, field: 'science', language: 'en' }, () => {}, { concurrency: 12, aiOnly: true, topupRounds: 3, shape: (sl, pr) => E.assignForms(sl, pr) });
  assert.strictEqual(res.accepted.length, 30, 'the full count from the model: ' + res.accepted.length + ' ' + JSON.stringify(res.stats)); assert(res.stats.unwritable >= 10, 'half of round 1 was refused');
  assert(res.accepted.every((c) => (c.issues || []).every((i) => i.code !== 'weak_options' || i.severity === 'minor')), 'the reviewer\'s remarks stayed remarks');
  console.log(`5) half the slots refused + a picky reviewer: ${res.accepted.length}/30 written by the model (${res.stats.unwritable} refused slots replaced; remarks kept as remarks)`);
  // 6) «gives away another question's answer» (21 good questions lost in a real CNS quiz): an answer that is the lecture's own subject - «central nervous system»,
  //    on most pages - does not make every later question a give-away; a real give-away (a rare phrase) still is
  const cnsPages = Array.from({ length: 8 }, (_, i) => ({ ref: 'd1p' + (i + 1), text: `The central nervous system part ${i + 1}. Fact ${i + 1}: the structure N${i + 1} relays signal type T${i + 1} to the cortex.` }));
  const qA = { slot: 1, qtype: 'basic_recall', stem: 'Which division consists of the brain and the spinal cord?', options: ['central nervous system', 'peripheral nervous system', 'autonomic nervous system', 'somatic nervous system'], correct_index: 0, evidence: [{ page: 'd1p1', quote: 'The central nervous system part 1.' }] };
  const qB = { slot: 2, qtype: 'mechanisms', stem: 'Within the central nervous system, which structure relays signal type T2 to the cortex?', options: ['N2', 'N3', 'N4', 'N5'], correct_index: 0, evidence: [{ page: 'd1p2', quote: 'Fact 2: the structure N2 relays signal type T2 to the cortex.' }] };
  const norm = (x) => E.norm(x); const pn = cnsPages.map((p) => norm(p.text)); const common = (k) => pn.filter((t) => t.includes(k)).length >= 3;
  assert.strictEqual(E.leaks(qB, [qA], false, common), null, 'naming the lecture\'s subject is not a give-away');
  const qC = { ...qB, slot: 3, stem: 'The peripheral nervous system relays which signal?' }; const qD = { ...qA, slot: 4, options: ['peripheral nervous system', 'central nervous system', 'autonomic nervous system', 'somatic nervous system'] };
  assert.notStrictEqual(E.leaks(qC, [qD], false, common), null, 'a rare phrase that is another question\'s answer is still a give-away');
  console.log('6) give-aways: the lecture\'s own subject («central nervous system») is not one; a rare answer phrase in another stem still is');
  console.log('options quality ok');
})().catch((e) => { console.error(e); process.exit(1); });
