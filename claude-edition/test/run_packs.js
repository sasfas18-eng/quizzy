// node claude-edition/test/run_packs.js <dist> — A LECTURE KEPT IN A FEW DOCUMENTS (Chromium, the claude.ai store simulated by shim.js):
// The claude.ai store of the site is one database for every student who opens the link (25,000 documents and 100 MB in all). A lecture was one document a
// slide, and its explanation one a slide and level: about 250 documents for one lecture explained at its three levels.
//  1) a file uploaded: its slides are ONE pack (compressed), no document a slide; every document under the store's 256 KiB
//  2) the lecture explained: its explanations are one pack a level, no document a slide; the file and all it holds take a handful of documents
//  3) a lecture kept THE OLD WAY (a document a slide, one an explanation): read as before (the slides, the explanation kept - Claude not asked again), then moved
//     into its packs and the old documents removed
//  4) a quiz is made from the moved lecture (its text read from the pack)
//  5) the file deleted: its packs go with it
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
// what the store holds: [key, size] of every document of the viewer
const held = (p) => p.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('qz_shim_db') || '{}')).map(([k, v]) => [k.slice(k.lastIndexOf('/') + 1), JSON.stringify(v).length]));
(async () => {
  srv.listen(8817); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8817/#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fexplain', { timeout: 30000 });
  const id = await p.evaluate(async () => (await (await fetch('/api/documents')).json())[0].id);
  const nSlides = await p.evaluate(async (i) => (await (await fetch('/api/documents/' + i)).json()).page_count, id);
  // 1) one pack for the slides
  let h = await held(p); const mine = (l) => l.filter(([k]) => k.includes(id));
  assert.strictEqual(h.filter(([k]) => k.startsWith('page_')).length, 0, '1) no document a slide');
  const pk = h.filter(([k]) => k.startsWith('pgk_' + id)); assert(pk.length >= 1 && pk.length <= 2, '1) the slides are one pack: ' + pk.map(([k]) => k));
  assert(h.every(([, n]) => n < 256 * 1024), '1) every document under 256 KiB');
  const raw = await p.evaluate((i) => { const o = JSON.parse(localStorage.getItem('qz_shim_db')); return Object.entries(o).find(([k]) => k.endsWith('/pgk_' + i + '_0'))[1]; }, id);
  assert(typeof raw.zz === 'string' && raw.kind === 'pagepack' && raw.doc === id, '1) the pack is compressed and names its file');
  console.log(`1) a file of ${nSlides} slides is kept as ${pk.length} pack (${pk.map(([, n]) => n).join('+')} characters, compressed), no document a slide`);
  // 2) the lecture explained at one level: one pack of explanations
  await p.click('tbody tr a.fexplain'); await p.waitForSelector('.xidea', { timeout: 20000 });
  await p.waitForSelector('.xready.all', { timeout: 60000 });
  h = await held(p); assert.strictEqual(h.filter(([k]) => k.startsWith('xpc_')).length, 0, '2) no document an explanation');
  const xp = h.filter(([k]) => k.startsWith('xpk_' + id + '_simple')); assert.strictEqual(xp.length, 1, '2) the explanations are one pack: ' + xp.map(([k]) => k));
  const all = mine(h); assert(all.length <= 6, '2) the file and all it holds in a handful of documents: ' + all.map(([k]) => k));
  const asked = await p.evaluate(() => (window.__explain || []).length + (window.__explainBatch || []).length);
  console.log(`2) the lecture explained (${asked} requests): ${all.length} documents in all for it (${all.map(([k]) => k.replace(id, '…')).join(', ')})`);
  // 2b) the same student on two devices: what the other device saved meanwhile is kept when this one saves (the pack is merged, not written over)
  await p.evaluate(async (i) => { const o = JSON.parse(localStorage.getItem('qz_shim_db')); const k = Object.keys(o).find((x) => x.endsWith('/xpk_' + i + '_simple_0'));
    const z = await window.JSZip.loadAsync(o[k].zz, { base64: true }); const arr = JSON.parse(await z.file('d').async('string')); arr.push(['xpc_other_device', { page: 999, data: { idea: 'from the phone' }, at: 1 }]);
    const nz = new window.JSZip(); nz.file('d', JSON.stringify(arr)); o[k] = { ...o[k], zz: await nz.generateAsync({ type: 'base64', compression: 'DEFLATE' }) }; localStorage.setItem('qz_shim_db', JSON.stringify(o)); }, id);
  await p.click('button:has-text("اشرحها بطريقة أخرى")'); await p.waitForSelector('.xidea', { timeout: 20000 });
  await p.waitForFunction(async (i) => { const o = JSON.parse(localStorage.getItem('qz_shim_db')); const k = Object.keys(o).find((x) => x.endsWith('/xpk_' + i + '_simple_0'));
    const z = await window.JSZip.loadAsync(o[k].zz, { base64: true }); const arr = JSON.parse(await z.file('d').async('string')); return arr.some(([key]) => key === 'xpc_other_device') && o[k].at > Date.now() / 1000 - 30; }, id, { timeout: 15000, polling: 300 });
  await p.evaluate(async (i) => { const o = JSON.parse(localStorage.getItem('qz_shim_db')); const k = Object.keys(o).find((x) => x.endsWith('/xpk_' + i + '_simple_0'));
    const z = await window.JSZip.loadAsync(o[k].zz, { base64: true }); const arr = JSON.parse(await z.file('d').async('string')).filter(([key]) => key !== 'xpc_other_device');
    const nz = new window.JSZip(); nz.file('d', JSON.stringify(arr)); o[k] = { ...o[k], zz: await nz.generateAsync({ type: 'base64', compression: 'DEFLATE' }) }; localStorage.setItem('qz_shim_db', JSON.stringify(o)); }, id);      // (the made-up one taken out again)
  console.log('2b) an explanation saved meanwhile on another device of the same student is kept when this device saves its own');
  // 3) the same lecture as it was kept BEFORE the packs: a document a slide and an explanation - read as before, then moved
  await p.evaluate(async (i) => { const o = JSON.parse(localStorage.getItem('qz_shim_db')); const pre = Object.keys(o).find((k) => k.endsWith('/doc_' + i)).replace(/doc_[^/]+$/, '');
    const unzip = async (v) => { const z = await window.JSZip.loadAsync(v.zz, { base64: true }); return JSON.parse(await z.file('d').async('string')); };
    for (const k of Object.keys(o)) { if (k.startsWith(pre + 'pgk_' + i + '_')) { for (const [no, x] of await unzip(o[k])) o[pre + `page_${i}_${no}`] = { kind: 'page', doc: i, page_no: +no, text: x.text, ...(x.fig ? { fig: x.fig } : {}), at: x.at }; delete o[k]; }
      else if (k.startsWith(pre + 'xpk_' + i + '_')) { const lv = o[k].level; for (const [key, x] of await unzip(o[k])) o[pre + key] = { kind: 'xcache', id: key, doc: i, page: x.page, level: lv, data: x.data, at: x.at }; delete o[k]; } }
    localStorage.setItem('qz_shim_db', JSON.stringify(o)); }, id);
  h = await held(p); const oldPages = h.filter(([k]) => k.startsWith('page_' + id)).length, oldX = h.filter(([k]) => k.startsWith('xpc_')).length;
  assert(oldPages === nSlides && oldX >= nSlides - 3, `3) the old way set up: ${oldPages} slides, ${oldX} explanations`);
  await p.goto('http://localhost:8817/#/files'); await p.reload(); await p.waitForSelector('tbody tr a.fexplain', { timeout: 20000 });
  await p.click('tbody tr a.fexplain'); await p.waitForSelector('.xidea', { timeout: 20000 }); await p.waitForSelector('.xready.all', { timeout: 20000 });
  assert.strictEqual(await p.evaluate(() => (window.__explain || []).length + (window.__explainBatch || []).length), 0, '3) the kept explanations are shown: Claude is not asked again');
  assert((await p.locator('.xslide [data-line]').count()) >= 2, '3) the slide\'s text is there');
  await p.waitForFunction((i) => { const o = JSON.parse(localStorage.getItem('qz_shim_db') || '{}'); const ks = Object.keys(o).map((k) => k.slice(k.lastIndexOf('/') + 1));
    return !ks.some((k) => k.startsWith('page_' + i) || k.startsWith('xpc_')) && ks.some((k) => k.startsWith('pgk_' + i)) && ks.some((k) => k.startsWith('xpk_' + i)); }, id, { timeout: 20000 });
  console.log(`3) a lecture kept the old way (${oldPages} slide documents, ${oldX} explanation documents) is read as before - its explanations shown, Claude not asked - and moved into its packs`);
  // 4) a quiz from the moved lecture
  const src = await p.evaluate(async (i) => { const s = await window.QZ_API._source([{ document_id: i, pages: null }]); return s.pages.map((x) => x.text.length); }, id);
  assert(src.length >= nSlides - 3 && src.every((n) => n > 0), '4) every slide read from the pack: ' + src);
  await p.goto('http://localhost:8817/#/files'); await p.waitForSelector('tbody tr a.fquiz', { timeout: 20000 }); await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz');
  await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل"), #retry', { timeout: 240000 });
  const made = await p.evaluate(async () => { const qid = location.hash.split('/')[2]; const qs = await (await fetch('/api/quizzes/' + qid + '/questions')).json(); return { n: (Array.isArray(qs) ? qs : qs.questions || []).length, retry: !!document.querySelector('#retry') }; });
  assert(!made.retry && made.n >= 5, '4) the quiz is made: ' + JSON.stringify(made));
  console.log(`4) a quiz is made from the moved lecture (${made.n} questions)`);
  // 5) the file deleted: nothing of it is left
  await p.evaluate(async (i) => { await fetch('/api/documents/' + i, { method: 'DELETE' }); }, id);
  await p.waitForFunction((i) => !Object.keys(JSON.parse(localStorage.getItem('qz_shim_db') || '{}')).some((k) => /\/(pgk_|xpk_|page_|xpl_)/.test(k) && k.includes(i)), id, { timeout: 15000 });
  console.log('5) the file deleted: its packs and its progress are gone with it');
  assert.deepStrictEqual(errs, [], 'no page errors: ' + errs.join(' | '));
  console.log('packs ok'); await b.close(); srv.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
