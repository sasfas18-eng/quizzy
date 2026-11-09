// node claude-edition/test/run_quota.js <dist> <pdf> — the viewer's Claude quota runs out (claude.ai says "usage limit reached").
// In this edition every question is Claude's (nothing is completed locally):
// 1) from the very first request: no minutes of silent retrying - within seconds the page says the quota ran out, and offers to try again later;
// 2) in the middle of the writing: what Claude already wrote and checked is the quiz, and the page says so; the time it took is shown.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
async function run(b, query) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()');
  await p.goto(`http://localhost:8796/${query}#/files`); await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")');
  const t0 = Date.now(); await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل"), #retry', { timeout: 60000 }); const ms = Date.now() - t0;
  const failedMsg = (await p.locator('#retry').count()) ? await p.textContent('.alert.bad') : null;
  const note = (await p.locator('#quota-note').count()) ? await p.textContent('#quota-note') : null; const timing = (await p.locator('#timing summary').count()) ? await p.textContent('#timing summary') : null;
  const q = await p.evaluate(async () => { const id = location.hash.split('/')[2]; const quiz = await (await fetch('/api/quizzes/' + id)).json(); const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json().catch(() => []);
    const list = Array.isArray(qs) ? qs : (qs.questions || []); return { n: list.length, local: list.filter((x) => x.prompt_version === 'rules-1.0').length, status: quiz.status }; });
  await p.close(); assert.deepStrictEqual(errs, []); return { ms, note, timing, n: q.n, local: q.local, status: q.status, failedMsg };
}
(async () => {
  srv.listen(8796); const b = await chromium.launch();
  { const r = await run(b, '?quotaafter=0'); assert(r.ms < 15000, 'no silent minutes of retrying: ' + r.ms + ' ms'); assert(r.failedMsg && /نفدت حصة Claude/.test(r.failedMsg), 'the page says the quota ran out: ' + r.failedMsg); assert.strictEqual(r.n, 0, 'no local quiz');
    console.log(`1) quota gone from the start: told within ${(r.ms / 1000).toFixed(1)} s, no quiz made without Claude (${r.failedMsg.slice(0, 50)}…)`); }
  { const r = await run(b, '?quotaafter=10'); assert(r.ms < 20000, 'stops at once: ' + r.ms); assert(r.note && /كتبها Claude وفحصها قبل نفاد الحصة/.test(r.note), 'it says what Claude wrote: ' + r.note); assert(r.n >= 1 && r.local === 0, 'only Claude\'s questions: ' + r.n + ' / local ' + r.local);
    assert.strictEqual(r.timing, null, 'how long it took (reading, requests) is not shown to the student');
    console.log(`2) quota gone mid-quiz: ready in ${(r.ms / 1000).toFixed(1)} s with the ${r.n} questions Claude wrote and checked (none local); no timing shown to the student`); }
  // 3) a used-up quota that answers like «too many at once» (no word about a quota - as a real account did): the quiz stops with the quota note, and the gate
  //    learns NO limit from it (it used to keep «one at a time» on the device, and every later quiz ran its requests one after another)
  { const p = await b.newPage(); await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()');
    await p.goto('http://localhost:8796/?refuseall#/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
    await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.click('#create-quiz'); await p.waitForSelector('#retry', { timeout: 120000 });
    const msg = await p.textContent('.alert.bad'); const lanes = await p.evaluate(() => localStorage.getItem('qz_claude_lanes_v3'));
    assert(/نفدت حصة Claude/.test(msg), 'told it is the quota: ' + msg); assert(lanes === null || +lanes >= 3, 'no «one at a time» learned from the quota: ' + lanes);
    await p.close(); console.log(`3) a quota that says only «too many»: told plainly; the gate kept ${lanes || 'its default'} lanes (never one at a time)`); }
  { const p = await b.newPage(); await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript("localStorage.setItem('qz_claude_lanes_v2', '1')");      // an account the earlier gate left at «one at a time»
    await p.goto('http://localhost:8796/#/files'); const lanes = await p.evaluate(() => (window.QZ_HOST && window.QZ_HOST.concurrency) || null); assert(lanes >= 3, 'a kept «one at a time» is forgotten: ' + lanes);
    await p.close(); console.log(`4) a device the earlier gate left at «one at a time» starts at ${lanes} lanes`); }
  await b.close(); srv.close(); console.log('quota alert ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
