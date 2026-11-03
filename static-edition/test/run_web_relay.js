// node static-edition/test/run_web_relay.js <dist> <pdf>
// AI-written quizzes for EVERY visitor via the site's relay (config.js `relay` = a Cloudflare Worker that holds a free Gemini key SERVER-side), WITHOUT
// a key in the site and without the visitor signing up or seeing anything new:
//  1) with the relay set, a quiz is written through the AI (the engine's analyse/generate/verify run), the generator says it is the relay's model, and the
//     site never sends a key to the relay (the key is the relay's, not the site's);
//  2) when the relay fails or its free daily quota is spent (429), the quiz is built LOCALLY instead, with a clear note - no visitor is ever blocked;
//  3) the published config carries only the relay's ADDRESS, never a key; the operator page sees the relay as configured.
// The relay is stood in for by an OpenAI-compatible mock (test/mock_llm.js) whose "model" builds cloze questions from the pages - the same wire shape the
// real Cloudflare Worker forwards to Gemini. The real worker is unit-tested in relay/test/worker.test.mjs.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { start: startRelay } = require('./mock_llm.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2);
(async () => {
  const relay = await startRelay(0);      // the fake relay: GET/POST on http://127.0.0.1:<port>/... ; its `stats` object is live
  const relayOrigin = relay.url.replace(/\/v1$/, '');
  const site = await serve(dist, 0, `window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',relay:'${relayOrigin}',relayModel:'gemini-2.0-flash'};`);
  const b = await chromium.launch(); const errs = []; const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const api = (method, url, body) => p.evaluate(async ([m, u, x]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: x ? JSON.stringify(x) : undefined }); let j = null; try { j = await r.json(); } catch (_) { j = null; } return j; }, [method, url, body]);
  const quizById = (id) => api('GET', '/api/quizzes/' + id);

  // the site knows AI is available through the relay, with no key of its own
  await p.goto(site.url + '/#/'); await p.waitForSelector('#lang-switch');
  const caps = await api('GET', '/api/auth/capabilities'); assert(caps.claude_ok === true && caps.relay === true && caps.shared_ai === true, JSON.stringify(caps));

  // 1) a quiz written through the AI relay
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع|جارٍ قراءة/.test(document.body.innerText), null, { timeout: 60000 });
  const doc = (await api('GET', '/api/documents'))[0];
  await p.goto(site.url + '/#/new?doc=' + doc.id); await createQuiz(p, { count: 10, timeout: 120000 });
  const quiz = (await api('GET', '/api/quizzes'))[0]; const qs = await api('GET', `/api/quizzes/${quiz.id}/questions`);
  assert.strictEqual(quiz.status, 'ready'); assert(!quiz.fallback, 'the AI path succeeded, so no fallback: ' + JSON.stringify(quiz.fallback));
  assert.strictEqual(quiz.generator, 'Gemini (عبر وسيط الموقع)'); assert(qs.length >= 5 && qs.every((q) => q.evidence && q.evidence.length), 'AI questions with evidence: ' + qs.length);
  assert(relay.stats.calls.analyze >= 1 && relay.stats.calls.generate >= 1 && relay.stats.calls.verify >= 1, 'the engine ran through the relay: ' + JSON.stringify(relay.stats.calls));
  assert(relay.stats.total >= 3 && (relay.stats.lastAuth == null), 'the site sent NO key to the relay (the key is the relay’s): ' + JSON.stringify(relay.stats.lastAuth));
  assert(relay.stats.models.every((m) => m === 'gemini-2.0-flash'), 'the configured model was used: ' + JSON.stringify([...new Set(relay.stats.models)]));
  console.log(`1) AI quiz via the relay: ${qs.length} questions, generator «${quiz.generator}», ${relay.stats.total} relay calls, no key sent by the site`);

  // 2) the relay's free quota is spent (429 on every call) -> the quiz is built locally, with a note; no visitor blocked
  relay.stats.rate429 = 999;
  await p.goto(site.url + '/#/new?doc=' + doc.id); await createQuiz(p, { count: 10, timeout: 120000 });
  const q2 = (await api('GET', '/api/quizzes')).find((x) => x.id !== quiz.id); const fresh = await quizById(q2.id); const qs2 = await api('GET', `/api/quizzes/${q2.id}/questions`);
  assert.strictEqual(fresh.status, 'ready'); assert(qs2.length >= 1, 'local fallback still delivers questions: ' + qs2.length);
  assert(fresh.fallback && fresh.fallback.from === 'claude', 'it fell back to local with a note: ' + JSON.stringify(fresh.fallback));
  assert.notStrictEqual(fresh.generator, 'Gemini (عبر وسيط الموقع)', 'a fallback quiz is labelled local, not AI: ' + fresh.generator);
  await p.goto(site.url + '/#/quiz/' + q2.id); await p.waitForSelector('h2');
  assert(await p.isVisible('#fallback-note'), 'the student is told it was built locally this time');
  console.log(`2) relay out of quota (429): quiz built locally with the note, ${qs2.length} questions - no visitor blocked`);
  relay.stats.rate429 = 0;

  // 3) the published config carries only the relay ADDRESS, never a key; the operator sees the relay configured
  const cfg = await (await fetch(site.url + '/config.js')).text(); assert(/relay:\s*'http/.test(cfg) && !/AIza|sk-|Bearer/.test(cfg), 'config.js has the relay address and no key');
  await api('POST', '/api/operator', { on: true }); const rs = await api('GET', '/api/llm/relay-status');
  assert(rs.configured === true && rs.model === 'gemini-2.0-flash', 'operator relay status: ' + JSON.stringify(rs));
  console.log('3) config.js carries the relay address only (no key); operator sees the relay configured');

  assert.deepStrictEqual(errs, []); console.log('relay (AI for every visitor) E2E ok'); await b.close(); await site.close(); await relay.close();
})().catch((e) => { console.error(e); process.exit(1); });
