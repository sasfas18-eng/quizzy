// node claude-edition/test/forms_learning.test.js — THE DEVELOPMENT TRACK: the question forms learn from many quizzes, bounded, and never leave the forms plan.
//  1) the writer's «form» is read back to one of the type's four fixed forms (or «cannot tell»)
//  2) learning: first attempts only add up per type x form x density; a cell stops at FL.MAX (settled - no later quiz moves it)
//  3) guidance: an untried form sits in the middle, a form that works costs less than one that fails, never more than FL.W; a reminder only from the
//     fixed catalogue, only for a recurring failure
//  4) the forms plan holds with ANY profile: inside a section the four forms still rotate (a «bad» form is not dropped), only fixed forms are offered;
//     across sections a form that fails is offered less than one that works
//  5) progress / ready: a cell is learned at FL.READY, unfit when refused three times and never passed; ready only when every reachable cell is
//  6) exploration: the cells that learned least, the four fixed forms only, spread over the sections, never the same objective and type twice
//  7) generate(): the outcomes are FIRST attempts of planned slots (a retry, a reinforcement slot and a failure of the checking service are not
//     recorded); a slot written in another form or type is «unfit» for the suggested one; each failure is filed by the check that failed it
//  8) no drift: hundreds of random quizzes later every cell is within FL.MAX, every form offered is one of the fixed four and every reminder a fixed one
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const { FL, AI_FORMS, FORM_TIPS, ORDER } = E;
const TIPS = new Set(Object.values(FORM_TIPS));
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

