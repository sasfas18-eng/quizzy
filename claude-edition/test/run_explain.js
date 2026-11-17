// node claude-edition/test/run_explain.js <dist> — THE LECTURE EXPLAINED, SLIDE BY SLIDE (Chromium, Claude simulated by shim.js):
//  1) from the file's page «اشرح المحاضرة» opens the explanation: the slide on one side, its explanation on the other - the big idea, the points (each quoting
//     a line of the slide), the terms, «تذكّر للاختبار», a check question; one dot per slide in the strip
//  1b) the whole lecture is prepared in the background, several slides a request, and counted
//  2) a point lights up the line of the slide it explains; the slide's questions are answered on the spot (right / wrong, why, the line)
//  3) the next slide is prepared while the student reads (asked before they get there); «فهمتها، التالي» marks the slide and goes on; the arrows move too
//  4) another level («للاختبار») is a new explanation at that level
//  5) a question about the slide is answered; a phrase selected on the slide gets «اشرح هذا», answered about that phrase
//  6) back on the page later: the same slide, the explanations kept (nothing asked again), what was understood still marked
//  6b) a slide with a drawing: shown as it looks (kept on the device), explained with its picture seen; a point from it tagged; no check question needs a picture
//  6c) shown as it is written: the idea and the checked points first, then the whole explanation
//  6d) following an answer refused: the same explanation asked the plain way, no error
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
  // 1b) the whole lecture prepared in the background (several slides a request): every slide ready, counted; a far slide opens with no request of its own
  await p.waitForSelector('.xready.all', { timeout: 30000 }); const batches = await p.evaluate(() => (window.__explainBatch || []).length); assert(batches >= 1 && batches < n, '1b) prepared in batches: ' + batches);
  const singles = await p.evaluate(() => (window.__explain || []).length);
  console.log(`1b) the whole lecture was prepared in the background (${batches} requests for ${n} slides), «✓ الشرح جاهز كاملًا»`);
  // 2) a point lights its line; the check question
  await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 15000 });
  await p.hover('.xpoints li >> nth=0'); await p.waitForSelector('.ximg .xhl', { timeout: 5000 });
  assert.strictEqual(await p.locator('.xslide .lit').count(), 0, '2) the light is on the slide\'s picture only, not on the text under it');
  // the two columns scroll on their own: the slide's column scrolled down, the explanation stays where it was
  const cols = await p.evaluate(() => { const s = document.querySelector('.xslide'), e = document.querySelector('.xexp'); const before = e.getBoundingClientRect().top, wy = window.scrollY;
    s.scrollTop = 400; return { scrolls: s.scrollHeight > s.clientHeight ? s.scrollTop > 0 : true, expMoved: Math.abs(e.getBoundingClientRect().top - before) > 1 || window.scrollY !== wy, ov: getComputedStyle(s).overflowY + '/' + getComputedStyle(e).overflowY }; });
  assert(cols.scrolls && !cols.expMoved && cols.ov === 'auto/auto', '2) each column scrolls on its own: ' + JSON.stringify(cols)); await p.evaluate(() => { document.querySelector('.xslide').scrollTop = 0; });
  if (await p.locator('.xcheck .xopt').count()) { await p.click('.xcheck .xopt >> nth=0'); await p.waitForSelector('.xcheck .xwhy'); assert(/صح/.test(await p.textContent('.xcheck .xwhy')), '2) answered on the spot'); }
  console.log('2) a point lights up its line on the slide\'s picture only; the slide and the explanation scroll each on its own; the check question is answered on the spot with the line');
  // 3) the next slide prepared ahead; «فهمتها» marks and goes on; the arrows
  const firstPage = await p.evaluate(() => +document.querySelector('.xdot.cur').textContent); const asked0 = await p.evaluate(() => (window.__explain || []).length);
  await p.click('#x-understood'); await p.waitForSelector('.xdot.ok'); await p.waitForSelector('.xidea');
  assert(/فهمت 1/.test(await p.textContent('.xprogress')), '3) one slide understood');
  const before = await p.evaluate(() => window.__explain.length); await p.waitForTimeout(300); assert.strictEqual(before, asked0, '3) the next slide was ready: no request of its own');
  assert(await p.evaluate(() => document.querySelector('.xdot.cur').textContent) !== String(firstPage), '3) on the next slide');
  await p.keyboard.press('ArrowLeft'); await p.waitForSelector('.xidea'); await p.keyboard.press('ArrowRight'); await p.waitForSelector('.xidea');
  console.log('3) the next slide opened ready (prepared with the whole lecture, no request of its own); «فهمتها» marked it and went on; the arrows move');
  // 4) another level
  await p.click('.xlevels button:has-text("للاختبار")'); await p.waitForFunction(() => window.__explain.some((x) => x.level === 'EXAM'), null, { timeout: 10000 }); await p.waitForSelector('.xidea');
  assert(/للاختبار/.test(await p.textContent('.xidea')), '4) the exam level');
  console.log('4) «للاختبار» asked a new explanation at that level');
  // 5) a question; a selected phrase
  await p.fill('.xask .tin', 'ما الفكرة هنا؟'); await p.press('.xask .tin', 'Enter'); await p.waitForSelector('.xask .tb.ai:not(.wait)', { timeout: 10000 });
  await p.waitForFunction(() => new Promise((ok) => { const y = scrollY; setTimeout(() => ok(scrollY === y), 250); }), null, { timeout: 5000 });      // (the page has stopped scrolling: a scroll hides «اشرح هذا»)
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
  assert(await p.evaluate(() => (window.__explain || []).some((x) => x.page === 3 && x.images === 1) || (window.__explainBatch || []).some((b) => b.seen.includes(3) && b.images >= 1)), '6b) Claude saw the slide as an image');
  assert.strictEqual(await p.locator('.xpic').count(), 1, '6b) the point from the picture is tagged'); assert.strictEqual(await p.locator('.xcheck').count(), 0, '6b) the question that needs the picture is not shown');
  await p.click('.xdot:text-is("2")'); await p.waitForSelector('.xidea'); await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 15000 });      // every slide is shown as it looks
  assert(await p.evaluate(() => (window.__explain || []).some((x) => x.page === 2 && x.images === 0) || (window.__explainBatch || []).some((b) => b.pages.includes(2) && !b.seen.includes(2))), '6b) shown as it looks, but its picture is not sent to Claude (its text is what it reads)');
  console.log('6b) a slide with a drawing is shown as it looks and explained with its picture seen; the picture\'s point is tagged; a question needing the picture is not shown; a slide of text is shown as it looks too, its picture not sent');
  // 6b2) THE PAGE LEFT OPEN WHILE THE IPAD SLEPT (a day): Safari closes the pictures' database connection - every slide must still show its picture, without a reload
  await p.evaluate(() => window.QZ_API._simgClose());
  for (const n of ['6', '8']) {      // (slides not opened before: their pictures are read from the store now, not from what the page already holds)
    if (n === '8') await p.evaluate(() => window.QZ_API._simgClose());
    await p.click(`.xdot:text-is("${n}")`); await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return (im && im.src.startsWith('blob:') && im.complete && im.naturalWidth > 0) || document.querySelector('.ximg-lost'); }, null, { timeout: 15000 });
    assert.strictEqual(await p.locator('.ximg-lost').count(), 0, `6b2) slide ${n} says its picture is gone after the store was closed`); }
  console.log('6b2) after the browser closed the pictures\' store (the iPad asleep), the slides still show their pictures - the store is opened again by itself');
  // 6b3) SAFARI EMPTIED THE STORE (a day later every slide showed its text only): the page says so and the SAME file brings the pictures back to the same lecture;
  // another file is refused
  await p.evaluate(async () => { await window.QZ_API._simgClose(); await new Promise((r) => { const q = indexedDB.deleteDatabase('qz-slides'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  const files0 = await p.evaluate(async () => (await (await fetch('/api/documents')).json()).length);
  await p.reload(); await p.waitForSelector('.xrestore', { timeout: 15000 }); assert.strictEqual(await p.locator('.ximg img[src^="blob:"]').count(), 0, '6b3) no picture is left');
  // a slide explained with its picture seen is still found once the pictures are gone (it was written again: its key said «seen» - measured on the iPad)
  await p.click('.xdot:text-is("3")'); await p.waitForSelector('.xidea:has-text("مناطق الكلية")', { timeout: 20000 });
  assert(await p.evaluate(() => !(window.__explain || []).some((x) => x.page === 3) && !(window.__explainBatch || []).some((b) => b.pages.includes(3))), '6b3) the slide explained with its picture is shown as kept, not written again');
  await p.setInputFiles('.xrestore-file', PDF); await p.waitForSelector('.toast:has-text("ليس ملف المحاضرة نفسه")', { timeout: 30000 }); assert.strictEqual(await p.locator('.ximg img[src^="blob:"]').count(), 0, '6b3) another file brings nothing');
  await p.setInputFiles('.xrestore-file', FIG);
  await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.src.startsWith('blob:') && im.complete && im.naturalWidth > 0; }, null, { timeout: 30000 });
  await p.click('.xdot:text-is("3")'); await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.src.startsWith('blob:') && im.complete && im.naturalWidth > 0; }, null, { timeout: 15000 });
  assert.strictEqual(await p.evaluate(async () => (await (await fetch('/api/documents')).json()).length), files0, '6b3) no second copy of the file');
  assert(await p.evaluate(async () => { const d = (await (await fetch('/api/documents')).json()).find((x) => /fig/.test(x.filename)); const r = await (await fetch('/api/explain/' + d.id)).json(); return r.slides.filter((x) => x.img).length >= 5; }), '6b3) the pictures are kept again');
  console.log('6b3) the store emptied by the browser: the explanations stay as kept (not written again); the page offers to bring the pictures back; another file is refused; the same file brings them back to the same lecture (no second copy)');
  // 6c) shown AS IT IS WRITTEN: the idea and the first points appear (each checked) while the rest is still coming, then the whole explanation
  const p3 = await ctx.newPage(); p3.on('pageerror', (e) => errs.push(e.message)); await p3.addInitScript(() => { window.__sawPart = 0; new MutationObserver(() => { if (document.querySelector('.xexp .xmore') && document.querySelector('.xexp .xidea')) window.__sawPart = 1; }).observe(document, { childList: true, subtree: true }); });
  await p3.goto('http://localhost:8814/?slowstream' + (await p.evaluate(() => location.hash))); await p3.waitForSelector('.xdot');
  await p3.click('.xdot >> nth=-1'); await p3.waitForSelector('#x-understood', { timeout: 30000 }); await p3.evaluate(() => { window.__sawPart = 0; });      // (a slide and a level never explained before: nothing kept)
  await p3.click('.xlevels button:has-text("بعمق")'); await p3.waitForSelector('#x-understood', { timeout: 30000 });
  assert.strictEqual(await p3.evaluate(() => window.__sawPart), 1, '6c) the idea showed while the rest was being written'); await p3.close();
  console.log('6c) the explanation showed as it was written (its idea and checked points first, «يكمل الشرح…»), then whole');
  // 6d) following an answer refused (as on a real account: «تعذّر الوصول إلى Claude الآن»): the explanation is asked the plain way, and comes
  const p4 = await ctx.newPage(); p4.on('pageerror', (e) => errs.push(e.message)); await p4.goto('http://localhost:8814/?nostream' + (await p.evaluate(() => location.hash))); await p4.waitForSelector('.xidea', { timeout: 30000 });
  await p4.click('.xactions button:has-text("اشرحها بطريقة أخرى")'); await p4.waitForSelector('#x-understood', { timeout: 30000 });
  assert(await p4.evaluate(() => window.__streamRefused >= 1), '6d) following was refused'); assert.strictEqual(await p4.locator('.xexp .alert.bad').count(), 0, '6d) no error shown'); await p4.close();
  console.log('6d) following the answer refused: the explanation came the plain way, no error shown');
  // 6e) the next slide is never behind the requests preparing the rest (each takes 6 s here): it is asked alone and shows at once
  const p5 = await ctx.newPage(); p5.on('pageerror', (e) => errs.push(e.message)); await p5.goto('http://localhost:8814/?slowbatch' + (await p.evaluate(() => location.hash))); await p5.waitForSelector('.xdot');
  await p5.click('.xdot >> nth=0'); await p5.click('.xlevels button >> nth=2'); await p5.waitForSelector('.xidea', { timeout: 20000 }); const t5 = Date.now(); await p5.click('#x-understood'); await p5.waitForSelector('.xidea', { timeout: 20000 }); const ms5 = Date.now() - t5;
  assert(ms5 < 3000, '6e) the next slide came in ' + ms5 + ' ms (the batches take 6 s)'); await p5.close();
  console.log(`6e) the next slide showed in ${ms5} ms while the rest of the lecture was still being prepared (6 s a request)`);
  // 6f) the slide pictures kept on this device: one kept the old way (a Blob, which Safari later cannot read back) is shown and rewritten as bytes; one whose
  //     bytes are gone says so (never silently missing); Claude is sent a picture it can open
  const p6 = await ctx.newPage(); p6.on('pageerror', (e) => errs.push(e.message)); await p6.goto('http://localhost:8814/#/files'); await p6.waitForSelector('tbody tr a.fexplain');
  const keys = await p6.evaluate(() => new Promise((ok) => { const r = indexedDB.open('qz-slides', 1); r.onsuccess = () => { const q = r.result.transaction('img').objectStore('img').getAllKeys(); q.onsuccess = () => ok(q.result.map(String)); }; }));
  const doc = keys[0].split(':')[0]; await p6.goto('http://localhost:8814/#/explain/' + doc); await p6.waitForSelector('.xdot');
  const dots = await p6.evaluate(() => [...document.querySelectorAll('.xdot')].map((d) => d.textContent.trim()));
  const mine = keys.filter((k) => k.startsWith(doc + ':') && dots.includes(k.split(':')[1])); assert(mine.length >= 2, '6f) slide pictures kept: ' + mine.length);
  const [oldKey, lostKey] = mine;
  await p6.evaluate(([a, z]) => new Promise((ok) => { const r = indexedDB.open('qz-slides', 1); r.onsuccess = () => { const t = r.result.transaction('img', 'readwrite'), st = t.objectStore('img');
    st.get(a).onsuccess = (ev) => { const v = ev.target.result; st.put(new Blob([v.buf], { type: v.type }), a); }; st.get(z).onsuccess = (ev) => { const v = ev.target.result; st.put({ type: v.type, buf: new ArrayBuffer(0), pic: v.pic }, z); };
    t.oncomplete = () => ok(); }; }), [oldKey, lostKey]);      // one kept the old way (a Blob), one whose bytes are gone
  await p6.reload(); await p6.waitForSelector('.xdot');
  await p6.click(`.xdot:text-is("${oldKey.split(':')[1]}")`); await p6.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 15000 });
  const rewritten = await p6.evaluate((k) => new Promise((ok) => { const r = indexedDB.open('qz-slides', 1); r.onsuccess = () => { const q = r.result.transaction('img').objectStore('img').get(k); q.onsuccess = () => ok(!(q.result instanceof Blob) && q.result.buf.byteLength > 0); }; }), oldKey);
  assert(rewritten, '6f) the old entry is kept as bytes now');
  await p6.click(`.xdot:text-is("${lostKey.split(':')[1]}")`); await p6.waitForSelector('.ximg-lost', { timeout: 15000 });
  assert.strictEqual(await p6.locator('.xexp .alert.bad').count(), 0, '6f) no error'); await p6.close();
  console.log('6f) a slide picture kept the old way is shown and kept as bytes; a picture whose bytes are gone says so; Claude was sent pictures it can open');
  // 6h) an English term in brackets inside Arabic: the brackets stay a pair around it («((introspection» was shown); a bracket inside the term stays in it («Ca(2+)»)
  { const r = await p.evaluate(async () => { const m = await import('/js/pages_explain.js'); return ['يميل إلى التأمل ومراجعة النفس (introspection) والتفكير.', 'يدخل الكالسيوم Ca(2+) ثم الترشيح (filtration rate) يرتفع.'].map((t) => { const d = m._mixed(t); return { bdi: [...d.querySelectorAll('bdi')].map((x) => x.textContent), text: d.textContent }; }); });
    assert.deepStrictEqual(r[0].bdi, ['introspection'], '6h) the English run without its closing bracket'); assert(r[0].text.includes('(introspection)'), '6h) the text keeps its pair: ' + r[0].text);
    assert.deepStrictEqual(r[1].bdi, ['Ca(2+)', 'filtration rate'], '6h) a bracket inside a term stays in it'); }
  console.log('6h) an English term in brackets inside Arabic keeps its brackets as a pair; «Ca(2+)» stays whole');
  // 7) without Claude
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push(e.message)); await p2.goto('http://localhost:8814/?nosample' + (await p.evaluate(() => location.hash)));
  await p2.waitForSelector('.xslide [data-line]', { timeout: 20000 }); assert(/Claude/.test(await p2.textContent('.xexp')), '7) says why');
  console.log('7) without Claude: the slides are there to read, and the page says why there is no explanation');
  // 8) a lecturer's name, title or institution is not a line to explain (a part's own cover: «CARDIC CYCLE» / «College of Medicine, King Saud University, Riyadh»)
  const af = await p.evaluate(() => ['College of Medicine, King Saud University, Riyadh, Saudi Arabia', 'Prof. Sultan Ayoub Meo MBBS, Ph.D', 'Professor and Consultant, Department of Physiology,', 'The cardiac cycle is a complete beat of the heart.', 'Department of Health guidelines recommend hand washing', 'Dr. Semmelweis showed that hand washing saves lives.'].map((l) => window.QZ_API._affilLine(l)));
  assert.deepStrictEqual(af, [true, true, true, false, false, false], '8) affiliation lines only: ' + JSON.stringify(af));
  console.log('8) a lecturer\'s name, degrees and institution are left out of the explanation; a sentence that names a department or a doctor is not');
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('explain ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
