// node claude-edition/test/run_count.js <dist> <deck.pdf> — the full count from Claude alone (this edition has no local generator), under the conditions of a real
// quiz that delivered 9 of 50: half the slots refused the first time they are asked («no abbreviation to expand»), and a reviewer that calls good options weak.
// 50 asked -> 50 delivered, every one written and checked by Claude, every section of the lecture covered, no question repeated.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, deck] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
(async () => {
  srv.listen(8798); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()');
  await p.goto('http://localhost:8798/?refusehalf#/files'); await p.setInputFiles('#file', deck); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("50")'); await p.waitForTimeout(300);
  await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل"), #retry', { timeout: 240000 });
  const r = await p.evaluate(async () => { const id = location.hash.split('/')[2]; const q = await (await fetch('/api/quizzes/' + id)).json(); const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json(); const list = Array.isArray(qs) ? qs : qs.questions || [];
    return { status: q.status, n: list.length, local: list.filter((x) => x.prompt_version === 'rules-1.0').length, stems: new Set(list.map((x) => x.stem.toLowerCase())).size, cov: q.report && q.report.section_coverage, stats: q.report && q.report.stats, short: !!document.getElementById('shortfall-note') }; });
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []);
  assert.strictEqual(r.status, 'ready'); assert.strictEqual(r.n, 50, 'the full count: ' + r.n + ' ' + JSON.stringify(r.stats)); assert.strictEqual(r.local, 0, 'every question is Claude\'s'); assert.strictEqual(r.stems, 50, 'no question repeated');
  assert(!r.short, 'no shortfall note'); assert(r.cov && r.cov.covered === r.cov.total, 'every section covered: ' + JSON.stringify(r.cov));
  console.log(`50 asked, ${r.n} delivered by Claude (${r.stats.unwritable} refused slots replaced, ${r.stats.topup_rounds || 0} top-up round(s)), sections ${r.cov.covered}/${r.cov.total}, 0 local`);
  console.log('full count from Claude ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