(async () => {
  // 1) reading the writer's form back
  for (const t of ORDER) AI_FORMS[t].forEach((f, i) => { assert.strictEqual(E.formIndex(t, f), i, `${t} ${i}: full text`); assert.strictEqual(E.formIndex(t, f.split(' (options:')[0]), i, `${t} ${i}: head`); });
  assert.strictEqual(E.formIndex('mechanisms', 'effect → cause'), 1, 'word order breaks the tie between «cause -> effect» and «effect -> cause»');
  assert.strictEqual(E.formIndex('mechanisms', 'cause → effect'), 0);
  assert.strictEqual(E.formIndex('critical_thinking', 'Prediction'), 1);
  assert.strictEqual(E.formIndex('basic_recall', 'something else entirely'), -1, 'an unknown form: cannot tell');
  assert.strictEqual(E.formIndex('nope', 'term from its meaning'), -1);
  console.log('1) every fixed form is read back to itself; an unknown one is «cannot tell»');

  // 2) learning, bounded
  const p = E.learnForms(null, [{ type: 'basic_recall', form: 0, ok: true, fams: [] }, { type: 'basic_recall', form: 0, ok: false, fams: ['giveaway'] }, { type: 'nope', form: 0, ok: true }, { type: 'sequence', form: 9, ok: true }], 'heavy');
  assert.deepStrictEqual(p.cells['basic_recall|0|heavy'], { n: 2, ok: 1, f: { giveaway: 1 } }); assert.strictEqual(Object.keys(p.cells).length, 1, 'unknown types and forms are ignored'); assert.strictEqual(p.quizzes, 1);
  E.learnForms(p, [{ type: 'basic_recall', form: 0, ok: true }], 'enormous'); assert.strictEqual(p.cells['basic_recall|0|heavy'].n, 2, 'an unknown density is ignored');
  for (let i = 0; i < 100; i++) E.learnForms(p, [{ type: 'understanding', form: 2, ok: i % 3 === 0, fams: ['ambiguous'] }], 'light');
  const c = p.cells['understanding|2|light']; assert.strictEqual(c.n, FL.MAX, 'a cell stops at FL.MAX'); assert.strictEqual(c.ok, 10); assert.strictEqual(c.f.ambiguous, 20);
  const before = JSON.stringify(c); E.learnForms(p, [{ type: 'understanding', form: 2, ok: false, fams: ['giveaway'] }], 'light'); assert.strictEqual(JSON.stringify(p.cells['understanding|2|light']), before, 'a settled cell no longer moves');
  const m = E.mergeProfiles({ cells: { 'mechanisms|1|medium': { n: 20, ok: 18, f: { repeat: 2 } } } }, { cells: { 'mechanisms|1|medium': { n: 20, ok: 2, f: { unfit: 18 } } } }, null);
  assert.deepStrictEqual(m.cells['mechanisms|1|medium'], { n: FL.MAX, ok: 15, f: { repeat: 2, unfit: 14 } }, 'two profiles add up, scaled back to FL.MAX');
  console.log('2) first attempts add up per type x form x density; a cell settles at', FL.MAX);

  // 3) guidance
  const prof = { cells: { 'scenarios|0|heavy': { n: 12, ok: 11, f: { repeat: 1 } }, 'scenarios|1|heavy': { n: 12, ok: 1, f: { unfit: 6, ambiguous: 5 } }, 'scenarios|2|heavy': { n: 12, ok: 6, f: { giveaway: 5, format: 1 } },
    'scenarios|3|light': { n: 6, ok: 0, f: { unfit: 6 } } } };
  const g = E.formGuide(prof, 'heavy');
  assert(Math.abs(g.cost('basic_recall', 0) - FL.W / 2) < 1e-9, 'an untried form sits in the middle');
  assert(g.cost('scenarios', 0) < g.cost('scenarios', 2) && g.cost('scenarios', 2) < g.cost('scenarios', 1), 'a form that works costs less than one that fails');
  for (const t of ORDER) for (let i = 0; i < 4; i++) for (const d of FL.DENS) { const x = E.formGuide(prof, d).cost(t, i); assert(x >= 0 && x <= FL.W, 'cost within [0, FL.W]'); }
  assert(E.formGuide(prof, 'medium').cost('scenarios', 1) > E.formGuide(prof, 'medium').cost('scenarios', 0), 'a density with no data of its own borrows from the others');
  assert.strictEqual(g.tip('scenarios', 2), FORM_TIPS.giveaway, 'a recurring failure brings its fixed reminder');
  assert.strictEqual(g.tip('scenarios', 0), null, 'one failure in twelve: no reminder'); assert.strictEqual(g.tip('scenarios', 1), FORM_TIPS.ambiguous, '«unfit» has no reminder: the next recurring failure does');
  assert.strictEqual(g.tip('basic_recall', 0), null);
  console.log('3) guidance: cost', ['0', '1', '2', '3'].map((i) => g.cost('scenarios', +i).toFixed(2)).join(' / '), '- reminder for form 3:', JSON.stringify(g.tip('scenarios', 2).slice(0, 40) + '…'));

  // 4) the forms plan holds with any profile
  const sec = (k, n, type) => Array.from({ length: n }, (_, j) => ({ qtype: type, objective_id: 'o' + k, objective: 'Section ' + k, section_key: 'S' + k, section_label: 'Section ' + k, pages: ['d1p' + (k + 1)], slot: k * 10 + j }));
  const harsh = { cells: Object.fromEntries([0, 1, 2, 3].map((i) => ['understanding|' + i + '|heavy', i === 3 ? { n: 30, ok: 0, f: { unfit: 30 } } : { n: 30, ok: 30, f: {} }])) };
  const one = E.assignForms(sec(1, 4, 'understanding'), null, E.formGuide(harsh, 'heavy'));
  assert.strictEqual(new Set(one.map((s) => s.shape)).size, 4, 'four slots of one type in one section still get the four forms - a form that fails is never dropped');
  const many = E.assignForms(Array.from({ length: 12 }, (_, k) => sec(k, 1, 'understanding')[0]), null, E.formGuide(harsh, 'heavy')); const used = {}; many.forEach((s) => { used[s.shape] = (used[s.shape] || 0) + 1; });
  assert((used[AI_FORMS.understanding[3]] || 0) < (used[AI_FORMS.understanding[0]] || 0), 'across sections the failing form is offered less: ' + JSON.stringify(Object.values(used)));
  assert((used[AI_FORMS.understanding[3]] || 0) >= 1, 'but it is still offered (bounded weight)');
  const plain = E.assignForms(Array.from({ length: 12 }, (_, k) => sec(k, 1, 'understanding')[0]), null, null); const pu = {}; plain.forEach((s) => { pu[s.shape] = (pu[s.shape] || 0) + 1; });
  assert.deepStrictEqual(Object.values(pu), [3, 3, 3, 3], 'without a profile: the plain rotation'); assert(plain.every((s) => !s.form_tip));
  const tipped = E.assignForms(sec(2, 4, 'scenarios'), null, E.formGuide(prof, 'heavy')); assert(tipped.some((s) => s.form_tip === FORM_TIPS.giveaway), 'the slot given the failing form carries its reminder');
  tipped.forEach((s) => { assert(AI_FORMS.scenarios.includes(s.shape)); if (s.form_tip) assert(TIPS.has(s.form_tip)); });
  console.log('4) the plan holds: one section keeps its four forms; across 12 sections the failing form', used[AI_FORMS.understanding[3]], 'x, a working one', used[AI_FORMS.understanding[0]], 'x');

  // 5) progress and ready: ALL TEN TYPES, every one tried - nine learned types are not «ready»
  const pr = { cells: {} }; let st = E.formsProgress(pr, ['heavy']); assert.strictEqual(st.need, 40, 'ten types x four forms'); assert.strictEqual(st.pct, 0); assert(!st.ready);
  assert.strictEqual(E.formsProgress(pr).need, 120, 'and three densities: 120 cells');
  for (let i = 0; i < 4; i++) E.learnForms(pr, ORDER.filter((t) => t !== 'sequence').flatMap((t) => [0, 1, 2, 3].map((f) => ({ type: t, form: f, ok: f !== 2, fams: ['repeat'] }))), 'heavy');
  st = E.formsProgress(pr, ['heavy']); assert.strictEqual(st.pct, 90); assert(!st.ready, 'nine of the ten types learned: not ready');
  for (let i = 0; i < 4; i++) E.learnForms(pr, [0, 1, 2].map((f) => ({ type: 'sequence', form: f, ok: true })), 'heavy');
  for (let i = 0; i < 3; i++) E.learnForms(pr, [{ type: 'sequence', form: 3, ok: false, fams: ['unfit'] }], 'heavy');
  st = E.formsProgress(pr, ['heavy']); assert.strictEqual(st.cells.find((x) => x.type === 'sequence' && x.form === 3).status, 'unfit', 'refused three times by Claude, never written: unfit - settled by trying, not skipped');
  assert(st.ready && st.pct === 100, 'ready when every one of the 40 cells is learned or unfit'); assert(!E.formsProgress(pr).ready, 'the other densities still to learn');
  console.log('5) progress counts all ten types x four forms per density; ready only when every one is learned or proven unfit');

  // 6) exploration
  const pool = Array.from({ length: 6 }, (_, k) => ({ id: 'o' + k, statement: 'Objective ' + k, pages: ['d1p' + (k + 2)], section: 'S' + (k >> 1), section_label: 'Section ' + (k >> 1), types: { basic_recall: { pages: ['d1p' + (k + 2)] }, understanding: { pages: ['d1p' + (k + 2)] }, ...(k % 2 ? { not_except: {} } : {}) } }));
  const ex = E.exploreSlots(pool, { cells: { 'basic_recall|0|medium': { n: 4, ok: 4, f: {} } } }, 'medium', 12);
  assert(ex.length && ex.length <= 12); ex.forEach((s) => { assert(AI_FORMS[s.qtype].includes(s.shape), 'a fixed form'); assert(pool.find((o) => o.id === s.objective_id).types[s.qtype], 'a type its objective supports'); assert(!s.forced); });
  assert(!ex.some((s) => s.qtype === 'basic_recall' && s.shape === AI_FORMS.basic_recall[0]), 'a learned cell is not explored again');
  assert(!ex.some((s) => s.qtype === 'sequence'), 'a type the lecture does not support is not asked here while another lecture of its density may');
  const perSec = {}; ex.forEach((s) => { perSec[s.section_key] = (perSec[s.section_key] || 0) + 1; }); assert(Math.max(...Object.values(perSec)) <= 4 && Object.keys(perSec).length === 3, 'spread over the sections: ' + JSON.stringify(perSec));
  assert.strictEqual(new Set(ex.map((s) => s.objective_id + s.qtype)).size, ex.length, 'never the same objective and type twice in one step');
  assert(ex.findIndex((s) => s.shape === AI_FORMS.understanding[0]) < ex.findIndex((s) => s.shape === AI_FORMS.understanding[1]), 'form 1 of every type before form 2');
  const fx = E.exploreSlots(pool, { cells: {} }, 'light', 30, { force: ['sequence', 'scenarios'] });
  ['sequence', 'scenarios'].forEach((t) => { const f = fx.filter((s) => s.qtype === t); assert(f.length >= 1 && f.every((s) => s.forced && AI_FORMS[t].includes(s.shape)), t + ': no lecture of this density supports it - tried anyway, marked forced'); });
  const settled = { cells: Object.fromEntries([0, 1, 2, 3].map((i) => ['sequence|' + i + '|light', { n: 3, ok: 0, f: { unfit: 3 } }])) };
  assert(!E.exploreSlots(pool, settled, 'light', 30, { force: ['sequence'] }).some((s) => s.qtype === 'sequence'), 'refused three times: settled, not asked again');
  console.log('6) exploration:', ex.length, 'slots over', Object.keys(perSec).length, 'sections, fixed forms only; a type no lecture supports is tried (forced) until Claude settles it');

  // 7) generate(): first attempts, filed by what failed them
  const pagesList = [{ ref: 'd1p1', text: 'Cardiac output equals heart rate multiplied by stroke volume in every resting adult heart.\nThe sinoatrial node starts each normal heartbeat in the right atrium.\nAtrial systole completes ventricular filling before the ventricles contract.' },
    { ref: 'd1p2', text: 'The first heart sound is caused by closure of the atrioventricular valves.\nThe second heart sound is caused by closure of the semilunar valves.\nPreload is the degree of stretch of the ventricular muscle before contraction.' }];
  const slot = (n, type, form, extra) => ({ slot: n, qtype: type, objective_id: 'o' + n, objective: 'Heart', pages: [n % 2 ? 'd1p1' : 'd1p2'], section_key: 'S' + n, shape: AI_FORMS[type][form], difficulty: 'easy', ...(extra ? { extra: true, variant: 2, angle: 'reverse' } : {}) });
  const slots = [slot(1, 'basic_recall', 0), slot(2, 'basic_recall', 1), slot(3, 'understanding', 0), slot(4, 'mechanisms', 2), slot(5, 'basic_recall', 2), slot(6, 'understanding', 3, true), slot(7, 'basic_recall', 3), slot(8, 'mechanisms', 0)];
  const Q = { 1: { stem: 'Which value equals heart rate multiplied by stroke volume in a resting adult?', opts: ['Cardiac output', 'Preload', 'Afterload', 'Ejection fraction'], q: 'Cardiac output equals heart rate multiplied by stroke volume in every resting adult heart.', p: 'd1p1' },
    2: { stem: 'What is caused by closure of the atrioventricular valves?', opts: ['The first heart sound', 'The second heart sound', 'The third heart sound', 'The fourth heart sound'], q: 'The first heart sound is caused by closure of the atrioventricular valves.', p: 'd1p2', form: AI_FORMS.basic_recall[0] },
    3: { stem: 'Which structure starts each normal heartbeat?', opts: ['The sinoatrial node', 'The atrioventricular node', 'The bundle of His', 'The Purkinje fibres'], q: 'The sinoatrial node starts each normal heartbeat in the right atrium.', p: 'd1p1', type: 'basic_recall' },
    4: { stem: 'What is the purpose of atrial systole?', opts: ['To complete ventricular filling', 'To close the semilunar valves', 'To start each heartbeat', 'To stretch the ventricular wall'], q: 'Atrial systole completes ventricular filling before the ventricles contract.', p: 'd1p1' },
    5: null,
    6: { stem: 'What does preload describe before contraction?', opts: ['The stretch of the ventricular muscle', 'The closure of the valves', 'The heart rate', 'The stroke volume'], q: 'Preload is the degree of stretch of the ventricular muscle before contraction.', p: 'd1p2' },
    7: { stem: 'Which second heart sound is caused by closure of the semilunar valves?', opts: ['The second heart sound', 'The first heart sound', 'The semilunar sound', 'The atrial sound'], q: 'The second heart sound is caused by closure of the semilunar valves.', p: 'd1p2' },
    8: { stem: 'What is the degree of stretch of the ventricular muscle before contraction called?', opts: ['Preload', 'Afterload', 'Contractility', 'Compliance'], q: 'Preload is the degree of stretch of the ventricular muscle before contraction.', p: 'd1p2' } };
  let verifyCalls = 0; const llm = { async json(task, sys, prompt) {
    if (task === 'generate') { const sl = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); return { questions: sl.map((s) => { const x = Q[s.slot]; if (!x) return { slot: s.slot, unwritable_reason: 'nothing to ask' };
      return { slot: s.slot, unwritable_reason: null, stem: x.stem, options: x.opts, correct_index: 0, explanation: 'The lecture states it in these words, and the other options name different things.', purpose: 'p' + s.slot, type: x.type || s.type, form: x.form || s.shape, evidence: [{ page: x.p, quote: x.q }], uses_external: false }; }) }; }
    if (task === 'verify') { verifyCalls++; const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 12, prompt.indexOf('\nReturn JSON')));      // q4: the reviewer returns nothing for it (its checking failed)
      return { results: qs.filter((q) => q.id !== 'q4').map((q) => ({ id: q.id, chosen_index: q.id === 'q8' ? 1 : 0, answerable_from_source: true, single_best_answer: q.id !== 'q8', sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none', weak_options: [] })) }; }
    if (task === 'verify_explanation') return { results: [] };
    throw new Error('unexpected ' + task); }, scale: () => 1 };
  const res = await E.generate(llm, { slots, requested: 8 }, pagesList, { field: 'health', language: 'source', difficulty: 'easy' }, () => {}, { concurrency: 8 });
  const out = Object.fromEntries(res.outcomes.map((o) => [o.type + '|' + o.form, o]));
  assert(out['basic_recall|0'] && out['basic_recall|0'].ok, 'written as suggested and passed: ok');
  assert.deepStrictEqual(out['basic_recall|1'] && out['basic_recall|1'].fams, ['unfit'], 'written in another form of the type: unfit for the suggested one');
  assert.deepStrictEqual(out['understanding|0'] && out['understanding|0'].fams, ['unfit'], 'written as another type: unfit');
  assert.deepStrictEqual(out['basic_recall|2'] && out['basic_recall|2'].fams, ['unfit'], 'refused: unfit');
  assert(!res.outcomes.some((o) => o.type === 'understanding' && o.form === 3), 'a reinforcement slot is not recorded (its angle steers the form)');
  assert.deepStrictEqual(out['basic_recall|3'] && out['basic_recall|3'].fams, ['giveaway'], 'the stem names its key: filed as a give-away');
  assert.deepStrictEqual(out['mechanisms|0'] && out['mechanisms|0'].fams, ['ambiguous'], 'the blind solver chose another option: filed as ambiguous');
  assert(!out['mechanisms|2'], 'the checking itself failed (no verdict): says nothing about the form - not recorded');
  assert.strictEqual(res.outcomes.length, new Set(res.outcomes.map((o) => o.type + '|' + o.form)).size, 'one outcome per slot - the retry round adds none');
  console.log('7) generate():', res.outcomes.map((o) => `${o.type}#${o.form + 1}=${o.ok ? 'ok' : o.fams.join('+')}`).join(' '), '| accepted', res.accepted.length);

  // 8) no drift: hundreds of random quizzes
  const fams = ['giveaway', 'options_same', 'options_meta', 'options_weak', 'ambiguous', 'evidence', 'negation', 'order', 'repeat', 'format', 'unfit'];
  const big = { cells: {} };
  for (let q = 0; q < 400; q++) { const dens = FL.DENS[q % 3]; const outs = Array.from({ length: 20 }, () => { const t = ORDER[Math.floor(rnd() * 10)], f = Math.floor(rnd() * 4); return { type: t, form: f, ok: rnd() < 0.3 + 0.15 * f, fams: [fams[Math.floor(rnd() * fams.length)]] }; }); E.learnForms(big, outs, dens);
    if (q % 50 === 0) { const sl = Array.from({ length: 30 }, (_, k) => ({ qtype: ORDER[k % 10], objective_id: 'o' + (k % 7), objective: 'S' + (k % 7), section_key: 'S' + (k % 7), pages: ['d1p1'], slot: k + 1 }));
      E.assignForms(sl, null, E.formGuide(big, dens)); sl.forEach((s) => { assert(AI_FORMS[s.qtype].includes(s.shape), 'only the fixed forms'); if (s.form_tip) assert(TIPS.has(s.form_tip), 'only the fixed reminders'); }); } }
  Object.values(big.cells).forEach((x) => { assert(x.n <= FL.MAX && x.ok <= x.n, 'bounded'); });
  assert.strictEqual(Object.keys(big.cells).length, 120, 'ten types x four forms x three densities - nothing else');
  assert(E.formsProgress(big).ready, 'and the track is ready');
  console.log('8) 400 random quizzes: 120 cells, each within', FL.MAX, '- fixed forms and reminders only');
  console.log('forms learning ok');
})().catch((e) => { console.error(e); process.exit(1); });
