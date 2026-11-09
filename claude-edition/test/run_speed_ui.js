// node claude-edition/test/run_speed_ui.js <dist> <long_deck.pdf> — the everyday screens on a NETWORK store like claude.ai's: every call takes 200 ms, a list also its
// size at 2 MB/s, and more than 8 writes at once are refused («too many concurrent writes»). Timed, as a student sees them:
//  upload a 40-slide file · the home page and «كويزاتي» with 8 quizzes · delete one 40-slide file · delete two files at once · delete five quizzes at once.
// With QZ_ASSERT=1 each must stay under its limit, and what was deleted must really be gone from the store (no page left behind).
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, pdf] = process.argv.slice(2); const ASSERT = !!process.env.QZ_ASSERT;
const LIMIT = { upload: 4500, home: 2500, quizzes: 2500, delete_file: 1000, delete_files: 1000, delete_quizzes: 1000 };      // ms, what the student waits for (measured before: upload 9.2 s, deleting the 40-slide file 9.0 s, two files 2.5 s, five quizzes 2.4 s)
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(8797);
// 8 quizzes as real ones are (about 100 KB each: questions, analysis, plan, report), 2 small files, and attempts - as an account has them after a few weeks
function seed() {
  const P = 'data/users/u1/', o = {}; const now = Date.now() / 1000; const long = (n) => 'x'.repeat(n);
  for (const d of ['f1', 'f2']) { o[P + 'doc_' + d] = { kind: 'doc', id: d, title: 'Old ' + d, filename: d + '.pdf', kind_: 'pdf', status: 'ready', page_count: 3, created_at: now - 9000, pages: [1, 2, 3].map((n) => ({ page_no: n, status: 'ok', char_count: 400, notes: '', image_count: 0, snippet: 'Slide ' + n })) };
    for (const n of [1, 2, 3]) o[P + `page_${d}_${n}`] = { kind: 'page', doc: d, page_no: n, text: `Slide ${n} of ${d}\n` + long(400) }; }
  for (let i = 1; i <= 8; i++) { const id = 'q' + i; const qs = Array.from({ length: 20 }, (_, k) => ({ id: `${id}k${k}`, qtype: 'basic_recall', stem: 'Stem ' + long(300), options: [0, 1, 2, 3].map((j) => ({ id: `${id}k${k}o${j}`, text: 'Option ' + long(120) })), correct_option_id: `${id}k${k}o0`, explanation: long(600), evidence: [{ page: 'd1p1', page_no: 1, ref: 'd1p1', quote: long(200) }], source_pages: [1] }));
    o[P + 'quiz_' + id] = { kind: 'quiz', id, title: 'Quiz ' + i, status: 'ready', created_at: now - 1000 * i, updated_at: now - 1000 * i, settings: { count: 20, mode: 'practice', sources: [{ document_id: 'f1', pages: null }] }, generator: 'claude',
      questions: qs, analysis: { objectives: Array.from({ length: 30 }, (_, k) => ({ id: 'o' + k, statement: long(200), pages: ['d1p1'], supports: { basic_recall: { pages: ['d1p1'] } } })), lecture_character: long(500) },
      plan: { slots: Array.from({ length: 20 }, (_, k) => ({ slot: k + 1, qtype: 'basic_recall', objective: long(200), pages: ['d1p1'] })) }, report: { delivered: 20, requested: 20, dropped: Array.from({ length: 10 }, () => ({ reasons: [long(300)] })), stats: { log: Array.from({ length: 60 }, () => ['g', 1, 2]) } } };
    o[P + 'att_a' + i] = { kind: 'attempt', id: 'a' + i, quiz_id: id, mode: 'practice', order: qs.map((x) => x.id), optOrder: Object.fromEntries(qs.map((x) => [x.id, x.options.map((y) => y.id)])), answers: {}, idx: 0, elapsed: 0, status: i % 2 ? 'in_progress' : 'submitted', started: now - 900, updated: now - 900, timer: null }; }
  localStorage.setItem('qz_shim_db', JSON.stringify(o));
}
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errs.push('C ' + m.text()); });
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') });
  await p.addInitScript(() => { window.__dbLat = 200; window.__dbBps = 2e6; window.__dbMaxW = 8; });
  const U = 'http://localhost:8797/#'; await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.evaluate(seed); await p.reload(); await p.waitForSelector('tbody tr');
  const keys = () => p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('qz_shim_db') || '{}')));
  const out = {}; const T = async (name, fn) => { const t0 = Date.now(); await fn(); out[name] = Date.now() - t0; console.log(`${name.padEnd(15)} ${String(out[name]).padStart(6)} ms`); };
  // 1) upload a 40-slide file (from «ملفاتي»): until its row is there and the page says nothing is still going on
  await T('upload', async () => { await p.setInputFiles('#file', pdf); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3 && !/جارٍ/.test(document.querySelector('main').innerText), null, { timeout: 120000 }); });
  const big = (await p.evaluate(async () => (await (await fetch('/api/documents')).json()).find((d) => d.page_count === 40))).id; assert(big, 'the 40-slide file is listed');
  assert.strictEqual((await keys()).filter((k) => k.includes(`page_${big}_`)).length, 40, 'its 40 pages are stored');
  // 2) the home page and «كويزاتي» (a fresh page load each: nothing in the page's memory yet)
  await T('home', async () => { await p.goto('about:blank'); await p.goto(U + '/'); await p.waitForSelector('.statcard'); });
  await T('quizzes', async () => { await p.goto('about:blank'); await p.goto(U + '/quizzes'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 8); });
  // 3) delete the 40-slide file from its row: until the row is gone (the store must be clean too, checked after)
  await p.goto('about:blank'); await p.goto(U + '/files'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
  await T('delete_file', async () => { await p.click('tbody tr:has-text("long_deck") button.fdel'); await p.click('.modal button:has-text("احذف")'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2); });
  // 4) tick the two other files and delete them at once
  await T('delete_files', async () => { await p.check('#files-sel-all'); await p.click('#files-delete-selected'); await p.click('.modal button:has-text("احذف")'); await p.waitForSelector('.empty'); });
  // 5) tick five quizzes and delete them at once
  await p.goto(U + '/quizzes'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 8);
  const boxes = p.locator('tbody tr .qsel'); for (let i = 0; i < 5; i++) await boxes.nth(i).check();
  await T('delete_quizzes', async () => { await p.click('#delete-selected'); await p.click('.modal button:has-text("احذف")'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3); });
  // away and straight back while the store is still deleting: what was deleted does not come back on screen
  await p.evaluate(() => { location.hash = '#/files'; }); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.evaluate(() => { location.hash = '#/quizzes'; }); await p.waitForSelector('h1:has-text("كويزاتي")'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0);
  assert.strictEqual(await p.locator('tbody tr').count(), 3, 'the deleted quizzes do not come back while they are being deleted');
  // what was deleted is really gone (after the background work has finished), and nothing else was
  for (let i = 0; i < 100; i++) { const k = await keys(); if (!k.some((x) => /page_|doc_/.test(x)) && k.filter((x) => /quiz_/.test(x)).length === 3) break; await p.waitForTimeout(100); }
  const left = await keys(); console.log('store after:', left.filter((k) => /doc_|page_/.test(k)).length, 'file docs/pages,', left.filter((k) => /quiz_/.test(k)).length, 'quizzes,', left.filter((k) => /att_/.test(k)).length, 'attempts');
  assert.strictEqual(left.filter((k) => /doc_|page_/.test(k)).length, 0, 'every file and every page is gone from the store');
  assert.strictEqual(left.filter((k) => /quiz_/.test(k)).length, 3, 'exactly the five quizzes are gone'); assert.strictEqual(left.filter((k) => /att_/.test(k)).length, 3, 'and their attempts');
  // after a reload the lists agree
  await p.reload(); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
  console.log(JSON.stringify(out)); assert.deepStrictEqual(errs, []);
  if (ASSERT) for (const [k, v] of Object.entries(LIMIT)) assert(out[k] <= v, `${k}: ${out[k]} ms (limit ${v} ms)`);
  console.log('everyday screens on a network store ok'); await b.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
