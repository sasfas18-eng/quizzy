// node static-edition/test/run_web_semantic.js <dist> <pdf> [chromium|firefox|webkit]
// The composer's OPEN on-device model in a REAL browser engine - Chromium (Chrome/Edge), Firefox, WebKit (Safari): transformers.js + the sentence model, served by
// the site itself, run in WebAssembly (no key, no server, nothing leaves the machine).
//  1) the operator's card: «not downloaded» -> «try it now» runs the model on this device and shows what it found, with its own numbers -> «working»;
//  2) a quiz made with the model on: every question is read for meaning, the count is kept, the card reports the last quiz;
//  3) not one request leaves this machine (no CDN, no model hub); no page error.
// With the real model (CI: scripts/fetch_semantic.sh) the model's numbers are checked and printed; with the small format-identical test model (local runs) the path is.
const pw = require('playwright'); const assert = require('assert'); const fs = require('fs'); const path = require('path');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js');
const [dist, pdf, engine = 'chromium'] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(dist, 'vendor/semantic/models/Xenova/all-MiniLM-L6-v2/config.json'), 'utf8')); const real = cfg.hidden_size === 384;
(async () => {
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};"); const b = await pw[engine].launch(); const errs = [], outside = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('C ' + m.text()); });
  p.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) outside.push(r.url()); });
  const api = (method, url, body) => p.evaluate(async ([m, u, x]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, body: await r.json() }; }, [method, url, body]);
  // 1) the card on this device, then «try it now» on the real screen
  await p.goto(site.url + '/#/operator'); await p.click('#op-on'); await p.waitForSelector('#semantic-state'); const st0 = await p.getAttribute('#semantic-state', 'data-state');
  assert.strictEqual(st0, 'downloadable', 'first visit: not downloaded yet'); const t0 = Date.now(); await p.click('#semantic-try');
  await p.waitForSelector('#semantic-try-result, #semantic-out .alert', { timeout: 180000 }); const shown = await p.innerText('#semantic-out'); assert(await p.$('#semantic-try-result'), 'the model ran on this device: ' + shown);
  const tryMs = Date.now() - t0; const r = (await api('POST', '/api/semantic/try')).body;      // the same run again (now warm), for its numbers
  console.log(`[${engine}] ${real ? 'REAL model' : 'test model'}: first «try it now» ${tryMs} ms (download + start + run); numbers ${JSON.stringify(r.sims)}; found ${JSON.stringify(r.examples.map((x) => [x.why, x.sim]))}`);
  assert(r.sims.twin_option > r.sims.unrelated + 0.25, 'a wrong option meaning the answer is much closer than two unrelated questions'); assert(r.examples.some((x) => x.why === 'two_right'), 'the twin option is found');
  assert(r.kept.some((k) => /Sympathetic/.test(k)), 'a deliberate opposite (increased / decreased heart rate) is not a twin');
  if (real) { assert(r.sims.same_fact > r.sims.unrelated + 0.25, 'the same fact in other words is much closer than two unrelated questions'); assert(r.sims.unrelated < 0.6, 'unrelated questions are far apart'); }
  await p.goto(site.url + '/#/operator'); await p.waitForSelector('#semantic-state'); assert.strictEqual(await p.getAttribute('#semantic-state', 'data-state'), 'available', 'after the run: working on this device');
  // 2) a quiz with the model on (in the same tab: the model stays loaded)
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
  const quiz = await p.evaluate(async () => { const d = (await (await fetch('/api/documents')).json())[0];
    let q = await (await fetch('/api/quizzes', { method: 'POST', body: JSON.stringify({ title: 'semantic', sources: [{ document_id: d.id, pages: null }], settings: { count: 10 } }) })).json();
    await fetch('/api/quizzes/' + q.id + '/analyze', { method: 'POST', body: JSON.stringify({ auto_generate: true }) });
    for (let i = 0; i < 600 && !['ready', 'failed', 'partial', 'insufficient'].includes(q.status); i++) { await new Promise((s) => setTimeout(s, 200)); q = await (await fetch('/api/quizzes/' + q.id)).json(); }
    return { status: q.status, n: (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()).length }; });
  assert.strictEqual(quiz.status, 'ready'); assert.strictEqual(quiz.n, 10, 'the count is kept');
  const st = (await api('GET', '/api/semantic')).body; assert(st.last && st.last.state === 'available' && st.last.checked >= 8, 'every question read for meaning: ' + JSON.stringify(st.last));
  await p.goto(site.url + '/#/operator'); await p.waitForSelector('#semantic-last'); const last = await p.innerText('#semantic-last');
  console.log(`[${engine}] quiz of ${quiz.n}: ${last.trim()}`);
  // 3) nothing left this machine
  assert.deepStrictEqual(outside, [], 'no request left this machine: ' + outside.join(' | ')); assert.deepStrictEqual(errs, [], errs.join(' | '));
  console.log(`[${engine}] no request left the machine; no page error - semantic E2E ok`); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
