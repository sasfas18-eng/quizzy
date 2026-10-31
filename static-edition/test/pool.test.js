// node static-edition/test/pool.test.js — browser LLM pool: failover, pacing, waiting, error mapping (fake fetch + fake clock).
global.window = {}; const { LLMPool, PoolError, extractJson, pickModel } = require('../../shared/pool.js'); const assert = require('assert');
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
  // ---- model discovery: GET {base}/models with the right auth, tolerant of the shapes providers return
  { const seen = []; const f = (data, status = 200) => async (url, init) => { seen.push([url, init.headers]); return res(status, data); };
    assert.deepStrictEqual(await LLMPool.listModels({ kind: 'openai', base: 'https://x.example/v1/', key: 'K' }, f({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] })), ['a', 'b']);
    assert.strictEqual(seen[0][0], 'https://x.example/v1/models'); assert.strictEqual(seen[0][1].authorization, 'Bearer K');
    assert.deepStrictEqual(await LLMPool.listModels({ kind: 'openai', base: 'https://x.example/v1', key: '' }, f({ models: [{ name: 'models/n1' }, 'n2'] })), ['models/n1', 'n2']);
    assert(!('authorization' in seen[1][1]), 'no key -> no Authorization header (e.g. local Ollama)');
    await LLMPool.listModels({ kind: 'anthropic', base: 'https://api.anthropic.com', key: 'AK' }, f({ data: [{ id: 'claude-sonnet-5-5' }] }));
    assert.strictEqual(seen[2][0], 'https://api.anthropic.com/v1/models?limit=100'); assert.strictEqual(seen[2][1]['x-api-key'], 'AK'); assert.strictEqual(seen[2][1]['anthropic-dangerous-direct-browser-access'], 'true');
    await assert.rejects(() => LLMPool.listModels({ kind: 'openai', base: 'https://x.example/v1', key: 'bad' }, f({}, 401)), (e) => e.code === 'auth');
    await assert.rejects(() => LLMPool.listModels({ kind: 'openai', base: 'https://x.example/v1', key: 'k' }, f({}, 500)), (e) => e.code === 'bad_request');
    await assert.rejects(() => LLMPool.listModels({ kind: 'openai', base: 'https://x.example/v1', key: 'k' }, async () => { throw new TypeError('Failed to fetch'); }), (e) => e.code === 'network' && /CORS/.test(e.message)); }

  // ---- model choice: newest stable flash for Gemini, no typing of model names (ids as each provider lists them)
  { const G = 'https://generativelanguage.googleapis.com/v1beta/openai';
    const gem = ['models/gemini-2.0-flash', 'models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-2.5-pro', 'models/gemini-2.5-flash-preview-05-20', 'models/gemini-2.0-flash-001', 'models/text-embedding-004', 'models/gemini-2.5-flash-image', 'models/gemini-2.5-flash-preview-tts', 'models/gemini-live-2.5-flash', 'models/gemma-3-27b-it'];
    assert.strictEqual(pickModel('openai', G, gem), 'gemini-2.5-flash', 'prefix stripped, stable id, not lite/preview/tts/embedding/image/live');
    assert.strictEqual(pickModel('openai', G, gem.concat(['models/gemini-3-flash', 'models/gemini-3-pro'])), 'gemini-3-flash', 'newest version wins');
    assert.strictEqual(pickModel('openai', G, ['models/gemini-2.5-flash-lite', 'models/gemini-2.0-flash-lite']), 'gemini-2.5-flash-lite', 'lite only when no plain flash');
    assert.strictEqual(pickModel('openai', G, ['models/gemini-3-flash-preview', 'models/embedding-001']), 'gemini-3-flash-preview', 'previews only as a last resort');
    assert.strictEqual(pickModel('openai', 'https://api.groq.com/openai/v1', ['whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'meta-llama/llama-guard-4-12b']), 'llama-3.3-70b-versatile');
    assert.strictEqual(pickModel('openai', 'https://openrouter.ai/api/v1', ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct:free', 'mistralai/mistral-small-3.1-24b-instruct:free']), 'meta-llama/llama-3.3-70b-instruct:free', 'only :free models on OpenRouter');
    assert.strictEqual(pickModel('openai', 'https://openrouter.ai/api/v1', ['openai/gpt-4o']), null, 'no free model -> nothing is silently chosen');
    assert.strictEqual(pickModel('anthropic', 'https://api.anthropic.com', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']), 'claude-sonnet-5-5');
    assert.strictEqual(pickModel('openai', 'http://localhost:11434/v1', ['nomic-embed-text', 'qwen2.5:7b']), 'qwen2.5:7b', 'generic host: first chat model');
    assert.strictEqual(pickModel('openai', 'https://x.example/v1', []), null); }
  console.log('pool tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
