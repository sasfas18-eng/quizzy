// node static-edition/test/chain.test.js — the automatic path UNDER FAILURE. What an operator met: "Google Gemini: HTTP 503" (the provider says "the model is overloaded"; the key is fine).
// The path must (1) never blame the key for a busy provider, (2) switch to another MODEL of the same key at once (Gemini flash -> flash-lite, Groq 70b -> 8b: separate quotas), (3) switch to the next
// PROVIDER in the preset order, (4) stop asking a provider that is down (parked for a while, probed again later) instead of making every request wait minutes, (5) when everything is out hand over to the free
// local generator at once (the caller's fallback: every error code below is one the site treats as "AI unavailable"), (6) come back to the preferred provider by itself.
global.window = {}; const { LLMPool, PoolError, rankOf, defaultAlts, withAlts } = require('../../shared/pool.js'); const assert = require('assert');
const AI_UNAVAILABLE = ['not_granted', 'network', 'auth', 'rate_limited', 'keys_invalid', 'bad_request', 'too_large', 'bad_json', 'llm_not_configured', 'llm_error'];     // = shared/api-core.js aiUnavailable
const clock = () => { const c = { t: 1e6, slept: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; c.slept += ms; } }; return c; };
const res = (status, body = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const mk = (endpoints, fetch, c, opts = {}) => new LLMPool(endpoints, { fetch, now: c.now, sleep: c.sleep, ...opts });
const mkAuto = (endpoints, fetch, c, opts = {}) => mk(endpoints.map(withAlts), fetch, c, opts);        // what the site does: every saved key gets its default alternate models
const GEM_OK = (obj) => res(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const GEM_503 = () => res(503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } });
const GEM_429 = (retry) => res(429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: retry ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }] : [] } });
const OAI_OK = (obj) => res(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }] });
const ANT_OK = (obj) => res(200, { content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn' });
const GM = (model = 'gemini-2.5-flash', extra = {}) => ({ id: 'gem', name: 'Google Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', key: 'AIza-K', model, rpm: 100, ...extra });
const modelOf = (url) => (/models\/([^:]+):/.exec(url) || [])[1];
const T = []; const scenario = (name, fn) => T.push([name, fn]);

scenario('1) the probe: a busy provider is retried briefly, and a provider that stays busy is "key accepted, service busy" - never an error blaming the key', async () => {
  { let n = 0; const r = await mk([], async () => (++n <= 2 ? GEM_503() : GEM_OK({ ok: true })), clock()).test(GM()); assert.strictEqual(r.ok, true); assert.strictEqual(n, 3, 'two busy answers, then it works'); }
  { let n = 0; const r = await mk([], async () => { n++; return GEM_503(); }, clock()).test(GM());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.busy, true); assert.strictEqual(r.status, 503); assert.strictEqual(n, 3, 'a few quick tries, not a long wait');
    assert(/مزدحمة/.test(r.message) && /503/.test(r.message) && /gemini-2\.5-flash/.test(r.message) && /المفتاح/.test(r.message), 'plain Arabic that says the KEY is fine: ' + r.message); }
  { const r = await mk([], async () => GEM_429(), clock()).test(GM()); assert.strictEqual(r.busy, true); assert(/حدّ الطلبات/.test(r.message) && /429/.test(r.message), r.message); }
  // a real problem stays a real error
  await assert.rejects(() => mk([], async () => res(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), clock()).test(GM()), (e) => e.code === 'bad_request' && /API key not valid/.test(e.message));
  await assert.rejects(() => mk([], async () => res(403, 'no'), clock()).test(GM()), (e) => e.code === 'auth');
  // a server that is not a known cloud provider returning 503 is NOT "busy" (the address may simply be wrong)
  await assert.rejects(() => mk([], async () => res(503, 'down'), clock()).test({ name: 'x', kind: 'openai', base: 'https://x.example/v1', key: 'k', model: 'm', rpm: 100 }), (e) => e.code === 'rate_limited' && /503/.test(e.message)); });

scenario('2) the same key has other MODELS: Gemini flash overloaded -> flash-lite answers at once, nobody waits; the preferred model takes over again when it recovers', async () => {
  assert.deepStrictEqual(defaultAlts(GM('gemini-2.5-flash')), ['gemini-2.5-flash-lite', 'gemini-2.0-flash']); assert.deepStrictEqual(defaultAlts(GM('gemini-2.5-flash-lite')), ['gemini-2.0-flash', 'gemini-2.0-flash-lite']);
  assert.deepStrictEqual(defaultAlts({ name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' }), ['llama-3.1-8b-instant']);
  assert.deepStrictEqual(defaultAlts({ name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' }), ['llama-3.3-70b-versatile']);
  assert.deepStrictEqual(defaultAlts({ name: 'Claude', kind: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }), [], 'a paid model is never swapped silently'); assert.deepStrictEqual(defaultAlts({ name: 'x', kind: 'openai', base: 'https://x.example/v1', model: 'm' }), []);
  const hits = []; let down = true; const f = async (url) => { const m = modelOf(url); hits.push(m); return m === 'gemini-2.5-flash' && down ? GEM_503() : GEM_OK({ from: m }); };
  const c = clock(); const p = mkAuto([GM()], f, c);
  assert.deepStrictEqual(p.status().map((x) => [x.model, !!x.alt]), [['gemini-2.5-flash', false], ['gemini-2.5-flash-lite', true], ['gemini-2.0-flash', true]], 'preferred model first, then its alternates');
  assert.deepStrictEqual(await p.json('generate', 's', 'p'), { from: 'gemini-2.5-flash-lite' }); assert.deepStrictEqual(hits, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']); assert.strictEqual(c.slept, 0, 'nobody waited');
  hits.length = 0; for (let i = 0; i < 3; i++) await p.json('generate', 's', 'p'); assert(hits.every((m) => m === 'gemini-2.5-flash-lite'), 'the overloaded model rests, it is not hammered: ' + hits);
  down = false; c.t += 70000; hits.length = 0; assert.deepStrictEqual(await p.json('generate', 's', 'p'), { from: 'gemini-2.5-flash' }, 'the preferred model is back in charge by itself');
  // explicit alternates / none
  assert.strictEqual(mk([GM('gemini-2.5-flash', { alts: [] })], f, clock()).eps.length, 1); assert.deepStrictEqual(mk([GM('gemini-2.5-flash', { alts: ['gemini-2.5-flash-lite', 'a', 'b', 'c', 'd'] })], f, clock()).eps.map((e) => e.model), ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'a', 'b'], 'at most three alternates'); });

scenario('3) a model the key cannot use (404) is dropped quietly as an alternate (not shown as "needs fixing"); the others carry on', async () => {
  const f = async (url) => { const m = modelOf(url); return m === 'gemini-2.5-flash' ? GEM_503() : m === 'gemini-2.5-flash-lite' ? res(404, { error: { code: 404, message: 'models/gemini-2.5-flash-lite is not found for API version v1beta' } }) : GEM_OK({ from: m }); };
  const p = mkAuto([GM()], f, clock()); assert.deepStrictEqual(await p.json('generate', 's', 'p'), { from: 'gemini-2.0-flash' }); assert(!p.status().some((x) => x.alt && x.state === 'dead'), 'a dead alternate is not listed: ' + JSON.stringify(p.status().map((x) => [x.model, x.state])));
  // revive() on the group brings every model back
  p.revive('gem'); assert(p.status().length === 3 || p.status().length === 2); });

scenario('4) everything busy: gives up in about half a minute of waiting (not 15 minutes), parks the models, then fails INSTANTLY; probed again after the rest', async () => {
  const hits = []; let up = false; const f = async (url) => { hits.push(modelOf(url)); return up ? GEM_OK({ ok: 1 }) : GEM_503(); }; const c = clock(); const p = mkAuto([GM()], f, c);
  await assert.rejects(() => p.json('generate', 's', 'p'), (e) => e.code === 'rate_limited' && /503/.test(e.message) && /مزدحمة/.test(e.message) && AI_UNAVAILABLE.includes(e.code), 'the caller sees "AI unavailable" and falls back to the local generator');
  assert(c.slept <= 120000, 'virtual time spent waiting: ' + c.slept); const n1 = hits.length, s1 = c.slept;
  for (let i = 0; i < 3; i++) await assert.rejects(() => p.json('generate', 's', 'p'), (e) => AI_UNAVAILABLE.includes(e.code)); assert.strictEqual(hits.length, n1, 'parked: no request at all'); assert.strictEqual(c.slept, s1, 'and no waiting');
  assert(p.status().every((x) => x.state === 'out' && /مزدحم/.test(x.reason)), 'the operator page can say why: ' + JSON.stringify(p.status().map((x) => [x.state, x.reason])));
  up = true; c.t += 130000; assert.deepStrictEqual(await p.json('generate', 's', 'p'), { ok: 1 }, 'back after the rest, with nobody touching anything'); });

scenario('5) a per-minute limit is waited for (Retry-After / retryDelay), only a DAILY one rests for an hour', async () => {
  const hits = []; const c = clock(); let n = 0; const p = mk([GM('gemini-2.5-flash', { alts: [] })], async (url) => { hits.push(c.t); return ++n === 1 ? GEM_429('34s') : GEM_OK({ ok: 1 }); }, c);
  assert.deepStrictEqual(await p.json('generate', 's', 'p'), { ok: 1 }); assert(hits[1] - hits[0] >= 34000 && hits[1] - hits[0] < 60000, 'waited the 34s the provider asked for, not an hour: ' + (hits[1] - hits[0]));
  const d = mk([GM('gemini-2.5-flash', { alts: [] })], async () => res(429, { error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 250, PerDay' } }), clock(), { maxWait: 60000 });
  await assert.rejects(() => d.json('generate', 's', 'p'), (e) => e.code === 'rate_limited'); assert(d.eps[0].coolUntil - d.now() >= 3500000, 'a daily quota rests for about an hour'); });

scenario('6) THE WHOLE CHAIN, stage by stage: relay -> Claude key -> Gemini (flash, flash-lite...) -> Groq (70b, 8b) -> OpenRouter -> a local model -> (the free local generator) - and back', async () => {
  const RL = { id: 'relay', name: 'Relay', kind: 'anthropic', relay: true, base: 'https://relay.example.workers.dev', key: '', model: 'claude-opus-5-5', rpm: 100 };
  const CL = { id: 'claude', name: 'Claude', kind: 'anthropic', base: 'https://api.anthropic.com', key: 'sk-ant', model: 'claude-sonnet-5-5', rpm: 100 };
  const GQ = { id: 'groq', name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', key: 'gsk', model: 'llama-3.3-70b-versatile', rpm: 100 };
  const OR = { id: 'or', name: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', key: 'sk-or', model: 'meta-llama/llama-3.3-70b-instruct:free', rpm: 100 };
  const LO = { id: 'local', name: 'Local', kind: 'openai', base: 'http://localhost:11434/v1', key: '', model: 'qwen2.5:7b', rpm: 100 };
  // what each provider answers right now: ok | busy (503) | limit (429) | credit | key (401) | down (network error)
  const world = { relay: 'ok', claude: 'ok', gemini: 'ok', groq: 'ok', or: 'ok', local: 'ok', geminiMain: null, groqMain: null }; const served = [];
  const f = async (url, init) => { const u = new URL(url); let who = u.host.startsWith('relay.') ? 'relay' : u.host === 'api.anthropic.com' ? 'claude' : u.host === 'generativelanguage.googleapis.com' ? 'gemini' : u.host === 'api.groq.com' ? 'groq' : u.host === 'openrouter.ai' ? 'or' : 'local';
    const model = who === 'gemini' ? modelOf(url) : JSON.parse(init.body).model; let state = world[who]; if (who === 'gemini' && model === 'gemini-2.5-flash' && world.geminiMain) state = world.geminiMain; if (who === 'groq' && model === 'llama-3.3-70b-versatile' && world.groqMain) state = world.groqMain;
    const ant = who === 'relay' || who === 'claude'; if (state === 'down') throw new TypeError('Failed to fetch');
    if (state === 'busy') return who === 'gemini' ? GEM_503() : res(503, { error: { message: 'overloaded' } });
    if (state === 'limit') return res(429, 'slow down', { 'retry-after': '120' });
    if (state === 'credit') return res(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
    if (state === 'key') return res(401, 'no');
    served.push(who + (who === 'gemini' || who === 'groq' ? ':' + model : '')); return ant ? ANT_OK({ ok: 1 }) : who === 'gemini' ? GEM_OK({ ok: 1 }) : OAI_OK({ ok: 1 }); };
  const c = clock(); const p = mkAuto([LO, OR, GQ, GM(), CL, RL], f, c);          // added in the WRONG order on purpose: the preset order decides
  const who = async () => { served.length = 0; await p.json('generate', 's', 'p'); return served[served.length - 1]; };
  assert.deepStrictEqual(p.status().filter((x) => !x.alt).map((x) => x.name), ['Relay', 'Claude', 'Google Gemini', 'Groq', 'OpenRouter', 'Local'], 'the preset order');
  assert.strictEqual(await who(), 'relay', '1) all healthy: the site\'s own Claude leads');
  world.relay = 'credit'; assert.strictEqual(await who(), 'claude', '2) relay out of credit -> the operator\'s Claude key');
  world.claude = 'credit'; assert.strictEqual(await who(), 'gemini:gemini-2.5-flash', '3) Claude out of credit/over its spend limit -> Gemini');
  world.geminiMain = 'busy'; assert.strictEqual(await who(), 'gemini:gemini-2.5-flash-lite', '4) Gemini overloaded (503) -> its lighter model, same key');
  world.gemini = 'limit'; world.geminiMain = 'limit'; assert.strictEqual(await who(), 'groq:llama-3.3-70b-versatile', '5) every Gemini model out of quota -> Groq');
  world.groqMain = 'limit'; assert.strictEqual(await who(), 'groq:llama-3.1-8b-instant', '6) Groq 70b over its limit -> Groq 8b (own quota)');
  world.groq = 'key'; world.groqMain = 'key'; assert.strictEqual(await who(), 'or', '7) Groq key rejected -> OpenRouter');
  world.or = 'limit'; assert.strictEqual(await who(), 'local', '8) OpenRouter limited -> the model on the operator\'s own machine');
  world.local = 'down'; const slept0 = c.slept;
  await assert.rejects(() => p.json('generate', 's', 'p'), (e) => AI_UNAVAILABLE.includes(e.code), '9) NOTHING left: an "AI unavailable" error the site answers with the free local generator'); assert(c.slept - slept0 <= 130000, 'and it did not make anyone wait minutes: ' + (c.slept - slept0));
  const st = p.status(); assert(st.every((x) => x.state !== 'ready'), 'nobody is ready: ' + JSON.stringify(st.map((x) => [x.name, x.model, x.state])));
  const before = c.slept; await assert.rejects(() => p.json('generate', 's', 'p'), (e) => AI_UNAVAILABLE.includes(e.code)); assert(c.slept - before <= 130000, 'the next request does not start the waiting over: ' + (c.slept - before));
  // recovery: things come back one by one; the preferred one takes over again
  world.local = 'ok'; world.or = 'ok'; c.t += 700000; assert.strictEqual(await who(), 'or', '10) providers rest and come back by themselves (the best one that works)');
  world.relay = 'ok'; world.claude = 'ok'; p.revive('relay'); p.revive('claude'); assert.strictEqual(await who(), 'relay', '11) credit added + one real check -> the relay leads again'); });

(async () => {
  let bad = 0; for (const [name, fn] of T) { try { await fn(); console.log('ok   ' + name.slice(0, 150)); } catch (e) { bad++; console.log('FAIL ' + name.slice(0, 150) + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n     ')); } }
  if (bad) { console.error(`${bad} of ${T.length} scenarios failed`); process.exit(1); } console.log('chain tests ok');
})();
