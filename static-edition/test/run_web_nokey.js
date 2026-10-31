// node static-edition/test/run_web_nokey.js <dist> <pdf> [pptx]  — the website with NO key at all: upload -> "إنشاء الكويز" -> questions, built locally from the file's text.
// Asserts: nothing is sent to any outside host, the page never blocks on a key, no "token" wording, quiz is solvable, cards work, and an optional AI connect stays available.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs'); const serve = require('./serve.js'); const { assertHidden, createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf, pptx] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [], outside = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('C ' + m.text()); });
  p.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) outside.push(r.method() + ' ' + r.url().slice(0, 80)); });
  const U = site.url + '/#'; const S = (n) => p.screenshot({ path: `/tmp/shots/nokey-${n}.png`, fullPage: true });
  const run = async (file, label) => {
    await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', file); await p.waitForSelector('table'); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
    await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#local-note'); await assertHidden(p, label + ': new-quiz page (no key)');
    assert(await p.locator('#create-quiz').isEnabled(), 'the create button is NOT blocked without a key'); assert((await p.locator('#local-note').textContent()).includes('بلا أي مفتاح'));
    await S(label + '-new'); await createQuiz(p, { count: 10, timeout: 60000 }); await assertHidden(p, label + ': ready'); await S(label + '-ready');
    assert(await p.locator('#local-ready-note').count() === 1, 'ready page says how the quiz was built'); const rep = (await p.textContent('text=تقرير الجودة >> xpath=..')).replace(/\s+/g, ' '); assert(/المولّد: محلي \(بدون ذكاء اصطناعي\)/.test(rep), 'generator label: ' + rep.slice(-140));
    const n = await p.evaluate(async () => { const l = await (await fetch('/api/quizzes')).json(); const q = await (await fetch('/api/quizzes/' + l[0].id + '/questions')).json(); return q.map((x) => ({ stem: x.stem, n: x.options.length, ev: x.evidence.length, quote: x.evidence[0] && x.evidence[0].quote })); });
    assert(n.length >= 3, label + ': delivered ' + n.length); n.forEach((q) => { assert.strictEqual(q.n, 4); assert(q.ev >= 1 && q.quote); }); console.log(label + ': delivered', n.length, 'questions, e.g.:', n[0].stem.replace(/\s+/g, ' ').slice(0, 110));
    return n.length;
  };
  await run(pdf, 'pdf');
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await assertHidden(p, 'solve'); await S('solve');
  if (pptx) { await run(pptx, 'pptx'); }
  // cards without a key
  await p.goto(U + '/cards'); await p.waitForSelector('#local-cards-note'); await p.click('button:has-text("توليد بطاقات") >> nth=0'); await p.waitForSelector('table', { timeout: 30000 }); const rows = await p.locator('tbody tr').count(); assert(rows >= 3, 'cards without a key: ' + rows); console.log('cards rows:', rows);
  // the optional AI upgrade stays one click away (inside the note), never in the way
  await p.goto(U + '/files'); await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#local-note summary'); await p.click('#local-note summary'); await p.waitForSelector('#connect-ai', { state: 'visible' });
  assert.deepStrictEqual(outside, [], 'no request left this machine: ' + outside.join(' | ')); console.log('outside requests: none · ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|'));
  console.log('no-key website E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
