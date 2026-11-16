// node claude-edition/test/run_unpack.js <dist> <packed-dist> — VERSION 38 TAKEN BACK (Chromium, the claude.ai store simulated by shim.js):
// for an hour a lecture's slides and its explanations were kept packed (a few zipped documents). A lecture kept that way, opened with this version:
//  1) its slides are read (one document a slide again), its explanations shown as kept (Claude not asked again), the packs removed
//  2) a quiz is made from it
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, packed] = process.argv.slice(2); const PDF = path.join(dist, 'corpus', 'cardiac.pdf'); let root = packed;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(d); } }); });
const held = (p) => p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('qz_shim_db') || '{}')).map((k) => k.slice(k.lastIndexOf('/') + 1)));
(async () => {
  srv.listen(8818); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  let p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  // the lecture kept by version 38: packed
  await p.goto('http://localhost:8818/#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fexplain', { timeout: 30000 });
  await p.click('tbody tr a.fexplain'); await p.waitForSelector('.xidea', { timeout: 20000 }); await p.waitForSelector('.xready.all', { timeout: 60000 });
  let h = await held(p); const id = await p.evaluate(async () => (await (await fetch('/api/documents')).json())[0].id);
  assert(h.some((k) => k.startsWith('pgk_' + id)) && h.some((k) => k.startsWith('xpk_' + id)) && !h.some((k) => k.startsWith('page_')), 'set up: kept packed');
  const idea = await p.textContent('.xidea'); await p.close();
  // this version opens it
  root = dist; p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8818/#/files'); await p.waitForSelector('tbody tr a.fexplain', { timeout: 20000 });
  await p.click('tbody tr a.fexplain'); await p.waitForSelector('.xidea', { timeout: 20000 }); await p.waitForSelector('.xready.all', { timeout: 20000 });
  assert.strictEqual(await p.evaluate(() => (window.__explain || []).length + (window.__explainBatch || []).length), 0, '1) the kept explanations are shown: Claude is not asked again');
  assert.strictEqual(await p.textContent('.xidea'), idea, '1) the same explanation');
  assert((await p.locator('.xslide [data-line]').count()) >= 2, '1) the slide\'s text is there');
  h = await held(p); assert(!h.some((k) => /^(pgk_|xpk_)/.test(k)), '1) the packs are removed: ' + h.filter((k) => /^(pgk_|xpk_)/.test(k)));
  const n = (await p.evaluate(async (i) => (await (await fetch('/api/documents/' + i)).json()).page_count, id));
  assert.strictEqual(h.filter((k) => k.startsWith('page_' + id + '_')).length, n, '1) one document a slide again'); assert(h.filter((k) => k.startsWith('xpc_')).length >= n - 3, '1) one an explanation again');
  console.log(`1) a lecture kept packed by version 38 (${n} slides) is read as before: its explanations shown (Claude not asked), one document a slide again, the packs removed`);
  await p.goto('http://localhost:8818/#/files'); await p.waitForSelector('tbody tr a.fquiz', { timeout: 20000 }); await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz');
  await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل"), #retry', { timeout: 240000 });
  const made = await p.evaluate(async () => { const qid = location.hash.split('/')[2]; const qs = await (await fetch('/api/quizzes/' + qid + '/questions')).json(); return (Array.isArray(qs) ? qs : qs.questions || []).length; });
  assert(made >= 5, '2) the quiz is made: ' + made); console.log(`2) a quiz is made from it (${made} questions)`);
  assert.deepStrictEqual(errs, [], 'no page errors: ' + errs.join(' | '));
  console.log('unpack ok'); await b.close(); srv.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
