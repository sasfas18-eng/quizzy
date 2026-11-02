// node claude-edition/test/semantic.test.js — the composer's OPEN on-device model (every browser) reads MEANING after the questions are written:
// (1) the same fact asked twice in other words -> the later question is dropped and another part of the lecture asked instead (the count is kept);
// (2) a wrong option that means the right answer -> dropped and written again; (3) a deliberate opposite (increased / decreased) is never "the same meaning";
// (4) a model that is still downloading, missing, or on a data-saver connection never holds a quiz up and changes nothing.
// The model is simulated here (bag of word-groups -> unit vectors, deterministic); the real one is run in a real browser by run_web_semantic.js.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules, SM = R.semantic; const assert = require('assert');
const GROUPS = [['lowers', 'reduces', 'decreases'], ['glucose', 'sugar'], ['level', 'amount'], ['carrying', 'transporting'], ['increased', 'decreased']];
const gid = (w) => { const i = GROUPS.findIndex((g) => g.includes(w)); return i >= 0 ? 'g' + i : w; };
const embedOne = (t, D = 64) => { const v = new Array(D).fill(0); E.norm(t).split(' ').filter((w) => w && !E.STOP.has(w)).forEach((w) => { const k = gid(w); let h = 7; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % D] += 1; v[(h >> 7) % D] += 0.5; });
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); };
const fake = (o = {}) => ({ calls: 0, load: async () => { if (o.loadErr) throw new Error(o.loadErr); if (o.loadMs) await new Promise((r) => setTimeout(r, o.loadMs)); return true; }, embed: async function (ts) { this.calls += ts.length; return ts.map((t) => embedOne(t)); }, status: async () => ({ state: 'available' }) });
const q = (stem, options, form = 'defToTerm') => ({ stem, options, correct_index: 0, form, qtype: 'basic_recall', slot: 0, evidence: [] });
(async () => {
  // 1) the operator's «try it now»: the same fact in other words and a twin option are found; the deliberate opposite and the sound question stay
  SM.use(fake()); const d = await SM.demo();
  assert.strictEqual(d.dropped, 2, JSON.stringify(d)); assert.deepStrictEqual(d.examples.map((x) => x.why).sort(), ['same_fact', 'two_right']);
  assert(d.kept.some((s) => /lowers/.test(s)) && d.kept.some((s) => /Sympathetic/.test(s)), 'the first question and the one with a deliberate opposite stay');
  assert(d.sims.same_fact > d.sims.unrelated && d.sims.twin_option > 0.9, JSON.stringify(d.sims));
  console.log('1) try-it-now: same fact in other words + a twin option found; the opposite (increased/decreased) kept;', JSON.stringify(d.sims));
  const arS = { base: [], acc: [q('ما وظيفة خلايا الدم الحمراء؟', ['نقل الأكسجين', 'نقل الأكسجين إلى الأنسجة', 'مكافحة العدوى', 'تخثر الدم']), q('ما وظيفة كريات الدم الحمراء؟', ['نقل الأكسجين', 'الهضم', 'الحركة', 'الإخراج'])], dropped: [] };
  const ar = await SM.review(arS, 5000); assert.strictEqual(ar.checked, 0); assert.strictEqual(arS.acc.length, 2, 'the model reads English: Arabic questions are left as they are');

  // 2) in a real quiz: two questions made to ask the same fact -> one is dropped, another part of the lecture is asked, the count stays
  const mk = (arr) => arr.map((t, i) => ({ ref: 'd1p' + (i + 1), text: t, doc_id: 'd', page_no: i + 1 }));
  const src = require('fs').readFileSync(__dirname + '/types.test.js', 'utf8'); const lit = src.slice(src.indexOf('const S = mk([') + 'const S = mk('.length, src.indexOf(']);', src.indexOf('const S = mk([')) + 1);
  const pages = mk(eval(lit)); const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
  const gen = async (n) => R.generate(E.buildPlan(R.analyse(pages), st(n), E.support(pages.map((p) => p.text), 'health')), pages, st(n), () => {});
  SM.use(null); const plain = await gen(25); assert(!plain.stats.semantic, 'no model, no pass');
  const twinOf = plain.accepted[2], target = plain.accepted[9]; const fa = (c) => (/_{3,}/.test(c.stem) ? c.stem.replace(/^[^:]{0,60}:\s*/, '').replace(/_{3,}/, c.options[c.correct_index]) : c.stem + ' ' + c.options[c.correct_index]);
  const forced = fake(); const base = forced.embed.bind(forced); forced.embed = async (ts) => (await base(ts)).map((v, i) => (ts[i] === fa(target) ? embedOne(fa(twinOf)) : ts[i] === target.options[target.correct_index] ? embedOne(twinOf.options[twinOf.correct_index]) : v));
  SM.use(forced); const r = await gen(25); const s = r.stats.semantic; console.log('2) a quiz with two questions on the same fact:', JSON.stringify({ ...s, examples: undefined }));
  assert.strictEqual(s.state, 'available'); assert(s.same_fact >= 1, 'the later one is found'); assert.strictEqual(r.accepted.length, 25, 'written again: the count stays');
  assert(!r.accepted.some((c) => c.stem === target.stem), 'the duplicate is gone'); assert(r.accepted.some((c) => c.stem === twinOf.stem), 'the first one stays');
  assert(r.dropped.some((x) => /النموذج المفتوح/.test((x.reasons || [])[0] || '')), 'the reason is recorded');

  // 3) an ordinary quiz with a sound model: nothing is dropped for nothing (opposite lures, sibling items, pairings are not "the same meaning")
  SM.use(fake()); const ok = await gen(25); console.log('3) an ordinary quiz:', JSON.stringify({ ...ok.stats.semantic, examples: undefined }));
  assert.strictEqual(ok.accepted.length, 25); assert.strictEqual(ok.stats.semantic.checked, 25, 'every question checked once'); assert.strictEqual(ok.stats.semantic.dropped, 0, 'nothing dropped for nothing');

  // 4) still downloading (slower than the budget), missing files, a data-saver connection: no waiting past the budget, nothing changes
  SM.use(fake({ loadMs: 60000 })); const t0 = Date.now(); const slow = await gen(15); const ms = Date.now() - t0; assert.strictEqual(slow.stats.semantic.state, 'loading'); assert(ms < 12000, 'not held up: ' + ms); assert.strictEqual(slow.accepted.length, 15);
  SM.use(fake({ loadErr: 'missing' })); assert.strictEqual((await gen(10)).stats.semantic.state, 'missing');
  SM.use(fake({ loadErr: 'save-data' })); assert.strictEqual((await gen(10)).stats.semantic.state, 'save_data');
  console.log(`4) downloading: quiz delivered in ${ms} ms without it; missing files / data saver: nothing changes`); SM.use(null);
  console.log('semantic tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
