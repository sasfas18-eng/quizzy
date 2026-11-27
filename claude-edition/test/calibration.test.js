// node claude-edition/test/calibration.test.js — THE CALIBRATION ON THE OWNER'S REAL EXAMS (docs/EXAM-CALIBRATION.md): a quiz is about one step above them, never a trick.
//  1) the forms: the four fixed forms of each type are untouched, in place (the development track counts each form by its place); the new ones are appended
//  2) one step deeper: about 40% of the slots that can take a step get one, spread evenly, continued across rounds; critical thinking and NOT/EXCEPT never
//     (already a step above the exam); each type its own steps (sequence: close orders; a case: an indirect cue; the rest: reworded key / reversed detail, in turn)
//  3) the full prompt (Claude) explains the level and exactly the steps used, «reword» with the steps that fall back on it; the compact prompt of a small
//     provider is exactly what it was (no step, no new rule: its size is unchanged)
//  4) a static check: options of two items each whose key is made of the items the options repeat most - a student counts and picks; the balanced set passes,
//     and so do the real exam's tie, the 2x2 grid of directions and Arabic options that only start with «و»
//  5) NOT/EXCEPT asked less (the real exams: 0-2%)
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const OLD = {"basic_recall": ["term from its meaning (options: four terms of the same kind from this lecture)", "complete a key statement with one decisive term blanked (options: four terms of the same kind)", "which item belongs to a group the lecture lists (options: one member and three items from other groups of the lecture)", "what a named structure / item does, as stated (options: four functions named in this lecture)"], "understanding": ["meaning in other words (options: four paraphrases, three of them wrong in one detail)", "which statement about this section is true (options: four statements, three altered in one detail)", "what an abbreviation used in the pages stands for (options: four expansions)", "why: which explanation of a stated point is correct (options: four explanations)"], "mechanisms": ["cause -> effect (options: four effects)", "effect -> cause (options: four causes)", "purpose of a step / structure (options: four purposes)", "what follows when a stated step / factor is absent, only as the lecture states it (options: four outcomes)"], "application": ["classify a new example into the lecture's categories (options: four categories of the lecture)", "apply a value / range from the lecture (options: four values or ranges)", "which member of a family fits a description (options: four members)", "which finding is expected in a described example (options: four findings)"], "critical_thinking": ["inference: two findings from the pages; which state / group / conclusion follows (options: four states or conclusions from this lecture)", "prediction: a stated condition; which combination of findings follows (options: four combinations; wrong ones reverse or swap one element)", "correct the claim: a claim with one detail altered; which corrected version matches the lecture (options: four versions of the claim, each changing a different detail; only one restores the lecture)", "best-supported conclusion from the lecture's evidence (options: four conclusions; wrong ones over-reach, reverse or misattribute)"], "scenarios": ["vignette: a short case through two findings from the pages; which state / phase / category explains them (options: four sibling states)", "prediction in a case: which further finding is expected (options: four findings)", "decision in context: the interpretation the lecture supports (options: four interpretations)", "two cases: which pairing of states / groups is correct (options: four pairings of named states)"], "compare_contrast": ["difference between two items (options: four contrasts)", "match items to their groups (options: four pairings of named items)", "which feature distinguishes A from B (options: four features)", "which feature is shared by both (options: four features)"], "best_answer": ["best description (options: four descriptions)", "most accurate statement (options: four statements)", "best example (options: four examples)", "best justification for a stated point (options: four justifications)"], "not_except": ["all of the following EXCEPT (options: three true items of one list and one item from elsewhere in the lecture)", "which is NOT true (options: three true statements and one altered)", "which is LEAST related (options: four items)", "which pairing is INCORRECT (options: four pairings)"], "sequence": ["correct order (options: four orders of the same steps)", "what comes next (options: four steps)", "what comes first (options: four steps)", "which step is missing from the sequence (options: four steps)"]};
const ORDER = Object.keys(OLD);

