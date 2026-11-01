// node static-edition/test/run_web_correction.js <dist> <pdf> — the CORRECTION of a wrong answer, in a real browser.
//  A) AI quiz whose explanations are English: a wrong answer shows the teacher's slip at once (what you chose crossed out, the right answer highlighted, a stamp), the lecture's own explanation
//     labelled as the original, the lecture sentence with the right word marked - and then the correction in Arabic, which keeps the ORIGINAL right answer exactly (marked inside it); one model call,
//     kept with the attempt: the review of the submitted attempt shows the same corrections, and a reload asks the model for nothing more
//  B) a model that misbehaves (English, or forgetting the original) is never shown: the slip and the original explanation stay, nothing is half-shown
//  C) the model unreachable: the page says so and offers one more try, which works
//  D) no AI at all (local quiz): the slip and the Arabic explanation around the lecture's own English sentence - and no model is asked for anything
const { chromium } = require('playwright'); const assert = require('assert');
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const { seedAccount, EMAIL, PASSWORD } = require('./signin.js'); const { assertHidden, createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2);
let axeSrc = null; try { axeSrc = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (_) { /* axe-core is not installed here: the scan is skipped (CI installs it) */ }
const axeScan = async (p, label) => { if (!axeSrc) return false; await p.addScriptTag({ content: axeSrc });
  const vs = await p.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((x) => x.target.join(' ')) })));
  assert.strictEqual(vs.length, 0, label + ': accessibility violations ' + JSON.stringify(vs)); return true; };
