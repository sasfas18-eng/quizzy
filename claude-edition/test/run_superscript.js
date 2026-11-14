// node claude-edition/test/run_superscript.js <dist> <super.pdf> [shot.png] — a slide's raised / lowered figures and the light on the slide's picture.
// The real case (an iPad, a muscle-physiology slide): «Ca²⁺ active transport pumps use ATP to move Ca²⁺ ions back into SR cisterns» was read as five lines
// («Ca» / «2+» / «active transport…» / «2+» / «ions back…», shown «+2» in the Arabic page), and the yellow light of a point lit only the text under the picture.
//  1) the figures are written into their line (Ca²⁺, CO₂), the sentence whole, a space after them
//  2) a point of the explanation lights its line ON the slide's picture (a yellow box over that line), and the light goes when the point is left
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, pdf, shot] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
(async () => {
  srv.listen(8801); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 1000 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') });
  await p.goto('http://localhost:8801/#/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr a.fexplain', { timeout: 30000 });
  const text = await p.evaluate(async () => { const d = (await (await fetch('/api/documents')).json())[0]; const src = await window.QZ_API._source([{ document_id: d.id, pages: null }]); return src.pages.find((x) => x.page_no === 2).text; });
  assert(/Ca²⁺ active transport pumps use ATP to move Ca²⁺/.test(text), '1) the raised figures in their line: ' + JSON.stringify(text)); assert(/CO₂ out of the lungs/.test(text), '1) a lowered figure: ' + JSON.stringify(text));
  assert(!/^\s*\+?2\+?\s*$/m.test(text), '1) no line of a figure alone');
  console.log('1) «Ca²⁺ active transport pumps use ATP to move Ca²⁺» and «CO₂ out of the lungs» read whole, no «2+» line of its own');
  await p.click('tbody tr a.fexplain'); await p.waitForSelector('.xidea', { timeout: 30000 });
  if (!(await p.evaluate(() => /Relaxation/.test(document.querySelector('.xslide').textContent)))) { await p.click('.xdot:text-is("2")'); await p.waitForSelector('.xidea', { timeout: 30000 }); }
  await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 15000 });
  const li = p.locator('.xpoints li').first(); await li.scrollIntoViewIfNeeded(); await li.hover();
  await p.waitForSelector('.ximg .xhl', { timeout: 10000 });
  const geo = await p.evaluate(() => { const im = document.querySelector('.ximg img').getBoundingClientRect(); return [...document.querySelectorAll('.ximg .xhl')].map((e) => { const r = e.getBoundingClientRect(); return { in: r.left >= im.left - 4 && r.right <= im.right + 4 && r.top >= im.top - 4 && r.bottom <= im.bottom + 4, h: r.height / im.height, w: r.width / im.width }; }); });
  assert(geo.length >= 1 && geo.every((g) => g.in && g.h > 0.02 && g.h < 0.2 && g.w > 0.1), '2) a yellow box over the line, inside the picture: ' + JSON.stringify(geo));
  if (shot) { await p.evaluate(() => document.querySelector('.ximg').scrollIntoView({ block: 'start' })); await p.screenshot({ path: shot }); }
  await p.mouse.move(5, 5); await p.waitForFunction(() => !document.querySelector('.ximg .xhl'), null, { timeout: 5000 });
  console.log(`2) a point lights its line on the slide's picture (${geo.length} box(es)); the light goes when the point is left`);
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('superscript ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
