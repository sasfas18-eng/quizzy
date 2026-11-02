// node claude-edition/test/composer.test.js — the COMPOSER: the agent that improves questions WHILE they are generated (rules.js COMPOSER).
// For every slot it tries every form of the identity, keeps the candidates that pass the checks, prefers deeper reasoning and better wrong options, and does not let one form
// (or one stem opening) repeat; it recognises the material for deep thinking (states and findings, phases, two groups, checkable claims) and writes scenario and
// critical-thinking questions that make the student infer, predict and evaluate - and it guides the AI path the same way (a shape per slot, the deep material).
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules, C = R.composer; const assert = require('assert'); const fs = require('fs');
const mk = (arr) => arr.map((t, i) => ({ ref: 'd1p' + (i + 1), text: t, doc_id: 'd', page_no: i + 1 }));
// the synthetic lecture of types.test.js section 8 (two opposite effect lists, phases, groups with examples, glosses, ranges, hedged statements) - one source for both tests
const src = fs.readFileSync(__dirname + '/types.test.js', 'utf8'); const lit = src.slice(src.indexOf('const S = mk([') + 'const S = mk('.length, src.indexOf(']);', src.indexOf('const S = mk([')) + 1);
const pages = mk(eval(lit)); const texts = pages.map((p) => p.text); const byRef = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
const gen = async (n) => (await R.generate(E.buildPlan(R.analyse(pages), st(n), E.support(texts, 'health')), pages, st(n), () => {})).accepted;
const inLecture = (t) => texts.some((x) => E.norm(x).includes(E.norm(t)));
(async () => {
  // 1) it recognises the material for deep thinking
  const D = C.deep(R.mine(pages)); console.log(`1) deep material: ${D.states.length} states with findings, ${D.groups.length} families with features, ${D.pairs.length} pairs (${D.pairs.filter((p) => p.kind === 'state').length} opposite states), ${D.claims.length} checkable claims`);
  assert(D.states.length >= 2 && D.pairs.some((p) => p.kind === 'state') && D.groups.length >= 1 && D.claims.length >= 3, 'states, opposite states, phases and claims are recognised');

  // 2) a 60-question quiz: every question sound, scenario / critical questions only from reasoning forms, deep forms present, no form repeated beyond its share
  const t0 = Date.now(); const qs = await gen(60); const ms = Date.now() - t0; assert.strictEqual(qs.length, 60);
  qs.forEach((c) => { assert.strictEqual(new Set(c.options.map(E.norm)).size, 4, 'four distinct options: ' + c.stem); c.evidence.forEach((e) => assert(E.quoteIn(e.quote, byRef[e.page]), 'verbatim evidence: ' + e.quote)); });
  const forms = {}; qs.filter((c) => !c.review).forEach((c) => { forms[c.form] = (forms[c.form] || 0) + 1; }); const top = Object.entries(forms).sort((a, b) => b[1] - a[1]);
  console.log(`2) 60 questions in ${ms} ms: ${top.length} forms, most used ${top.slice(0, 3).map((x) => x.join('×')).join(', ')}`);
  assert(top[0][1] <= Math.max(3, Math.ceil(0.12 * 60)), 'no form beyond 12 % of the quiz: ' + JSON.stringify(top.slice(0, 3)));
  const deepForms = ['caseInfer', 'caseContrast', 'judgeClaims', 'claimFlaw', 'inferAlso']; const usedDeep = deepForms.filter((f) => forms[f]); assert(usedDeep.length >= 3, 'the deep forms are used: ' + usedDeep);
  const thinking = qs.filter((c) => ['scenarios', 'critical_thinking'].includes(c.qtype)); assert(thinking.length >= 6, 'scenario and critical questions: ' + thinking.length);
  thinking.forEach((c) => assert((C.depth[c.form] || 0) >= 2, `${c.qtype} from a reasoning form, not recall: ${c.form}`));
  console.log(`   scenario/critical: ${thinking.length} questions from ${[...new Set(thinking.map((c) => c.form))].join(', ')}`);
  assert(ms < 5000, 'well inside the 10 s the agent may take: ' + ms);

  // 3) the claim forms are right by construction: a statement shown as true is the lecture's own, one shown as false is not in the lecture, the key follows
  const L = { A: 'Only Student A', B: 'Only Student B', both: 'Both students', none: 'Neither student' };
  qs.filter((c) => c.form === 'judgeClaims').forEach((c) => { const a = c.stem.match(/Student A: "(.+)"/)[1], b = c.stem.match(/Student B: "(.+)"/)[1]; const ta = inLecture(a), tb = inLecture(b);
    assert.strictEqual(c.options[c.correct_index], ta && tb ? L.both : ta ? L.A : tb ? L.B : L.none, 'who is right follows the lecture: ' + c.stem); });
  qs.filter((c) => c.form === 'claimFlaw').forEach((c) => { const shown = c.stem.match(/: "(.+)"\./)[1]; const key = c.options[c.correct_index];
    assert.strictEqual(/^Nothing/.test(key), inLecture(shown), 'a note is "nothing wrong" exactly when it is the lecture\'s own statement: ' + shown); });
  console.log(`3) claims: ${qs.filter((c) => c.form === 'judgeClaims').length} "who is right" and ${qs.filter((c) => c.form === 'claimFlaw').length} "what is wrong" questions checked against the lecture`);

  // 4) cases: the two-case question pairs each finding with the state / group the lecture gives it; the inference question's key belongs to the inferred state
  qs.filter((c) => c.form === 'caseContrast').forEach((c) => { assert(/Patient 1|Description 1/.test(c.stem) && c.evidence.length === 2, 'two cases, two pieces of evidence'); });
  qs.filter((c) => c.form === 'inferAlso').forEach((c) => assert(inLecture(c.options[c.correct_index]), 'the predicted finding is in the lecture: ' + c.options[c.correct_index]));
  console.log(`4) cases: ${qs.filter((c) => c.form === 'caseContrast').length} two-case, ${qs.filter((c) => c.form === 'caseInfer').length} findings -> state, ${qs.filter((c) => c.form === 'inferAlso').length} infer-then-predict`);

  // 5) deterministic: the same lecture gives the same quiz
  const again = await gen(60); assert.deepStrictEqual(again.map((c) => c.stem), qs.map((c) => c.stem), 'same input, same questions'); console.log('5) deterministic');

  // 6) the AI path: each slot gets a shape (rotated per identity, none repeated before the others are used) and, for scenario / critical slots, the deep material of its pages
  const plan = E.buildPlan(R.analyse(pages), st(30), E.support(texts, 'health')); C.guide(plan, pages); const by = {};
  plan.slots.forEach((s) => { assert(s.shape, 'every slot has a shape'); (by[s.qtype] ||= {})[s.shape] = (by[s.qtype][s.shape] || 0) + 1; });
  Object.entries(by).forEach(([t, m]) => { const v = Object.values(m); assert(Math.max(...v) - Math.min(...v) <= 1, `${t}: shapes rotate evenly ${JSON.stringify(v)}`); });
  const deepSlots = plan.slots.filter((s) => ['scenarios', 'critical_thinking'].includes(s.qtype)); assert(deepSlots.some((s) => s.material), 'scenario / critical slots carry the deep material');
  const [, prompt] = E.P.generate(plan.slots.slice(0, 3), { d1p1: byRef.d1p1 }, st(30), [], {}); assert(/"shape"/.test(prompt) && /question form to use/.test(prompt), 'the AI is told the shape');
  console.log(`6) AI guidance: ${plan.slots.length} slots shaped, ${deepSlots.filter((s) => s.material).length}/${deepSlots.length} scenario/critical slots with deep material`);

  // 7) a form added later joins its identity and the composer uses it (no other change)
  const ok = C.register('understanding', 'testTwin', (T, slot, m) => { const d = T.here(m.defs, 'testTwin')[0]; if (!d) return null; T.take('testTwin', d); const w = m.defs.filter((x) => x !== d).slice(0, 3).map((x) => x.term); if (w.length < 3) return null;
    return T.mk(`Which term does the lecture define as: "${d.tail}"?`, d.term, w, d, T.note(d.sentence), 'term from its definition: ' + d.term); }, 3);
  assert(ok); const q2 = await gen(60); const n2 = q2.filter((c) => c.form === 'testTwin').length; assert(n2 >= 1, 'the new form is used'); console.log(`7) a newly registered form is used ${n2} time(s)`);
  console.log('composer tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
