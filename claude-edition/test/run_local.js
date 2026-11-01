// node test/run_local.js <dist> <pdf> — a viewer NOT signed in to claude.ai (db/user/sample all null): device-local storage + the local (no-AI) generator.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert'); const { assertHidden, reportOf } = require('./flow.js');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8794);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript(() => { window.claude = { use: async () => null }; });
  const U = 'http://localhost:8794/#';
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(300); console.log('banner:', (await p.textContent('#ce-banner')).slice(0, 60));
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz');
  await assertHidden(p, 'new-quiz page (no AI)');
  // not signed in (no Claude): the page does NOT block — the quiz is built locally, straight from the file's text, with zero AI calls
  await p.waitForSelector('#local-note'); console.log('local note:', (await p.textContent('#local-note')).trim().slice(0, 80)); assert((await p.textContent('#local-note')).includes('على جهازك فورًا'));
  assert((await p.locator('#create-quiz').isEnabled()), 'creating is possible without Claude');
  await p.click('.chips button:text-is("10")'); await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 40000 }); await assertHidden(p, 'ready page (local)');
  assert(await p.locator('#local-ready-note').count() === 1); const rep = (await reportOf(p)); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(rep), rep.slice(-120));
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain');
  await p.reload(); await p.waitForSelector('.stem'); console.log('solved + resumed after reload (device-local storage)');
  await p.goto(U + '/files'); await p.waitForSelector('table'); console.log('files persisted:', await p.locator('tbody tr').count());
  console.log('ERRS', JSON.stringify(errs)); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
