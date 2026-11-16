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
  // 9) the slide's questions in the slide's language: Arabic questions on an English slide are dropped and asked again; English ones kept; an Arabic slide keeps Arabic ones
  { const en = { page_no: 21, total: 30, title: 'CVS', text: 'RAPID INFLOW\nThe left ventricular pressure decreases up to 2-4 mm Hg.\nThis change in pressure causes the opening of the mitral valve.' };
    const base = { idea: 'في هذه المرحلة ينخفض ضغط البطين فيفتح الصمام التاجي.', points: [{ ar: 'ينخفض ضغط البطين الأيسر إلى 2-4 ملم زئبق.', quote: 'The left ventricular pressure decreases up to 2-4 mm Hg.' }, { ar: 'هذا الانخفاض يفتح الصمام التاجي.', quote: 'This change in pressure causes the opening of the mitral valve.' }], terms: [], remember: [] };
    const qAr = { stem: 'ما الذي يفتح الصمام التاجي في مرحلة الامتلاء السريع؟', options: ['انخفاض ضغط البطين', 'ارتفاع ضغط الأبهر', 'انقباض البطين', 'إغلاق الصمام الرئوي'], correct_index: 0, quote: 'This change in pressure causes the opening of the mitral valve.', why: 'لأن ضغط البطين صار أقل من ضغط الأذين.' };
    const qEn = { stem: 'What opens the mitral valve during rapid inflow?', options: ['The fall in left ventricular pressure', 'A rise in aortic pressure', 'Ventricular contraction', 'Closure of the pulmonary valve'], correct_index: 0, quote: 'This change in pressure causes the opening of the mitral valve.', why: 'لأن ضغط البطين صار أقل من ضغط الأذين.' };
    let r = E.checkExplain({ ...base, questions: [qAr] }, en); assert(r.bad.includes('qlang') && r.x.questions.length === 0, '9) an Arabic question on an English slide is dropped and asked again');
    r = E.checkExplain({ ...base, questions: [qEn] }, en); assert(!r.bad.length && r.x.questions.length === 1, '9) an English question on an English slide is kept: ' + JSON.stringify(r.bad));
    const ar = { page_no: 3, total: 9, title: 'تمريض', text: 'عملية التمريض\nالتقييم هو الخطوة الأولى في عملية التمريض.\nيجمع الممرض البيانات من المريض وأسرته.' };
    const qAr2 = { stem: 'ما الخطوة الأولى في عملية التمريض؟', options: ['التقييم', 'التخطيط', 'التنفيذ', 'التقويم'], correct_index: 0, quote: 'التقييم هو الخطوة الأولى في عملية التمريض.', why: 'لأن الشريحة تنص على ذلك.' };
    r = E.checkExplain({ idea: 'تبدأ عملية التمريض بالتقييم وجمع البيانات.', points: [{ ar: 'التقييم أول خطوة.', quote: 'التقييم هو الخطوة الأولى في عملية التمريض.' }, { ar: 'تُجمع البيانات من المريض وأسرته.', quote: 'يجمع الممرض البيانات من المريض وأسرته.' }], terms: [], remember: [], questions: [qAr2] }, ar);
    assert(!r.bad.includes('qlang') && r.x.questions.length === 1, '9) an Arabic slide keeps its Arabic question');
    let n9 = 0; const m9 = { async json() { n9++; return { ...base, questions: [n9 === 1 ? qAr : qEn] }; } }; const x9 = await E.makeExplain(m9, en, 'simple');
    assert(n9 === 2 && x9.questions.length === 1 && /mitral/.test(x9.questions[0].stem), '9) asked again, the English question kept');
    console.log('9) the slide\'s questions in its own language: Arabic ones on an English slide asked again in English; an Arabic slide keeps Arabic ones'); }
  // 10) every line of the slide explained: the real «Dying Process» slide (six lines) came back with four points - «Psychological and emotional changes» and
  //     «Confusion» lost; now the missing lines are named and asked again; a one-word line and a point on several lines (« | ») count
  { const dy = { page_no: 20, total: 40, title: 'Death', text: 'The Dying Process\n• Death comes in its own time and in its own way, and it is unique to the individual\n• Psychological and emotional changes\n• Introspection and reflection\n• Increase in sleeping to "detach"\n• Loss of interest in food\n• Confusion\nCopyright ©2023 F.A. Davis Company' };
    const P4 = [{ ar: 'يأتي الموت في وقته وبطريقته الخاصة ويختلف من شخص لآخر.', quote: 'Death comes in its own time and in its own way, and it is unique to the individual' }, { ar: 'يميل المحتضر إلى التأمل ومراجعة النفس.', quote: 'Introspection and reflection' }, { ar: 'ينام المحتضر أكثر ليبتعد عن محيطه.', quote: 'Increase in sleeping to "detach"' }, { ar: 'يقل اهتمامه بالطعام في هذه المرحلة.', quote: 'Loss of interest in food' }];
    const base = { idea: 'الموت يأتي في وقته وبطريقته الخاصة وتصاحبه تغيرات نفسية وعاطفية.', terms: [], remember: [] };
    let r = E.checkExplain({ ...base, points: P4 }, dy); assert(r.bad.includes('cover') && r.missing.length === 2 && r.missing.some((l) => /Psychological/.test(l)) && r.missing.some((l) => /Confusion/.test(l)), '10) the two lines left out are named: ' + JSON.stringify(r.missing));
    const P6 = P4.concat([{ ar: 'تظهر على المحتضر تغيرات نفسية وعاطفية، وقد يصاب بالارتباك والتشوش.', quote: 'Psychological and emotional changes | Confusion' }]);
    r = E.checkExplain({ ...base, points: P6 }, dy); assert(!r.bad.length && r.x.points.length === 5, '10) a point on two lines (one of them a single word) covers both: ' + JSON.stringify(r.bad));
    let n10 = 0, fb10 = ''; const m10 = { async json(task, sys, pr) { n10++; if (n10 === 2) fb10 = sys + pr; return { ...base, points: n10 === 1 ? P4 : P6 }; } }; const x10 = await E.makeExplain(m10, dy, 'simple');
    assert(n10 === 2 && /Psychological and emotional changes/.test(fb10) && x10.points.length === 5, '10) asked again naming the missing lines, the whole slide explained');
    console.log('10) every line of the slide explained: the lines left out are named and asked again; a one-word line and a point on several lines count'); }
  // 11) THE SMART EXPLANATION: the teaching tools Claude chose for the slide, each checked on its own and left out when not sound - never a retry for them
  { const inf = { title: 'Inflammation', page_no: 5, total: 30, text: 'Cardinal signs of inflammation\nRubor (redness)\nTumor (swelling)\nCalor (heat)\nDolor (pain)\nAcute inflammation: neutrophils, minutes to days\nChronic inflammation: macrophages and lymphocytes, weeks to years\nInjury leads to vasodilation, then increased permeability, then exudate formation', before: 'Innate immunity overview', after: 'Mediators of inflammation' };
    const smart = () => ({ asks: 'كيف نعرف أن في الجسم التهابًا، وما نوعاه؟', link: 'بعد أن عرفنا المناعة الفطرية، نرى هنا أول استجابة لها: الالتهاب.', idea: 'للالتهاب أربع علامات ونوعان: حاد ومزمن، ويبدأ بسلسلة من التغيرات في الأوعية.',
      points: [{ ar: 'العلامات الأربع: الاحمرار والتورم والحرارة والألم.', quote: 'Rubor (redness) | Tumor (swelling) | Calor (heat) | Dolor (pain)' }, { ar: 'الالتهاب الحاد خلاياه العدلات ويدوم من دقائق إلى أيام.', quote: 'Acute inflammation: neutrophils, minutes to days' },
        { ar: 'والمزمن خلاياه البلاعم واللمفاويات ويدوم أسابيع إلى سنوات.', quote: 'Chronic inflammation: macrophages and lymphocytes, weeks to years' }, { ar: 'تبدأ الإصابة بتوسع الأوعية ثم زيادة نفاذيتها ثم تكوّن النضحة.', quote: 'Injury leads to vasodilation, then increased permeability, then exudate formation' }],
      flow: ['Injury', 'vasodilation', 'increased permeability', 'exudate formation'], compare: { items: ['Acute inflammation', 'Chronic inflammation'], rows: [{ aspect: 'الخلايا', values: ['neutrophils', 'macrophages and lymphocytes'] }, { aspect: 'المدة', values: ['minutes to days', 'weeks to years'] }] },
      analogy: 'تخيّل الالتهاب كفرقة إطفاء تصل إلى مكان الحريق فتسدّ الطريق مؤقتًا حتى تنتهي من عملها.', mnemonic: { key: 'RTCD', items: ['Rubor (redness)', 'Tumor (swelling)', 'Calor (heat)', 'Dolor (pain)'], ar: 'احفظ الحروف الأولى بترتيبها.' },
      trap: 'لا تخلط بين Tumor بمعنى التورم هنا وبين الورم بالمعنى المعتاد.', recall: { q: 'لماذا يحمرّ مكان الالتهاب ويتورم؟', a: 'لأن الإصابة تؤدي إلى توسع الأوعية vasodilation ثم زيادة نفاذيتها فتتكوّن النضحة.' }, terms: [], remember: [], questions: [] });
    let x = E.checkExplain(smart(), inf, 'simple').x; const all = ['asks', 'link', 'flow', 'compare', 'analogy', 'mnemonic', 'trap', 'recall'];
    assert(all.every((k) => x[k]) && x.smart === 1 && x.compare.rows.length === 2 && x.mnemonic.items.length === 4, '11) a sound smart explanation keeps every tool: ' + all.filter((k) => !x[k]));
    const bad = smart(); bad.asks = 'كيف نعرف أن في الجسم التهابًا'; bad.flow = ['Injury', 'histamine release', 'exudate formation']; bad.compare.rows[0].values[0] = 'neutrophils and eosinophils'; bad.analogy = 'تخيّل أن 90 بالمئة من الالتهابات تشفى وحدها.';
    bad.mnemonic.key = 'RTDC'; bad.trap = 'انتبه جيدًا لهذه الشريحة فهي مهمة.'; bad.recall = { q: 'لماذا؟', a: 'لأن.' };
    const r = E.checkExplain(bad, inf, 'simple'); assert(!r.bad.length && all.filter((k) => k !== 'link').every((k) => !r.x[k]) && r.x.points.length === 4, '11) each unsound tool left out, the explanation stands: ' + all.filter((k) => r.x[k]));
    assert(!E.checkExplain(smart(), inf, 'exam').x.analogy, '11) no everyday comparison on the exam level'); assert(!E.checkExplain(smart(), { ...inf, before: '' }, 'simple').x.link, '11) no link on the first slide');
    const seen = smart(); seen.flow = ['Injury', 'Histamine released by mast cells', 'exudate formation']; assert(E.checkExplain(seen, { ...inf, images: [{}] }, 'simple').x.flow, '11) a slide seen as an image: a step may carry its picture\'s words');
    let calls = 0; const once = { async json() { calls++; return bad; } }; const y = await E.makeExplain(once, inf, 'simple'); assert(calls === 1 && y && y.points.length === 4, '11) a tool left out is never a reason to ask again');
    const part = E.partialExplain('{"asks": "كيف نعرف أن في الجسم التهابًا؟", "link": "بعد أن عرفنا المناعة الفطرية نرى أول استجابة لها.", "idea": "للالتهاب أربع علامات ونوعان.", "points": [', inf);
    assert(part.asks && part.link && part.idea, '11) the question and the link shown first, as the explanation is written');
    console.log('11) the smart explanation: the question, the link, the steps, the table, the comparison, the memory key, the trap and the recall question kept when sound; each unsound one left out alone (an outside word, a key whose letters do not match, a vague trap, a number not on the slides), never a retry'); }
  console.log('explain ok');
})().catch((e) => { console.error(e); process.exit(1); });
