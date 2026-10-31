// node test/run_local.js <dist> <pdf> — a viewer NOT signed in to claude.ai (db/user/sample all null): device-local mode.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8794);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript(() => { window.claude = { use: async () => null }; });
  const U = 'http://localhost:8794/#';
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(300); console.log('banner:', (await p.textContent('#ce-banner')).slice(0, 60));
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=طريقة التوليد');
  console.log('chips:', await p.$$eval('.chips button', (b) => b.map((x) => x.textContent.trim()).filter((t) => /Claude|بدون توكن/.test(t)).join(' | ')));
  await p.click('button:has-text("متابعة: تحليل")'); await p.click('button:has-text("حلّل المحتوى")'); await p.waitForSelector('text=خطة الكويز', { timeout: 20000 });
  const gen = p.locator('button:has-text("ابدأ توليد")'); if (await gen.isDisabled()) await p.check('.card input[type=checkbox] >> nth=0'); await gen.click(); await p.waitForSelector('text=جاهز للحل', { timeout: 20000 });
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain');
  await p.reload(); await p.waitForSelector('.stem'); console.log('resumed after reload (IndexedDB):', await p.textContent('.qhead .badge'));
  await p.goto(U + '/files'); await p.waitForSelector('table'); console.log('files persisted:', await p.locator('tbody tr').count());
  console.log('ERRS', JSON.stringify(errs)); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
