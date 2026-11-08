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
  assert.strictEqual(d([]).length, 0); assert.strictEqual(d([{ index: 2, why: 'generic' }])[0].severity, 'decisive', 'one generic option: written again');
  assert.strictEqual(d([{ index: 1, why: 'also_correct' }])[0].severity, 'decisive', 'an option that is also right: written again');
  assert.strictEqual(d([{ index: 3, why: 'absurd' }])[0].severity, 'minor', 'one weak option: a remark'); assert.strictEqual(d([{ index: 2, why: 'off_topic' }, { index: 3, why: 'absurd' }])[0].severity, 'decisive', 'two weak options: written again');
  assert.strictEqual(d([{ index: 0, why: 'absurd' }]).length, 0, 'the key itself is not judged as a distractor');
  assert(/من نوع الإجابة نفسه ومن مادة هذا القسم/.test(d([{ index: 2, why: 'generic' }])[0].message), 'the feedback says how to fix the options');
  console.log('3) option audit: generic / also-correct -> rewrite; two weak -> rewrite; one weak -> remark; the key is not judged');
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
  console.log('options quality ok');
})().catch((e) => { console.error(e); process.exit(1); });
