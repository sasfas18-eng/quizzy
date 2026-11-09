// node test/run.js <dist-dir> <pdf> <pptx>  — drives the built Claude edition in Chromium with the local shim.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert'); const { assertHidden, createQuiz, reportOf } = require('./flow.js');
const [dist, pdf, pptx] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8791);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errs.push('C ' + m.text()); });
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const S = (n) => p.screenshot({ path: `/tmp/shots/ce-${n}.png`, fullPage: true });
  await p.goto('http://localhost:8791/#/files'); await p.waitForSelector('h1:has-text("ملفاتي")');
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 30000 }); console.log('pdf row:', (await p.textContent('tbody tr')).replace(/\s+/g, ' ').slice(0, 120)); await S('files');
  await assertHidden(p, 'files page'); await p.click('tbody tr td.bidi a'); await p.waitForSelector('a:has-text("إنشاء كويز")'); await assertHidden(p, 'file page'); console.log('file page:', (await p.innerText('main')).replace(/\s+/g, ' ').slice(0, 120));
  await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await assertHidden(p, 'new-quiz page'); await S('new');
  assert(await p.locator('#connect-ai').count() === 0, 'Claude edition: no key card, the viewer\'s Claude is the AI');
  await createQuiz(p); await S('ready'); await assertHidden(p, 'ready page'); console.log('report:', (await reportOf(p)).slice(0, 200));
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await assertHidden(p, 'solve page'); await S('solve');
  // practice answers at once even when saving is slow (a claude.ai db write can take a second or more): the right answer and the explanation do not wait for the save
  await p.evaluate(() => { window.__dbDelay = 1500; }); await p.click('button:has-text("التالي")'); await p.waitForSelector('.opt:not([disabled])');
  { const t0 = Date.now(); await p.click('.opt >> nth=1'); await p.waitForSelector('.explain'); const dt = Date.now() - t0; assert(dt < 700, `practice feedback waited for the save: ${dt} ms`);
    assert(await p.locator('.opt.right').count() === 1, 'the right answer is marked'); console.log(`practice feedback in ${dt} ms with a 1500 ms save`); }
  await p.evaluate(() => { window.__dbDelay = 0; }); await p.waitForTimeout(1800);
  await p.reload(); await p.waitForSelector('.stem'); console.log('resumed:', await p.textContent('.qhead .badge'));
  assert(await p.locator('.explain').count() === 1 && await p.locator('.opt.right').count() === 1, 'the answer given before the reload was saved (revealed again after it)');
  await p.click('aside button:has-text("تسليم")'); await p.click('.modal button:has-text("سلّم الآن")'); await p.waitForSelector('text=نتيجتك'); await assertHidden(p, 'result page'); await S('result');
  await p.goto('http://localhost:8791/#/cards'); await p.waitForSelector('button:has-text("توليد بطاقات")'); await p.click('button:has-text("توليد بطاقات")'); await p.waitForSelector('table', { timeout: 30000 });
  await p.goto('http://localhost:8791/#/cards/study'); await p.waitForSelector('.flip'); await p.click('.flipin'); await p.click('button:has-text("أعرفها")'); await S('cards');
  await p.goto('http://localhost:8791/#/files'); await p.setInputFiles('#file', pptx); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2, null, { timeout: 30000 }); console.log('pptx ok rows=2');
  // the quiz as paper in the Claude edition: the owner's template, saved as a real PDF file through claude.ai's `downloads` capability
  await p.goto('http://localhost:8791/#/quizzes'); await p.click('table a'); await p.click('a:has-text("PDF مع مفتاح")'); await p.waitForSelector('.sheet .pq'); await p.waitForSelector('#save-pdf');
  assert((await p.locator('.csheet').count()) >= 1 && (await p.locator('.qsheet .pstrip .ppill:has-text("ANSWER KEY")').count()) >= 1, 'question sheets with the ANSWER KEY strip + the Correction Sheet');
  await p.click('#save-pdf'); await p.waitForFunction(() => window.__saved, null, { timeout: 60000 }); const saved = await p.evaluate(() => window.__saved);
  assert(/\.pdf$/.test(saved.filename) && saved.size > 20000, 'a real PDF file was handed to claude.ai to save: ' + JSON.stringify(saved)); console.log('pdf saved:', JSON.stringify(saved));
  console.log('ERRS', JSON.stringify(errs)); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