// 1) the forms
for (const t of ORDER) { assert.deepStrictEqual(E.AI_FORMS[t].slice(0, 4), OLD[t], `the four forms of ${t} are untouched and in place`); }
const added = Object.fromEntries(ORDER.map((t) => [t, E.AI_FORMS[t].length - 4]).filter(([, n]) => n));
assert.deepStrictEqual(added, { basic_recall: 3, application: 1, scenarios: 1 }, 'the forms the real exams asked for, appended: ' + JSON.stringify(added));
for (const t of ORDER) for (const f of E.AI_FORMS[t]) assert(/\(options: [^)]*\)$/.test(f), 'every form says what its options are: ' + f);
assert(/each item in exactly two options/.test(E.AI_FORMS.basic_recall[5]), 'the pairs form keeps every item twice (no counting cue)');
console.log('1) forms: the 40 fixed forms untouched and in place; appended', JSON.stringify(added));

// 2) one step deeper
const types = ORDER; const mk = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ slot: from + i + 1, qtype: types[(from + i) % types.length], objective: 'Section ' + ((from + i) % 5), section_key: 'S' + ((from + i) % 5), pages: ['d1p1'] }));
const r1 = E.assignForms(mk(60), null, null); const elig = r1.filter((s) => E.STEPS[s.qtype]); const deep = elig.filter((s) => s.step);
const share = deep.length / elig.length; assert(share >= 0.37 && share <= 0.43, 'about 40% of the slots that can take a step: ' + share.toFixed(2));
assert(r1.filter((s) => s.qtype === 'critical_thinking' || s.qtype === 'not_except').every((s) => !s.step), 'critical thinking and NOT/EXCEPT: no step (already above the exam)');
for (const s of deep) assert(E.STEPS[s.qtype].includes(s.step), `${s.qtype} takes only its own steps (${s.step})`);
assert(r1.filter((s) => s.qtype === 'sequence' && s.step).every((s) => s.step === 'near_order') && r1.some((s) => s.qtype === 'sequence' && s.step), 'sequence: close orders');
assert(r1.filter((s) => (s.qtype === 'scenarios' || s.qtype === 'application') && s.step).every((s) => s.step === 'indirect_cue'), 'a case: an indirect cue');
const rr = deep.filter((s) => ['reword', 'reverse'].includes(s.step)).map((s) => s.step); assert(rr.includes('reword') && rr.includes('reverse') && Math.abs(rr.filter((x) => x === 'reword').length - rr.filter((x) => x === 'reverse').length) <= 1, 'reword and reverse in turn: ' + rr.join(','));
let run = 0, worst = 0; for (const s of elig) { run = s.step ? run + 1 : 0; worst = Math.max(worst, run); } assert(worst <= 1, 'spread evenly: never two stepped slots in a row among those that can take one');
const r2 = E.assignForms(mk(30, 60), r1, null); const all = r1.concat(r2).filter((s) => E.STEPS[s.qtype]); const share2 = all.filter((s) => s.step).length / all.length;
assert(share2 >= 0.37 && share2 <= 0.43, 'continued across rounds: ' + share2.toFixed(2));
const again = E.assignForms(r1.map((s) => ({ ...s })), null, null); assert.deepStrictEqual(again.map((s) => s.step || null), r1.map((s) => s.step || null), 'the same plan gives the same steps (deterministic)');
console.log(`2) one step deeper: ${deep.length}/${elig.length} (${Math.round(100 * share)}%), across two rounds ${Math.round(100 * share2)}%; steps by type; never two in a row; deterministic`);

// 3) the prompts
const st = { language: 'source', field: 'health' }; const pages = { d1p1: 'The pectoral girdle is formed by the scapula and clavicle.' };
const slots = [{ slot: 1, qtype: 'basic_recall', objective: 'o', pages: ['d1p1'], difficulty: 'easy', shape: E.AI_FORMS.basic_recall[0], step: 'reverse' }, { slot: 2, qtype: 'sequence', objective: 'o', pages: ['d1p1'], difficulty: 'medium', shape: E.AI_FORMS.sequence[0], step: 'near_order' }, { slot: 3, qtype: 'mechanisms', objective: 'o', pages: ['d1p1'], difficulty: 'medium', shape: E.AI_FORMS.mechanisms[0] }];
const [sys, user] = E.P.generate(slots, pages, st, [], {}, false, []);
assert(/8\. Exam-like/.test(sys), 'the full prompt: the exam-like rule');
assert(/LEVEL: a slot without "step" is written at the level of a real university exam/.test(user) && /ONE STEP DEEPER/.test(user), 'the level, explained');
const legend = (user.match(/^- (\w+): /gm) || []).map((x) => x.slice(2, -2)).sort(); assert.deepStrictEqual(legend, ['near_order', 'reverse', 'reword'], 'exactly the steps used, with reword (reverse falls back on it): ' + legend);
const sj = JSON.parse(user.slice(user.indexOf('SLOTS:\n') + 7, user.indexOf('\nPAGES:\n'))); assert.deepStrictEqual(sj.map((x) => x.step || null), ['reverse', 'near_order', null], 'each slot carries its own step');
const [, userNo] = E.P.generate([slots[2]], pages, st, [], {}, false, []); assert(!/LEVEL:/.test(userNo), 'no step in the batch: no level paragraph');
const [csys, cuser] = E.P.generate(slots, pages, st, [], {}, true, []); const [csys0, cuser0] = E.P.generate(slots.map(({ step, ...x }) => x), pages, st, [], {}, true, []);
assert(!/Exam-like|LEVEL:|"step"/.test(csys + cuser) && csys === csys0 && cuser === cuser0, 'the compact prompt of a small provider is exactly what it was');
console.log('3) prompts: full = the exam-like rule + the level + the steps used (reword with reverse); compact = unchanged, byte for byte');

