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
    assert.deepStrictEqual(await p.json('verify', 'SYS', 'PROMPT'), { ok: 1 });
    assert.strictEqual(seen.url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(seen.init.headers['x-api-key'], 'sk-ant-x'); assert.strictEqual(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.strictEqual(seen.body.model, 'claude-haiku-5-5'); assert.strictEqual('temperature' in seen.body, false, 'Claude 5 models REJECT temperature/top_p/top_k with a 400: never sent'); assert(!('top_p' in seen.body) && !('top_k' in seen.body)); assert.deepStrictEqual(seen.body.output_config, { effort: 'low' }, 'checking tasks: little thinking'); assert(seen.body.max_tokens >= 16000, 'room for thinking + the JSON'); assert.strictEqual(seen.body.system[0].cache_control.type, 'ephemeral'); assert(/ONLY one valid JSON/.test(seen.body.system[0].text)); assert.strictEqual(seen.body.messages[0].content, 'PROMPT');
    // writing/analysis use medium effort; an older model (no effort control) gets neither effort nor sampling parameters; a relay endpoint sends no key and no provider headers
    await p.json('generate', 'S', 'P'); assert.deepStrictEqual(seen.body.output_config, { effort: 'medium' }); await p.json('analyze', 'S', 'P'); assert.deepStrictEqual(seen.body.output_config, { effort: 'medium' });
    const pOld = mk([{ name: 'old', kind: 'anthropic', base: 'https://api.anthropic.com', key: 'k', model: 'claude-haiku-4-5', rpm: 50 }], async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return ANT({ ok: 1 }); }, c);
    await pOld.json('generate', 'S', 'P', 3000); assert.strictEqual('temperature' in seen.body, false); assert.strictEqual('output_config' in seen.body, false); assert.strictEqual(seen.body.max_tokens, 3000);
    const pRel = mk([{ name: 'relay', kind: 'anthropic', relay: true, base: 'https://quizzy-ai.example.workers.dev/', key: '', model: 'claude-opus-5-5', rpm: 50 }], async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return ANT({ ok: 3 }); }, c);
    assert.deepStrictEqual(await pRel.json('generate', 'S', 'P'), { ok: 3 }); assert.strictEqual(seen.url, 'https://quizzy-ai.example.workers.dev/v1/messages'); assert.deepStrictEqual(Object.keys(seen.init.headers), ['content-type'], 'no key and no provider headers leave the page'); assert.strictEqual(seen.body.model, 'claude-opus-5-5');
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
    assert.strictEqual(pickModel('anthropic', 'https://api.anthropic.com', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']), 'claude-opus-5-5', 'the strongest current Claude by default (the card shows it and lets the operator pick a cheaper one)');
    assert.strictEqual(pickModel('anthropic', 'https://api.anthropic.com', ['claude-opus-5', 'claude-opus-5-5', 'claude-opus-5-5-20261001', 'claude-opus-4-1-20250805']), 'claude-opus-5-5', 'newest version; an alias beats a dated snapshot');
    assert.strictEqual(pickModel('anthropic', 'https://api.anthropic.com', ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']), 'claude-sonnet-5-5', 'no Opus on this key: the newest Sonnet');
    assert.strictEqual(pickModel('anthropic', 'https://api.anthropic.com', ['claude-haiku-4-5', 'claude-haiku-5-5']), 'claude-haiku-5-5');
    assert.strictEqual(pickModel('openai', 'http://localhost:11434/v1', ['nomic-embed-text', 'qwen2.5:7b']), 'qwen2.5:7b', 'generic host: first chat model');
    assert.strictEqual(pickModel('openai', 'https://x.example/v1', []), null); }
  // ---- Gemini NATIVE api (generateContent): request shape, response parsing, discovery of chat-capable models
  { const c = clock(); const seen = [];
    const GEM = (obj) => res(200, { candidates: [{ content: { role: 'model', parts: [{ text: '```json\n' + JSON.stringify(obj) + '\n```' }] }, finishReason: 'STOP' }] });
    const f = async (url, init) => { seen.push([url, init]); return GEM({ ok: 1 }); };
    const gp = mk([{ name: 'g', kind: 'gemini', base: 'https://generativelanguage.googleapis.com/', key: 'AIza-K', model: 'gemini-2.5-flash', rpm: 100 }], f, c);
    assert.deepStrictEqual(await gp.json('generate', 'SYS', 'USER', 1000), { ok: 1 });
    const [url, init] = seen[0]; const body = JSON.parse(init.body);
    assert.strictEqual(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.strictEqual(init.headers['x-goog-api-key'], 'AIza-K'); assert(!('authorization' in init.headers), 'the key goes in x-goog-api-key, not in the URL or Authorization');
    assert(body.systemInstruction.parts[0].text.startsWith('SYS')); assert.strictEqual(body.contents[0].parts[0].text, 'USER'); assert.strictEqual(body.generationConfig.responseMimeType, 'application/json'); assert(body.generationConfig.maxOutputTokens >= 8192);
    // blocked / empty answers are retried, never returned as data; 400 (bad key / bad request) surfaces at once
    let n = 0; const f2 = async () => (++n === 1 ? res(200, { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }) : GEM({ ok: 2 }));
    assert.deepStrictEqual(await mk([{ name: 'g', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', key: 'k', model: 'm', rpm: 100 }], f2, clock()).json('generate', 's', 'p'), { ok: 2 });
    await assert.rejects(() => mk([{ name: 'g', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', key: 'bad', model: 'm', rpm: 100 }], async () => res(400, { error: { code: 400, message: 'API key not valid.' } }), clock()).json('generate', 's', 'p'), (e) => e.code === 'bad_request' && /API key not valid/.test(e.message));
    const lf = async (u, i) => { seen.push([u, i]); return res(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] }); };
    assert.deepStrictEqual(await LLMPool.listModels({ kind: 'gemini', base: 'https://generativelanguage.googleapis.com', key: 'AIza-K' }, lf), ['models/gemini-2.5-flash', 'models/gemini-2.5-pro']);
    assert.strictEqual(seen.at(-1)[0], 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200'); assert.strictEqual(seen.at(-1)[1].headers['x-goog-api-key'], 'AIza-K');
    assert.strictEqual(pickModel('gemini', 'https://generativelanguage.googleapis.com', ['models/gemini-2.5-flash', 'models/gemini-2.5-pro']), 'gemini-2.5-flash'); }
  console.log('pool tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
