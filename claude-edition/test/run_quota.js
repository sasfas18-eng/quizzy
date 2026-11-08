// node claude-edition/test/run_quota.js <dist> <pdf> — the viewer's Claude quota runs out (claude.ai says "usage limit reached").
// 1) from the very first request: no minutes of silent retrying - the quiz is ready within seconds, built from the lecture's own text, and the page says the quota ran out;
// 2) in the middle of the writing: what Claude already wrote is kept, the rest is completed locally, and the page says so; the time it took is shown.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, pdf] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
async function run(b, query) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()');
  await p.goto(`http://localhost:8796/${query}#/files`); await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")');
  const t0 = Date.now(); await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 60000 }); const ms = Date.now() - t0;
  const note = (await p.locator('#quota-note').count()) ? await p.textContent('#quota-note') : null; const timing = (await p.locator('#timing summary').count()) ? await p.textContent('#timing summary') : null;
  const n = await p.evaluate(async () => { const id = location.hash.split('/')[2]; const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json(); return (Array.isArray(qs) ? qs : qs.questions).length; });
  await p.close(); assert.deepStrictEqual(errs, []); return { ms, note, timing, n };
}
(async () => {
  srv.listen(8796); const b = await chromium.launch();
  { const r = await run(b, '?quotaafter=0'); assert(r.ms < 15000, 'no silent minutes of retrying: ' + r.ms + ' ms'); assert(r.note && /نفدت حصة Claude/.test(r.note) && /كاملًا من نص محاضرتك/.test(r.note), 'the page says the quota ran out: ' + r.note); assert.strictEqual(r.n, 10);
    console.log(`1) quota gone from the start: ready in ${(r.ms / 1000).toFixed(1)} s, built locally, the student is told (${r.note.slice(0, 40)}…)`); }
  { const r = await run(b, '?quotaafter=10'); assert(r.ms < 20000, 'stops at once: ' + r.ms); assert(r.note && /كتب Claude جزءًا/.test(r.note), 'partial: ' + r.note); assert.strictEqual(r.n, 10); assert(r.timing && /أُنشئ في/.test(r.timing), 'the time is shown');
    console.log(`2) quota gone mid-quiz: ready in ${(r.ms / 1000).toFixed(1)} s, Claude's questions kept and the rest completed locally; "${r.timing}"`); }
  await b.close(); srv.close(); console.log('quota alert ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
