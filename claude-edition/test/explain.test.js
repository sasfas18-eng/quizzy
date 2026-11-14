// node claude-edition/test/explain.test.js — THE LECTURE EXPLAINED (engine.js makeExplain / checkExplain / makeSlideAnswer): free in its words, never in its facts
//  1) a sound explanation passes whole: Arabic idea and points, each point quoting its slide, terms that are on the slide, a valid check question
//  2) a point quoting a line that is not on the slide, or holding a number the slides do not hold, is sent back once with the reason; a term not on the slide
//     and a broken check question are dropped (the explanation still stands)
//  3) a title slide may have no points; a slide with text may not
//  4) a question about the slide: answered from it; a number it does not hold is refused; the selected phrase goes with the question
//  5) pictures: never described or asked about unseen; seen, only what is written in them (tagged); no check question needs a picture
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const c = { title: 'Renal', page_no: 14, text: 'The Glomerular Filtration Rate\nGFR is the volume of fluid filtered into Bowman capsule per unit time\nNormal GFR is about 125 ml/min', before: 'Filtration', after: 'Control of GFR' };
const model = (answers) => { const seen = []; return { seen, json: async (task, sys, pr) => { seen.push({ task, sys, pr }); const a = answers.shift(); if (a instanceof Error) throw a; return a; } }; };
const good = () => ({ idea: 'هذه الشريحة تعرّف معدل الترشيح الكبيبي (GFR) وقيمته الطبيعية.', points: [{ ar: 'المعدل هو حجم السائل الذي يُرشَّح إلى Bowman capsule في وحدة الزمن.', quote: 'GFR is the volume of fluid filtered into Bowman capsule per unit time' }, { ar: 'وقيمته الطبيعية نحو 125 مل في الدقيقة كما تقول الشريحة.', quote: 'Normal GFR is about 125 ml/min' }],
  terms: [{ en: 'Bowman capsule', ar: 'محفظة بومان' }], remember: ['قيمة GFR الطبيعية نحو 125 مل في الدقيقة.'], check: { stem: 'What is the normal GFR?', options: ['About 125 ml/min', 'About 25 ml/min', 'About 500 ml/min', 'About 5 ml/min'], correct_index: 0, quote: 'Normal GFR is about 125 ml/min', why: 'الشريحة تقول إنه نحو 125 مل في الدقيقة.' } });
