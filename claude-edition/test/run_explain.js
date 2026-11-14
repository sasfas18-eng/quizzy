// node claude-edition/test/run_explain.js <dist> — THE LECTURE EXPLAINED, SLIDE BY SLIDE (Chromium, Claude simulated by shim.js):
//  1) from the file's page «اشرح المحاضرة» opens the explanation: the slide on one side, its explanation on the other - the big idea, the points (each quoting
//     a line of the slide), the terms, «تذكّر للاختبار», a check question; one dot per slide in the strip
//  2) a point lights up the line of the slide it explains; the check question is answered on the spot (right / wrong, why, the line)
//  3) the next slide is prepared while the student reads (asked before they get there); «فهمتها، التالي» marks the slide and goes on; the arrows move too
//  4) another level («للاختبار») is a new explanation at that level
//  5) a question about the slide is answered; a phrase selected on the slide gets «اشرح هذا», answered about that phrase
//  6) back on the page later: the same slide, the explanations kept (nothing asked again), what was understood still marked
//  6b) a slide with a drawing: shown as it looks (kept on the device), explained with its picture seen; a point from it tagged; no check question needs a picture
//  7) without Claude: the slides are there to read, and the page says why there is no explanation
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
(async () => {
  srv.listen(8814); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8814/#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fexplain', { timeout: 30000 });
  // 1) from the file's page
  await p.click('tbody tr a[href^="#/files/"]'); await p.click('#explain-lecture'); await p.waitForSelector('.xidea', { timeout: 20000 });
  const n = await p.locator('.xdot').count(); assert(n >= 5, 'one dot per slide: ' + n);
  assert((await p.locator('.xpoints li').count()) >= 1, '1) points'); assert((await p.locator('.xremember').count()) === 1, '1) remember');
  const lines = await p.locator('.xslide [data-line]').count(); assert(lines >= 2, '1) the slide is shown');
  console.log(`1) «اشرح المحاضرة» opens the explanation: the slide (${lines} lines) beside its idea, ${await p.locator('.xpoints li').count()} points, terms, «تذكّر», ${n} slides in the strip`);
  // 2) a point lights its line; the check question
  await p.hover('.xpoints li >> nth=0'); assert((await p.locator('.xslide .lit').count()) >= 1, '2) the line the point explains lights up');
  if (await p.locator('.xcheck .xopt').count()) { await p.click('.xcheck .xopt >> nth=0'); await p.waitForSelector('.xcheck .xwhy'); assert(/صح/.test(await p.textContent('.xcheck .xwhy')), '2) answered on the spot'); }
  console.log('2) a point lights up the line of the slide it explains; the check question is answered on the spot with the line');
  // 3) the next slide prepared ahead; «فهمتها» marks and goes on; the arrows
  await p.waitForFunction(() => (window.__explain || []).some((x) => x.page !== (window.__explain[0] || {}).page), null, { timeout: 10000 });
  const firstPage = await p.evaluate(() => window.__explain[0].page);
  await p.click('#x-understood'); await p.waitForSelector('.xdot.ok'); await p.waitForSelector('.xidea');
  assert(/فهمت 1/.test(await p.textContent('.xprogress')), '3) one slide understood');
  const before = await p.evaluate(() => window.__explain.length); await p.waitForTimeout(300);
  assert(await p.evaluate(() => document.querySelector('.xdot.cur').textContent) !== String(firstPage), '3) on the next slide');
  await p.keyboard.press('ArrowLeft'); await p.waitForSelector('.xidea'); await p.keyboard.press('ArrowRight'); await p.waitForSelector('.xidea');
  console.log(`3) the next slide was prepared while the first was read (${before} explanations asked so far); «فهمتها» marked it and went on; the arrows move`);
  // 4) another level
  await p.click('.xlevels button:has-text("للاختبار")'); await p.waitForFunction(() => window.__explain.some((x) => x.level === 'EXAM'), null, { timeout: 10000 }); await p.waitForSelector('.xidea');
  assert(/للاختبار/.test(await p.textContent('.xidea')), '4) the exam level');
  console.log('4) «للاختبار» asked a new explanation at that level');
  // 5) a question; a selected phrase
  await p.fill('.xask .tin', 'ما الفكرة هنا؟'); await p.press('.xask .tin', 'Enter'); await p.waitForSelector('.xask .tb.ai:not(.wait)', { timeout: 10000 });
  await p.evaluate(() => { const el = document.querySelector('.xslide .xlines p'); const t = el.firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(t.length, 24));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });      // a phrase selected on the slide
  await p.waitForSelector('.xpop:not([hidden])', { timeout: 5000 }); const sel = await p.evaluate(() => document.querySelector('.xpop').dataset.sel); await p.click('.xpop');
  await p.waitForFunction(() => document.querySelectorAll('.xask .tb.ai:not(.wait)').length === 2, null, { timeout: 10000 });
  assert((await p.locator('.xask .tb.ai').nth(1).textContent()).includes(sel.replace(/^\s*[•▪◦●‣\-–*]\s*/, '').trim()), '5) the answer is about the selected phrase (shown without its bullet)');
  console.log(`5) a question about the slide answered; the phrase «${sel.slice(0, 30)}…» selected on it was explained`);
  // 6) back later: same slide, nothing asked again, understood still marked
  const cur = await p.evaluate(() => document.querySelector('.xdot.cur').textContent); await p.reload(); await p.waitForSelector('.xidea', { timeout: 20000 });
  assert.strictEqual(await p.evaluate(() => document.querySelector('.xdot.cur').textContent), cur, '6) the same slide'); assert((await p.locator('.xdot.ok').count()) >= 1, '6) still marked');
  assert.strictEqual(await p.evaluate(() => (window.__explain || []).filter((x) => x.page === +document.querySelector('.xdot.cur').textContent && x.level === 'EXAM').length), 0, '6) the explanation was kept, not asked again');
  console.log('6) back on the page: the same slide, its explanation kept (not asked again), the understood slide still marked');
  // 6b) a slide with a drawing: shown as it looks, explained with its picture seen; a point from the picture is tagged; a check question that needs the picture is not shown
  const FIG = path.join(require('os').tmpdir(), 'qz_explain_fig.pdf'); require('child_process').execFileSync('python3', [path.join(__dirname, 'make_figure_pdf.py'), FIG]);
  await p.goto('http://localhost:8814/#/files'); await p.setInputFiles('#file', FIG); await p.waitForFunction(() => document.querySelectorAll('tbody tr a.fexplain').length === 2, null, { timeout: 30000 });
  await p.click('tbody tr a.fexplain >> nth=0'); await p.waitForSelector('.xdot');
  await p.click('.xdot:text-is("3")'); await p.waitForSelector('.xidea:has-text("مناطق الكلية")', { timeout: 20000 });
  await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.src.startsWith('blob:') && im.naturalWidth > 0; }, null, { timeout: 10000 });
  assert(await p.evaluate(() => window.__explain.some((x) => x.page === 3 && x.images === 1)), '6b) Claude saw the slide as an image');
  assert.strictEqual(await p.locator('.xpic').count(), 1, '6b) the point from the picture is tagged'); assert.strictEqual(await p.locator('.xcheck').count(), 0, '6b) the question that needs the picture is not shown');
  await p.click('.xdot:text-is("2")'); await p.waitForSelector('.xidea'); assert.strictEqual(await p.locator('.ximg').count(), 0, '6b) a slide without a large picture: its text only');
  assert(await p.evaluate(() => window.__explain.some((x) => x.page === 2 && x.images === 0)), '6b) and no image sent for it');
  console.log('6b) a slide with a drawing is shown as it looks and explained with its picture seen; the picture\'s point is tagged; a question needing the picture is not shown');
  // 7) without Claude
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push(e.message)); await p2.goto('http://localhost:8814/?nosample' + (await p.evaluate(() => location.hash)));
  await p2.waitForSelector('.xslide [data-line]', { timeout: 20000 }); assert(/Claude/.test(await p2.textContent('.xexp')), '7) says why');
  console.log('7) without Claude: the slides are there to read, and the page says why there is no explanation');
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('explain ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
