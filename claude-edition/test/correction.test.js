// node claude-edition/test/correction.test.js — the ARABIC CORRECTION of a wrong answer (made on demand, kept with the attempt, never part of generation).
// The model is free in its phrasing, never in its facts, so what it returns is CHECKED:
//  1) it must be Arabic and keep the ORIGINAL: the correct answer verbatim when it is short (a long answer: one of its key terms), and no number the lecture does not contain
//  2) a first attempt that fails the checks gets ONE retry that is told what was wrong; only the original forgotten -> it is named first; anything else -> null (the page keeps the plain slip)
//  3) a provider error on the first call is the caller's to see (the page says the correction could not be made now); markdown the model adds is stripped
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');

const ctx = { stem: 'Complete the statement from the lecture: The cardiac cycle is the sequence of ____ and mechanical events during one heartbeat.', options: ['pulmon', 'muscular', 'semilunar', 'electrical'],
  chosen: 'pulmon', correct: 'electrical', explanation: 'The correct answer follows the lecture text: "The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat".',
  quote: 'The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat.' };
const GOOD = 'الصواب: electrical. دورة القلب هي تسلسل الأحداث الكهربائية (electrical) والميكانيكية خلال نبضة واحدة، فـ pulmon لا علاقة لها بما تقوله الجملة هنا.';
const NO_ORIGINAL = 'الصواب: الكهربائية. دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة من نبضات القلب، وهذا ما تقوله الجملة.';
const scripted = (...answers) => { const calls = []; return { calls, json: async (task, system, prompt) => { calls.push({ task, system, prompt }); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; if (a instanceof Error) throw a; return a; } }; };