// 4) the pairs' counting cue
const ctx = { pages: { d1p1: 'The pectoral girdle is formed by the scapula and clavicle.' }, field: 'health', language: 'source', sourceAr: false };
const q = (o, ci, stem = 'Which of the following bones form the pectoral girdle?') => ({ qtype: 'basic_recall', stem, options: o, correct_index: ci, explanation: 'The lecture names the two bones of the girdle in one sentence.', evidence: [{ page: 'd1p1', quote: 'The pectoral girdle is formed by the scapula and clavicle.' }] });
const codes = (x) => E.validateQ(x, ctx).map((i) => i.code);
assert(codes(q(['Scapula and clavicle', 'Scapula and sternum', 'Clavicle and humerus', 'Ribs and pelvis'], 0)).includes('convergence_cue'), 'the key made of the most repeated items: caught');
assert(!codes(q(['Scapula and clavicle', 'Sternum and humerus', 'Scapula and sternum', 'Clavicle and humerus'], 0)).includes('convergence_cue'), 'every item twice: passes');
assert(!codes(q(['Scapula and clavicle.', 'Scapula and sternum.', 'Sternum and clavicle.', 'Humerus and scapula.'], 0)).includes('convergence_cue'), 'the real exam (a tie at the top): passes');
assert(!codes(q(['Posterior and superior to the bladder', 'Anterior and superior to the bladder', 'Posterior and inferior to the bladder', 'Anterior and inferior to the bladder'], 0, 'Where does the uterus lie in the pelvic cavity relative to the bladder?')).includes('convergence_cue'), 'the 2x2 grid of directions: passes');
assert(codes(q(['الكتف والترقوة', 'الكتف والقص', 'الترقوة والعضد', 'الأضلاع والحوض'], 0, 'ما العظمتان اللتان تكوّنان الحزام الصدري؟')).includes('convergence_cue'), 'the same cue in Arabic («و» joined to «ال»): caught');
assert(!codes(q(['وظيفة القلب', 'وريد الرئة', 'وحدة الكلية', 'وتر العضلة'], 0, 'ما الذي يصفه هذا السطر من المحاضرة تحديدًا؟')).includes('convergence_cue'), 'Arabic words that only start with «و»: not pairs');
console.log('4) the pairs\' counting cue: caught (English, Arabic); every item twice, the real exam\'s tie, the 2x2 grid of directions and words starting with «و» pass');

// 4b) the longest option is the key: glaring (a real quiz: 95 characters against 38-50) is written again, merely longer is a remark
const lc = (o) => E.validateQ({ ...q(o, 0, 'Which set of factors is stated as causing sepsis and septic shock in cancer patients?') }, ctx).find((i) => i.code === 'length_cue');
const glaring = lc(['Tumor necrosis, immune deficiency, antineoplastic therapy, malnutrition and comorbid conditions', 'Alopecia, xerostomia, anorexia and pain', 'Apheresis, stem cell return and marrow replacement', 'Hotlines, support groups and crisis intervention']);
assert(glaring && glaring.severity === 'decisive', 'the real quiz\'s glaring longest key: written again');
const longer = lc(['Tumor necrosis, immune deficiency and antineoplastic therapy here', 'Alopecia, xerostomia, anorexia and pain', 'Apheresis and marrow return', 'Hotlines and support groups']);      // (64 / 38 = 1.7)
assert(longer && longer.severity === 'minor', 'merely longer: a remark only (' + (longer && longer.severity) + ')');
assert(!lc(['Tumor necrosis and immune deficiency', 'Alopecia and xerostomia', 'Apheresis and stem cell return', 'Hotlines and support groups']), 'comparable lengths: nothing');
console.log('4b) the longest-answer cue: glaring is written again, merely longer is a remark, comparable lengths pass');

