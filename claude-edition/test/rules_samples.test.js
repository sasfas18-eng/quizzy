// node claude-edition/test/rules_samples.test.js — the no-token mode on realistic slide/note styles (the "تعذر استخراج أهداف" regression).
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert'); const samples = require('./samples/pages.json');
const MIN = { slides_en: [5, 5], notes_en: [3, 3], slides_ar: [4, 4], dense_en: [1, 1] };   // [min objectives, min delivered questions]
const JUNK = /Objectives|Lecture 3|"Result"|المحاضرة الثالثة/;
(async () => {
  for (const [name, texts] of Object.entries(samples)) {
    const pages = texts.map((t, i) => ({ ref: `d1p${i + 1}`, text: t })); const byRef = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
    const a = R.analyse(pages); assert(a.objectives.length >= MIN[name][0], `${name}: objectives ${a.objectives.length}`);
    const st = { count: 20, focus: 'balanced', field: 'science', difficulty: 'mixed' }; const plan = E.buildPlan(a, st, E.support(pages.map((p) => p.text), 'science'));
    const r = await R.generate(plan, pages, st, () => {}); assert(r.accepted.length >= MIN[name][1], `${name}: delivered ${r.accepted.length} of ${plan.feasible_count}`);
    for (const c of r.accepted) {
      assert.strictEqual(c.options.length, 4); assert.strictEqual(new Set(c.options.map(E.norm)).size, 4, 'distinct options'); assert(!JUNK.test(c.stem + ' ' + c.options.join(' ')), `${name}: junk in "${c.stem.slice(0, 70)}"`);
      c.evidence.forEach((e) => assert(E.quoteIn(e.quote, byRef[e.page]), `${name}: evidence not verbatim: ${e.quote.slice(0, 60)}`));
      if (c.qtype === 'basic_recall' && /____/.test(c.stem)) { const ans = c.options[c.correct_index]; assert(!c.stem.toLowerCase().replace('____', '').includes(ans.toLowerCase()), `${name}: answer given away in the stem: ${c.stem}`); }
    }
    const d = R.diagnose(pages); assert(d.pages === pages.length && d.words > 20);
    console.log(name.padEnd(10), 'objectives', a.objectives.length, 'planned', plan.feasible_count, 'delivered', r.accepted.length, [...new Set(r.accepted.map((c) => c.qtype))].join(','));
  }
  // nothing usable -> zero objectives with a useful diagnosis (the UI turns this into an explanation, not a bare error)
  const empty = [{ ref: 'd1p1', text: 'Figure 1\n\n3.2' }]; assert.strictEqual(R.analyse(empty).objectives.length, 0); assert.strictEqual(R.diagnose(empty).defs, 0);
  console.log('rules sample tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
