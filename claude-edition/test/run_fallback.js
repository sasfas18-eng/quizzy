// node claude-edition/test/run_fallback.js <dist> <pdf> — Claude is reachable but the viewer did NOT grant its use (the real failure seen in the field:
// "لم تُمنح صلاحية استخدام Claude"): the quiz fails with a clear message and ONE click builds it locally instead. Zero model calls for the local quiz.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert'); const { assertHidden, createQuiz } = require('./flow.js');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8796);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const U = 'http://localhost:8796/?denysample#';
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")');
  await p.waitForSelector('text=المصدر'); assert.strictEqual(await p.locator('#local-note').count(), 0, 'Claude is available: no "no key" note'); await assertHidden(p, 'new-quiz page');
  // the optional checkbox lives inside the folded extras and builds locally from the start
  assert.strictEqual(await p.locator('#use-local').count(), 1);
  await createQuiz(p, { count: 10, wait: 'none' }); await p.waitForSelector('#use-local, #retry', { timeout: 30000 }); const msg = (await p.textContent('.alert.bad')).trim(); console.log('failure shown:', msg.slice(0, 80)); assert(msg.includes('لم تُمنح صلاحية استخدام Claude'));
  await assertHidden(p, 'failure view'); await p.click('#use-local'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 40000 }); assert.strictEqual(await p.locator('#local-ready-note').count(), 1);
  const rep = (await p.textContent('text=تقرير الجودة >> xpath=..')).replace(/\s+/g, ' '); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(rep)); console.log('one click later: ready, generator =', rep.match(/المولّد: ([^·]+)/)[1].trim());
  // and the checkbox path from the start: a fresh quiz, local on purpose, no failure at all
  await p.goto(U + '/files'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); await p.click('summary:has-text("خيارات إضافية")'); await p.check('#use-local');
  await createQuiz(p, { count: 10 }); assert.strictEqual(await p.locator('#local-ready-note').count(), 1); console.log('checkbox path ok');
  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
