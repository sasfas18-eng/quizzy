// node claude-edition/test/run_figures.js <dist> — THE FIGURE READER while a lecture is read (Chromium, Claude simulated by shim.js; the lecture: make_figure_pdf.py):
//  1) only the slides with a LARGE picture AND a thin text of their own are shown to Claude (page 3's drawing, page 5's picture) - never the cover, never a small
//     logo (page 4), never a slide whose text already teaches (page 7) - one image each
//  1b) a slide whose text comes back in scattered pieces (a table of text boxes, page 8) is read in LAYOUT mode: its rows written back in the slide's own words
//      - a row with a word the slide does not carry is refused by the code
//  2) the file is ready AT ONCE (the pictures are read in the background), and a quiz made at once waits for them (a short while at most)
//  3) page 3 gains the labels written in its drawing; the label Claude invented (the checker could not read it), the credit and what the slide already says are not added;
//     page 5 (a picture with no lecture text) is unchanged; one second look was asked (page 3 only)
//  4) a quiz is made from the lecture as usual, and the writer sees the drawing's labels on page 3
//  5) a page that may not send pictures to Claude reads the lecture without them: ready at once, nothing asked
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'); const assert = require('assert'); const { execFileSync } = require('child_process');
const dist = process.argv[2]; const PDF = path.join(os.tmpdir(), 'qz_figures.pdf'); execFileSync('python3', [path.join(__dirname, 'make_figure_pdf.py'), PDF]);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
async function upload(p, q) {
  await p.goto(`http://localhost:8813/${q}#/files`); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  const t0 = Date.now(); await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fquiz', { timeout: 60000 }); await p.waitForFunction(() => !/قيد المعالجة|قيد القراءة/.test(document.body.textContent), null, { timeout: 60000 });
  const doc = await p.evaluate(async () => (await (await fetch('/api/documents')).json())[0]); return { doc, ms: Date.now() - t0 };
}
// a page's text and, beside it, the lines read in its picture (kept apart: the text - and the reading and analysis cached on it - stays as extracted)
const pageText = (p, id, n) => p.evaluate(async ([id, n]) => { const x = await (await fetch(`/api/documents/${id}/pages/${n}`)).json(); return x.text + '\n' + (x.figure || []).join('\n'); }, [id, n]);
const figOnly = (p, id, n) => p.evaluate(async ([id, n]) => (await (await fetch(`/api/documents/${id}/pages/${n}`)).json()).figure || [], [id, n]);
(async () => {
  srv.listen(8813); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const { doc, ms } = await upload(p, '');
  // 2) ready at once: the quiz page's own reading (loadSource) waits for the pictures
  assert.strictEqual(doc.status, 'ready'); const early = (await figOnly(p, doc.id, 3)).join(' ');
  await p.evaluate(async (id) => { await fetch('/api/quizzes/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: [{ document_id: id, pages: null }] }) }); }, doc.id);
  // 1) what was shown
  const fig = await p.evaluate(() => window.__fig || []); assert.deepStrictEqual(fig.filter((x) => !x.layout).map((x) => x.page).sort(), [3, 5], '1) the slides with a large picture and a thin text only: ' + JSON.stringify(fig));
  assert.deepStrictEqual(fig.filter((x) => x.layout).map((x) => x.page), [8], '1b) the scattered table only, in layout mode: ' + JSON.stringify(fig));
  assert(fig.every((x) => x.images === 1), '1) one image each');
  console.log('1) only the slides with a large picture and a thin text were shown to Claude (3, 5): not the cover, not the small logo (4), not the slide whose text teaches (7)');
  console.log(`2) the file was ready at once (${ms} ms, before the pictures were read: ${/Renal cortex/.test(early) ? 'already read' : 'not yet'}); the lecture's reading for a quiz waited for them`);
  // 3) what was added
  const t3 = await pageText(p, doc.id, 3), t5 = await pageText(p, doc.id, 5);
  for (const l of ['Renal cortex', 'Renal medulla', 'Renal pelvis']) assert(t3.includes(l), '3) added: ' + l);
  assert(!/Nephron loop/.test(t3) && !/Pearson|©/.test(t3), '3) the invented label and the credit are not added: ' + t3); assert.strictEqual((t3.match(/three regions/g) || []).length, 1, '3) the slide\'s own line is not added again');
  assert(!/Renal/.test(t5), '3) page 5 unchanged'); assert.strictEqual((await p.evaluate(() => window.__figCheck || [])).length, 2, '3) one second look for each slide that gave lines (page 3, page 8)');
  assert.deepStrictEqual(await figOnly(p, doc.id, 3), ['Renal cortex', 'Renal medulla', 'Renal pelvis'], '3) kept beside the text');
  assert.deepStrictEqual(await figOnly(p, doc.id, 8), ['Disorder — Cause', 'Respiratory acidosis — inadequate ventilation', 'Respiratory alkalosis — hyperventilation'], '1b) the table read row by row; the row with words not on the slide refused');
  console.log('1b) the scattered table (8) was read in layout mode, row by row in its own words; the invented row («Cardiac acidosis — heart failure») was refused');
  console.log('3) page 3 gained the labels of its drawing (cortex, medulla, pelvis), kept beside its text; the invented label, the credit and the slide\'s own line were not added; page 5 unchanged');
  // 4) a quiz
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(200); await p.click('#create-quiz');
  await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  assert(await p.evaluate(() => window.__genFig === 1), '4) the writer saw the labels of the drawing (they are part of the page it writes from)');
  console.log('4) a quiz was made from the lecture; the writer saw the labels read in the drawing');
  // 5) no pictures allowed
  const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await p2.context().addInitScript({ path: path.join(__dirname, 'shim.js') }); p2.on('pageerror', (e) => errs.push(e.message));
  const r2 = await upload(p2, '?noimages'); assert.strictEqual(r2.doc.status, 'ready'); assert.strictEqual((await p2.evaluate(() => window.__fig || [])).length, 0, '5) nothing asked');
  assert(!/Renal cortex/.test(await pageText(p2, r2.doc.id, 3)), '5) the text as extracted');
  console.log('5) a page that may not send pictures: the lecture is read without them, nothing asked');
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('figures ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
