// node claude-edition/test/run_student.js <dist> — WHAT STUDENTS MET, made to happen on purpose. A student opens the shared link (claude.ai: the `view` level, so
// their files and quizzes are kept on their own device, in IndexedDB) and:
//  1) the browser closes the page's connection to that storage (a phone that put the page in the background) - before the file is chosen and again and again
//     while the quiz is made: students saw «Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing» until they reloaded, and a
//     quiz that never became ready. Now: no error, the quiz is ready, and after a reload it is still there (saved)
//  2) Claude's permission is not given yet (claude.ai asks it at the first request, which waits): the new-quiz page says so, the progress screen says «press
//     Allow» while the request waits, and the quiz goes on once allowed
//  3) meanwhile reads of the quiz fail: the page keeps watching (it used to stop at the first failed read, its progress bar frozen) and shows the quiz
//  4) the permission was declined: the new-quiz page says so and offers «السماح لـClaude» (the Permissions panel); after it, the quiz is made
//  5) the connection drops in the middle of the quiz: the screen says so, nothing is spent on it, and the quiz carries on when it is back
//  6) a quiz refused for want of permission ends with the reason and the way out (not a frozen screen)
//  7) the link opened twice: the second tab shows the quiz being made in the first as such (it used to mark it «failed - the page was closed», and a retry
//     there made it twice), refuses to start it again, and shows it ready when the first tab is done
//  8) a quiz deleted while it is being made does not come back when its job ends
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
// every IndexedDB connection the page opens is kept here, so the test can close them as the browser does (a closed connection refuses every transaction with
// exactly the error the students saw)
const CAPTURE = `(() => { const open = IDBFactory.prototype.open; window.__idb = []; IDBFactory.prototype.open = function (...a) { const rq = open.apply(this, a); rq.addEventListener('success', () => window.__idb.push(rq.result)); return rq; };
  window.__closeIdb = () => { let n = 0; for (const d of window.__idb) { try { d.close(); n++; } catch (_) { /* closed */ } } return n; }; })();`;
