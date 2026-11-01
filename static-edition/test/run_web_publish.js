// node static-edition/test/run_web_publish.js <dist> — what the operator activates reaches EVERY visitor.
// Reported by the user: "on another device the site generates with the free local generator, not with what I set up" - the operator's keys lived in
// the operator's browser only. Now the operator page shows what visitors use and publishes the operator's FREE providers into the site's config.js
// (gh-pages, through the GitHub API with the operator's token). Here GitHub is a local fake that keeps the file.
//  1) the operator page says visitors are on the local generator; a paid Claude key is listed as NOT publishable (relay only)
//  2) "عمّم على كل الموقع": the free provider (with its key) is written into config.js on gh-pages, the Claude key is not; the token is checked and kept on this device only
//  3) a NEW visitor on another device, with the published config.js, gets the AI (no local-generator note) and sees no operator box; "ألغِ التعميم" empties the list
//  4) a wrong token: a clear message, nothing written
const { chromium } = require('playwright'); const assert = require('assert'); const http = require('http'); const fs = require('fs'); const path = require('path');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { start: startLLM } = require('./mock_llm.js');
const [dist] = process.argv.slice(2);
(async () => {
  const llm = await startLLM();
  // ---- fake GitHub contents API (CORS like api.github.com)
  let file = fs.readFileSync(path.join(dist, 'config.js'), 'utf8'), sha = 's1', puts = [], conflicts = 2;
  const gh = await new Promise((ok) => { const srv = http.createServer((q, r) => { const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
    if (q.method === 'OPTIONS') { r.writeHead(204, cors); return r.end(); }
    if (q.headers.authorization !== 'Bearer good-token') { r.writeHead(401, cors); return r.end('{}'); }
    if (!q.url.startsWith('/repos/me/site/contents/config.js')) { r.writeHead(404, cors); return r.end('{}'); }
    if (q.method === 'GET') { assert(/ref=gh-pages/.test(q.url)); r.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ sha, content: Buffer.from(file).toString('base64') })); }
    if (conflicts > 0) { conflicts--; sha = 'moved' + conflicts; r.writeHead(409, cors); return r.end('{}'); }      // the file moved between the read and the save (a deploy): the site must read it again and retry
    let body = ''; q.on('data', (c) => { body += c; }); q.on('end', () => { const j = JSON.parse(body); assert.strictEqual(j.branch, 'gh-pages'); assert.strictEqual(j.sha, sha); file = Buffer.from(j.content, 'base64').toString('utf8'); sha = 's' + (puts.length + 2); puts.push(j.message); r.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); r.end('{}'); }); });
    srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })); });
  const cfg0 = file.replace(/window\.QZ_CONFIG\s*=\s*\{/, `window.QZ_CONFIG = { repo: 'me/site', githubApi: '${gh.url}',`);
  const site = await serve(dist, 0, cfg0); const b = await chromium.launch(); const errs = [];
  const watch = (p) => { p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/401|409|favicon/.test(m.text())) errs.push(m.text()); }); };
  // ---- 1) the operator, with a free key and a paid one on this device
  const ctx = await b.newContext(); await seedAccount(ctx); const p = await ctx.newPage(); watch(p);
  await p.goto(site.url + '/#/operator'); await p.waitForSelector('#op-on'); await p.click('#op-on'); await p.waitForTimeout(300); await p.goto(site.url + '/#/operator'); await p.waitForSelector('#site-ai-now');
  await p.evaluate(async (base) => { for (const e of [{ name: 'Gemini', kind: 'openai', base, key: 'AIza-free-key-1', model: 'mock-model', rpm: 60 }, { name: 'Claude', kind: 'anthropic', base: 'https://api.anthropic.com', key: 'sk-ant-paid-key', model: 'claude-sonnet-5-5', rpm: 20 }]) await fetch('/api/llm/endpoints', { method: 'POST', body: JSON.stringify(e) }); }, 'https://generativelanguage.googleapis.com/v1beta/openai');
  await p.reload(); await p.waitForSelector('#publish-ai');
  assert(/التوليد المحلي/.test(await p.textContent('#site-ai-now')), 'the page says visitors are on the local generator'); assert(/Claude: مفتاح مدفوع لا يوضع/.test(await p.textContent('#site-ai-paid')), 'the paid key is not publishable');
  console.log('1) the operator page: visitors on the local generator; the paid Claude key is listed as relay-only');
  // ---- 4) a wrong token first
  await p.fill('#gh-token', 'bad-token'); await p.click('#publish-ai'); await p.click('.modal button:has-text("عمّم")'); await p.waitForSelector('#site-ai .alert.bad'); assert(/رمز GitHub غير صحيح/.test(await p.textContent('#site-ai .alert.bad'))); assert.strictEqual(puts.length, 0, 'nothing written');
  // ---- 2) publish
  await p.fill('#gh-token', 'good-token'); await p.click('#publish-ai'); await p.click('.modal button:has-text("عمّم")'); await p.waitForSelector('#site-ai-done');
  assert.strictEqual(puts.length, 1); const llmLine = file.split('\n').find((l) => /^\s*llm\s*:/.test(l)); assert(llmLine.includes('AIza-free-key-1') && !file.includes('sk-ant-paid-key'), 'the free provider is in config.js, the paid key is not: ' + llmLine);
  assert(file.includes("relay: ''") && /supabaseUrl/.test(file), 'the rest of config.js is untouched');
  assert.strictEqual(await p.evaluate(() => localStorage.getItem('quizzy_gh_token_v1')), 'good-token', 'the token is kept on this device (to publish again)');
  assert.strictEqual(conflicts, 0, 'two conflicts (409) were retried'); console.log('2) published (after two 409 conflicts, retried): the free provider written into config.js on gh-pages, the paid key not; a wrong token is refused clearly (4)');
  // ---- 3) another device, a plain visitor, with the published config.js
  const site2 = await serve(dist, 0, file); const ctx2 = await b.newContext(); await seedAccount(ctx2); const v = await ctx2.newPage(); watch(v);
  await v.goto(site2.url + '/#/new'); await v.waitForSelector('#create-quiz'); await v.waitForTimeout(400);
  assert.strictEqual(await v.locator('#local-note').count(), 0, 'the visitor has the AI (no local-generator note)'); assert.strictEqual(await v.locator('#connect-ai').count(), 0, 'and no operator box');
  assert.strictEqual(await v.evaluate(async () => (await fetch('/api/llm/site')).status), 403, 'the operator endpoints stay closed to visitors');
  console.log('3) a new visitor on another device generates with the published provider; no operator box');
  await p.evaluate(async () => (await fetch('/api/llm/publish', { method: 'POST', body: JSON.stringify({ none: true }) })).json());
  assert(/^\s*llm: \[\],/m.test(file), '"cancel" empties the list (saved token reused)');
  assert.strictEqual(errs.length, 0, errs.join(' | ')); console.log('publish E2E ok'); await b.close(); await site.close(); await site2.close(); gh.close(); await llm.close();
})().catch((e) => { console.error(e); process.exit(1); });
