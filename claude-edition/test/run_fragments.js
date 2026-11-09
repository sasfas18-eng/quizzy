// node claude-edition/test/run_fragments.js <dist> <fragments.pdf> <dense.pdf> — a real 50-question quiz of a lecture written as slide fragments ended at 21 (make_fragments_deck.py
// has the same shape, in its own words). Two causes, both fixed here:
//  1) the owner's reader files every line of nine words or fewer without a full stop as a «short label»: such lines (three words or more) are now settled by the
//     owner's own semantic review, so a taught fragment («– Tuft of capillaries inside Bowman capsule») is approved and can be quoted, a true label is not;
//     a quote may run over a bullet the PDF wrapped onto two lines, or a charge set as a raised run («Na» «+»), never over a heading or a label alone;
//  2) the clock never cuts the count: with the quiz's time already over before it starts (and a picky reviewer), the retry and top-up rounds still run - 50 asked, 50 delivered.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, deck, dense] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
(async () => {
  srv.listen(8800); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear(); window.QZ_CONFIG = { quizLimitMs: 1 };');      // the quiz's time is over before it starts
  await p.goto('http://localhost:8800/?refusehalf#/files'); await p.setInputFiles('#file', deck); await p.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  // 1) the reading and the evidence rule
  const ev = await p.evaluate(async () => { const docs = await (await fetch('/api/documents')).json(); const d = docs[0]; const pages = [];
    for (let n = 1; n <= d.page_count; n++) { const x = await (await fetch(`/api/documents/${d.id}/pages/${n}`)).json(); pages.push({ ref: 'd1p' + n, page_no: n, doc_id: d.id, text: x.text || '' }); }
    const content = pages.filter((x) => x.page_no > 2 && x.page_no < 15); const R = await window.QZ_API._readForAI({ pages: content, excluded: [] });
    const page = (t) => (content.find((x) => x.text.includes(t)) || {}).ref; const q = (ref, quote) => !R.check({ stem: 'Which statement is correct?', evidence: [{ page: ref, quote }] });
    return { stats: R.stats, text8: (content.find((x) => x.page_no === 8) || {}).text,
      fragment: q(page('Tuft of capillaries'), 'Tuft of capillaries inside Bowman capsule'),
      wrapped: q(page('medullary gradient'), 'Builds the medullary gradient that the collecting duct uses to concentrate urine later'),
      charge: q(page('ATPase'), 'Na+/K+ ATPase on the basolateral membrane'),
      heading: q(page('Collecting Duct'), 'Distal Tubule and Collecting Duct'), label: q(page('Thick ascending limb'), 'Thick ascending limb'),
      paraphrase: q(page('Tuft of capillaries'), 'A tuft of blood vessels located within the capsule') }; });
  const c = ev.stats.counts; assert(c.include > c.context, 'the taught fragments are approved now (include ' + c.include + ', context ' + c.context + ')');
  assert(ev.fragment, 'a taught slide fragment can be quoted'); assert(ev.wrapped, 'a bullet wrapped onto two lines can be quoted whole'); assert(ev.charge, 'a charge set as a raised run can be quoted as «Na+/K+»: ' + JSON.stringify(ev.text8));
  assert(!ev.heading, 'a heading alone is never evidence'); assert(!ev.label, 'a label alone is never evidence'); assert(!ev.paraphrase, 'a paraphrase is never evidence');
  console.log(`1) reading: include ${c.include}, context ${c.context}, review ${c.review || 0}; quotes: fragment ok, wrapped bullet ok, Na+/K+ ok; heading, label and paraphrase refused`);
  // 2) 50 asked, the time already over, a picky reviewer (half the slots refused the first time): 50 delivered (a lecture with room for 50 - make_dense_deck.py)
  await p.close(); const p2 = await b.newPage({ viewport: { width: 1280, height: 900 } }); p2.on('pageerror', (e) => errs.push(e.message));
  await p2.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p2.addInitScript('localStorage.clear(); window.QZ_CONFIG = { quizLimitMs: 1 };');
  await p2.goto('http://localhost:8800/?refusehalf#/files'); await p2.setInputFiles('#file', dense); await p2.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p2.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p2.click('tbody tr a.fquiz'); await p2.waitForSelector('#create-quiz'); await p2.click('.chips button:text-is("50")'); await p2.waitForTimeout(300); await p2.click('#create-quiz');
  await p2.waitForSelector('h2:has-text("جاهز للحل"), #retry', { timeout: 240000 });
  const r = await p2.evaluate(async () => { const id = location.hash.split('/')[2]; const q = await (await fetch('/api/quizzes/' + id)).json(); const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json();
    const owner = (q.report.dropped || []).filter((x) => (x.reasons || []).some((y) => /ليس من جزء معتمد/.test(y))).length; return { n: qs.length, short: !!(q.report.shortfall), stats: q.report.stats, owner, local: qs.filter((x) => x.prompt_version === 'rules-1.0').length }; });
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []);
  assert.strictEqual(r.n, 50, 'the full count even with the time over: ' + r.n + ' ' + JSON.stringify(r.stats)); assert(!r.short); assert.strictEqual(r.local, 0);
  assert(r.stats.topup_skipped_for_time !== 1 || r.n === 50, 'the clock did not cut the count');
  console.log(`2) 50 asked with the time already over: ${r.n} delivered by Claude (${r.stats.rejected_validation} rejected by the static checks, ${r.owner} of them for the evidence rule; ${r.stats.topup_rounds || 0} top-up round(s))`);
  console.log('slide fragments and the clock ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
