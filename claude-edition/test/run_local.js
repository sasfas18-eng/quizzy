// node test/run_local.js <dist> <pdf> — a viewer NOT signed in to claude.ai (db/user/sample all null): device-local mode.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert'); const { assertHidden } = require('./flow.js');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8794);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript(() => { window.claude = { use: async () => null }; });
  const U = 'http://localhost:8794/#';
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(300); console.log('banner:', (await p.textContent('#ce-banner')).slice(0, 60));
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر');
  await assertHidden(p, 'new-quiz page (no AI)');
  // not signed in: the page says plainly that generation needs Claude (no silent weaker fallback), and creating a quiz does nothing destructive
  await p.waitForSelector('.alert.warn:has-text("claude.ai")'); console.log('no-AI notice:', (await p.textContent('.alert.warn')).trim().slice(0, 90));
  await p.click('.chips button:text-is("10")'); await p.click('#create-quiz'); await p.waitForTimeout(300);
  assert(p.url().includes('/new'), 'stays on the new-quiz page'); assert((await p.evaluate(async () => (await (await fetch('/api/quizzes')).json()).length)) === 0, 'no empty draft quiz is left behind');
  await p.reload(); await p.waitForSelector('text=المصدر');
  await p.goto(U + '/files'); await p.waitForSelector('table'); console.log('files persisted:', await p.locator('tbody tr').count());
  console.log('ERRS', JSON.stringify(errs)); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
