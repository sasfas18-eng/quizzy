// node claude-edition/test/learner.test.js — the self-learning agent of the local generator (rules.js LEARN): it learns from students' answers which question
// shapes measure understanding (difficulty near 60 %, students who do well elsewhere get them right, no reports) and which kinds of wrong option students fall for,
// and then the generator uses what it learned. Nothing changes before it has seen enough answers; what it learned survives a reload.
const mem = {}; global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } };
require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules, L = R.learn; const assert = require('assert');
const texts = require('./samples/pages.json').lecture_en; const pages = texts.map((t, i) => ({ ref: `d1p${i + 1}`, text: t, doc_id: 'd', page_no: i + 1 }));
const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
const q4 = (form, key, wrong) => ({ form, options: [key, ...wrong], correct_index: 0 });
L.reset();

// 1) before MIN_ANSWERS nothing moves: the forms keep their order, the wrong options theirs
const base = ['caseEffect', 'caseExample', 'caseLead', 'scenario'];
for (let i = 0; i < 29; i++) L.observe(q4('scenario', 'a', ['b', 'c', 'd']), i % 2 ? 0 : 1);
assert.deepStrictEqual(L.rank(base), base, 'no reordering before 30 answers');
assert.deepStrictEqual(L.orderWrong('Heart rate increases', ['x y z', 'Heart rate decreases']), ['x y z', 'Heart rate decreases'], 'no reordering of wrong options before 30 answers');
assert.strictEqual(L.stats().ready, false); console.log('1) before 30 answers: forms and options keep their order');

// 2) evidence reorders the forms: too easy (everyone right) and reported forms sink, a form at ~60 % right rises
L.reset();
for (let i = 0; i < 40; i++) { L.observe(q4('caseEffect', 'a', ['b', 'c', 'd']), 0); L.observe(q4('scenario', 'a', ['b', 'c', 'd']), i % 5 < 3 ? 0 : 1); L.observe(q4('caseExample', 'a', ['b', 'c', 'd']), i % 5 < 3 ? 0 : 2); }
for (let i = 0; i < 6; i++) L.report('caseExample');
const r2 = L.rank(base); console.log('2) learned order:', r2.join(' > '), JSON.stringify(L.stats().forms.filter((f) => f.answered).map((f) => [f.form, f.score])));
assert.strictEqual(r2[0], 'scenario', 'the form students get right about 60 % of the time comes first');
assert(r2.indexOf('caseExample') > r2.indexOf('caseEffect'), 'a reported form ranks below an easy one');
assert(L.score('caseEffect') < L.score('scenario'), 'a form everyone gets right scores lower than one that separates');

// 3) discrimination: a form the strong students MISS (negative D) sinks below one they get right, even at the same difficulty
L.reset();
for (let i = 0; i < 40; i++) { L.observe(q4('caseLead', 'a', ['b', 'c', 'd']), i % 2 ? 0 : 1); L.observe(q4('caseEffect', 'a', ['b', 'c', 'd']), i % 2 ? 0 : 1); }
for (let i = 0; i < 12; i++) { L.discriminate('caseLead', true, 0.9); L.discriminate('caseLead', false, 0.2); L.discriminate('caseEffect', false, 0.9); L.discriminate('caseEffect', true, 0.2); }
const s3 = L.stats().forms; const D = (f) => s3.find((x) => x.form === f).disc; console.log('3) discrimination: caseLead D=' + D('caseLead') + ', caseEffect D=' + D('caseEffect'));
assert(D('caseLead') > 0.5 && D('caseEffect') < -0.5, 'D measured from the upper and lower groups'); assert(L.rank(base).indexOf('caseLead') < L.rank(base).indexOf('caseEffect'), 'the discriminating form ranks first');

// 4) wrong options: the kinds students actually fall for come first
L.reset(); const key = 'Heart rate increases during exercise';
assert.strictEqual(L.kindOf(key, 'Heart rate decreases during exercise'), 'flip'); assert.strictEqual(L.kindOf(key, 'Saliva production'), 'sibling');
for (let i = 0; i < 40; i++) L.observe({ form: 'statement', options: [key, 'Heart rate decreases during exercise', 'Saliva production', 'Pupils constrict'], correct_index: 0 }, i % 3 ? 1 : 0);
const ord = L.orderWrong(key, ['Bronchi constrict', 'Heart rate decreases during exercise']); console.log('4) lure rates:', JSON.stringify(L.stats().muts.map((m) => [m.kind, m.lure])), '-> first wrong option:', ord[0]);
assert.strictEqual(ord[0], 'Heart rate decreases during exercise', 'the flipped statement students fall for is offered first');

// 5) it persists: the state is in localStorage and a fresh load reads it back
const saved = JSON.parse(mem.quizzy_learner_v1); assert.strictEqual(saved.answers, 40, 'saved on every answer'); L._mem(); assert.strictEqual(L.stats().answers, 0);
assert(L.import(saved)); assert.strictEqual(L.stats().answers, 40, 'read back'); console.log('5) persisted in localStorage: ' + saved.answers + ' answers');

// 6) the generator uses it: every local question carries its form; after the agent learns that one scenario form works best, more scenario questions use it
const gen = async (n) => (await R.generate(E.buildPlan(R.analyse(pages), st(n), E.support(texts, 'health')), pages, st(n), () => {})).accepted;
(async () => {
  L.reset(); const q0 = await gen(40); assert(q0.length && q0.every((c) => c.form), 'every local question names its form');
  // pick an identity that used at least two forms and teach the agent that its least-used form is the good one and its most-used form is reported
  const types = {}; q0.forEach((c) => { (types[c.qtype] ||= {})[c.form] = (types[c.qtype][c.form] || 0) + 1; });
  const [qt, used] = Object.entries(types).find(([, m]) => Object.keys(m).length >= 2) || []; assert(qt, 'some identity uses two forms: ' + JSON.stringify(types));
  const forms = Object.keys(used).sort((a, b) => used[b] - used[a]); const top = forms[0], low = forms[forms.length - 1];
  for (let i = 0; i < 40; i++) { L.observe(q4(low, 'a', ['b', 'c', 'd']), i % 5 < 3 ? 0 : 1); L.observe(q4(top, 'a', ['b', 'c', 'd']), 0); }
  for (let i = 0; i < 8; i++) L.report(top);
  const q1 = await gen(40); const t1 = {}; q1.filter((c) => c.qtype === qt).forEach((c) => { t1[c.form] = (t1[c.form] || 0) + 1; });
  console.log(`6) ${qt}: before ${JSON.stringify(used)} -> after learning ${JSON.stringify(t1)} (learned: ${low} good, ${top} reported)`);
  assert((t1[low] || 0) > used[low], `the form the agent learned is good is used more (${used[low]} -> ${t1[low] || 0})`); assert((t1[top] || 0) < used[top], `the reported form is used less (${used[top]} -> ${t1[top] || 0})`);
  assert.strictEqual(q1.length, 40, 'the count is unchanged');
  L.reset(); console.log('learner tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
