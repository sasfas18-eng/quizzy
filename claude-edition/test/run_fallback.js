// node claude-edition/test/run_fallback.js <dist> <pdf> — when Claude cannot write the quiz (the real failure seen in the field: "لم تُمنح صلاحية استخدام Claude").
// In this edition every question is Claude's, so nothing is built locally instead:
//  1) Claude not granted -> the page says so plainly and offers to try again; no local quiz, no "build without AI" button;
//  2) Claude answers but nothing survives the checks -> the page says that Claude wrote no question that passed, and offers to try again; no local quiz.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert'); const { assertHidden, createQuiz, reportOf } = require('./flow.js');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8796);
(async () => { const b = await chromium.launch(); const errs = [];
  const open = async (query) => { const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript({ path: path.join(__dirname, 'shim.js') });
    const U = `http://localhost:8796/${query}#`; await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); return [p, U]; };
  const failed = async (p, timeout) => { await p.waitForSelector('#retry', { timeout }); const t = await p.textContent('.alert.bad');
    assert.strictEqual(await p.locator('#fallback-note').count(), 0, 'no local quiz'); assert.strictEqual(await p.locator('#local-ready-note').count(), 0); assert.strictEqual(await p.locator('#use-local').count(), 0, 'no "build without AI" offer'); return t; };
  // 1) the viewer did not grant Claude
  { const [p] = await open('?denysample'); await assertHidden(p, 'new-quiz page'); await createQuiz(p, { count: 10, wait: 'none' }); const t = await failed(p, 30000);
    console.log('Claude not granted -> said plainly, try again (no local quiz): ' + t.slice(0, 90)); await p.close(); }
  // 2) the model answers but nothing survives the checks
  { const [p] = await open('?badquotes'); await createQuiz(p, { count: 10, wait: 'none' }); const t = await failed(p, 90000); assert(/لم يكتب Claude سؤالًا اجتاز الفحوص/.test(t), 'it says why: ' + t);
    console.log('nothing usable from Claude -> said plainly, try again (no local quiz): ' + t.slice(0, 90)); await p.close(); }
  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
