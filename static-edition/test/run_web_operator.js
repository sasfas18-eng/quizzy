// node static-edition/test/run_web_operator.js <dist> <pdf>
// The AI box belongs to the OPERATOR; a paid Claude key is shared with every visitor ONLY through the relay (the real Worker code), never in the site:
//  1) a visitor has no box, and a key left in their browser does nothing;  2) the operator's own Claude key on this device: the request is the one the API accepts
//  (no temperature, effort for Claude 5, the key only to Anthropic);  3) when the credit runs out the quiz is still delivered (locally), with a note;
//  4) with a relay: visitors get Claude, the secret never reaches the page (requests, responses, storage, DOM), the operator page shows it works;
//  5) a relay set up wrong is diagnosed in plain words and visitors still get their quiz.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const { assertHidden, createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
const SECRET = 'sk-ant-api03-RELAY-ONLY-SECRET', OP_KEY = 'sk-ant-api03-OPERATOR-DEVICE-KEY';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const realFetch = globalThis.fetch;
const reportOf = async (p) => (await p.textContent('text=تقرير الجودة >> xpath=..')).replace(/\s+/g, ' ');

(async () => {
  const worker = (await import('../../relay/cloudflare-worker.mjs')).default;
  const llm = await startLLM(); const errs = [];
  // ---- what "Anthropic" answers: the pipeline's mock model behind the Messages API shape; the credit can be switched off
  const upstream = { log: [], credit: true, limit: false, scope: false };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://api.anthropic.com/v1/messages') return realFetch(url, init);
    const body = JSON.parse(init.body); upstream.log.push({ headers: init.headers, body });
    if (upstream.scope) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (upstream.limit) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (!upstream.credit) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    for (const k of ['temperature', 'top_p', 'top_k']) if (k in body) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: k + ' is not supported for this model' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const sys = (body.system || []).map((b) => b.text).join('\n'), user = typeof body.messages[0].content === 'string' ? body.messages[0].content : body.messages[0].content.map((b) => b.text).join('');
    const r = await realFetch(llm.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify({ model: body.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) });
    const j = await r.json(); return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: j.choices[0].message.content }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const b = await chromium.launch();
  const mkSite = async (cfg) => serve(dist, 0, cfg ? `window.QZ_CONFIG=${JSON.stringify({ supabaseUrl: '', supabaseAnonKey: '', llm: [], ...cfg })};` : undefined);
  const newCtx = async (site, { operator = false, legacyKey = false } = {}) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const seen = [];
    ctx.on('request', (r) => seen.push({ url: r.url(), headers: JSON.stringify(r.headers()), body: r.postData() || '' }));
    if (legacyKey) await ctx.addInitScript((base) => { try { localStorage.setItem('quizzy_llm_endpoints_v1', JSON.stringify([{ id: 'old1', name: 'Old', kind: 'openai', base, key: 'k-old', model: 'm', rpm: 600 }])); } catch (e) { /* ignore */ } }, llm.url);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('PE ' + e.message)); const U = site.url + '/#';
    if (operator) { await p.goto(U + '/operator'); await p.waitForSelector('#op-on'); await p.click('#op-on'); await p.waitForSelector('h1:has-text("ذكاء المشغل")'); }
    return { ctx, p, U, seen };
  };
  const upload = async (p, U) => { await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); };
  const anthropicRoute = async (ctx) => ctx.route('https://api.anthropic.com/**', async (route) => { const req = route.request();                       // the browser calls Anthropic directly (operator's own key): answer like Anthropic does
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const r = await globalThis.fetch(req.url(), { method: 'POST', headers: req.headers(), body: req.postData() }); route.fulfill({ status: r.status, headers: { ...CORS, 'content-type': 'application/json' }, body: await r.text() }); });
  const relayRoute = async (ctx, env, log) => ctx.route('https://quizzy-relay.test/**', async (route) => { const req = route.request();       // the relay is the REAL Worker code; only the network hop is simulated
    const r = await worker.fetch(new Request(req.url(), { method: req.method(), headers: { ...req.headers(), 'cf-connecting-ip': '203.0.113.7' }, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method()) ? undefined : req.postData() }), env);
    const text = await r.text(); log.push({ status: r.status, headers: JSON.stringify([...r.headers.entries()]), text }); route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: text }); });

  // ============ 1) a visitor: no box anywhere, and a key left in the browser does nothing
  { const site = await mkSite(); const { ctx, p, U, seen } = await newCtx(site, { legacyKey: true }); await upload(p, U);
    assert.strictEqual(await p.locator('#connect-ai').count(), 0); assert.strictEqual(await p.locator('nav a[href="#/settings"]').count(), 0); await assertHidden(p, 'visitor new-quiz page');
    await createQuiz(p, { count: 10 }); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(await reportOf(p)), 'a visitor\'s old saved key is ignored: the quiz is local');
    assert(!seen.some((r) => r.url.startsWith(llm.url)), 'nothing was sent to the key\'s provider'); console.log('1) visitor: no box, a saved key is ignored, quiz built locally'); await ctx.close(); await site.close(); }

  // ============ 2) the operator's own Claude key on this device + 3) the credit runs out
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); await anthropicRoute(ctx); upstream.log.length = 0;
    await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); assert.strictEqual(await p.inputValue('#quick-preset'), 'anthropic', 'Claude is the first choice'); assert.strictEqual(await p.locator('#quick-model').count(), 1);
    assert.deepStrictEqual(await p.$$eval('#quick-model option', (o) => o.map((x) => x.value)), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']); assert((await p.textContent('#quick-model-row')).includes('تقدير'), 'the cost is shown before choosing'); assert.strictEqual(await p.inputValue('#quick-model'), 'claude-sonnet-5-5', 'a small balance: the balanced model is pre-selected');
    await p.selectOption('#quick-model', 'claude-haiku-5-5'); await p.fill('#quick-key', OP_KEY); await p.click('#quick-go'); await p.waitForFunction(() => !document.querySelector('#connect-ai'), null, { timeout: 20000 });
    const t = upstream.log[0]; assert(t, 'a test call reached the provider'); assert.strictEqual(t.headers['x-api-key'], OP_KEY); assert.strictEqual(t.headers['anthropic-version'], '2023-06-01'); assert.strictEqual(t.body.model, 'claude-haiku-5-5');
    assert(!('temperature' in t.body) && !('top_p' in t.body) && !('top_k' in t.body), 'no sampling parameters'); assert.deepStrictEqual(t.body.output_config, { effort: 'low' }); assert(t.body.max_tokens >= 16000);
    await upload(p, U); await p.click('summary:has-text("خيارات إضافية")'); assert.strictEqual(await p.locator('#use-local').count(), 1, 'the operator may still choose local');
    await createQuiz(p, { count: 10 }); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p))); assert.strictEqual(await p.locator('#fallback-note').count(), 0);
    const gen = upstream.log.filter((x) => x.body.output_config && x.body.output_config.effort === 'medium').length, chk = upstream.log.filter((x) => x.body.output_config && x.body.output_config.effort === 'low').length; assert(gen >= 2 && chk >= 2, `effort per task: medium x${gen}, low x${chk}`);
    assert(upstream.log.every((x) => x.headers['x-api-key'] === OP_KEY && !('temperature' in x.body)), 'every call: the operator\'s key, no sampling parameters'); console.log('2) operator key: accepted request shape;', upstream.log.length, 'calls, medium x' + gen + ' / low x' + chk);
    // the credit runs out: the next quiz is still delivered
    upstream.credit = false; await upload(p, U); await createQuiz(p, { count: 10 }); assert.strictEqual(await p.locator('#fallback-note').count(), 1); assert(/credit balance/i.test(await p.textContent('#fallback-note')), 'the operator sees the real reason'); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(await reportOf(p)));
    await p.screenshot({ path: '/tmp/shots/operator-fallback.png', fullPage: true }); console.log('3) credit exhausted: quiz delivered locally, reason shown to the operator'); upstream.credit = true; await ctx.close(); await site.close(); }

  // ============ 3b) when the money stops, the operator is told in plain words WHY and WHERE to fix it (not a raw API error)
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); await anthropicRoute(ctx);
    const tryConnect = async () => { await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.fill('#quick-key', OP_KEY); await p.click('#quick-go'); await p.waitForSelector('#connect-ai .alert.bad', { timeout: 20000 }); return p.textContent('#connect-ai .alert.bad'); };
    upstream.credit = false; const noCredit = await tryConnect(); assert(/platform\.claude\.com\/settings\/billing/.test(noCredit) && /الرصيد/.test(noCredit), 'no credit: says where to look: ' + noCredit);
    upstream.credit = true; upstream.limit = true; const capped = await tryConnect(); assert(/سقف الإنفاق/.test(capped) && /Spend limits/.test(capped) && !/invalid_request_error/.test(capped), 'spend limit reached: explained, not a raw error: ' + capped);
    upstream.limit = false; upstream.scope = true; const unscoped = await tryConnect(); assert(/Default workspace/.test(unscoped) && /مساحة عمل/.test(unscoped) && !/invalid_request_error/.test(unscoped), 'an Organization-wide key: explained, with the fix: ' + unscoped); upstream.scope = false;
    assert.strictEqual(await p.locator('#connect-ai').count(), 1, 'a failed connection leaves nothing half-saved'); assert.strictEqual((await p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]').length)), 0);
    console.log('3b) credit gone / spend limit reached: plain-Arabic reason + where to fix it'); await ctx.close(); await site.close(); }

  // ============ 4) the relay: every visitor gets Claude, the secret never reaches a browser
  { const rlog = []; const site = await mkSite({ relay: 'https://quizzy-relay.test', relayModel: 'claude-sonnet-5-5' }); const env = { ANTHROPIC_API_KEY: SECRET, ALLOWED_ORIGIN: site.url };
    { const { ctx, p, U, seen } = await newCtx(site); await relayRoute(ctx, env, rlog); upstream.log.length = 0; await upload(p, U);
      assert.strictEqual(await p.locator('#connect-ai').count(), 0); assert.strictEqual(await p.locator('nav a[href="#/settings"]').count(), 0); assert.strictEqual(await p.locator('#local-note').count(), 0, 'AI is available: no "no key" note');
      await createQuiz(p, { count: 10, timeout: 90000 }); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p)), 'visitors get the AI'); await assertHidden(p, 'ready page via relay');
      assert(upstream.log.length >= 4, 'the relay forwarded the calls: ' + upstream.log.length); assert(upstream.log.every((x) => x.headers['x-api-key'] === SECRET && x.body.model === 'claude-sonnet-5-5' && !('temperature' in x.body)), 'upstream got the SECRET, the configured model, no sampling');
      const toRelay = seen.filter((r) => r.url.startsWith('https://quizzy-relay.test')); assert(toRelay.length >= 4 && toRelay.every((r) => !/x-api-key|authorization|anthropic-/i.test(r.headers)), 'the page sends no key and no provider headers to the relay');
      const everything = JSON.stringify(seen) + JSON.stringify(rlog) + (await p.content()) + JSON.stringify(await p.evaluate(() => ({ ...localStorage })));
      assert(!everything.includes(SECRET) && !/sk-ant/.test(everything), 'the secret key appears nowhere a browser can see: requests, responses, storage, page');
      console.log('4) relay: visitor got Claude via the relay;', upstream.log.length, 'calls; the secret appears nowhere in the browser'); await ctx.close(); }
    { const { ctx, p, U } = await newCtx(site, { operator: true }); await relayRoute(ctx, env, rlog); await p.goto(U + '/operator'); await p.waitForSelector('#relay-status h2:has-text("يعمل")', { timeout: 20000 }); assert((await p.textContent('#relay-status')).includes('claude-sonnet-5-5'));
      await p.click('#relay-test'); await p.waitForSelector('#relay-test-result:has-text("✓")', { timeout: 30000 }); await p.screenshot({ path: '/tmp/shots/operator-page.png', fullPage: true }); console.log('   operator page: relay shown as working, real test call ok'); await ctx.close(); }
    await site.close(); }

  // ============ 5) a relay set up wrong: diagnosed in plain words, and visitors still get their quiz
  { const site = await mkSite({ relay: 'https://quizzy-relay.test' }); const env = { ANTHROPIC_API_KEY: SECRET, ALLOWED_ORIGIN: 'https://some-other-site.example' }; const rlog = [];
    { const { ctx, p, U } = await newCtx(site, { operator: true }); await relayRoute(ctx, env, rlog); await p.goto(U + '/operator'); await p.waitForSelector('#relay-status h2:has-text("لا يقبل هذا الموقع")', { timeout: 20000 }); assert((await p.textContent('#relay-status')).includes('some-other-site.example'), 'it shows what is set and what it should be'); assert((await p.textContent('#relay-status')).includes(site.url));
      console.log('5) wrong ALLOWED_ORIGIN: operator page says so'); await ctx.close(); }
    { const { ctx, p, U } = await newCtx(site); await relayRoute(ctx, env, rlog); await upload(p, U); await createQuiz(p, { count: 10, timeout: 90000 }); assert.strictEqual(await p.locator('#fallback-note').count(), 1); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(await reportOf(p)));
      assert(!(await p.textContent('#fallback-note')).includes('HTTP'), 'a visitor gets a plain sentence, not a technical reason'); console.log('   visitor: quiz delivered locally despite the broken relay'); await ctx.close(); }
    { const env2 = { ALLOWED_ORIGIN: site.url }; const { ctx, p, U } = await newCtx(site, { operator: true }); await relayRoute(ctx, env2, rlog); await p.goto(U + '/operator'); await p.waitForSelector('#relay-status h2:has-text("ينقصه إعداد")', { timeout: 20000 }); assert((await p.textContent('#relay-status')).includes('ANTHROPIC_API_KEY')); console.log('   missing secret: operator page says so'); await ctx.close(); }
    await site.close(); }

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('operator / relay E2E ok'); await b.close(); await llm.close(); globalThis.fetch = realFetch;
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
