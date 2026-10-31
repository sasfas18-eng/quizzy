// node static-edition/test/pool.test.js — browser LLM pool: failover, pacing, waiting, error mapping (fake fetch + fake clock).
global.window = {}; const { LLMPool, PoolError, extractJson } = require('../../shared/pool.js'); const assert = require('assert');
const clock = () => { const c = { t: 1e6, slept: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; c.slept += ms; } }; return c; };
const res = (status, body = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const OAI = (obj) => res(200, { choices: [{ message: { content: '```json\n' + JSON.stringify(obj) + '\n```' } }] });
const ANT = (obj) => res(200, { content: [{ type: 'text', text: JSON.stringify(obj) }] });
const ep = (name, extra = {}) => ({ name, kind: 'openai', base: `https://${name}.example/v1`, key: 'k-' + name, model: 'm', rpm: 100, ...extra });
const mk = (endpoints, fetch, c, opts = {}) => new LLMPool(endpoints, { fetch, now: c.now, sleep: c.sleep, ...opts });

(async () => {
  // ---- json extraction
  assert.deepStrictEqual(extractJson('{"a":1}'), { a: 1 }); assert.deepStrictEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepStrictEqual(extractJson('Sure! {"a":"x } y"} done'), { a: 'x } y' }); assert.throws(() => extractJson('nothing'), (e) => e.code === 'bad_json');

  // ---- failover + cooldown
  { const c = clock(); const hits = [];
    const f = async (url) => { const host = new URL(url).host; hits.push(host); return host.startsWith('a') ? res(429, 'slow down', { 'retry-after': '120' }) : OAI({ ok: 1 }); };
    const p = mk([ep('a'), ep('b')], f, c);
    assert.deepStrictEqual(await p.json('generate', 's', 'p'), { ok: 1 }); assert.deepStrictEqual(hits, ['a.example', 'b.example']);
    hits.length = 0; for (let i = 0; i < 3; i++) await p.json('generate', 's', 'p'); assert(hits.every((h) => h === 'b.example'), 'A must not be hammered while cooling');
    c.t += 130000; hits.length = 0; for (let i = 0; i < 4; i++) await p.json('generate', 's', 'p'); assert(hits.includes('a.example'), 'A rejoins after cooldown'); }

  // ---- pacing under rpm: waits, never trips the provider's limiter
  { const c = clock(); const seen = []; const f = async () => { seen.push(c.t); return OAI({ ok: 1 }); };
    const p = mk([ep('a', { rpm: 3 })], f, c); for (let i = 0; i < 7; i++) await p.json('generate', 's', 'p');
    assert(c.slept > 60000, 'waited for the window');
    for (let i = 0; i < seen.length; i++) assert(seen.filter((t) => t >= seen[i] && t < seen[i] + 60000).length <= 3, 'never more than rpm per 60s'); }

  // ---- no Retry-After visible (CORS hides it): short exponential back-off, then success on the same single endpoint
  { const c = clock(); let n = 0; const p = mk([ep('a')], async () => (++n <= 2 ? res(429, '') : OAI({ ok: 1 })), c);
    assert.deepStrictEqual(await p.json('generate', 's', 'p'), { ok: 1 }); assert(c.slept >= 24000 && c.slept < 30000, 'waited ~8s then ~16s, not minutes: ' + c.slept); }

  // ---- everything exhausted: clear error, no infinite loop
  { const c = clock(); const p = mk([ep('a')], async () => res(429, '', { 'retry-after': '3000' }), c, { maxWait: 60000 });
    await assert.rejects(() => p.json('generate', 's', 'p'), (e) => e instanceof PoolError && e.code === 'rate_limited' && /استنفدوا/.test(e.message)); }

  // ---- auth errors mark the key invalid; the other endpoint still serves
  { const c = clock(); const f = async (url) => (url.includes('//bad.') ? res(401, 'nope') : OAI({ ok: 1 }));
    const p = mk([ep('bad'), ep('good')], f, c); assert.deepStrictEqual(await p.json('generate', 's', 'p'), { ok: 1 }); assert.strictEqual(p.eps[0].dead, true);
    const p2 = mk([ep('bad')], f, clock()); await assert.rejects(() => p2.json('generate', 's', 'p'), (e) => e.code === 'keys_invalid' || e.code === 'auth'); }

  // ---- request shapes
  { const c = clock(); let seen;
    const p = mk([{ name: 'claude', kind: 'anthropic', base: 'https://api.anthropic.com', key: 'sk-ant-x', model: 'claude-haiku-5-5', rpm: 50 }], async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return ANT({ ok: 1 }); }, c);
    assert.deepStrictEqual(await p.json('verify_batch', 'SYS', 'PROMPT'), { ok: 1 });
    assert.strictEqual(seen.url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(seen.init.headers['x-api-key'], 'sk-ant-x'); assert.strictEqual(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.strictEqual(seen.body.model, 'claude-haiku-5-5'); assert.strictEqual(seen.body.temperature, 0); assert.strictEqual(seen.body.system[0].cache_control.type, 'ephemeral'); assert(/ONLY one valid JSON/.test(seen.body.system[0].text)); assert.strictEqual(seen.body.messages[0].content, 'PROMPT');
    const p2 = mk([ep('g', { base: 'https://api.groq.com/openai/v1/' })], async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return OAI({ ok: 2 }); }, c);
    assert.deepStrictEqual(await p2.json('generate', 'SYS', 'PROMPT'), { ok: 2 }); assert.strictEqual(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(seen.init.headers.authorization, 'Bearer k-g'); assert.strictEqual(seen.body.temperature, 0.4); assert.strictEqual(seen.body.messages[0].role, 'system'); }

  // ---- network/CORS failure => failover with a helpful message; bad request surfaces immediately
  { const c = clock(); const f = async (url) => { if (url.includes('//a.')) throw new TypeError('Failed to fetch'); return OAI({ ok: 1 }); };
    assert.deepStrictEqual(await mk([ep('a'), ep('b')], f, c).json('generate', 's', 'p'), { ok: 1 });
    await assert.rejects(() => mk([ep('a')], f, clock(), { maxWait: 1000 }).json('generate', 's', 'p'), (e) => /CORS|استنفدوا/.test(e.message));
    await assert.rejects(() => mk([ep('x')], async () => res(400, 'model not found'), clock()).json('generate', 's', 'p'), (e) => e.code === 'bad_request' && /model not found/.test(e.message)); }

  // ---- malformed JSON from one model => another endpoint answers; no endpoints => explicit code
  { const c = clock(); const f = async (url) => (url.includes('//a.') ? res(200, { choices: [{ message: { content: 'I cannot comply' } }] }) : OAI({ ok: 1 }));
    assert.deepStrictEqual(await mk([ep('a'), ep('b')], f, c).json('generate', 's', 'p'), { ok: 1 });
    await assert.rejects(() => mk([], f, c).json('generate', 's', 'p'), (e) => e.code === 'llm_not_configured'); }

  // ---- test(): one probe through one endpoint
  { const c = clock(); const r = await mk([], async () => OAI({ ok: true }), c).test(ep('t')); assert.strictEqual(r.ok, true); }
  console.log('pool tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