(async () => {
  // 1) sound
  let m = model([good()]); let x = await E.makeExplain(m, c, 'simple'); assert(x && x.points.length === 2 && x.terms.length === 1 && x.questions.length === 1 && x.questions[0].correct_index === 0, '1) ' + JSON.stringify(x)); assert.strictEqual(m.seen.length, 1);
  assert(/LEVEL: SIMPLE/.test(m.seen[0].sys) && /PREVIOUS SLIDE/.test(m.seen[0].pr), '1) the level and the neighbours go along');
  m = model([good()]); await E.makeExplain(m, c, 'exam'); assert(/LEVEL: EXAM/.test(m.seen[0].sys), '1) the exam level');
  console.log('1) a sound explanation passes whole: idea, points quoting the slide, terms on the slide, a check question; the level and the neighbours go along');
  // 2) sent back once; dropped parts
  const badQuote = good(); badQuote.points[1].quote = 'GFR rises during sleep'; m = model([badQuote, good()]); x = await E.makeExplain(m, c, 'simple');
  assert(x && x.points.length === 2 && m.seen.length === 2 && /copied EXACTLY/.test(m.seen[1].pr), '2) a quote not on the slide: sent back with the reason');
  const badNum = good(); badNum.points[0].ar = 'المعدل نحو 180 لترًا في اليوم كما هو معروف.'; m = model([badNum, badNum]); x = await E.makeExplain(m, c, 'simple');
  assert(x && x.points.length === 1 && !/180/.test(JSON.stringify(x)), '2) the point with an invented number never shows, even after the retry');
  const extra = good(); extra.terms.push({ en: 'Podocyte', ar: 'خلية قدمية' }); extra.check.options = ['a', 'a', 'b', 'c']; x = E.checkExplain(extra, c).x;
  assert.strictEqual(x.terms.length, 1, '2) a term not on the slide dropped'); assert.strictEqual(x.questions.length, 0, '2) a broken question dropped');
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
  // 5) pictures: unseen, never described or asked about; seen, what is WRITTEN in them may be explained (tagged) - and the check question never needs a picture
  m = model([good()]); await E.makeExplain(m, c, 'simple'); assert(/You do not see the slide's pictures/.test(m.seen[0].sys), '5) unseen pictures: never described');
  const picQ = good(); picQ.check.stem = 'In the figure, which structure is labelled A?'; assert.strictEqual(E.checkExplain(picQ, c).x.questions.length, 0, '5) a question that needs a picture is dropped');
  const arQ = good(); arQ.check.stem = 'ما الذي يوضحه الشكل في هذه الشريحة؟'; assert.strictEqual(E.checkExplain(arQ, c).x.questions.length, 0, '5) also in Arabic');
  const withPic = good(); withPic.points.push({ ar: 'وتُسمّي الصورة الجزء الخارجي من الكلية القشرة Renal cortex.', quote: 'Renal cortex', from_picture: true });
  assert.strictEqual(E.checkExplain(withPic, c).x.points.length, 2, '5) unseen: a point from a picture is refused (its quote is not on the slide)');
  const seen = { ...c, images: [{ fake: 'blob' }] }; const x5 = E.checkExplain(withPic, seen).x; assert(x5.points.length === 3 && x5.points[2].pic === true, '5) seen: the picture\'s written words may be explained, tagged');
  const picNum = good(); picNum.points.push({ ar: 'وتذكر الصورة أن القشرة سمكها 7 ملم تقريبًا.', quote: 'Cortex 7 mm', from_picture: true }); assert.strictEqual(E.checkExplain(picNum, seen).x.points.length, 2, '5) a number the slides do not hold, even from a picture: refused');
  m = model([withPic]); await E.makeExplain(m, seen, 'simple'); assert(/attached as an image/.test(m.seen[0].sys), '5) seen: told to judge the pictures');
  console.log('5) pictures: unseen ones are never described or asked about; a seen picture\'s written words are explained (tagged, no new number); no check question needs a picture');
  // 6) shown as it is written: only what is complete AND sound - the idea once its string closes, each point once its object closes and passes its check
  const full = JSON.stringify(good()); const cut = (n) => E.partialExplain(full.slice(0, n), c);
  assert.deepStrictEqual(cut(20), { idea: '', points: [] }, '6) nothing yet');
  const ideaEnd = full.indexOf('"points"'); assert(cut(ideaEnd).idea.length > 8 && cut(ideaEnd).points.length === 0, '6) the idea alone');
  const p1 = full.indexOf('},{', ideaEnd) + 1; assert.strictEqual(cut(p1).points.length, 1, '6) the first point once it is complete'); assert.strictEqual(cut(p1 - 5).points.length, 0, '6) never a half point');
  const bad = good(); bad.points[0].quote = 'not on the slide at all here'; assert.strictEqual(E.partialExplain(JSON.stringify(bad), c).points.length, 1, '6) a point that fails its check is never shown');
  console.log('6) shown as it is written: the idea once complete, each point once complete and checked - never a half point, never an unchecked one');
  // 7) the slide's questions: several, each on another fact, never two alike, never about a picture
  const qs = good(); delete qs.check; qs.questions = [good().check, { ...good().check }, { stem: 'GFR is the volume of fluid filtered into which structure per unit time?', options: ['Bowman capsule', 'Loop of Henle', 'Collecting duct', 'Renal pelvis'], correct_index: 0, quote: 'GFR is the volume of fluid filtered into Bowman capsule per unit time', why: 'كما تقول الشريحة.' }, { stem: 'In the figure, what is labelled?', options: ['a', 'b', 'c', 'd'], correct_index: 0, quote: 'Normal GFR is about 125 ml/min' }];
  const xq = E.checkExplain(qs, c).x; assert.strictEqual(xq.questions.length, 2, '7) two different questions kept (a repeat and a picture question dropped)');
  console.log('7) the slide\'s questions: each on its own fact, a repeat and a question needing a picture dropped');
  // 8) several slides in one request: each checked alone; a slide that comes back unsound is left for its own request
  const c2 = { ...c, page_no: 15, text: 'Control of GFR\nThe afferent arteriole regulates blood flow into the glomerulus' };
  const s2 = { idea: 'هذه الشريحة عن التحكم في معدل الترشيح عبر الشريان الوارد.', points: [{ ar: 'الشريان الوارد afferent arteriole ينظم تدفق الدم إلى الكبيبة.', quote: 'The afferent arteriole regulates blood flow into the glomerulus' }], terms: [], remember: [], questions: [] };
  m = model([{ slides: [{ page: 14, ...good() }, { page: 15, ...s2 }, { page: 99, ...s2 }] }]); let bx = await E.makeExplainBatch(m, [c, c2], 'simple');
  assert(bx[14] && bx[15] && !bx[99] && m.seen.length === 1 && /=== SLIDE 14/.test(m.seen[0].pr) && /=== SLIDE 15/.test(m.seen[0].pr), '8) two slides in one request, each kept');
  const bad15 = { ...s2, points: [{ ar: 'نقطة عن سطر غير موجود في الشريحة أصلًا هنا.', quote: 'nothing like this on the slide' }] }; m = model([{ slides: [{ page: 14, ...good() }, { page: 15, ...bad15 }] }]); bx = await E.makeExplainBatch(m, [c, c2], 'simple');
  assert(bx[14] && !bx[15], '8) the unsound slide is left out (explained alone later)');
  console.log('8) several slides explained in one request, each checked alone; an unsound one is left for its own request');
  console.log('explain ok');
})().catch((e) => { console.error(e); process.exit(1); });
