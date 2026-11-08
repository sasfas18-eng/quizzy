// node test/run_local.js <dist> <pdf> — a viewer NOT signed in to claude.ai (db/user/sample all null): device-local storage; in this edition every question is Claude's,
// so no quiz is made without Claude (no local generator here): the new-quiz page says how to get Claude and the create button waits for it.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert'); const { assertHidden, reportOf } = require('./flow.js');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8794);
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); await p.addInitScript(() => { window.claude = { use: async () => null }; });
  const U = 'http://localhost:8794/#';
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(300); console.log('banner:', (await p.textContent('#ce-banner')).slice(0, 60));
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz');
  await assertHidden(p, 'new-quiz page (no AI)');
  // not signed in (no Claude): nothing is generated without Claude - the page says how to get it, the button waits, and no local quiz is made
  await p.waitForSelector('#claude-needed-note'); const note = (await p.textContent('#claude-needed-note')).trim(); console.log('note:', note.slice(0, 90));
  assert(/claude\.ai/i.test(note) && !/محلي|على جهازك فورًا/.test(note), 'the note points to Claude and offers no local quiz: ' + note);
  assert(!(await p.locator('#create-quiz').isEnabled()), 'creating waits for Claude'); assert.strictEqual(await p.locator('#local-note').count(), 0, 'no local mode is offered');
  const caps = await p.evaluate(async () => (await fetch('/api/auth/capabilities')).json()); assert.strictEqual(caps.rules_mode, false, 'the local generator is not part of this edition');
  assert.strictEqual(await p.evaluate(() => !!(window.QZE && window.QZE.rules)), false, 'rules.js is not even loaded');
  console.log('no Claude -> no quiz (and no local generator loaded)');
  await p.goto(U + '/files'); await p.waitForSelector('table'); console.log('files persisted:', await p.locator('tbody tr').count());
  console.log('ERRS', JSON.stringify(errs)); await b.close(); srv.close(); })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
