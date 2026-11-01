// node claude-edition/test/types.test.js — the local generator imitates the identity of ALL ten quiz types, and the analysis of a lecture is strict about which section supports which type.
// A section "supports" a type only when it holds a real item of that shape (the same items the questions are made of), so what is announced is exactly what can be asked:
//  contrast (two subjects set against each other) · best answer (a superlative: "most common / main / primary") · scenario (a condition and its result) · critical reading (a caution / limit)
// Every such question: four distinct options, a verbatim quotation as evidence, the right option always the lecture's own words, wrong ones taken from elsewhere in the lecture or swapped from it.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert');
const mk = (arr) => arr.map((t, i) => ({ ref: 'd1p' + (i + 1), text: t, doc_id: 'd', page_no: i + 1 }));
const lecture = mk([
  'Cardiac Physiology\nThe left ventricle has a thick muscular wall and pumps blood to the whole body, whereas the right ventricle has a thinner wall and pumps blood only to the lungs.\nSystole is the phase of ventricular contraction that ejects blood into the aorta and pulmonary artery.\nDiastole is the phase of ventricular relaxation during which the chambers fill with blood from the atria.\nThe most common cause of left heart failure is coronary artery disease affecting the supply of oxygen to the muscle.\nIf the aortic valve becomes narrow, the left ventricle must generate a higher pressure to eject blood into the aorta.',
  'Blood Vessels\nArteries carry blood away from the heart under high pressure, while veins return blood to the heart under low pressure.\nCapillaries are the thin walled vessels where oxygen and nutrients are exchanged between blood and the tissues.\nWhen blood pressure falls, the baroreceptor reflex increases the heart rate and constricts the arterioles to restore pressure.\nThe primary regulator of blood flow to a tissue is the diameter of its arterioles, controlled by local metabolites and nerves.\nVenous valves prevent backflow of blood, however they can fail in varicose veins and allow blood to pool in the legs.',
  'Kidney Function\nThe nephron is the functional unit of the kidney and filters plasma at the glomerulus before reabsorbing most of the water.\nIf the afferent arteriole constricts, the glomerular filtration rate falls because the capillary pressure drops.\nDiuretics increase urine output, but they can cause loss of potassium and dehydration when used for long periods.\nThe proximal tubule is the main site of reabsorption of sodium and glucose, unlike the collecting duct that adjusts water according to hormones.\nWhen the body loses water, the hormone vasopressin increases water reabsorption in the collecting duct and concentrates the urine.']);
