// node claude-edition/test/section_forms.test.js — several question forms in every section of the lecture (AI path and local path), each form only where the pages carry what it needs.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert'); const samples = require('./samples/pages.json');
(async () => {
  for (const [name, texts] of Object.entries(samples)) {
    const pages = texts.map((t, i) => ({ ref: `d1p${i + 1}`, text: t })); const a = R.analyse(pages); const st = { count: 30, focus: 'balanced', field: 'science', difficulty: 'mixed' };
    const plan = E.buildPlan(a, st, E.support(pages.map((p) => p.text), 'science')); R.composer.guide(plan, pages);
    const extra = E.reinforcementSlots(plan.pool, {}, 6, {}); R.composer.guide({ slots: extra }, pages, plan.slots); const all = plan.slots.concat(extra);
    // 1) inside one section and identity a form comes back only after every other form of that identity was used there (the rotation continues into the extra round)
    const by = {}; all.forEach((s) => { assert(s.shape && s.section !== undefined, `${name}: slot without a form/section`); (by[s.objective_id + '|' + s.qtype] ||= []).push(s.shape); });
    for (const k in by) { const f = by[k], n = new Set(f).size, forms = (R.composer.formsFor ? null : null); const max = Math.max(...Object.values(f.reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {}))); const min = Math.min(...[...new Set(f)].map((x) => f.filter((y) => y === x).length));
      assert(max - min <= 1, `${name}: ${k} repeats a form before using the others: ${f.join(' / ')}`); if (f.length >= 2) assert(n >= 2, `${name}: ${k} one form for the whole section`); }
    // 2) a form that needs something the pages do not carry is not chosen while another fits
    const txt = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
    all.filter((s) => s.shape === 'what an abbreviation stands for').forEach((s) => { const t = s.pages.map((r) => txt[r]).join('\n'); assert(/\b[A-Z]{2,6}\b/.test(t), `${name}: abbreviation form on pages without one`); });
    // 3) the local generator (a real-sized lecture; a three-sentence note may allow one form only): a section's questions do not all share one form
    const r = await R.generate(plan, pages, st, () => {}); const loc = {}; r.accepted.forEach((c) => (loc[c.objective_id] ||= []).push(c.form));
    if (name === 'lecture_en') for (const k in loc) if (loc[k].length >= 3) assert(new Set(loc[k]).size >= 2, `${name}: local section ${k} has one form: ${loc[k].join(',')}`);
    console.log(name.padEnd(10), 'sections', Object.keys(by).length, 'slots', all.length, 'local', r.accepted.length);
  }
  console.log('section forms ok');
})().catch((e) => { console.error(e); process.exit(1); });