(async () => {
  const llm = await startLLM(); const site = await serve(dist, 0); const b = await chromium.launch(); const errs = [];
  const control = (o) => fetch(llm.url.replace('/v1', '') + '/__control', { method: 'POST', body: JSON.stringify(o) });
  const U = site.url + '/#'; const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const watch = (p) => { p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/429|favicon/.test(m.text())) errs.push('C ' + m.text().slice(0, 200)); }); };
  const toNewQuiz = async (p) => { await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); };
  const upload = async (p) => { await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); };
  const startSolving = async (p) => { await p.click('#start-solve'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); };
  /** answer with the FIRST option until one is wrong (a practice question locks after its answer); returns what was chosen */
  const answerUntilWrong = async (p) => { for (let i = 0; i < 12; i++) { await p.waitForSelector('.opt'); const mine = norm(await p.locator('.opt >> nth=0 >> .txt').textContent()); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain');
    if (await p.locator('.explain strong:has-text("غير صحيحة")').count()) return mine; const next = p.locator('button:has-text("التالي")'); if (!(await next.isEnabled())) break; await next.click(); await p.waitForSelector('.stem'); } throw new Error('no wrong answer found'); };

  // ================= A) the AI path
  const ctxA = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctxA); const pa = await ctxA.newPage(); watch(pa);
  await pa.goto(U + '/operator'); await pa.waitForSelector('#op-on'); await pa.click('#op-on'); await pa.waitForSelector('h1:has-text("ذكاء المشغل")'); await pa.click('details summary'); await pa.selectOption('#preset', 'custom'); await pa.fill('#base', llm.url); await pa.fill('#key', 'sk-123456'); await pa.fill('#rpm', '300');
  await pa.click('form:has-text("إضافة مزوّد") button[type=submit]'); await pa.waitForSelector('text=المفاتيح المربوطة');
  await upload(pa); await control({ explainEn: true }); await toNewQuiz(pa); await createQuiz(pa, { count: 10, timeout: 120000 });
  assert(!llm.stats.calls.correction, 'generating a quiz asks the model for no correction: ' + JSON.stringify(llm.stats.calls));
  await startSolving(pa); const mine = await answerUntilWrong(pa);
  const slip = pa.locator('.fix'); await slip.waitFor(); assert.strictEqual(norm(await pa.locator('.fix .stamp').textContent()), 'تصحيح');
  const right = norm(await pa.locator('.opt.right .txt').first().textContent());
  assert.strictEqual(norm(await pa.locator('.fix del.fx-wrong').textContent()), mine, 'what you chose is crossed out'); assert.strictEqual(norm(await pa.locator('.fix strong.fx-right').textContent()), right, 'the right answer is written in the highlighter');
  assert((await pa.locator('.fix .fx-l').allTextContents()).map(norm).join('|') === 'اخترتَ|الصواب', 'labels: you chose / the right answer');
  assert.strictEqual(norm(await pa.locator('.orig .olbl').textContent()), 'الشرح الأصلي', 'the lecture-language explanation is the original'); assert(/The correct answer follows the lecture text/.test(await pa.locator('.orig p').textContent()));
  const mk = pa.locator('.evidence blockquote mark.key'); assert((await mk.count()) >= 1 && norm(await mk.first().textContent()).toLowerCase() === right.toLowerCase(), 'the right word is marked inside the lecture\'s own sentence');
  await pa.waitForSelector('.fx-ar p', { timeout: 15000 }); const ar = norm(await pa.locator('.fx-ar p').textContent());
  assert(ar.startsWith('الصواب: ' + right), 'the Arabic correction names the right answer first, in its original spelling: ' + ar); assert.strictEqual(norm(await pa.locator('.fx-ar .lbl').textContent()), 'بالعربي');
  assert.strictEqual(norm(await pa.locator('.fx-ar p mark.key').first().textContent()).toLowerCase(), right.toLowerCase(), 'and the right word is marked inside it');
  assert((await pa.locator('.fx-ar p').getAttribute('lang')) === 'ar' && (await pa.locator('.fx-ar p').getAttribute('dir')) === 'rtl');
  assert.strictEqual(llm.stats.calls.correction, 1, 'one model call: ' + JSON.stringify(llm.stats.calls)); await assertHidden(pa, 'a wrong answer');
  let scanned = await axeScan(pa, 'wrong answer + Arabic correction (light)'); await pa.emulateMedia({ colorScheme: 'dark' }); await pa.waitForTimeout(300); await axeScan(pa, '... (dark)');
  await pa.setViewportSize({ width: 390, height: 844 }); await pa.waitForTimeout(300); await axeScan(pa, '... (phone)'); await pa.setViewportSize({ width: 1280, height: 900 }); await pa.emulateMedia({ colorScheme: 'light' }); console.log(scanned ? '   axe: no violations on the wrong-answer screen with the Arabic correction (light / dark / phone)' : '   (axe-core not installed: accessibility scan skipped)');
  // finish the attempt: more answers (some wrong), submit, review
  for (let i = 0; i < 12; i++) { const next = pa.locator('button:has-text("التالي")'); if (!(await next.count()) || !(await next.isEnabled())) break; await next.click(); await pa.waitForSelector('.stem'); if (!(await pa.locator('.explain').count())) await pa.click('.opt >> nth=0'); await pa.waitForSelector('.explain'); }
  await pa.click('button:has-text("مراجعة وتسليم")'); await pa.click('.modal button:has-text("سلّم الآن")'); await pa.waitForSelector('h1:has-text("نتيجتك")');
  const attemptId = (await pa.evaluate(() => location.hash)).match(/attempt\/(\w+)/)[1]; await pa.click('.chip-btn:has-text("الأخطاء")');
  const wrongCards = pa.locator('#main .card:has(.fix)'); const nWrong = await wrongCards.count(); assert(nWrong >= 1, 'the review lists the wrong answers with their slips');
  await pa.waitForFunction((n) => document.querySelectorAll('.fx-ar p').length >= n, nWrong, { timeout: 30000 }); assert.strictEqual(await pa.locator('.fx-ar p').count(), nWrong, 'every wrong answer has its Arabic correction');
  for (const t of await pa.locator('.fx-ar p').allTextContents()) assert(/^الصواب: /.test(norm(t)), 'each names the right answer first');
  assert.strictEqual(llm.stats.calls.correction, nWrong, 'one call per wrong answer, the one seen while solving was not asked again: ' + JSON.stringify(llm.stats.calls));
  const before = llm.stats.calls.correction; await pa.reload(); await pa.waitForSelector('h1:has-text("نتيجتك")'); await pa.click('.chip-btn:has-text("الأخطاء")'); await pa.waitForFunction((n) => document.querySelectorAll('.fx-ar p').length >= n, nWrong, { timeout: 15000 });
  assert.strictEqual(llm.stats.calls.correction, before, 'kept with the attempt: a reload asks the model for nothing');
  const kept = await pa.evaluate(async (id) => (await (await fetch('/api/attempts/' + id)).json()).questions.filter((q) => !q.is_correct).length, attemptId); assert.strictEqual(kept, nWrong);
  const all = await pa.evaluate(async (id) => { const a = await (await fetch('/api/attempts/' + id)).json(); const r = await fetch('/api/attempts/' + id + '/correction', { method: 'POST', body: JSON.stringify({ question_id: a.questions.find((q) => q.is_correct).id }) }); return r.json(); }, attemptId);
  assert.deepStrictEqual(all, { available: false, reason: 'not_wrong' }, 'a right answer needs no correction');
  console.log('A) AI quiz: the slip at once (crossed out / highlighted / stamp), the original explanation labelled, the right word marked in the lecture sentence, the Arabic correction keeps the original right answer; ' + nWrong + ' wrong answers reviewed, kept with the attempt (no call after a reload)');

  // ================= B) a model that misbehaves is never shown
  await control({ fixMode: 'english' }); const callsB = llm.stats.calls.correction;
  await pa.goto(U + '/quizzes'); await pa.waitForSelector('h1'); await pa.click('a:has-text("فتح") >> nth=0'); await pa.waitForSelector('#start-solve'); await startSolving(pa); await answerUntilWrong(pa);
  await pa.waitForTimeout(2500);      // the (rejected) answer takes a moment: two tries
  assert.strictEqual(await pa.locator('.fx-ar p').count(), 0, 'an English "correction" is not shown'); assert.strictEqual(await pa.locator('.fx-ar button').count(), 0, 'and there is nothing to retry: the model answered, wrongly');
  assert(await pa.locator('.fix').isVisible() && (await pa.locator('.orig p').textContent()).length > 20 && (await pa.locator('.evidence').count()) === 1, 'the slip, the original explanation and the lecture sentence stay');
  assert.strictEqual(llm.stats.calls.correction - callsB, 2, 'one try and one retry that says what was wrong');
  await control({ fixMode: 'noorig' }); const callsN = llm.stats.calls.correction; await pa.goto(U + '/quizzes'); await pa.waitForSelector('h1'); await pa.click('a:has-text("فتح") >> nth=0'); await pa.waitForSelector('#start-solve'); await startSolving(pa); await answerUntilWrong(pa);
  const rightN = norm(await pa.locator('.opt.right .txt').first().textContent()); await pa.waitForSelector('.fx-ar p', { timeout: 15000 }); const fixed = norm(await pa.locator('.fx-ar p').textContent());
  assert(fixed.startsWith('الصواب: «' + rightN + '»'), 'Arabic text that forgot the original right answer: the original is put in front (it is the only thing missing): ' + fixed); assert.strictEqual(llm.stats.calls.correction - callsN, 2, 'after one retry');
  await control({ fixMode: null }); console.log('B) a model that answers in English is never shown (the slip and the original explanation stay); one that only forgets the original has it put in front; one retry in both cases');

  // ================= C) the model unreachable: the page says so, one more try works
  await pa.goto(U + '/quizzes'); await pa.waitForSelector('h1'); await pa.click('a:has-text("فتح") >> nth=0'); await pa.waitForSelector('#start-solve');
  await pa.evaluate(() => { const orig = window.fetch; window.__fail = 1; window.fetch = (u, i) => (String(u).includes('/correction') && window.__fail-- > 0 ? Promise.resolve(new Response(JSON.stringify({ available: true, ar: null, reason: 'failed' }), { status: 200, headers: { 'content-type': 'application/json' } })) : orig(u, i)); });
  await startSolving(pa); await answerUntilWrong(pa); const retry = pa.locator('.fx-ar button'); await retry.waitFor({ timeout: 10000 }); assert(/مرة أخرى/.test(await retry.textContent()), 'a retry is offered');
  await retry.click(); await pa.waitForSelector('.fx-ar p', { timeout: 15000 }); assert(/^الصواب: /.test(norm(await pa.locator('.fx-ar p').textContent())), 'and it works'); assert.strictEqual(await pa.locator('.fx-ar button').count(), 0);
  console.log('C) the model unreachable: "try again" is offered, and works'); await ctxA.close();

  // ================= D) no AI at all
  const ctxD = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctxD); const pd = await ctxD.newPage(); watch(pd); const callsD = { ...llm.stats.calls };
  await upload(pd); await toNewQuiz(pd); await createQuiz(pd, { count: 10, timeout: 90000 }); await startSolving(pd); await answerUntilWrong(pd);
  await pd.locator('.fix').waitFor(); assert((await pd.locator('.fix del.fx-wrong').count()) === 1 && (await pd.locator('.fix strong.fx-right').count()) === 1, 'the slip does not need an AI');
  const expl = norm(await pd.locator('.explain').textContent()); assert(/الإجابة الصحيحة مبنية على نص المحاضرة/.test(expl), 'the local explanation is Arabic around the lecture\'s own sentence: ' + expl.slice(0, 160));
  assert.strictEqual(await pd.locator('.orig .olbl').count(), 0, 'an Arabic explanation is not "the original" of anything'); assert((await pd.locator('.evidence blockquote mark.key').count()) >= 1, 'the right word is marked in the lecture sentence');
  await pd.waitForTimeout(800); assert.strictEqual(await pd.locator('.fx-ar p').count(), 0, 'no Arabic block: there is no model, and nothing to translate'); assert.deepStrictEqual(llm.stats.calls, callsD, 'no model was asked for anything');
  await assertHidden(pd, 'a wrong answer (local quiz)'); console.log('D) no AI: the slip, the Arabic explanation around the lecture\'s own sentence, the right word marked - and no model call'); await ctxD.close();

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('correction E2E ok'); await b.close(); await site.close(); await llm.close();
})().catch((e) => { console.error(e); process.exit(1); });