const byRef = Object.fromEntries(lecture.map((p) => [p.ref, p.text]));
(async () => {
  // ---------------------------------------------------------------- 1) the analysis: per type, per section
  const m = R.mine(lecture); assert(m.contrasts.length >= 3 && m.conds.length >= 3 && m.bests.length >= 2 && m.critics.length >= 1, `the shapes are found: ${m.contrasts.length}/${m.conds.length}/${m.bests.length}/${m.critics.length}`);
  const an = R.analyse(lecture); const cap = Object.fromEntries(Object.entries(an.profile.types).map(([k, v]) => [k, v.capacity]));
  assert(cap.compare_contrast >= 3 && cap.scenarios >= 3 && cap.best_answer >= 2 && cap.critical_thinking >= 1, 'a lecture with those shapes supports those types: ' + JSON.stringify(cap));
  assert.strictEqual(cap.sequence, 0, 'no numbered procedure: no sequence'); assert.strictEqual(cap.application, 0, 'no values with units: no application');
  const sup = (ref) => Object.keys(an.objectives.find((o) => o.pages[0] === ref).supports);
  assert(sup('d1p1').includes('compare_contrast') && sup('d1p1').includes('scenarios') && !sup('d1p1').includes('critical_thinking'), 'section 1: contrast + scenario, no caution: ' + sup('d1p1'));
  assert(sup('d1p2').includes('critical_thinking') && sup('d1p2').includes('compare_contrast'), 'section 2: the caution about the venous valves, the arteries/veins contrast');
  // a lecture with none of the shapes supports none of the four (no loose keyword guess)
  const plain = R.analyse(mk(['Cell Membrane\nThe plasma membrane separates the cell from its surroundings.\nIt is made mainly of phospholipids and proteins.\nThe membrane controls which substances enter and leave the cell.\nOsmosis is the movement of water across a selectively permeable membrane.\nDiffusion is the movement of particles from high to low concentration.\nActive transport requires energy from ATP and moves ions against a gradient.']));
  ['compare_contrast', 'best_answer', 'scenarios', 'critical_thinking'].forEach((t) => assert.strictEqual(plain.profile.types[t].capacity, 0, 'plain definitions: not ' + t));
  console.log('ok   1) analysis: the four shapes found per section; a section supports a type only with a real item; plain definitions support none of them');
  // ---------------------------------------------------------------- 2) the questions
  const st = { count: 20, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' };
  const plan = E.buildPlan(an, st, E.support(lecture.map((p) => p.text), 'health')); const r = await R.generate(plan, lecture, st, () => {}); assert.strictEqual(r.accepted.length, 20);
  const by = (t) => r.accepted.filter((q) => q.qtype === t); ['compare_contrast', 'best_answer', 'scenarios'].forEach((t) => assert(by(t).length >= 1, 'a ' + t + ' question was written'));
  r.accepted.forEach((q) => { assert.strictEqual(new Set(q.options.map(E.norm)).size, 4, 'distinct options: ' + q.stem); q.evidence.forEach((e) => assert(E.quoteIn(e.quote, byRef[e.page]), 'verbatim evidence: ' + e.quote)); });
  const c = by('compare_contrast')[0]; assert(/distinguishes/.test(c.stem) && c.options[c.correct_index].includes('whereas') || c.options[c.correct_index].includes('while') || c.options[c.correct_index].includes('unlike'), 'contrast: the right option is the lecture\'s own sentence'); assert(c.options.filter((o, i) => i !== c.correct_index).some((o) => /share this property/.test(o)) && c.options.some((o, i) => i !== c.correct_index && /^(The )?(right|veins|collecting)/i.test(o)), 'wrong options: the two properties swapped, or given to both');
  const sc = by('scenarios')[0]; assert(/^Scenario: in a case where/.test(sc.stem) && !sc.options.some((o) => /^(of|for|in|to) /.test(o)), 'scenario: a case, an outcome; no fragment as an option');
  const b = by('best_answer')[0]; assert(/BEST completion/.test(b.stem) && /most common|primary|main/.test(b.stem), 'best answer: built on a sentence that names the best/primary/main one');
  console.log(`ok   2) questions: contrast ${by('compare_contrast').length}, scenario ${by('scenarios').length}, best answer ${by('best_answer').length}, caution ${by('critical_thinking').length} - four distinct options, verbatim evidence, the right option the lecture's own words`);
  // ---------------------------------------------------------------- 3) a noun "cause" is not a causal link (it gave the fragment "of left heart failure is…" as an outcome)
  assert(!m.causal.some((x) => /^of /.test(x.tail)), 'no causal tail that starts with a preposition');
  // ---------------------------------------------------------------- 4) Arabic
  const ar = mk(['القلب\nالبطين الأيسر له جدار عضلي سميك ويضخ الدم إلى الجسم كله، بينما البطين الأيمن له جدار أرق ويضخ الدم إلى الرئتين فقط.\nإذا ضاقت الصمام الأبهري، يحتاج البطين الأيسر إلى ضغط أعلى لدفع الدم إلى الأبهر.']);
  const mar = R.mine(ar); assert(mar.contrasts.length >= 1, 'Arabic contrast (بينما) is found: ' + JSON.stringify(mar.contrasts.map((x) => x.text)));
  console.log('ok   3-4) no noun-"cause" fragments; Arabic contrast found');
  console.log('types tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
