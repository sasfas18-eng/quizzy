// node static-edition/test/run_web_cards.js <dist>
// Flashcards do not keep the student waiting: made on the device (the site has no AI service), at once, and spread over the whole lecture
// (not the first slides only).
const { chromium } = require('playwright'); const assert = require('assert');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js');
const [dist] = process.argv.slice(2); const os = require('os'); const path = require('path');
(async () => {
  // a 30-page lecture, printed to PDF by the browser itself (real text, a heading and seven sentences per page)
  const pdf = path.join(os.tmpdir(), 'cards-lecture-30p.pdf'); { const b0 = await chromium.launch(); const p0 = await b0.newPage(); const W = (k) => 'Neuro' + String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + Math.floor(k / 26) % 26) + 'tine';
    const html = Array.from({ length: 30 }, (_, i) => `<section style="page-break-after:always;font:14px sans-serif"><h1>Topic ${i + 1}: ${W(i)} regulation</h1>` + Array.from({ length: 7 }, (_, j) => `<p>${W(i * 7 + j)} is the receptor that controls the release of ${W(i * 7 + j + 3)} in the ${['cortex', 'medulla', 'gut', 'liver', 'kidney', 'heart', 'lung'][j]} during stress.</p>`).join('') + '</section>').join('');
    await p0.setContent(html); await p0.pdf({ path: pdf, format: 'A4' }); await b0.close(); }
  const b = await chromium.launch(); const errs = [];
  const run = async (cfg, count = 12) => { const site = await serve(dist, 0, cfg); const ctx = await b.newContext(); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
    const r = await p.evaluate(async (n) => { const d = (await (await fetch('/api/documents')).json())[0]; const t0 = performance.now(); const res = await (await fetch(`/api/documents/${d.id}/cards/generate`, { method: 'POST', body: JSON.stringify({ count: n }) })).json();
      const cards = await (await fetch('/api/cards?document_id=' + d.id)).json(); return { ms: performance.now() - t0, res, pages: [...new Set(cards.map((c) => c.source_page))], total: d.page_count }; }, count);
    await ctx.close(); await site.close(); return r; };
  // made on the device: instant, spread over the lecture
  let r = await run("window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};", 6);
  assert.strictEqual(r.res.created, 6); assert(r.ms < 3000, 'local cards are instant'); assert(Math.max(...r.pages) >= r.total - 1 || r.pages.length >= Math.min(r.total, 4), 'spread over the pages, not the first ones: ' + r.pages + ' of ' + r.total);
  console.log(`local cards: ${r.res.created} cards in ${Math.round(r.ms)} ms over pages ${r.pages.sort((a, x) => a - x)} of ${r.total}`);
  console.log('ERRS', JSON.stringify(errs)); assert.deepStrictEqual(errs, []); await b.close(); console.log('cards E2E ok');
})().catch((e) => { console.error(e); process.exit(1); });