(async () => {
  // ---------------------------------------------------------------- 1) the checks
  assert.deepStrictEqual(E.checkCorrection(GOOD, ctx), [], 'a good correction passes');
  assert(E.checkCorrection('The correct answer is electrical because the lecture says so, and that is all there is to say about it.', ctx).includes('not_arabic'), 'English is not an Arabic correction');
  assert(E.checkCorrection(NO_ORIGINAL, ctx).includes('original_missing'), 'the original word must be there, not only its translation');
  assert.deepStrictEqual(E.checkCorrection(NO_ORIGINAL.replace('الصواب: الكهربائية', 'الصواب: ELECTRICAL'), ctx), [], 'the original is matched without regard to case');
  assert(E.checkCorrection('قصير', ctx).includes('length') && E.checkCorrection(GOOD.repeat(12), ctx).includes('length'), 'too short / too long');
  assert(E.checkCorrection(GOOD + ' وتتكرر 72 مرة في الدقيقة.', ctx).includes('invented_number'), 'a number the lecture does not contain is refused');
  assert(E.checkCorrection(GOOD + ' وتتكرر ٧٢ مرة في الدقيقة.', ctx).includes('invented_number'), '... also when it is written with Arabic-Indic digits');
  const num = { stem: 'The resting heart rate is about ____ beats per minute.', options: ['72', '60', '90', '120'], chosen: '90', correct: '72', explanation: 'The lecture says the resting rate is about 72 beats per minute.', quote: 'The resting heart rate is about 72 beats per minute.' };
  assert.deepStrictEqual(E.checkCorrection('الصواب: 72. معدل القلب أثناء الراحة نحو ٧٢ نبضة في الدقيقة، وليس 90 ولا 60 كما قد يخطر لك.', num), [], 'numbers that are in the question, its options or the lecture are fine (Arabic-Indic digits read as digits)');
  const long = { ...ctx, correct: 'The sequence of electrical and mechanical events that happen during one complete heartbeat', options: ['x', 'y', 'z', 'The sequence of electrical and mechanical events that happen during one complete heartbeat'] };
  assert.deepStrictEqual(E.checkCorrection('الصواب أنها تسلسل الأحداث الكهربائية (electrical) والميكانيكية خلال نبضة قلب كاملة واحدة كما تقول المحاضرة.', long), [], 'a long answer: one of its key terms in the original is enough');
  assert(E.checkCorrection(NO_ORIGINAL, long).includes('original_missing'), '... but not none of them');
  const arabicAnswer = { stem: 'ما وظيفة الميتوكوندريا حسب المحاضرة؟', options: ['إنتاج الطاقة', 'تخزين الماء', 'بناء الجدار', 'نقل الصبغيات'], chosen: 'تخزين الماء', correct: 'إنتاج الطاقة', explanation: 'تنتج الميتوكوندريا الطاقة للخلية.', quote: 'تنتج الميتوكوندريا الطاقة للخلية.' };
  assert.deepStrictEqual(E.checkCorrection('الصواب: إنتاج الطاقة. الميتوكوندريا هي مصنع الطاقة في الخلية، وليست مخزنًا للماء كما اخترت.', arabicAnswer), [], 'an Arabic answer has no original to keep');
  console.log('ok   1) the checks: Arabic, the original kept (short answer verbatim / long answer a key term), no number the lecture does not contain');

  // ---------------------------------------------------------------- 2) making it
  let llm = scripted({ ar: GOOD }); let r = await E.makeCorrection(llm, ctx);
  assert.strictEqual(r, GOOD); assert.strictEqual(llm.calls.length, 1); assert.strictEqual(llm.calls[0].task, 'correction');
  const p0 = llm.calls[0].prompt; assert(p0.includes('CHOSE (wrong): pulmon') && p0.includes('CORRECT ANSWER: electrical') && p0.includes('LECTURE SENTENCE (verbatim): The cardiac cycle'), 'the model sees the question, the wrong choice, the right answer and the lecture sentence');
  assert(/ONLY what the lecture sentence/.test(llm.calls[0].system) && /Keep the ORIGINAL/.test(llm.calls[0].system) && /الصواب/.test(llm.calls[0].system), 'faithful, keeps the original, names the correction first');
  llm = scripted({ ar: NO_ORIGINAL }, { ar: GOOD }); r = await E.makeCorrection(llm, ctx);
  assert.strictEqual(r, GOOD); assert.strictEqual(llm.calls.length, 2, 'one retry');
  assert(/REJECTED/.test(llm.calls[1].prompt) && /EXACTLY as written/.test(llm.calls[1].prompt), 'the retry says what was wrong'); assert(!/REJECTED/.test(llm.calls[0].prompt));
  llm = scripted({ ar: NO_ORIGINAL }); r = await E.makeCorrection(llm, ctx);
  assert(r.startsWith('الصواب: «electrical» — الكهربائية.') && (r.match(/الصواب:/g) || []).length === 1 && E.checkCorrection(r, ctx).length === 0 && llm.calls.length === 2, 'only the original was forgotten twice: it is named first, without repeating the lead: ' + r);
  llm = scripted({ ar: 'دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة من نبضات القلب كما تقول المحاضرة.' }); r = await E.makeCorrection(llm, ctx); assert(r.startsWith('الصواب: «electrical». دورة القلب') && E.checkCorrection(r, ctx).length === 0, 'no lead to rewrite: the original is put in front');
  llm = scripted({ ar: GOOD + ' وتتكرر 72 مرة في الدقيقة.' }); assert.strictEqual(await E.makeCorrection(llm, ctx), null); assert.strictEqual(llm.calls.length, 2, 'an invented number twice: nothing is shown (null), after one retry');
  llm = scripted('Sorry, I cannot do that.'); assert.strictEqual(await E.makeCorrection(llm, ctx), null, 'a refusal in English is not shown');
  const boom = Object.assign(new Error('HTTP 429'), { code: 'rate_limited' }); llm = scripted(boom);
  await assert.rejects(() => E.makeCorrection(llm, ctx), (e) => e === boom && llm.calls.length === 1); llm = scripted({ ar: NO_ORIGINAL }, boom); assert((await E.makeCorrection(llm, ctx)).startsWith('الصواب: «electrical»'), 'an error on the retry does not lose a first attempt that only forgot the original: it is repaired');
  llm = scripted({ ar: GOOD + ' وتتكرر 72 مرة في الدقيقة.' }, boom); assert.strictEqual(await E.makeCorrection(llm, ctx), null, 'an error on the retry after a first attempt with an invented number: null, not a crash');
  llm = scripted({ ar: '**الصواب: electrical.**\n- دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة.' }); r = await E.makeCorrection(llm, ctx);
  assert(!/\*|\n|^-/.test(r) && r.startsWith('الصواب: electrical.'), 'markdown and line breaks are stripped: ' + r);
  llm = scripted('الصواب: electrical. دورة القلب هي تسلسل الأحداث الكهربائية والميكانيكية خلال نبضة واحدة من نبضات القلب.'); assert((await E.makeCorrection(llm, ctx)).startsWith('الصواب'), 'a bare string answer is accepted');
  llm = scripted({ ar: GOOD }); await E.makeCorrection(llm, { ...ctx, chosen: null }); assert(/LEFT IT BLANK/.test(llm.calls[0].prompt) && !/CHOSE/.test(llm.calls[0].prompt), 'an unanswered question gets its correction too');
  console.log('ok   2) making it: one retry that says what was wrong; the original named first when only it was forgotten; null when the checks cannot be met; provider errors surface on the first call');

  // ---------------------------------------------------------------- 3) which explanations need an Arabic correction: a quotation from the lecture does not decide the language
  assert(E.isArabicText('الإجابة الصحيحة مبنية على نص المحاضرة الأصلي: «The cardiac cycle is the sequence of electrical and mechanical events during one heartbeat». الخيارات الأخرى تصف أشياء أخرى.'), 'an Arabic sentence around an English quotation is Arabic');
  assert(!E.isArabicText('The correct answer follows the lecture text: "The cardiac cycle is the sequence". The other options describe other items.'), 'an English sentence around a quotation is not');
  assert(E.isArabicText('تنتج الميتوكوندريا الطاقة للخلية.') && E.isArabicText('«إنتاج الطاقة»') && !E.isArabicText('') && !E.isArabicText(null), 'plain Arabic; only a quotation (then the quotation decides); nothing');
  console.log('ok   3) the language rule: a quotation from the lecture does not decide the language of the explanation');

  // ---------------------------------------------------------------- 4) cleaning
  assert.strictEqual(E.cleanFix('  **a**  b\n\n- c  `d` '), 'a b c d'); assert.strictEqual(E.cleanFix(null), ''); assert.strictEqual(E.cleanFix(undefined), '');
  console.log('ok   4) cleaning');
  console.log('correction tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
