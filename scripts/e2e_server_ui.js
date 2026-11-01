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
  await p.goto(B + '/#/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await assertHidden(p, 'files'); await p.click('a:has-text("التفاصيل")'); await p.waitForSelector('text=جودة الاستخراج'); await assertHidden(p, 'file detail');
  await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); await assertHidden(p, 'new-quiz page'); assert.strictEqual(await p.locator('#connect-ai').count(), 0, 'the server has its own AI: no key card');
  // ---- one click -> the finished quiz (analysis + generation are chained by the server; no plan screen, no confirmation)
  await createQuiz(p, { timeout: 120000 }); await assertHidden(p, 'ready page'); const quizId = p.url().split('/quiz/')[1];
  const qs = await p.evaluate(async (id) => (await (await fetch('/api/quizzes/' + id + '/questions')).json()), quizId); assert(qs.length >= 2, 'questions were delivered');
  console.log('quiz ready with', qs.length, 'questions; internal types:', [...new Set(qs.map((q) => q.qtype))].length, '(none shown on the page)');
  await p.click('button:has-text("بنك الأسئلة")'); await p.waitForSelector('.modal .stem'); await assertHidden(p, 'question bank'); await p.keyboard.press('Escape');
  // ---- solve, answer, submit
  await p.click('#start-solve'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await assertHidden(p, 'solve page'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await assertHidden(p, 'solve answered');
  // a WRONG answer shows the correction slip (what you chose crossed out, the right answer highlighted). The test provider explains in Arabic around the lecture's English sentence, so there is nothing to
  // translate: the endpoint says so and the page shows no Arabic block (the AI path of the endpoint is covered by backend/tests/test_correction.py and the browser test of the static edition).
  for (let i = 0; i < 12 && !(await p.locator('.explain strong:has-text("غير صحيحة")').count()); i++) { await p.click('button:has-text("التالي")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); }
  await p.locator('.fix').waitFor(); assert((await p.locator('.fix del.fx-wrong').count()) === 1 && (await p.locator('.fix strong.fx-right').count()) === 1 && (await p.locator('.fix .stamp').count()) === 1, 'server edition: the correction slip of a wrong answer');
  assert((await p.locator('.evidence blockquote mark.key').count()) >= 1, 'the right word is marked in the lecture sentence'); await assertHidden(p, 'a wrong answer');
  { const r = await p.evaluate(async () => { const id = location.hash.match(/attempt\/(\w+)/)[1]; const a = await (await fetch('/api/attempts/' + id)).json(); const q = a.questions.find((x) => x.answered && !x.is_correct);
      const wrong = await (await fetch('/api/attempts/' + id + '/correction', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question_id: q.id }) })).json();
      const fresh = a.questions.find((x) => !x.answered); const early = fresh ? (await fetch('/api/attempts/' + id + '/correction', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question_id: fresh.id }) })).status : null; return { wrong, early }; });
    assert.deepStrictEqual(r.wrong, { available: false, reason: 'already_arabic' }, 'nothing to translate: ' + JSON.stringify(r.wrong)); assert(r.early === null || r.early === 409, 'an unanswered question reveals nothing: ' + r.early); }
  await p.click('aside button:has-text("تسليم")'); await p.click('.modal button:has-text("سلّم الآن")'); await p.waitForSelector('text=نتيجتك'); await assertHidden(p, 'result page');
  assert((await p.locator('#revisit').count()) + (await p.locator('.alert.ok:has-text("أحسنت")').count()) === 1, 'result shows which source pages to revisit (or full marks) instead of per-type bars');
  // ---- leave the page right after clicking: the server must finish on its own
  await p.goto(B + '/#/files'); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); await p.click('button:has-text("استبعد")'); await p.click('.chips button:text-is("20")'); await p.click('#create-quiz'); await p.waitForSelector('#stage, .progress, h2:has-text("جاهز للحل")');
  await p.goto(B + '/#/quizzes'); await p.waitForSelector('table');
  const done = await p.evaluate(async () => { for (let i = 0; i < 120; i++) { const l = await (await fetch('/api/quizzes')).json(); if (l.length >= 2 && l.every((q) => !['draft', 'analyzing', 'planned', 'generating'].includes(q.status))) return l.map((q) => q.status); await new Promise((r) => setTimeout(r, 500)); } return null; });
  assert(done && done.every((s) => s === 'ready'), 'both quizzes finished on the server although the student left the page: ' + JSON.stringify(done)); console.log('left the page mid-generation -> statuses:', done.join(','));
  await p.reload(); await p.waitForSelector('table'); await assertHidden(p, 'quizzes list');
  // ---- a NEW file straight from the new-quiz page (the server reads it in the background: the page waits for it, then lists it first and ticked)
  await p.goto(B + '/#/new'); await p.waitForSelector('#new-file-btn'); const before = await p.locator('#source-card .card').count();
  await p.setInputFiles('#new-file', { name: 'inline-upload.pdf', mimeType: 'application/pdf', buffer: require('fs').readFileSync(pdf) }); await p.waitForSelector('#source-card .alert.ok', { timeout: 60000 });
  assert.strictEqual(await p.locator('#source-card .card').count(), before + 1); assert.strictEqual(await p.locator('#source-card input[type=checkbox]:checked').count(), 1); assert(/inline-upload/.test(await p.locator('#source-card .card').first().textContent()));
  await assertHidden(p, 'new-quiz page after an upload'); console.log('new file uploaded from the new-quiz page (server edition): listed first and ticked');
  // ---- cards + account
  await p.goto(B + '/#/cards'); await p.click('button:has-text("توليد بطاقات")'); await p.waitForSelector('table'); await p.goto(B + '/#/cards/study'); await p.waitForSelector('.flip'); await assertHidden(p, 'card study'); await p.goto(B + '/#/account'); await p.waitForSelector('text=حسابي'); await assertHidden(p, 'account');
  // ---- guest: no registration. The door on the landing page, the notice (nothing guaranteed, how long it lives), registering keeps the work, leaving asks first
  { const gctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const g = await gctx.newPage(); g.on('pageerror', (e) => errs.push('GPE ' + e.message));
    await g.goto(B + '/#/'); await g.waitForSelector('.hero h1'); await g.click('#guest-enter'); await g.waitForSelector('text=أهلًا بك');
    assert(/لا ضمان/.test(await g.textContent('#guest-note')) && /يومًا/.test(await g.textContent('#guest-note')), 'the notice says nothing is guaranteed and for how long the temporary account lives');
    await g.goto(B + '/#/files'); await g.setInputFiles('#file', pdf); await g.waitForSelector('table'); await assertHidden(g, 'guest files page');
    await g.goto(B + '/#/account'); await g.waitForSelector('#guest-account'); assert.strictEqual(await g.locator('text=تغيير كلمة المرور').count(), 0, 'a guest has no password');
    await g.goto(B + '/#/register'); await g.waitForSelector('#guest-upgrade'); await g.fill('#name', 'كانت ضيفة'); await g.fill('#email', `up${Date.now()}@example.com`); await g.fill('#password', 'password-123'); await g.click('#go'); await g.waitForSelector('text=أهلًا كانت ضيفة');
    assert.strictEqual(await g.locator('#guest-note').count(), 0); await g.goto(B + '/#/files'); await g.waitForSelector('table'); assert.strictEqual(await g.locator('tbody tr').count(), 1, 'the guest file survived registering');
    await gctx.close();
    const lctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const l = await lctx.newPage(); await l.goto(B + '/#/'); await l.waitForSelector('.hero h1'); await l.click('#guest-enter'); await l.waitForSelector('text=أهلًا بك');
    await l.click('header button:has-text("خروج")'); await l.waitForSelector('.modal'); assert(/الخروج من وضع الضيف/.test(await l.textContent('.modal h2')), 'leaving asks first'); await l.click('.modal button:has-text("إلغاء")'); assert.strictEqual(await l.locator('#guest-note').count(), 1, 'cancel: still a guest');
    await l.click('header button:has-text("خروج")'); await l.click('.modal button:has-text("اخرج")'); await l.waitForSelector('.hero h1'); await lctx.close(); console.log('guest (server edition): door, notice, kept when registering, leaving asks first'); }
  console.log('server UI ok; page errors:', errs.length); assert.strictEqual(errs.length, 0, errs.join('|')); await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
