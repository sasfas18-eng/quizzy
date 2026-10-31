// node test/run_rules.js <dist> <pdf> — no-token flow with Claude unavailable; asserts 0 LLM calls.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8793);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const U = 'http://localhost:8793/?nosample#'; const S = (n) => p.screenshot({ path: `/tmp/shots/rules-${n}.png`, fullPage: true });
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table');
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=طريقة التوليد'); await p.click('button:has-text("آلي بدون توكن")'); await S('setup');
  await p.click('button:has-text("متابعة: تحليل")'); await p.waitForSelector('button:has-text("حلّل المحتوى")'); console.log('analyze disabled?', await p.locator('button:has-text("حلّل المحتوى")').isDisabled());
  await p.click('button:has-text("حلّل المحتوى")'); await p.waitForSelector('text=خطة الكويز', { timeout: 20000 }); await S('plan');
  const gen = p.locator('button:has-text("ابدأ توليد")'); if (await gen.isDisabled()) await p.check('.card input[type=checkbox] >> nth=0'); await gen.click(); await p.waitForSelector('text=جاهز للحل', { timeout: 20000 }); await S('ready');
  console.log('generator label:', (await p.textContent('text=المولّد: >> xpath=..')).slice(-120));
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await S('solve');
  await p.goto(U + '/cards'); await p.check('label:has-text("بدون توكن") input'); await p.click('button:has-text("توليد بطاقات")'); await p.waitForSelector('table', { timeout: 20000 }); console.log('cards rows:', await p.locator('tbody tr').count());
  console.log('LLM calls:', await p.evaluate(() => window.__calls || 0), 'ERRS', JSON.stringify(errs)); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
