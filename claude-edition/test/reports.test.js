// node claude-edition/test/reports.test.js — the composer handles the students' reports (there is no self-learning agent any more):
// a reported question is never written again; a report that the answer / the source / the options are wrong keeps that form off that fact; the reported form is
// weighed down in the next quizzes; a repeated report counts once; the count is always kept; nothing changes without reports; and the reports survive a reload.
const mem = {}; global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } };
require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules, C = R.composer; const assert = require('assert');
const mk = (arr) => arr.map((t, i) => ({ ref: 'd1p' + (i + 1), text: t, doc_id: 'd', page_no: i + 1 }));
const src = require('fs').readFileSync(__dirname + '/types.test.js', 'utf8'); const lit = src.slice(src.indexOf('const S = mk([') + 'const S = mk('.length, src.indexOf(']);', src.indexOf('const S = mk([')) + 1);
const pages = mk(eval(lit)); const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
const gen = async (n) => (await R.generate(E.buildPlan(R.analyse(pages), st(n), E.support(pages.map((p) => p.text), 'health')), pages, st(n), () => {})).accepted;
const key = (c) => c.options[c.correct_index]; const n = (t) => E.norm(String(t).replace(/^(مراجعة|Review): /, '')); const sig = (c) => n(c.stem) + '|' + n(key(c));
const asReport = (c, kind) => ({ form: c.form, stem: c.stem, key: key(c), kind });
(async () => {
  assert(!R.learn, 'the self-learning agent is gone');
  // 0) without reports: the same lecture gives the same quiz
  const base = await gen(30); assert.strictEqual(base.length, 30); assert.deepStrictEqual((await gen(30)).map(sig), base.map(sig), 'deterministic without reports');
  // 1) an unclear question: never written again (its fact may still be asked, in another way)
  const a = base[3]; const r1 = C.report(asReport(a, 'unclear')); assert(r1.handled && r1.never_again && !r1.fact_blocked, JSON.stringify(r1));
  let q = await gen(30); assert.strictEqual(q.length, 30, 'the count is kept'); assert(!q.some((c) => sig(c) === sig(a)), 'the reported question does not come back');
  console.log(`1) «unclear» on a ${a.form} question: not written again; 30 questions`);
  // 2) a wrong answer: the same form never asks that fact again
  const b = q.find((c) => c.form && c.form !== a.form && !/^(Review|مراجعة)/.test(c.stem)); const r2 = C.report(asReport(b, 'wrong_key')); assert(r2.fact_blocked, 'the fact is kept off for that form');
  q = await gen(30); assert.strictEqual(q.length, 30); assert(!q.some((c) => c.form === b.form && n(key(c)) === n(key(b))), 'no ' + b.form + ' on the same fact');
  assert(!q.some((c) => sig(c) === sig(a) || sig(c) === sig(b)), 'neither reported question');
  console.log(`2) «wrong answer» on a ${b.form} question: that form does not ask "${key(b).slice(0, 40)}" again`);
  // 3) the reported form is weighed down: after reports against one form, it writes fewer questions
  const counts = (qs) => qs.reduce((o, c) => ((o[c.form] = (o[c.form] || 0) + 1), o), {}); const before = counts(base);
  const target = Object.keys(before).sort((x, y) => before[y] - before[x])[0]; const theirs = q.filter((c) => c.form === target).slice(0, 4);
  theirs.forEach((c) => C.report(asReport(c, 'bad_distractor'))); const pen = C.reports().forms.find((f) => f.form === target).penalty; assert(pen > 0 && pen <= 0.3, 'penalty in (0, 0.3]: ' + pen);
  const after = counts(await gen(30)); console.log(`3) ${theirs.length} reports against ${target} (penalty ${pen}): ${before[target]} -> ${after[target] || 0} questions of that form in 30`);
  assert((after[target] || 0) < before[target], 'the reported form writes fewer questions');
  // 4) the same report twice counts once
  const t0 = C.reports().total; C.report(asReport(a, 'unclear')); assert.strictEqual(C.reports().total, t0, 'a repeated report counts once');
  // 5) kept on the device: a reload reads them back; reset gives the original quiz again
  const saved = JSON.parse(mem.quizzy_reports_v1); assert.strictEqual(saved.total, t0); C._mem(); assert.strictEqual(C.reports().total, 0);
  delete require.cache[require.resolve('../rules.js')]; require('../rules.js'); assert.strictEqual(window.QZE.rules.composer.reports().total, t0, 'read back after a reload');
  window.QZE.rules.composer.resetReports(); assert.strictEqual(window.QZE.rules.composer.reports().total, 0);
  const again = await window.QZE.rules.generate(E.buildPlan(window.QZE.rules.analyse(pages), st(30), E.support(pages.map((p) => p.text), 'health')), pages, st(30), () => {});
  assert.deepStrictEqual(again.accepted.map(sig), base.map(sig), 'after a reset: the original quiz');
  console.log('4) a repeated report counts once; 5) kept on the device, read back after a reload, reset restores the original quiz');
  console.log('reports tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
