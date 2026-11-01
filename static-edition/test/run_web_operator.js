// node static-edition/test/run_web_operator.js <dist> <pdf>
// The AI box belongs to the OPERATOR; a paid Claude key is shared with every visitor ONLY through the relay (the real Worker code), never in the site:
//  1) a visitor has no box, and a key left in their browser does nothing;  2) the operator's own Claude key on this device: the request is the one the API accepts
//  (no temperature, effort for Claude 5, the key only to Anthropic);  3) when the credit runs out the quiz is still delivered (locally), with a note;
//  4) with a relay: visitors get Claude, the secret never reaches the page (requests, responses, storage, DOM), the operator page shows it works;
//  5) a relay set up wrong is diagnosed in plain words and visitors still get their quiz;
//  6) the providers back each other up in a PRESET order (Claude first, even if the free one was added first); when Claude's credit is gone the next one carries on
//     (no local fallback), the operator page shows the path and why, and a real check brings Claude back.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const { assertHidden, createQuiz, reportOf } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
const SECRET = 'sk-ant-api03-RELAY-ONLY-SECRET', OP_KEY = 'sk-ant-api03-OPERATOR-DEVICE-KEY';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const realFetch = globalThis.fetch;

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
    if (req.method() === 'GET') return route.abort('failed');       // the REAL API answers GET /v1/models WITHOUT any CORS header (measured, even its 401), so a page can never read it: anything that depends on it must fail here exactly as it does in a browser
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

  // ============ 3d) the "CORS" failure the operator hit: the advanced form with Claude and NO model typed used to ask GET /v1/models (unreadable from a browser) -> now Claude's models are a known list
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); await anthropicRoute(ctx); upstream.credit = true; upstream.log.length = 0; const gets = []; ctx.on('request', (r) => { if (r.method() === 'GET' && r.url().startsWith('https://api.anthropic.com')) gets.push(r.url()); });
    await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.click('summary:has-text("خيارات متقدمة")'); await p.selectOption('#preset', 'anthropic'); await p.fill('#key', OP_KEY);
    await p.click('form:not(#connect-ai) button[type=submit]'); await p.waitForSelector('.toast:has-text("أُضيف المفتاح")', { timeout: 10000 }); assert.strictEqual(gets.length, 0, 'no model-list request is ever made to Anthropic');
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]')); assert.strictEqual(saved.length, 1); assert.strictEqual(saved[0].model, 'claude-sonnet-5-5', 'the balanced model is chosen for a small balance'); assert.strictEqual(saved[0].kind, 'anthropic');
    await p.click('button:has-text("اختبار")'); await p.waitForSelector('text=يعمل'); assert(upstream.log.length >= 1 && upstream.log[0].headers['x-api-key'] === OP_KEY && upstream.log[0].body.model === 'claude-sonnet-5-5', 'the real test message went to Anthropic with the key');
    console.log('3d) advanced form, Claude, no model typed: no unreadable model-list call, added at once, real test ok'); await ctx.close(); await site.close(); }

  // ============ 3e) Groq's free tier, the failure an operator hit: requests above its tokens-per-minute budget are answered 413 "Request too large". The site must size its requests for the provider,
  //             learn from a refusal, and still deliver the quiz made by the AI (not the local fallback).
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const groq = { refused: 0, ok: 0, maxLen: 0, lists: 0 }; const BUDGET = 5000;      // tokens per request (prompt/3 + max_tokens), like a small free tier
    await ctx.route('https://api.groq.com/**', async (route) => { const req = route.request(); if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.method() === 'GET') { groq.lists++; return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-20b' }] }) }); }
      const body = JSON.parse(req.postData()); const len = body.messages.map((m) => m.content).join('').length; const asked = Math.round(len / 3 + body.max_tokens);
      if (asked > BUDGET) { groq.refused++; return route.fulfill({ status: 413, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'Request too large for model `' + body.model + '` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit ' + BUDGET + ', Requested ' + asked + ', please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } }) }); }
      groq.ok++; groq.maxLen = Math.max(groq.maxLen, asked); const r = await realFetch(llm.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify({ model: body.model, messages: body.messages }) });
      route.fulfill({ status: r.status, headers: { ...CORS, 'content-type': 'application/json' }, body: await r.text() }); });
    await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.selectOption('#quick-preset', 'groq'); await p.fill('#quick-key', 'gsk_test_key_123'); await p.click('#quick-go'); await p.waitForFunction(() => !document.querySelector('#connect-ai'), null, { timeout: 20000 });
    assert.strictEqual(groq.lists, 1, 'the model list is asked once (Groq allows it from a browser)'); const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]')); assert.strictEqual(saved[0].model, 'llama-3.3-70b-versatile', 'a real chat model, not the whisper one listed first');
    await p.evaluate(() => { const k = 'quizzy_llm_endpoints_v1'; const a = JSON.parse(localStorage.getItem(k)); a.forEach((e) => { e.rpm = 600; e.limits = { tpm: 0 }; }); localStorage.setItem(k, JSON.stringify(a)); });   // pacing by tokens is unit-tested; here the quiz must not wait a real minute
    await upload(p, U); await createQuiz(p, { count: 10, timeout: 120000 }); assert.strictEqual(await p.locator('#fallback-note').count(), 0, 'no local fallback: Groq served the quiz'); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p)), 'made by the AI');
    assert(groq.ok >= 6, 'the AI did the work: ' + groq.ok + ' calls'); assert(groq.maxLen <= BUDGET, 'no accepted request above the provider\'s budget');
    console.log('3e) Groq free-tier budget (' + BUDGET + ' tokens/request): ' + groq.ok + ' requests served, ' + groq.refused + ' refused (learned from), largest ' + groq.maxLen + ' -> quiz made by the AI'); await ctx.close(); await site.close(); }

  // ============ 3f) the "no JSON in model output" an operator met: the only chat model the site could pick on the Groq list was a THINKING one (gpt-oss). It pays its hidden reasoning out of max_tokens, so with a
  //             small budget its answer is EMPTY. The connection test (it used to ask for 64 tokens) and the whole quiz must work anyway: more room + "think little", and it is learned after the first time.
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const groq = { empty: 0, ok: 0, lists: 0 };
    await ctx.route('https://api.groq.com/**', async (route) => { const req = route.request(); if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.method() === 'GET') { groq.lists++; return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }] }) }); }
      const body = JSON.parse(req.postData()); const need = body.reasoning_effort === 'low' ? 150 : 6000;      // hidden reasoning is paid from max_tokens: the default effort burns far more than the site first allows
      if (body.max_tokens < need) { groq.empty++; return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'Okay, the user wants me to ...' } }] }) }); }
      groq.ok++; const r = await realFetch(llm.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify({ model: body.model, messages: body.messages }) });
      route.fulfill({ status: r.status, headers: { ...CORS, 'content-type': 'application/json' }, body: await r.text() }); });
    await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.selectOption('#quick-preset', 'groq'); await p.fill('#quick-key', 'gsk_test_key_123'); await p.click('#quick-go');
    await p.waitForFunction(() => !document.querySelector('#connect-ai'), null, { timeout: 20000 });
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]')); assert.strictEqual(saved[0].model, 'openai/gpt-oss-20b', 'the only chat model on that list');
    assert(groq.empty >= 1 && groq.ok >= 1, 'the connection test needed the second, adjusted try: ' + JSON.stringify({ empty: groq.empty, ok: groq.ok }));
    await p.evaluate(() => { const k = 'quizzy_llm_endpoints_v1'; const a = JSON.parse(localStorage.getItem(k)); a.forEach((e) => { e.rpm = 600; e.limits = { tpm: 0 }; }); localStorage.setItem(k, JSON.stringify(a)); });   // pacing by tokens is unit-tested
    groq.empty = 0; groq.ok = 0; await upload(p, U); await createQuiz(p, { count: 10, timeout: 120000 });
    assert.strictEqual(await p.locator('#fallback-note').count(), 0, 'no local fallback: the thinking model served the quiz'); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p)), 'made by the AI');
    assert(groq.ok >= 6, 'the AI did the work: ' + groq.ok); assert(groq.empty <= 4, 'it learned: a few empty answers at the start, not one per request: ' + groq.empty);
    console.log('3f) thinking model on Groq (gpt-oss): connection test ok after one adjusted retry; quiz made by the AI (' + groq.ok + ' answers, only ' + groq.empty + ' empty ones)'); await ctx.close(); await site.close(); }

  // ============ 3g) a model that never answers in JSON (prose only): the quiz is NOT failed with the bare English line — it is delivered locally, the key is parked with the reason, the provider is not hammered
  { const site = await mkSite(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const groq = { calls: 0 };
    await ctx.addInitScript(() => { try { localStorage.setItem('quizzy_operator_v1', '1'); localStorage.setItem('quizzy_llm_endpoints_v1', JSON.stringify([{ id: 'g1', name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', key: 'gsk_x', model: 'llama-3.3-70b-versatile', rpm: 600, limits: { tpm: 0 } }])); } catch (e) { /* ignore */ } });
    await ctx.route('https://api.groq.com/**', async (route) => { if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS }); groq.calls++;
      route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: "I'm sorry, but I can't help with that request." } }] }) }); });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('PE ' + e.message)); const U = site.url + '/#';
    await upload(p, U); await createQuiz(p, { count: 10, timeout: 120000 });
    assert.strictEqual(await p.locator('#fallback-note').count(), 1, 'delivered locally, with the reason'); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(await reportOf(p)));
    const note = (await p.textContent('#fallback-note')).trim(); assert(!/^no JSON in model output$/.test(note) && /JSON/.test(note) && /llama-3\.3-70b-versatile/.test(note), 'the operator is told which model and what it said: ' + note);
    assert(groq.calls >= 2 && groq.calls <= 24, 'bounded: each of the two models is asked again once per request, a few requests run in parallel before the first strike lands, then both rest: ' + groq.calls + ' requests');
    await p.goto(U + '/operator'); await p.waitForSelector('#chain-list li[data-name="Groq"]'); assert.strictEqual(await p.getAttribute('#chain-list li[data-name="Groq"]', 'data-state'), 'out'); assert(/JSON/.test(await p.textContent('#chain-list li[data-name="Groq"]')), 'the reason is on the operator page');
    console.log('3g) a model that never answers in JSON: quiz delivered locally with the reason, models resting with the reason (' + groq.calls + ' requests to the provider in all)'); await ctx.close(); await site.close(); }

  // ============ 3h) the connect card with a model that answers in prose: it says in plain Arabic WHICH model and WHAT it answered (not the bare English line) and saves nothing
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); let calls = 0;
    await ctx.route('https://api.groq.com/**', async (route) => { const req = route.request(); if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.method() === 'GET') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'llama-3.3-70b-versatile' }] }) });
      calls++; route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello! How can I help you today?' } }] }) }); });
    await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.selectOption('#quick-preset', 'groq'); await p.fill('#quick-key', 'gsk_test_key_123'); await p.click('#quick-go');
    await p.waitForSelector('#connect-ai .alert.bad', { timeout: 20000 }); const msg = (await p.textContent('#connect-ai .alert.bad')).trim();
    assert(/llama-3\.3-70b-versatile/.test(msg) && /JSON/.test(msg) && /How can I help/.test(msg) && msg !== 'no JSON in model output', 'plain message naming the model and what it said: ' + msg); assert(calls <= 2, 'one try and one adjusted retry: ' + calls);
    assert.strictEqual(await p.evaluate(() => (JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]')).length), 0, 'a key that cannot work is not saved');
    console.log('3h) connect card, model answering in prose: ' + msg.slice(0, 90) + '…'); await ctx.close(); await site.close(); }

  // ============ 3i) the connect card, the first model of the list never answers in JSON: it goes on to the next one by itself (a problem of the MODEL is not a problem of the KEY)
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const seenModels = [];
    await ctx.route('https://api.groq.com/**', async (route) => { const req = route.request(); if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (req.method() === 'GET') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }] }) });
      const body = JSON.parse(req.postData()); seenModels.push(body.model); const content = body.model === 'llama-3.3-70b-versatile' ? 'Hello! How can I help you today?' : '{"ok": true}';
      route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }) }); });
    await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.selectOption('#quick-preset', 'groq'); await p.fill('#quick-key', 'gsk_test_key_123'); await p.click('#quick-go');
    await p.waitForFunction(() => !document.querySelector('#connect-ai'), null, { timeout: 20000 });
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]')); assert.strictEqual(saved.length, 1, 'only the working model is kept'); assert.strictEqual(saved[0].model, 'llama-3.1-8b-instant', 'the next model of the list');
    assert(seenModels.includes('llama-3.3-70b-versatile') && seenModels.includes('llama-3.1-8b-instant'), 'both were tried: ' + seenModels);
    console.log('3i) connect card: the first model never answers in JSON -> the next one is tried and kept (' + seenModels.join(' > ') + ')'); await ctx.close(); await site.close(); }

  // ============ 3j-3m) "Google Gemini: HTTP 503" - the provider is OVERLOADED, the key is fine. The Gemini native API is what the site calls (generateContent); here a page.route plays Google.
  const geminiModels = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
  const geminiRoute = async (ctx, g) => ctx.route('https://generativelanguage.googleapis.com/**', async (route) => { const req = route.request(); if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const J = { ...CORS, 'content-type': 'application/json' };
    if (req.method() === 'GET') { g.lists++; return route.fulfill({ status: 200, headers: J, body: JSON.stringify({ models: geminiModels.map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })).concat([{ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }]) }) }); }
    const model = /models\/([^:]+):/.exec(req.url())[1]; g.byModel[model] = (g.byModel[model] || 0) + 1; g.total++;
    if (g.mode(model, g.total) === 503) { g.busy++; return route.fulfill({ status: 503, headers: J, body: JSON.stringify({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }) }); }
    const body = JSON.parse(req.postData()); const sys = body.systemInstruction.parts.map((x) => x.text).join(''), user = body.contents[0].parts.map((x) => x.text).join('');
    const r = await realFetch(llm.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) }); const j = await r.json();
    g.ok++; route.fulfill({ status: 200, headers: J, body: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: j.choices[0].message.content }] } }] }) }); });
  const newGem = (mode) => ({ lists: 0, total: 0, ok: 0, busy: 0, byModel: {}, mode });
  const connectGemini = async (p, U) => { await p.goto(U + '/settings'); await p.waitForSelector('#connect-ai'); await p.selectOption('#quick-preset', 'gemini'); await p.fill('#quick-key', 'AIza-test-key-123'); await p.click('#quick-go'); };

  // ---- 3j) the card (what the operator did): Gemini answers 503 to every request. The KEY is accepted and kept, the page says so in plain Arabic, nothing is deleted.
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const g = newGem(() => 503); await geminiRoute(ctx, g);
    await connectGemini(p, U); await p.waitForSelector('#busy-note', { timeout: 30000 }); const note = (await p.textContent('#busy-note')).replace(/\s+/g, ' ');
    assert(/مزدحمة/.test(note) && /503/.test(note) && /gemini-2\.5-flash/.test(note) && /المفتاح مقبول/.test(note), 'plain Arabic: the key is fine, the provider is busy: ' + note); assert(!/^Google Gemini: HTTP 503$/.test(note.trim()));
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_llm_endpoints_v1') || '[]')); assert.strictEqual(saved.length, 1, 'the key is kept'); assert.strictEqual(saved[0].model, 'gemini-2.5-flash'); assert.strictEqual(g.lists, 1);
    assert.strictEqual(g.total, 3, 'a few quick tries, not a long wait: ' + g.total); await p.screenshot({ path: '/tmp/shots/gemini-busy-card.png' });
    console.log('3j) Gemini answers 503: key kept, "' + note.slice(0, 80) + '…" (' + g.total + ' quick tries)'); await ctx.close(); await site.close(); }

  // ---- 3k) the preferred Gemini model is overloaded while the lighter one of the SAME key works: the quiz is still made by the AI, the busy model is not hammered
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const g = newGem((m) => (m === 'gemini-2.5-flash' ? 503 : 0)); await geminiRoute(ctx, g);
    await connectGemini(p, U); await p.waitForSelector('#busy-note', { timeout: 30000 }); g.total = 0; g.busy = 0; g.ok = 0; g.byModel = {};
    await p.evaluate(() => { const k = 'quizzy_llm_endpoints_v1'; const a = JSON.parse(localStorage.getItem(k)); a.forEach((e) => { e.rpm = 600; }); localStorage.setItem(k, JSON.stringify(a)); });
    await upload(p, U); await createQuiz(p, { count: 10, timeout: 120000 });
    assert.strictEqual(await p.locator('#fallback-note').count(), 0, 'no local fallback: the lighter Gemini model served'); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p)), 'made by the AI');
    assert(g.byModel['gemini-2.5-flash-lite'] >= 6, 'the alternate did the work: ' + JSON.stringify(g.byModel)); assert((g.byModel['gemini-2.5-flash'] || 0) <= 4, 'the busy model was tried and then left alone: ' + JSON.stringify(g.byModel));
    await p.goto(U + '/operator'); await p.waitForSelector('#chain-list li[data-alt="1"]'); const rows = await p.$$eval('#chain-list li', (l) => l.filter((x) => x.querySelector('code')).map((x) => [x.getAttribute('data-name'), x.querySelector('code').textContent, x.getAttribute('data-state'), x.getAttribute('data-alt')]));
    assert.deepStrictEqual(rows.slice(0, 3).map((r) => r[1]), geminiModels, 'preferred model first, then its alternates: ' + JSON.stringify(rows)); assert.notStrictEqual(rows[0][2], 'ready', 'the busy model rests'); assert.strictEqual(rows[1][2], 'ready');
    await p.screenshot({ path: '/tmp/shots/operator-chain-alternates.png', fullPage: true });
    console.log('3k) Gemini flash overloaded: ' + JSON.stringify(g.byModel) + ' -> quiz made by the AI through the alternate model; the path page lists it'); await ctx.close(); await site.close(); }

  // ---- 3l) Gemini is down for every model and nothing else is connected: the free local generator delivers, quickly, with the reason - nobody waits minutes
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const g = newGem(() => 503); await geminiRoute(ctx, g);
    await connectGemini(p, U); await p.waitForSelector('#busy-note', { timeout: 30000 }); g.total = 0;
    await upload(p, U); const t0 = Date.now(); await createQuiz(p, { count: 10, timeout: 120000 }); const secs = Math.round((Date.now() - t0) / 1000);
    assert.strictEqual(await p.locator('#fallback-note').count(), 1, 'every model busy: the local generator delivers, with the reason'); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(await reportOf(p)));
    assert(secs < 90, 'did not make anyone wait minutes: ' + secs + 's'); const n = g.total; assert(n <= 14, 'not hammered: ' + n + ' requests');
    await p.goto(U + '/operator'); await p.waitForSelector('#chain-list li'); const states = await p.$$eval('#chain-list li[data-alt]', (l) => l.map((x) => x.getAttribute('data-state'))); assert(states.every((s) => s === 'out'), 'all three parked with the reason: ' + states);
    assert(/مزدحمة/.test(await p.textContent('#chain-list li')), 'the reason is on the page');
    console.log('3l) every Gemini model busy: quiz delivered locally in ' + secs + 's (' + n + ' requests in all), models parked with the reason'); await ctx.close(); await site.close(); }

  // ---- 3m) the AI dies HALFWAY through a quiz (works for the first requests, then 503 for good): the quiz is still delivered in full - what the AI made plus the rest made locally
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const g = newGem((m, n) => (n > 7 ? 503 : 0)); await geminiRoute(ctx, g);
    await connectGemini(p, U); await p.waitForFunction(() => !document.querySelector('#quick-go') || document.querySelector('#busy-note') || !document.querySelector('#connect-ai'), null, { timeout: 30000 }); g.total = 0; g.ok = 0; g.busy = 0;
    await p.evaluate(() => { const k = 'quizzy_llm_endpoints_v1'; const a = JSON.parse(localStorage.getItem(k)); a.forEach((e) => { e.rpm = 600; }); localStorage.setItem(k, JSON.stringify(a)); });
    await upload(p, U); await createQuiz(p, { count: 10, timeout: 120000 }); const rep = await reportOf(p);
    assert(g.ok >= 3 && g.busy >= 1, 'the AI worked and then died: ' + JSON.stringify({ ok: g.ok, busy: g.busy })); assert(/10/.test(rep), 'delivered the full count');
    console.log('3m) AI died after ' + g.ok + ' answers: quiz delivered in full (' + rep.slice(0, 60) + '…)'); await ctx.close(); await site.close(); }

  // ---- 3n) the shell works exactly as before - only its look changed - and the menu is a VERTICAL list on the side: the account name + "خروج", the operator's link, the theme switch;
  //          on a wide screen the menu is always there (a full-height column on the right, in Arabic); on a phone it is a drawer from the same side (button, Esc, a tap outside, a link closes it);
  //          nothing may be clipped or fall outside the screen, down to a 320px phone; and the signature "أخوكم سعد مقبل" is on the page exactly ONCE.
  { const site = await mkSite(); const { ctx, p, U } = await newCtx(site, { operator: true }); const sigCount = async () => (await p.evaluate(() => document.body.innerText)).split('أخوكم سعد مقبل').length - 1;
    const NAV = [['#/', 'الرئيسية'], ['#/files', 'ملفاتي'], ['#/quizzes', 'كويزاتي'], ['#/cards', 'بطاقات المراجعة'], ['#/settings', 'ذكاء المشغل']]; const navLink = (href) => `nav.links a[href="${href}"]`;
    for (const [label, vp, wide] of [['desktop 1280', { width: 1280, height: 860 }, true], ['tablet 900', { width: 900, height: 800 }, false], ['phone 390', { width: 390, height: 844 }, false], ['phone 360', { width: 360, height: 740 }, false], ['phone 320', { width: 320, height: 640 }, false]]) {
      await p.setViewportSize(vp); await p.goto(U + '/'); await p.waitForSelector('h1'); await p.waitForSelector('header a.acct', { state: 'attached' }); await p.waitForTimeout(300);
      const inView = async (sel, what) => { const el = p.locator(sel).first(); assert(await el.isVisible(), label + ': ' + what + ' is visible'); const r = await el.boundingBox(); assert(r.x >= -0.5 && r.x + r.width <= vp.width + 0.5 && r.y >= -0.5 && r.y + r.height <= vp.height + 0.5, label + ': ' + what + ' is inside the screen ' + JSON.stringify(r)); return r; };
      assert(await p.locator('header .sig').isVisible() && (await sigCount()) === 1 && (await p.locator('header .sig').count()) === 1, label + ': the signature is visible, once, in the lockup'); await inView('header .logo', 'the lockup');
      if (wide) { assert(!(await p.locator('#menu-btn').isVisible()), label + ': no menu button, the menu is always there'); const side = await p.locator('header#top').boundingBox(); assert(side.x + side.width >= vp.width - 1 && side.height >= vp.height - 1 && side.width < 340, label + ': the menu is a full-height column on the right ' + JSON.stringify(side)); }
      else { assert(await p.locator('#menu-btn').isVisible(), label + ': a menu button'); assert(!(await p.locator(navLink('#/files')).isVisible()), label + ': the drawer is closed at first'); assert.strictEqual(await p.getAttribute('#menu-btn', 'aria-expanded'), 'false');
        await p.click('#menu-btn'); await p.waitForTimeout(400); assert.strictEqual(await p.getAttribute('#menu-btn', 'aria-expanded'), 'true'); }
      const boxes = []; for (const [href, t] of NAV) { boxes.push(await inView(navLink(href), 'the menu item "' + t + '"')); const clipped = await p.evaluate((sel) => { const a = document.querySelector(sel); return a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1; }, navLink(href)); assert(!clipped, label + ': the item "' + t + '" is not clipped'); }
      for (let k = 1; k < boxes.length; k++) assert(boxes[k].y > boxes[k - 1].y + 20 && Math.abs(boxes[k].x - boxes[0].x) < 2, label + ': the menu is a vertical list');
      await inView('header a.acct', 'the account link'); assert(/حسابي/.test(await p.getAttribute('header a.acct', 'aria-label')), label + ': the account link is named'); assert.strictEqual(await p.getAttribute('header a.acct', 'href'), '#/account');
      await inView('header button:has-text("خروج")', 'the logout button'); await inView('#theme-toggle', 'the theme switch');
      assert((await p.evaluate(() => document.documentElement.scrollWidth)) <= vp.width, label + ': no horizontal scrolling');
      if (!wide) { await p.keyboard.press('Escape'); await p.waitForTimeout(400); assert(!(await p.locator(navLink('#/files')).isVisible()), label + ': Esc closes the drawer'); assert.strictEqual(await p.evaluate(() => document.activeElement && document.activeElement.id), 'menu-btn', label + ': focus goes back to the button');
        await p.click('#menu-btn'); await p.waitForTimeout(350); await p.mouse.click(8, Math.round(vp.height / 2)); await p.waitForTimeout(400); assert(!(await p.locator(navLink('#/files')).isVisible()), label + ': a tap outside closes it'); } }
    { await p.setViewportSize({ width: 390, height: 844 }); await p.goto(U + '/'); await p.waitForSelector('#menu-btn'); await p.click('#menu-btn'); await p.waitForTimeout(350); await p.click(navLink('#/files')); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(350);
      assert(!(await p.locator(navLink('#/quizzes')).isVisible()), 'picking an item closes the drawer and opens the page'); assert.strictEqual(await p.getAttribute(navLink('#/files'), 'aria-current'), 'page', 'and the item of the page you are on is marked'); }
    { await p.setViewportSize({ width: 390, height: 844 }); await p.goto(U + '/'); await p.waitForSelector('#menu-btn'); await p.click('#menu-btn'); await p.waitForTimeout(350); await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await p.waitForTimeout(400);
      assert.strictEqual(await p.evaluate(() => document.getElementById('top').classList.contains('open')), false, 'logging out from the drawer leaves it closed'); assert(await p.locator('.hero a:has-text("لدي حساب")').isVisible(), 'and the landing page is usable'); await p.click('.hero a:has-text("لدي حساب")'); await p.waitForSelector('#email'); await p.fill('#email', 'a@b.co'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('text=أهلًا'); }
    await p.setViewportSize({ width: 1280, height: 860 }); for (const h of ['/files', '/quizzes', '/cards', '/settings', '/account']) { await p.goto(U + h); await p.waitForSelector('h1'); assert.strictEqual(await sigCount(), 1, 'the signature appears once on ' + h); }
    await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); assert(/حوّل سلايداتك إلى كويزات دقيقة وبطاقات مراجعة/.test(await p.textContent('.hero h1')), 'logging out shows the landing page'); assert.strictEqual(await sigCount(), 1, 'the signature appears once on the landing page');
    assert.strictEqual(await p.locator('header a:text-is("دخول")').count(), 1, 'the landing page offers sign-in in the menu'); assert.strictEqual(await p.locator('header a:has-text("الدخول كضيف")').count(), 1, 'and the guest entry'); assert.strictEqual(await p.locator('header a:has-text("إنشاء حساب")').count(), 1);
    await p.click('.hero a:has-text("لدي حساب")'); await p.waitForSelector('#email'); await p.fill('#email', 'a@b.co'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('text=أهلًا'); await p.waitForSelector(navLink('#/settings'));
    console.log('3n) vertical side menu: always there on a wide screen, a drawer from the same side on phones (down to 320px); account link + logout + operator link + theme inside the screen, signature once; logout -> landing -> sign-in works as before'); await ctx.close(); await site.close(); }

  // ============ 3c) the providers BACK EACH OTHER UP, in a preset order
  { const site = await mkSite(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const direct = []; ctx.on('request', (r) => { if (r.url().startsWith(llm.url)) direct.push(r.url()); });
    await ctx.addInitScript(([base, key]) => { try { localStorage.setItem('quizzy_operator_v1', '1'); localStorage.setItem('quizzy_llm_endpoints_v1', JSON.stringify([
      { id: 'free1', name: 'نموذج مجاني', kind: 'openai', base, key: 'k-free', model: 'm', rpm: 600 },          // added FIRST on purpose: the preset order decides, not the insertion order
      { id: 'claude1', name: 'Claude', kind: 'anthropic', base: 'https://api.anthropic.com', key, model: 'claude-haiku-5-5', rpm: 600 }])); } catch (e) { /* ignore */ } }, [llm.url, OP_KEY]);
    await anthropicRoute(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('PE ' + e.message)); const U = site.url + '/#';
    // (a) Claude is preferred although the free provider was added first
    upstream.log.length = 0; upstream.credit = true; await upload(p, U); await createQuiz(p, { count: 10 });
    assert(upstream.log.length >= 4, 'Claude did the work: ' + upstream.log.length); assert.strictEqual(direct.length, 0, 'the free provider was not touched while Claude works'); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p)));
    // (b) Claude's credit is gone: the free provider carries on — the quiz is still made by AI, not by the local generator
    upstream.credit = false; const before = upstream.log.length; await upload(p, U); await createQuiz(p, { count: 10 });
    assert(direct.length > 0, 'the next provider served the quiz'); assert.strictEqual(await p.locator('#fallback-note').count(), 0, 'no local fallback: another AI answered'); assert(/المولّد: ذكاء اصطناعي/.test(await reportOf(p)));
    assert(upstream.log.length - before <= 6, 'Claude was not hammered once it was out: ' + (upstream.log.length - before) + ' attempts');
    // (c) the operator page shows the path, in order, and why Claude is out
    await p.goto(U + '/operator'); await p.waitForSelector('#chain-list li[data-name="Claude"]');
    const order = await p.$$eval('#chain-list li', (l) => l.map((x) => x.getAttribute('data-name'))); assert.deepStrictEqual(order, ['Claude', 'نموذج مجاني', 'local'], 'preset order, local generator last');
    assert.strictEqual(await p.getAttribute('#chain-list li[data-name="Claude"]', 'data-state'), 'out'); assert.strictEqual(await p.getAttribute('#chain-list li[data-name="نموذج مجاني"]', 'data-state'), 'ready');
    assert(/نفد الرصيد/.test(await p.textContent('#chain-list li[data-name="Claude"]')) && /يُعاد تجريبه تلقائيًا/.test(await p.textContent('#chain-list li[data-name="Claude"]')), 'plain reason + it retries by itself');
    await p.screenshot({ path: '/tmp/shots/operator-chain-out.png', fullPage: true });
    // (d) credit is back: one real check brings Claude back, and it takes over again
    upstream.credit = true; await p.click('#chain-go'); await p.waitForSelector('#chain-check [data-ok="1"]'); await p.waitForFunction(() => document.querySelectorAll('#chain-check [data-ok]').length === 2);
    assert.strictEqual(await p.locator('#chain-check [data-ok="0"]').count(), 0, 'both providers answer the real check'); assert.strictEqual(await p.getAttribute('#chain-list li[data-name="Claude"]', 'data-state'), 'ready');
    await p.screenshot({ path: '/tmp/shots/operator-chain-ok.png', fullPage: true });
    const d1 = direct.length, u1 = upstream.log.length; await upload(p, U); await createQuiz(p, { count: 10 }); assert.strictEqual(direct.length, d1, 'Claude took over again: no request to the free provider'); assert(upstream.log.length > u1);
    // (e) both gone (Claude out of credit, the other one rejects its key): the quiz is still delivered, locally, with the reason
    upstream.credit = false; await ctx.route(llm.url + '/**', (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 401, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"error":"nope"}' })));
    await upload(p, U); await createQuiz(p, { count: 10 }); assert.strictEqual(await p.locator('#fallback-note').count(), 1, 'every AI failed: the local generator delivers'); assert(/محلي \(بدون ذكاء اصطناعي\)/.test(await reportOf(p)));
    console.log('3c) preset order, mutual back-up (Claude out -> the free one carries on -> Claude back after a real check), local only when all fail'); upstream.credit = true; await ctx.close(); await site.close(); }

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
