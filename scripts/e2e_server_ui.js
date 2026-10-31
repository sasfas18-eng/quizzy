// node scripts/e2e_server_ui.js <base-url> <pdf>
// The SERVER edition's website in a real browser (same frontend as the other editions): ONE step from file to quiz, the question
// types never shown, and generation that keeps going on the server when the student leaves the page.
// Needs a server running with a generator (CI: QUIZZY_ALLOW_FAKE_LLM=1 -> clearly labelled test content).
const { chromium } = require('playwright'); const assert = require('assert'); const { assertHidden, createQuiz } = require('../claude-edition/test/flow.js');
const [B, pdf] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const email = `ui${Date.now()}@example.com`;
  await p.goto(B + '/#/register'); await p.fill('#name', 'سارة'); await p.fill('#email', email); await p.fill('#password', 'password-123'); await p.click('#go'); await p.waitForSelector('text=أهلًا'); await assertHidden(p, 'dashboard');
  await p.goto(B + '/#/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('a:has-text("التفاصيل")', { timeout: 60000 }); await assertHidden(p, 'files'); await p.click('a:has-text("التفاصيل")'); await p.waitForSelector('text=جودة الاستخراج'); await assertHidden(p, 'file detail');
  await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await assertHidden(p, 'new-quiz page'); assert.strictEqual(await p.locator('#connect-ai').count(), 0, 'the server has its own AI: no key card');
  // ---- one click -> the finished quiz (analysis + generation are chained by the server; no plan screen, no confirmation)
  await createQuiz(p, { count: 10, timeout: 120000 }); await assertHidden(p, 'ready page'); const quizId = p.url().split('/quiz/')[1];
  const qs = await p.evaluate(async (id) => (await (await fetch('/api/quizzes/' + id + '/questions')).json()), quizId); assert(qs.length >= 2, 'questions were delivered');
  console.log('quiz ready with', qs.length, 'questions; internal types:', [...new Set(qs.map((q) => q.qtype))].length, '(none shown on the page)');
  await p.click('button:has-text("بنك الأسئلة")'); await p.waitForSelector('.modal .stem'); await assertHidden(p, 'question bank'); await p.keyboard.press('Escape');
  // ---- solve, answer, submit
  await p.click('#start-solve'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await assertHidden(p, 'solve page'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await assertHidden(p, 'solve answered');
  await p.click('aside button:has-text("تسليم")'); await p.click('.modal button:has-text("سلّم الآن")'); await p.waitForSelector('text=نتيجتك'); await assertHidden(p, 'result page');
  assert((await p.locator('#revisit').count()) + (await p.locator('.alert.ok:has-text("أحسنت")').count()) === 1, 'result shows which source pages to revisit (or full marks) instead of per-type bars');
  // ---- leave the page right after clicking: the server must finish on its own
  await p.goto(B + '/#/files'); await p.waitForSelector('a:has-text("التفاصيل")'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await createQuiz(p, { count: 20, wait: 'none' }); await p.waitForSelector('#stage, .progress, #start-solve');
  await p.goto(B + '/#/quizzes'); await p.waitForSelector('a.item');
  const done = await p.evaluate(async () => { for (let i = 0; i < 120; i++) { const l = await (await fetch('/api/quizzes')).json(); if (l.length >= 2 && l.every((q) => !['draft', 'analyzing', 'planned', 'generating'].includes(q.status))) return l.map((q) => q.status); await new Promise((r) => setTimeout(r, 500)); } return null; });
  assert(done && done.every((s) => s === 'ready'), 'both quizzes finished on the server although the student left the page: ' + JSON.stringify(done)); console.log('left the page mid-generation -> statuses:', done.join(','));
  await p.reload(); await p.waitForSelector('a.item'); await assertHidden(p, 'quizzes list');
  // ---- cards + account
  await p.goto(B + '/#/cards'); await p.click('button:has-text("توليد بطاقات")'); await p.waitForSelector('table'); await p.goto(B + '/#/cards/study'); await p.waitForSelector('.flip'); await assertHidden(p, 'card study'); await p.goto(B + '/#/account'); await p.waitForSelector('h1:has-text("حسابي")'); await assertHidden(p, 'account');
  console.log('server UI ok; page errors:', errs.length); assert.strictEqual(errs.length, 0, errs.join('|')); await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
