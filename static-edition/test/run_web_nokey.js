// node static-edition/test/run_web_nokey.js <dist> <pdf> [pptx]  — the website with NO key at all: upload -> "إنشاء الكويز" -> questions, built locally from the file's text.
// Asserts: nothing is sent to any outside host, the page never blocks on a key, no "token" wording, quiz is solvable, cards work, and an optional AI connect stays available.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs'); const serve = require('./serve.js'); const { seedAccount, EMAIL, PASSWORD } = require('./signin.js'); const { assertHidden, createQuiz, reportOf } = require('../../claude-edition/test/flow.js');
const [dist, pdf, pptx] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); await seedAccount(p.context()); const errs = [], outside = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('C ' + m.text()); });
  p.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) outside.push(r.method() + ' ' + r.url().slice(0, 80)); });
  const U = site.url + '/#'; const S = (n) => p.screenshot({ path: `/tmp/shots/nokey-${n}.png`, fullPage: true });
  const run = async (file, label) => {
    await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', file); await p.waitForSelector('table'); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
    await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#local-note'); await assertHidden(p, label + ': new-quiz page (no key)');
    assert(await p.locator('#create-quiz').isEnabled(), 'the create button is NOT blocked without a key'); assert((await p.locator('#local-note').textContent()).includes('على جهازك فورًا'));
    await S(label + '-new'); await createQuiz(p, { count: 10, timeout: 60000 }); await assertHidden(p, label + ': ready'); await S(label + '-ready');
    assert(await p.locator('#local-ready-note').count() === 1, 'ready page says how the quiz was built'); const rep = (await reportOf(p)); assert(/المولّد: محلي \(بدون ذكاء اصطناعي\)/.test(rep), 'generator label: ' + rep.slice(-140));
    const n = await p.evaluate(async () => { const l = await (await fetch('/api/quizzes')).json(); const q = await (await fetch('/api/quizzes/' + l[0].id + '/questions')).json(); return q.map((x) => ({ stem: x.stem, n: x.options.length, ev: x.evidence.length, quote: x.evidence[0] && x.evidence[0].quote })); });
    assert(n.length >= 3, label + ': delivered ' + n.length); n.forEach((q) => { assert.strictEqual(q.n, 4); assert(q.ev >= 1 && q.quote); }); console.log(label + ': delivered', n.length, 'questions, e.g.:', n[0].stem.replace(/\s+/g, ' ').slice(0, 110));
    return n.length;
  };
  await run(pdf, 'pdf');
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await assertHidden(p, 'solve'); await S('solve');
  // the time on the result is the time spent, even when submitting between two automatic saves (it showed 00:00 / 00:40 for a full minute)
  await p.waitForTimeout(3200); await p.click('button:has-text("تسليم")'); await p.click('.modal button.primary'); await p.waitForURL(/result/); await p.waitForSelector('h1');
  const spent = (await p.innerText('main')).match(/(\d\d):(\d\d)/); assert(spent && +spent[1] * 60 + +spent[2] >= 3, 'the result shows the time really spent: ' + (spent && spent[0]));
  const nWrong = +((await p.textContent('button:has-text("أعد حل الأخطاء")')).match(/\((\d+)\)/) || [])[1]; assert(nWrong >= 1, 'the result offers to redo the mistakes');
  await p.click('button:has-text("أعد حل الأخطاء")'); await p.waitForURL((u) => !/result/.test(u.toString())); await p.waitForSelector('.stem');
  assert(new RegExp(`من ${nWrong}\\b`).test(await p.innerText('main')), 'redoing the mistakes is an attempt of exactly those questions');
  if (pptx) { await run(pptx, 'pptx'); }
  // a short file asked for MORE than it holds: the real questions it has, told honestly - never «مراجعة» copies, never the same question twice (no padding)
  await p.goto(U + '/files'); await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#local-note'); await createQuiz(p, { count: 30, timeout: 60000 });
  await p.waitForSelector('#shortfall-note'); const note = await p.textContent('#shortfall-note');
  const sq = await p.evaluate(async () => { const l = await (await fetch('/api/quizzes')).json(); return (await (await fetch('/api/quizzes/' + l[0].id + '/questions')).json()).map((x) => x.stem); });
  assert(sq.length < 30 && sq.length >= 8, 'a 3-page file asked for 30: ' + sq.length); assert(!sq.some((s) => /^(مراجعة|Review):/.test(s)), 'no review copies'); assert.strictEqual(new Set(sq).size, sq.length, 'no question twice');
  assert(/لا يكفي إلا لـ/.test(note), note); console.log(`short file asked for 30: ${sq.length} real questions; note: ${note.trim().slice(0, 100)}`);
  // cards without a key
  await p.goto(U + '/cards'); await p.waitForSelector('#local-cards-note'); await p.click('button:has-text("توليد بطاقات") >> nth=0'); await p.waitForSelector('table', { timeout: 30000 }); const rows = await p.locator('tbody tr').count(); assert(rows >= 3, 'cards without a key: ' + rows); console.log('cards rows:', rows);
  // there is no AI box anywhere (not on the new-quiz page, not in the menu); the operator's unlisted #/operator has no AI card
  await p.goto(U + '/files'); await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#local-note');
  assert.strictEqual(await p.locator('#connect-ai').count(), 0, 'a visitor never sees the AI box'); assert.strictEqual(await p.locator('#local-note summary').count(), 0); assert.strictEqual(await p.locator('nav a[href="#/settings"]').count(), 0);
  assert(!/مفتاح مجاني|اربط ذكاء|الصق/.test(await p.textContent('main')), 'no "paste a key" hint for visitors');
  await p.goto(U + '/operator'); await p.waitForSelector('#op-on'); assert.strictEqual(await p.locator('#quick-key').count(), 0, 'no key field anywhere');
  // the operator's page has NO AI box at all any more (the site makes every quiz locally): the accounts check, the learning agent, Chrome's built-in model
  await p.click('#op-on'); await p.waitForSelector('#chrome-ai-state'); assert.strictEqual(await p.locator('#connect-ai, #quick-key, #chain-box, #relay-status, #site-ai, #publish-ai').count(), 0, 'no AI key / provider / relay / publish card');
  assert(['unsupported', 'unavailable', 'downloadable'].includes(await p.getAttribute('#chrome-ai-state', 'data-state')), 'the card tells what this browser offers (this headless Chromium exposes the API with the model not downloaded)'); assert.strictEqual(await p.locator('nav a[href="#/operator"]').count(), 1, 'operator mode: the menu link appears'); await S('operator-box');
  assert.deepStrictEqual(outside, [], 'no request left this machine: ' + outside.join(' | ')); console.log('outside requests: none · ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|'));
  console.log('no-key website E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