const BAD = /IDBDatabase|connection is closing|InvalidStateError|undefined|\[object/;
async function student(ctx, query, errs) {
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8806/?viewer' + query + '#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 }); return p; }
async function upload(p) {
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 }); }
async function toNewQuiz(p, count = 10) { await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click(`.chips button:text-is("${count}")`); await p.waitForTimeout(200); }
const ready = (p, timeout = 120000) => p.waitForSelector('h2:has-text("جاهز للحل")', { timeout });
const quizId = (p) => p.evaluate(() => (location.hash.match(/#\/quiz\/(\w+)/) || [])[1]);
(async () => {
  srv.listen(8806); const b = await chromium.launch(); const errs = [];
  const fresh = async () => { const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') }); await ctx.addInitScript({ content: CAPTURE }); return ctx; };

  // 1) the browser closes the storage connection, before and during the quiz
  let ctx = await fresh(); let p = await student(ctx, '&lat=120', errs); await upload(p);      // (a slower Claude: the connection is closed while the quiz is being made)
  assert((await p.evaluate(() => window.__closeIdb())) >= 1, 'the page holds a connection to its storage');
  await toNewQuiz(p, 20); await p.click('#create-quiz');
  await p.waitForSelector('#stage', { timeout: 20000 }); let closed = 0;
  for (let i = 0; i < 8 && !(await p.locator('h2:has-text("جاهز للحل")').count()); i++) { closed += await p.evaluate(() => window.__closeIdb()); await p.waitForTimeout(500); }
  assert(closed >= 2, 'the connection was closed while the quiz was being made: ' + closed);
  await ready(p); const id1 = await quizId(p); let body = await p.textContent('body');
  assert(!BAD.test(body), 'no storage error on screen: ' + (body.match(/.{0,40}(IDBDatabase|closing).{0,40}/) || [''])[0]);
  const n1 = await p.evaluate(async (i) => (await (await fetch('/api/quizzes/' + i + '/questions')).json()).length, id1); assert.strictEqual(n1, 20, 'the full quiz');
  await p.evaluate(() => window.__closeIdb()); await p.reload(); await ready(p, 20000);
  assert.strictEqual(await p.evaluate(async (i) => (await (await fetch('/api/quizzes/' + i)).json()).status, id1), 'ready', 'after a reload the quiz is still there: it was saved');
  console.log(`1) the storage connection closed before the quiz and ${closed} more times while it was made: no error, 20 questions, still there after a reload`);

  await ctx.close();

  // 2) the permission is not given yet (the request waits on claude.ai's dialog): said before, and «press Allow» while it waits - 3) and meanwhile reads of the
  // quiz fail: the page keeps watching (it used to stop at the first failed read) and shows the quiz once allowed
  ctx = await fresh(); p = await student(ctx, '&perm=prompt', errs); await upload(p); await toNewQuiz(p, 10);
  await p.waitForSelector('#perm-prompt', { timeout: 5000 });
  await p.click('#create-quiz'); await p.waitForSelector('#consent-note', { timeout: 30000 });
  assert(/سماح/.test(await p.textContent('#consent-note')), 'the student is told to press Allow');
  await p.evaluate(() => { const f = window.fetch; window.__failed = 0; window.fetch = (u, o) => { const s = String(u); if (/\/api\/quizzes\/\w+$/.test(s) && (!o || !o.method || o.method === 'GET') && window.__failed < 4) { window.__failed++; return Promise.reject(new TypeError('Failed to fetch')); } return f(u, o); }; });
  await p.waitForFunction(() => window.__failed >= 4, null, { timeout: 40000 }); await p.waitForSelector('#poll-note', { state: 'attached', timeout: 10000 });
  await p.evaluate(() => window.__allow()); await ready(p); assert.strictEqual(await p.locator('#consent-note').count(), 0); assert(!BAD.test(await p.textContent('body')));
  console.log('2) permission not given yet: the new-quiz page said so, the progress screen said «press Allow» while Claude waited, the quiz went on once allowed');
  console.log('3) meanwhile four reads of the quiz failed: the page kept watching (and said so) and showed the ready quiz');
  await ctx.close();

  // 4) the permission was declined: the way back, then the quiz
  ctx = await fresh(); p = await student(ctx, '&perm=denied', errs); await upload(p); await toNewQuiz(p, 10);
  await p.waitForSelector('#perm-denied', { timeout: 5000 }); await p.click('#perm-allow');
  await p.waitForFunction(() => !document.getElementById('perm-denied'), null, { timeout: 5000 }); assert.strictEqual(await p.evaluate(() => window.__managed), 1, 'the Permissions panel was opened once');
  await p.click('#create-quiz'); await ready(p);
  console.log('4) permission declined: the new-quiz page said so, «السماح لـClaude» opened the Permissions panel, then the quiz was made');

  // 5) the connection drops in the middle of the quiz
  // (held on the permission dialog first, so the connection drops while the quiz is being made - the analysis of this file is already kept, the rest is quick)
  await p.goto('http://localhost:8806/?viewer&perm=prompt#/files'); await p.waitForSelector('tbody tr a.fquiz', { timeout: 20000 });
  await toNewQuiz(p, 10); await p.click('#create-quiz'); await p.waitForSelector('#consent-note', { timeout: 30000 });
  await ctx.setOffline(true); await p.evaluate(() => window.__allow()); await p.waitForSelector('#offline-note', { timeout: 30000 });
  await p.waitForTimeout(1500); assert.strictEqual(await p.locator('h2:has-text("جاهز للحل")').count(), 0, 'nothing finished while offline');
  await ctx.setOffline(false); await ready(p); assert.strictEqual(await p.locator('#offline-note').count(), 0);
  const q5 = await p.evaluate(async (i) => (await (await fetch('/api/quizzes/' + i)).json()), await quizId(p)); assert.strictEqual(q5.report.delivered, 10, 'the full count after the connection came back');
  console.log('5) the connection dropped mid-quiz: the screen said so, the quiz waited and carried on when it was back (10 of 10)');
  await ctx.close();

  // 6) a quiz refused for want of permission ends with the reason and the way out
  ctx = await fresh(); p = await student(ctx, '&denysample', errs); await upload(p); await toNewQuiz(p, 10); await p.click('#create-quiz');
  await p.waitForSelector('.alert.bad', { timeout: 30000 }); body = await p.textContent('body');
  assert(/لم يُسمح لكويزي باستخدام Claude/.test(body) && (await p.locator('#perm-allow').count()) === 1, 'the reason and «السماح لـClaude»');
  console.log('6) a quiz refused for want of permission: the reason in Arabic and «السماح لـClaude», not a frozen screen');
  await ctx.close();

  // 7) the link opened twice
  ctx = await fresh(); p = await student(ctx, '&perm=prompt', errs); await upload(p); await toNewQuiz(p, 10); await p.click('#create-quiz'); await p.waitForSelector('#consent-note', { timeout: 30000 });
  const id7 = await quizId(p); const t2 = await ctx.newPage(); t2.on('pageerror', (e) => errs.push(e.message));
  await t2.goto('http://localhost:8806/?viewer&perm=prompt#/quiz/' + id7); await t2.waitForSelector('#stage', { timeout: 20000 });
  assert(/نافذة أخرى/.test(await t2.textContent('#stage')), 'the second tab says the quiz is being made in another one: ' + (await t2.textContent('#stage')));
  const again = await t2.evaluate(async (i) => { const r = await fetch('/api/quizzes/' + i + '/analyze', { method: 'POST', body: JSON.stringify({ auto_generate: true }) }); return [r.status, (await r.json()).message]; }, id7);
  assert.strictEqual(again[0], 409, 'not started a second time: ' + again.join(' '));
  await p.evaluate(() => window.__allow()); await ready(p); await ready(t2, 30000);
  assert.strictEqual(await t2.evaluate(async (i) => (await (await fetch('/api/quizzes/' + i)).json()).status, id7), 'ready');
  console.log('7) the link opened twice: the second tab said «being made in another tab», refused to start it again (409), and showed it ready when the first was done');
  await t2.close();

  // 8) a quiz deleted while it is being made does not come back
  await p.goto('http://localhost:8806/?viewer&perm=prompt&s=8#/files'); await p.waitForSelector('tbody tr a.fquiz', { timeout: 20000 });      // (a new query: a real reload, the permission asked again)
  await toNewQuiz(p, 10); await p.click('#create-quiz'); await p.waitForSelector('#consent-note', { timeout: 30000 }); const id8 = await quizId(p);
  await p.evaluate(async (i) => { await fetch('/api/quizzes/' + i, { method: 'DELETE' }); location.hash = '#/quizzes'; }, id8); await p.evaluate(() => window.__allow());
  await p.waitForFunction(async (i) => !(await (await fetch('/api/quizzes')).json()).some((x) => x.id === i), id8, { timeout: 20000 }); await p.waitForTimeout(4000);      // its job ends meanwhile
  await p.reload(); await p.waitForSelector('h1', { timeout: 20000 });
  const left = await p.evaluate(async (i) => (await (await fetch('/api/quizzes')).json()).some((x) => x.id === i), id8); assert(!left, 'the deleted quiz did not come back');
  console.log('8) a quiz deleted while it was being made stayed deleted after its job ended and the page was reloaded');
  await ctx.close();

  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('students ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
