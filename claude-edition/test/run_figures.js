// node claude-edition/test/run_figures.js <dist> — THE FIGURE READER while a lecture is read (Chromium, Claude simulated by shim.js; the lecture: make_figure_pdf.py):
//  1) only the slides with a LARGE picture are shown to Claude (the drawing of page 3 and the picture of page 5) - never the cover, never a small logo (page 4) - one image each
//  2) the file is «being read» until the pictures are read, with its progress on the screen («يقرأ Claude صور …»), then ready
//  3) page 3 gains the labels written in its drawing; the label Claude invented (the checker could not read it), the credit and what the slide already says are not added;
//     page 5 (a picture with no lecture text) is unchanged; one second look was asked (page 3 only)
//  4) a quiz is made from the lecture as usual
//  5) a page that may not send pictures to Claude reads the lecture without them: ready at once, nothing asked
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'); const assert = require('assert'); const { execFileSync } = require('child_process');
const dist = process.argv[2]; const PDF = path.join(os.tmpdir(), 'qz_figures.pdf'); execFileSync('python3', [path.join(__dirname, 'make_figure_pdf.py'), PDF]);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
async function upload(p, q) {
  await p.goto(`http://localhost:8813/${q}#/files`); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.evaluate(() => { window.__seen = []; new MutationObserver(() => { const t = document.body.textContent; if (/يقرأ Claude صور/.test(t)) window.__seen.push(t.match(/يقرأ Claude صور[^\n]{0,60}/)[0]); }).observe(document.body, { childList: true, subtree: true, characterData: true }); });
  const t0 = Date.now(); await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fquiz', { timeout: 60000 }); await p.waitForFunction(() => !/قيد المعالجة|قيد القراءة/.test(document.body.textContent), null, { timeout: 60000 });
  const doc = await p.evaluate(async () => (await (await fetch('/api/documents')).json())[0]); return { doc, ms: Date.now() - t0 };
}
const pageText = (p, id, n) => p.evaluate(async ([id, n]) => (await (await fetch(`/api/documents/${id}/pages/${n}`)).json()).text, [id, n]);
(async () => {
  srv.listen(8813); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const { doc } = await upload(p, '');
  // 1) what was shown
  const fig = await p.evaluate(() => window.__fig || []); assert.deepStrictEqual(fig.map((x) => x.page).sort(), [3, 5], '1) the slides with a large picture only: ' + JSON.stringify(fig));
  assert(fig.every((x) => x.images === 1), '1) one image each');
  console.log('1) only the slides with a large picture were shown to Claude (3, 5): not the cover, not the small logo of page 4');
  // 2) ready after the pictures, with progress on the screen
  assert.strictEqual(doc.status, 'ready'); assert((await p.evaluate(() => window.__seen)).length > 0, '2) the progress was on the screen');
  console.log('2) the file was «being read» while Claude read its pictures («' + (await p.evaluate(() => window.__seen[0])) + '»), then ready');
  // 3) what was added
  const t3 = await pageText(p, doc.id, 3), t5 = await pageText(p, doc.id, 5);
  for (const l of ['Renal cortex', 'Renal medulla', 'Renal pelvis']) assert(t3.includes(l), '3) added: ' + l);
  assert(!/Nephron loop/.test(t3) && !/Pearson|©/.test(t3), '3) the invented label and the credit are not added: ' + t3); assert.strictEqual((t3.match(/three regions/g) || []).length, 1, '3) the slide\'s own line is not added again');
  assert(!/Renal/.test(t5), '3) page 5 unchanged'); assert.strictEqual((await p.evaluate(() => window.__figCheck || [])).length, 1, '3) one second look (page 3)');
  console.log('3) page 3 gained the labels of its drawing (cortex, medulla, pelvis); the invented label, the credit and the slide\'s own line were not added; page 5 unchanged');
  // 4) a quiz
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(200); await p.click('#create-quiz');
  await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 }); console.log('4) a quiz was made from the lecture');
  // 5) no pictures allowed
  const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await p2.context().addInitScript({ path: path.join(__dirname, 'shim.js') }); p2.on('pageerror', (e) => errs.push(e.message));
  const r2 = await upload(p2, '?noimages'); assert.strictEqual(r2.doc.status, 'ready'); assert.strictEqual((await p2.evaluate(() => window.__fig || [])).length, 0, '5) nothing asked');
  assert(!/Renal cortex/.test(await pageText(p2, r2.doc.id, 3)), '5) the text as extracted');
  console.log('5) a page that may not send pictures: the lecture is read without them, nothing asked');
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('figures ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
