// node claude-edition/test/explain.test.js — THE LECTURE EXPLAINED (engine.js makeExplain / checkExplain / makeSlideAnswer): free in its words, never in its facts
//  1) a sound explanation passes whole: Arabic idea and points, each point quoting its slide, terms that are on the slide, a valid check question
//  2) a point quoting a line that is not on the slide, or holding a number the slides do not hold, is sent back once with the reason; a term not on the slide
//     and a broken check question are dropped (the explanation still stands)
//  3) a title slide may have no points; a slide with text may not
//  4) a question about the slide: answered from it; a number it does not hold is refused; the selected phrase goes with the question
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const c = { title: 'Renal', page_no: 14, text: 'The Glomerular Filtration Rate\nGFR is the volume of fluid filtered into Bowman capsule per unit time\nNormal GFR is about 125 ml/min', before: 'Filtration', after: 'Control of GFR' };
const model = (answers) => { const seen = []; return { seen, json: async (task, sys, pr) => { seen.push({ task, sys, pr }); const a = answers.shift(); if (a instanceof Error) throw a; return a; } }; };
const good = () => ({ idea: 'هذه الشريحة تعرّف معدل الترشيح الكبيبي (GFR) وقيمته الطبيعية.', points: [{ ar: 'المعدل هو حجم السائل الذي يُرشَّح إلى Bowman capsule في وحدة الزمن.', quote: 'GFR is the volume of fluid filtered into Bowman capsule per unit time' }, { ar: 'وقيمته الطبيعية نحو 125 مل في الدقيقة كما تقول الشريحة.', quote: 'Normal GFR is about 125 ml/min' }],
  terms: [{ en: 'Bowman capsule', ar: 'محفظة بومان' }], remember: ['قيمة GFR الطبيعية نحو 125 مل في الدقيقة.'], check: { stem: 'What is the normal GFR?', options: ['About 125 ml/min', 'About 25 ml/min', 'About 500 ml/min', 'About 5 ml/min'], correct_index: 0, quote: 'Normal GFR is about 125 ml/min', why: 'الشريحة تقول إنه نحو 125 مل في الدقيقة.' } });
(async () => {
  // 1) sound
  let m = model([good()]); let x = await E.makeExplain(m, c, 'simple'); assert(x && x.points.length === 2 && x.terms.length === 1 && x.check && x.check.correct_index === 0, '1) ' + JSON.stringify(x)); assert.strictEqual(m.seen.length, 1);
  assert(/LEVEL: SIMPLE/.test(m.seen[0].sys) && /PREVIOUS SLIDE/.test(m.seen[0].pr), '1) the level and the neighbours go along');
  m = model([good()]); await E.makeExplain(m, c, 'exam'); assert(/LEVEL: EXAM/.test(m.seen[0].sys), '1) the exam level');
  console.log('1) a sound explanation passes whole: idea, points quoting the slide, terms on the slide, a check question; the level and the neighbours go along');
  // 2) sent back once; dropped parts
  const badQuote = good(); badQuote.points[1].quote = 'GFR rises during sleep'; m = model([badQuote, good()]); x = await E.makeExplain(m, c, 'simple');
  assert(x && x.points.length === 2 && m.seen.length === 2 && /copied EXACTLY/.test(m.seen[1].pr), '2) a quote not on the slide: sent back with the reason');
  const badNum = good(); badNum.points[0].ar = 'المعدل نحو 180 لترًا في اليوم كما هو معروف.'; m = model([badNum, badNum]); x = await E.makeExplain(m, c, 'simple');
  assert(x && x.points.length === 1 && !/180/.test(JSON.stringify(x)), '2) the point with an invented number never shows, even after the retry');
  const extra = good(); extra.terms.push({ en: 'Podocyte', ar: 'خلية قدمية' }); extra.check.options = ['a', 'a', 'b', 'c']; x = E.checkExplain(extra, c).x;
  assert.strictEqual(x.terms.length, 1, '2) a term not on the slide dropped'); assert.strictEqual(x.check, null, '2) a broken check question dropped');
  console.log('2) a point off the slide or with an invented number is sent back (and never shown); a foreign term and a broken check question are dropped');
  // 3) a title slide
  const title = { ...c, text: 'CONTROL OF GFR' }; assert.deepStrictEqual(E.checkExplain({ idea: 'شريحة عنوان تفتح قسم التحكم في معدل الترشيح.', points: [] }, title).bad, [], '3) a title slide needs no points');
  assert(E.checkExplain({ idea: 'فكرة الشريحة واضحة جدًا هنا.', points: [] }, c).bad.length, '3) a slide with text needs its points');
  console.log('3) a title slide may have only its idea; a slide with text must have its points');
  // 4) a question about the slide
  m = model([{ ar: 'العبارة تعني أن GFR هو حجم ما يُرشَّح إلى Bowman capsule في الدقيقة، ونحو 125 مل طبيعيًا.' }]); let a = await E.makeSlideAnswer(m, c, 'وش يعني؟', [], 'per unit time');
  assert(a && /125/.test(a) && /SELECTED ON THE SLIDE: «per unit time»/.test(m.seen[0].pr), '4) answered, the phrase sent along');
  m = model([{ ar: 'المعدل يرتفع إلى 300 مل عند الرياضيين كما هو معروف في الكتب.' }, { ar: 'الشريحة لا تذكر ذلك، وتقول فقط إن المعدل الطبيعي نحو 125 مل في الدقيقة.' }]); a = await E.makeSlideAnswer(m, c, 'كم عند الرياضيين؟', []);
  assert(a && !/300/.test(a), '4) an invented number refused');
  console.log('4) a question about the slide is answered from it (a selected phrase goes along); an invented number is refused');
  console.log('explain ok');
})().catch((e) => { console.error(e); process.exit(1); });
