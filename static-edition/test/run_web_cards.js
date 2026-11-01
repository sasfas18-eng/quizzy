// node static-edition/test/run_web_cards.js <dist>
// Flashcards do not keep the student waiting: with an AI, the lecture's parts are asked IN PARALLEL and spread over the whole lecture, the asking
// stops once the number is reached, and a provider that is too slow is not waited for - the local builder completes the set at once. Without AI,
// the cards are spread over the pages (not the first slides only).
const { chromium } = require('playwright'); const assert = require('assert');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { start } = require('./mock_llm.js');
const [dist] = process.argv.slice(2); const os = require('os'); const path = require('path');
(async () => {
  // a 30-page lecture, printed to PDF by the browser itself (real text, a heading and seven sentences per page)
  const pdf = path.join(os.tmpdir(), 'cards-lecture-30p.pdf'); { const b0 = await chromium.launch(); const p0 = await b0.newPage(); const W = (k) => 'Neuro' + String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + Math.floor(k / 26) % 26) + 'tine';
    const html = Array.from({ length: 30 }, (_, i) => `<section style="page-break-after:always;font:14px sans-serif"><h1>Topic ${i + 1}: ${W(i)} regulation</h1>` + Array.from({ length: 7 }, (_, j) => `<p>${W(i * 7 + j)} is the receptor that controls the release of ${W(i * 7 + j + 3)} in the ${['cortex', 'medulla', 'gut', 'liver', 'kidney', 'heart', 'lung'][j]} during stress.</p>`).join('') + '</section>').join('');
    await p0.setContent(html); await p0.pdf({ path: pdf, format: 'A4' }); await b0.close(); }
  const llm = await start(); const ctl = (o) => fetch(llm.url.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify(o) }); const b = await chromium.launch(); const errs = [];
  const run = async (cfg, count = 12) => { const site = await serve(dist, 0, cfg); const ctx = await b.newContext(); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
    const r = await p.evaluate(async (n) => { const d = (await (await fetch('/api/documents')).json())[0]; const t0 = performance.now(); const res = await (await fetch(`/api/documents/${d.id}/cards/generate`, { method: 'POST', body: JSON.stringify({ count: n }) })).json();
      const cards = await (await fetch('/api/cards?document_id=' + d.id)).json(); return { ms: performance.now() - t0, res, pages: [...new Set(cards.map((c) => c.source_page))], total: d.page_count }; }, count);
    await ctx.close(); await site.close(); return r; };
  const ai = (extra = '') => `window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',${extra}llm:[{name:'Mock',kind:'openai',base:'${llm.url}',model:'mock-model',key:'k',rpm:600}]};`;
  // 1) a provider that takes 1.5 s per request: the parts go out together, not one after another
  await ctl({ delays: { cards: 1500 }, maxInFlight: 0, calls: {} }); let r = await run(ai());
  assert.strictEqual(r.res.created, 12, '12 cards'); assert(llm.stats.maxInFlight >= 2, 'requests in parallel: ' + llm.stats.maxInFlight); assert(r.ms < 1500 * (llm.stats.calls.cards || 1) - 500 || (llm.stats.calls.cards || 0) <= 1, `faster than one after another: ${Math.round(r.ms)} ms for ${llm.stats.calls.cards} requests`);
  console.log(`1) AI 1.5 s per request: ${r.res.created} cards in ${Math.round(r.ms)} ms (${llm.stats.calls.cards} requests, up to ${llm.stats.maxInFlight} at once)`);
  // 2) a provider that does not answer in time: the student does not wait for it
  await ctl({ delays: { cards: 20000 } }); r = await run(ai('cardsDeadlineMs:2500,'));
  assert.strictEqual(r.res.created, 12, 'the set is complete anyway'); assert(r.ms < 6000, 'not waited for: ' + Math.round(r.ms) + ' ms'); assert(r.res.from_local >= 1, 'completed locally');
  console.log(`2) AI that does not answer: ${r.res.created} cards in ${Math.round(r.ms)} ms (${r.res.from_local} built locally)`);
  // 3) no AI: instant, spread over the lecture
  r = await run("window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',llm:[]};", 6);
  assert.strictEqual(r.res.created, 6); assert(r.ms < 3000, 'local cards are instant'); assert(Math.max(...r.pages) >= r.total - 1 || r.pages.length >= Math.min(r.total, 4), 'spread over the pages, not the first ones: ' + r.pages + ' of ' + r.total);
  console.log(`3) no AI: ${r.res.created} cards in ${Math.round(r.ms)} ms over pages ${r.pages.sort((a, x) => a - x)} of ${r.total}`);
  console.log('ERRS', JSON.stringify(errs)); assert.deepStrictEqual(errs, []); await b.close(); await llm.close(); console.log('cards E2E ok');
})().catch((e) => { console.error(e); process.exit(1); });
