// node claude-edition/test/tutor.test.js — THE TUTOR and THE SIMILAR QUESTION are checked before a student sees them (the model is free in its words, never in its facts):
//  1) a tutor answer in Arabic, built from the lecture, is accepted; one with a number the lecture does not contain is sent back once with the reason, and the
//     corrected one is accepted; one still in English after the retry is refused (the page then says no sound answer came)
//  2) the conversation so far is sent along (at most four turns), and an empty question asks nothing
//  3) a similar question is accepted only when it quotes the lecture word for word, has four different options, a valid key and is NOT the original reworded;
//     a refused one is sent back once with the reason
//  4) the smart correction is given the lecture pages too, and may name a number that is in them
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const pages = { d1p3: 'The heart has four chambers: two atria that receive blood and two ventricles that pump it out.\nThe left ventricle has the thickest wall of the heart.\nAt rest the heart beats about 70 times a minute.' };
const ctx = { stem: 'Which chambers pump blood out of the heart?', options: ['atria', 'ventricles', 'valves', 'veins'], chosen: 'atria', correct: 'ventricles', explanation: 'The lecture says the ventricles pump blood out.', quote: 'two ventricles that pump it out', pages };
const model = (answers) => { const seen = []; return { seen, json: async (task, sys, pr) => { seen.push({ task, pr, sys }); const a = answers.shift(); if (a instanceof Error) throw a; return a; } }; };
(async () => {
  // 1) tutor: accepted / sent back for an invented number / refused when never Arabic
  let m = model([{ ar: 'اختيارك atria (الأذينان) يستقبلان الدم، أما ventricles (البطينان) فهما اللذان يضخّانه خارج القلب كما تقول المحاضرة.' }]);
  assert(/ventricles/.test(await E.makeTutorReply(m, ctx, 'ليش اختياري غلط؟', [])), '1) a sound answer is accepted'); assert.strictEqual(m.seen.length, 1);
  m = model([{ ar: 'البطينان يضخان الدم بقوة 120 مليلترًا في كل نبضة كما هو معروف، وهذا يفسر الجواب الصحيح ventricles.' }, { ar: 'البطينان ventricles يضخّان الدم خارج القلب، والأذينان atria يستقبلانه فقط.' }]);
  const r1 = await E.makeTutorReply(m, ctx, 'اشرح أبسط', []); assert(r1 && !/120/.test(r1), '1) the invented number is gone'); assert(/number that the lecture pages do not contain/.test(m.seen[1].pr), '1) the retry says why');
  m = model([{ ar: 'The ventricles pump the blood out.' }, { ar: 'Still in English, sorry.' }]); assert.strictEqual(await E.makeTutorReply(m, ctx, 'why?', []), null, '1) never Arabic: refused');
  console.log('1) a tutor answer is accepted when it is Arabic and holds only the lecture\'s facts; an invented number is sent back with the reason; English is refused');
  // 2) the conversation goes along, bounded; an empty question asks nothing
  m = model([{ ar: 'نعم، والجدار الأسمك هو جدار البطين الأيسر كما تذكر المحاضرة.' }]); const hist = Array.from({ length: 7 }, (_, i) => ({ q: 'سؤال ' + i, a: 'جواب ' + i }));
  await E.makeTutorReply(m, ctx, 'وأي بطين أقوى؟', hist); const pr = m.seen[0].pr; assert(/STUDENT: سؤال 6/.test(pr) && !/سؤال 2\b/.test(pr), '2) the last four turns go along');
  m = model([]); assert.strictEqual(await E.makeTutorReply(m, ctx, '   ', []), null); assert.strictEqual(m.seen.length, 0, '2) an empty question asks nothing');
  console.log('2) the last four turns of the conversation are sent with a new question; an empty one asks nothing');
  // 3) the similar question
  const good = { stem: 'Which chamber of the heart has the thickest wall?', options: ['left ventricle', 'right atrium', 'left atrium', 'right ventricle'], correct_index: 0, explanation: 'المحاضرة تقول إن left ventricle له أسمك جدار.', quote: 'The left ventricle has the thickest wall of the heart.', page: 'd1p3' };
  m = model([JSON.parse(JSON.stringify(good))]); const s1 = await E.makeSimilar(m, ctx); assert(s1 && s1.correct_index === 0 && s1.page === 'd1p3', '3) a sound similar question is accepted');
  const reworded = { ...good, stem: 'Which chambers pump blood out of the heart?', options: ['ventricles', 'atria', 'valves', 'veins'], quote: 'two ventricles that pump it out of the heart' };
  m = model([reworded, { ...good, quote: 'The left ventricle is the strongest pump in the whole body.' }, JSON.parse(JSON.stringify(good))]);
  assert.strictEqual(await E.makeSimilar(m, ctx), null, '3) the original reworded, then a quote not in the lecture: refused');
  assert(/original question reworded/.test(m.seen[1].pr), '3) the retry says it was the original reworded');
  assert.deepStrictEqual(E.checkSimilar({ ...good, options: ['a', 'a', 'b', 'c'] }, ctx), ['options'], '3) two options alike');
  assert.deepStrictEqual(E.checkSimilar({ ...good, correct_index: 7 }, ctx), ['key'], '3) a key out of range');
  console.log('3) a similar question passes only when it quotes the lecture word for word, has four different options and a valid key, and is not the original reworded');
  // 4) the correction sees the pages
  m = model([{ ar: 'الصواب: ventricles. اختيارك atria يستقبلان الدم فقط، والبطينان يضخّان الدم مع كل نبضة، وهي نحو 70 نبضة في الدقيقة كما تقول المحاضرة.' }]);
  const fix = await E.makeCorrection(m, ctx); assert(fix && /70/.test(fix), '4) a number from the pages is allowed'); assert(/LECTURE PAGES/.test(m.seen[0].pr) && /Diagnose the slip/.test(m.seen[0].sys), '4) the pages and the diagnosis rule go along');
  console.log('4) the smart correction is given the lecture pages and asked to diagnose the slip; a number the pages hold is allowed');
  console.log('tutor ok');
})().catch((e) => { console.error(e); process.exit(1); });
