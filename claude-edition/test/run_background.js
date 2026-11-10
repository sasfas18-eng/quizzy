// node claude-edition/test/run_background.js <dist> — THE QUIZ GOES ON IN THE BACKGROUND (a student of the shared link, their data on their device):
//  1) the page is reloaded in the middle of the quiz (a phone does that to an app left in the background): the quiz goes on by itself from where it stopped - the
//     questions already written and checked are kept, their slots are never asked again, the screen says it went on - and it ends ready with the full count
//  2) the student leaves the progress screen for other pages: a small bar on every page shows the quiz being made and links to it, and the moment it is ready a
//     notice with a link says so; the link opens the ready quiz
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
// every slot asked of Claude, in this page load (window.__gen)
const RECORD = `(() => { window.__gen = []; const t = setInterval(() => { const c = window.claude; if (!c || c.__rec) return; clearInterval(t); c.__rec = true; const use = c.use.bind(c);
  c.use = async (n) => { const s = await use(n); if (n !== 'sample' || !s || s.__r) return s; const j = s.json.bind(s);
    s.json = async (input, o) => { if (input.includes('Write one question per slot')) { const a = input.indexOf('SLOTS:\\n') + 7, b = input.indexOf('\\nPAGES:\\n'); try { window.__gen.push(...JSON.parse(input.slice(a, b)).map((x) => x.slot)); } catch (_) { /* not this request */ } } return j(input, o); };
    s.__r = true; return s; }; }, 1); })();`;
const ckpt = (p, id) => p.evaluate((qid) => new Promise((res) => { const r = indexedDB.open('quizzy_local_v1', 1); r.onerror = () => res(null);
  r.onsuccess = () => { const g = r.result.transaction('kv', 'readonly').objectStore('kv').get('ckpt_' + qid); g.onsuccess = () => { const v = g.result || null; r.result.close(); res(v); }; g.onerror = () => { r.result.close(); res(null); }; }; }), id);
const ready = (p, timeout = 120000) => p.waitForSelector('h2:has-text("جاهز للحل")', { timeout });
(async () => {
  srv.listen(8810); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') }); await ctx.addInitScript({ content: RECORD });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8810/?viewer&lat=150#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });

  // 1) reloaded in the middle of the quiz
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("20")'); await p.waitForTimeout(200); await p.click('#create-quiz');
  await p.waitForSelector('#stage', { timeout: 30000 }); const id = await p.evaluate(() => (location.hash.match(/#\/quiz\/(\w+)/) || [])[1]);
  let ck = null; for (let i = 0; i < 300; i++) { ck = await ckpt(p, id); if (ck && ck.accepted.length >= 5) break; await p.waitForTimeout(100); }
  assert(ck && ck.accepted.length >= 5, 'a checkpoint of the questions accepted so far is kept while the quiz is made: ' + (ck ? ck.accepted.length : 'none'));
  assert.strictEqual(await p.locator('h2:has-text("جاهز للحل")').count(), 0, 'the quiz is not finished yet when the page is reloaded');
  const before = ck.accepted.map((c) => ({ slot: c.slot, stem: c.stem }));
  await p.reload(); await p.waitForSelector('#resumed-note', { timeout: 30000 });
  await ready(p); const after = await p.evaluate(() => window.__gen.slice());
  const qs = await p.evaluate(async (qid) => (await (await fetch('/api/quizzes/' + qid + '/questions')).json()), id);
  assert.strictEqual(qs.length, 20, 'the full count after the reload: ' + qs.length);
  const asked = new Set(after); const again = before.filter((c) => asked.has(c.slot)); assert.deepStrictEqual(again, [], 'no slot of the checkpoint was written again after the reload');
  const stems = new Set(qs.map((x) => x.stem)); const keptN = before.filter((c) => stems.has(c.stem)).length;
  assert.strictEqual(keptN, before.length, `the questions written before the reload are in the quiz (${keptN} of ${before.length})`);
  assert.strictEqual(await ckpt(p, id), null, 'the checkpoint is removed once the quiz is ready');
  console.log(`1) reloaded with ${before.length} questions written: the quiz went on by itself («تابعنا إنشاء هذا الكويز من حيث توقف»), wrote only the rest (${after.length} slots, none of the ${before.length} again), ready with 20, the ${before.length} kept`);

  // 2) the student moves to other pages while the quiz is made
  await p.goto('http://localhost:8810/?viewer&lat=150&n=2#/files'); await p.waitForSelector('tbody tr a.fquiz', { timeout: 20000 });
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(200); await p.click('#create-quiz');
  await p.waitForSelector('#stage', { timeout: 30000 }); const id2 = await p.evaluate(() => (location.hash.match(/#\/quiz\/(\w+)/) || [])[1]);
  assert(/يمكنك التنقل/.test(await p.textContent('#bg-note')), 'the progress screen says the student may move around');
  await p.evaluate(() => { location.hash = '#/files'; }); await p.waitForSelector(`#jobs-bar a.jobpill[href="#/quiz/${id2}"]`, { timeout: 15000 });
  assert(/cardiac/.test(await p.textContent('#jobs-bar')), 'the bar names the quiz being made');
  await p.evaluate(() => { location.hash = '#/quizzes'; }); await p.waitForSelector(`#jobs-bar a.jobpill[href="#/quiz/${id2}"]`, { timeout: 15000 });
  const note = p.locator(`.toast a[href="#/quiz/${id2}"]`); await note.waitFor({ timeout: 120000 });
  assert(/جاهز/.test(await p.locator('.toast').filter({ has: p.locator(`a[href="#/quiz/${id2}"]`) }).first().textContent()), 'the notice says the quiz is ready');
  await note.click(); await ready(p, 20000); assert.strictEqual(await p.locator('#jobs-bar a.jobpill').count(), 0, 'no bar once nothing is being made');
  console.log('2) the student went to «ملفاتي» and «كويزاتي» meanwhile: a bar on each page showed the quiz being made, then «جاهز» with a link opened the ready quiz');

  await ctx.close(); await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('background ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