// 4c) a stem never names the lecture: «in / according to the lecture» taken out (the sentence reads the same), anything else left to the writer's rule
const cs = [['Which risk factor for cancer is linked in the lecture to lack of insurance and access to care?', 'Which risk factor for cancer is linked to lack of insurance and access to care?'],
  ['According to the lecture, which phase follows G1?', 'Which phase follows G1?'], ['Which finding is listed in the lecture as a manifestation of bladder neck obstruction?', 'Which finding is listed as a manifestation of bladder neck obstruction?'],
  ['Which statement, according to this lecture, is correct about cachexia?', 'Which statement is correct about cachexia?'], ['بحسب المحاضرة، ما وظيفة الكبد؟', 'ما وظيفة الكبد؟'], ['ما المرض المذكور في المحاضرة الذي يسبب الحمى؟', 'ما المرض المذكور الذي يسبب الحمى؟'],
  ['A nurse checks the source of bleeding from the wound. What is the first action?', null], ['Which lecture hall rule in the lecture notes applies?', null], ['في المحاضرات السابقة ذُكر أن الكبد ينتج الصفراء. ما وظيفته؟', null]];
for (const [a, b] of cs) assert.strictEqual(E.cleanStem(a), b || a, 'cleaned: ' + a);
assert(/Never name the lecture, the slides or the source in the stem/.test(E.P.generate(slots, pages, st, [], {}, false, [])[0]), 'the writer is told so');
console.log('4c) «in / according to the lecture» taken out of a stem (English, Arabic); «the source of bleeding», «lecture notes», «المحاضرات السابقة» left as they are');

// 4d) openings: the real exams open with «Which» about one stem in three (13-49%); a real quiz of ours: 25 of 30. The writer is told the mix, and how many of the
//     stems already written open with «Which» - above one in three, to open its own another way
const ex = (w, n) => Array.from({ length: n }, (_, i) => ({ purpose: 'p' + i, stem: i < w ? 'Which item is listed ' + i + '?' : 'The outermost layer ' + i + ' is:', type: 'basic_recall' }));
const [sysO, many] = E.P.generate([slots[2]], pages, st, ex(4, 6), {}, false, []); const [, few] = E.P.generate([slots[2]], pages, st, ex(2, 6), {}, false, []);
assert(/at most one stem in three opens with «Which»/.test(sysO) && /ends with a colon/.test(sysO), 'the writer is told the real exams\' mix of openings');
assert(/OPENINGS: 4 of the 6 stems above open with «Which» - more than one in three: open yours another way/.test(many), 'four of six: told to open another way');
assert(/OPENINGS: 2 of the 6 stems above open with «Which»\./.test(few), 'two of six: only the count');
assert(!/OPENINGS/.test(E.P.generate([slots[2]], pages, st, ex(4, 6), {}, true, [])[1]), 'the compact prompt: unchanged');
assert(E.WHICH.test('Which of the following?') && E.WHICH.test('أيّ مما يلي صحيح؟') && E.WHICH.test('أي العظام') && !E.WHICH.test('What is it?') && !E.WHICH.test('أين يقع؟'), 'what counts as a «Which» opening');
console.log('4d) openings: the real exams\' mix told; above one «Which» in three the writer is told to open its stems another way; the compact prompt unchanged');

// 5) NOT/EXCEPT asked less
assert(E.CALIB.not_except > 0 && E.CALIB.not_except < 0.6 && Object.keys(E.CALIB).join() === 'not_except', 'only NOT/EXCEPT is weighed down: ' + JSON.stringify(E.CALIB));
console.log('5) NOT/EXCEPT weighed down (x' + E.CALIB.not_except + '); every other type follows its lecture as before');
console.log('calibration ok');
