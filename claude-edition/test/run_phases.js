// node claude-edition/test/run_phases.js <dist> <phases.pdf> — EVERY SECTION WITH TEXT GETS A QUESTION, even one the analysis folded into its neighbour.
// The real case (a CVS lecture, 30 questions): one running title over the ventricular-systole slides; «MAXIMUM EJECTION PHASE: …» opened its slide's first
// sentence and was not seen as a heading (the slide joined the previous section), and the analysis gave slides 24-25 one objective, filed under 24 - so the
// «REDUCED EJECTION PHASE» section was never a target and neither phase had a question, while isovolumetric relaxation had four.
// Here (make_phases_deck.py; ?fold=ISOVOLUMETRIC gives the isovolumetric-relaxation page's objective the reduced-ejection page first, so it is filed under that
// section), with 10 questions:
//  1) «MAXIMUM EJECTION PHASE» is a section of its own (its heading opens the first sentence)
//  2) the folded section is still a target (8 sections counted, not 7) and ends with a question quoting it; so does the maximum-ejection one
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, deck] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
(async () => {
  srv.listen(8798); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()');
  await p.goto('http://localhost:8798/?fold=ISOVOLUMETRIC#/files'); await p.setInputFiles('#file', deck); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  const secs = await p.evaluate(async () => { const d = (await (await fetch('/api/documents')).json())[0]; const src = await window.QZ_API._source([{ document_id: d.id, pages: null }]); const s = window.QZ_API._sections(src.pages);
    return Object.fromEntries(src.pages.map((x) => [+x.ref.replace(/^d\d+p/, ''), s[x.ref].label])); });
  assert.strictEqual(secs[5], 'MAXIMUM EJECTION PHASE', '1) the heading that opens the first sentence starts a section: ' + JSON.stringify(secs)); assert.strictEqual(secs[6], 'REDUCED EJECTION PHASE');
  console.log('1) sections: ' + Object.entries(secs).map(([k, v]) => k + ' ' + v).join(' | '));
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(400);
  await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  const r = await p.evaluate(async () => { const id = location.hash.split('/')[2]; const q = await (await fetch('/api/quizzes/' + id)).json(); const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json();
    const pages = (qs.questions || qs).flatMap((c) => (c.evidence || []).map((e) => +String(e.page).replace(/^d\d+p/, ''))); return { pages, cov: q.report.section_coverage, n: (qs.questions || qs).length, objs: ((q.analysis && q.analysis.objectives) || []).map((o) => o.id + ':' + (o.pages || []).join(',') + ':' + (o.section || '')) }; });
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []);
  assert.strictEqual(r.cov && r.cov.total, 8, '2) every section with text is counted, the folded one too: ' + JSON.stringify(r.cov));
  assert(r.pages.includes(7), '2) the folded section (isovolumetric relaxation) has a question: pages quoted ' + JSON.stringify(r.pages));
  assert(r.pages.includes(5), '2) the maximum ejection section has a question: ' + JSON.stringify(r.pages));
  assert.strictEqual(r.n, 10, '2) the count: ' + r.n); assert(r.cov && r.cov.covered === r.cov.total, '2) every section covered: ' + JSON.stringify(r.cov));
  console.log(`2) 10 questions; the folded «ISOVOLUMETRIC RELAXATION» is counted and has a question, and so does «MAXIMUM EJECTION PHASE»; sections ${r.cov.covered}/${r.cov.total}`);
  console.log('phases ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
