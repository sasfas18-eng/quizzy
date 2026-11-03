// node relay/test/worker.test.mjs — the relay holds the free Gemini key server-side: who may call it, what it forwards to Gemini, what it never leaks.
import assert from 'assert';
import worker, { problem } from '../cloudflare-worker.mjs';

const SECRET = 'AIzaSyFAKE-the-secret-gemini-key-000';
const ORIGIN = 'https://sasfas18-eng.github.io';
const env = { GEMINI_API_KEY: SECRET, ALLOWED_ORIGIN: ORIGIN + '/' };       // a trailing slash in the setting is tolerated
const good = () => ({ model: 'gemini-2.0-flash', max_tokens: 4000, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }] });

let upstream = []; let reply = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), init }); return reply(url, init); };
let ipN = 0; const post = (body, { origin = ORIGIN, headers = {}, e = env, raw, ip } = {}) => worker.fetch(new Request('https://relay.example.workers.dev/v1/chat/completions', { method: 'POST',
  headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip || `10.0.0.${++ipN}`, ...(origin ? { Origin: origin } : {}), ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) }), e);
const text = async (r) => { const t = await r.text(); try { return [JSON.parse(t), t]; } catch { return [null, t]; } };
const allHeaders = (r) => JSON.stringify([...r.headers.entries()]);

(async () => {
  // ---- status page: shows whether it is set up, never a secret
  { const r = await worker.fetch(new Request('https://relay.example.workers.dev/', { headers: { Origin: ORIGIN } }), env); const [j, t] = await text(r);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual([j.ok, j.upstream, j.key_set, j.origin_set], [true, 'gemini', true, true]); assert(!t.includes(SECRET) && !t.includes('AIza'), 'the status page never shows the key'); assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'readable by any site: it holds no secret'); assert.strictEqual(j.origin_ok, true); assert.deepStrictEqual(j.allowed_origins, [ORIGIN]);
    const rf = await worker.fetch(new Request('https://relay.example.workers.dev/', { headers: { Origin: 'https://evil.example' } }), env); const jf = (await text(rf))[0]; assert.strictEqual(jf.origin_ok, false, 'it tells a site whether ITS address is accepted'); assert.deepStrictEqual(jf.allowed_origins, [ORIGIN]);
    const r2 = await worker.fetch(new Request('https://relay.example.workers.dev/'), {}); const j2 = (await text(r2))[0]; assert.deepStrictEqual([j2.key_set, j2.origin_set], [false, false], 'an unconfigured relay says so'); }

  // ---- preflight: only the website may ask
  { const ok = await worker.fetch(new Request('https://relay.example.workers.dev/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }), env);
    assert.strictEqual(ok.status, 204); assert.strictEqual(ok.headers.get('access-control-allow-origin'), ORIGIN); assert(/content-type/i.test(ok.headers.get('access-control-allow-headers')));
    const no = await worker.fetch(new Request('https://relay.example.workers.dev/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env); assert.strictEqual(no.status, 403); assert.strictEqual(no.headers.get('access-control-allow-origin'), null); }

  // ---- a good request: the SERVER key is added as a Bearer token, the visitor's own auth is NOT forwarded, the key never comes back
  { upstream = []; const r = await post(good(), { headers: { authorization: 'Bearer visitor-supplied', 'x-goog-api-key': 'visitor' } }); const [j, t] = await text(r);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.choices[0].message.content, '{"ok":true}'); assert.strictEqual(upstream.length, 1);
    const u = upstream[0]; assert.strictEqual(u.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'); assert.strictEqual(u.init.headers.authorization, `Bearer ${SECRET}`); assert(!JSON.stringify(u.init.headers).includes('visitor'), 'nothing the visitor sent as credentials is forwarded');
    assert.deepStrictEqual(JSON.parse(u.init.body), good()); assert(!t.includes(SECRET) && !allHeaders(r).includes(SECRET), 'the key is never in what the page receives'); assert.strictEqual(r.headers.get('access-control-allow-origin'), ORIGIN); }

  // ---- who may call
  { upstream = []; for (const o of [null, 'https://evil.example', 'http://sasfas18-eng.github.io', ORIGIN + '.evil.example']) { const r = await post(good(), { origin: o }); assert.strictEqual(r.status, 403, 'origin ' + o); assert.strictEqual(r.headers.get('access-control-allow-origin'), null); }
    assert.strictEqual(upstream.length, 0, 'a refused call costs nothing'); }
  { const r = await post(good(), { e: { GEMINI_API_KEY: SECRET } }); assert.strictEqual(r.status, 403, 'no ALLOWED_ORIGIN set => fails closed'); assert(/ALLOWED_ORIGIN/.test((await text(r))[0].error.message)); }
  { const r = await post(good(), { e: { ALLOWED_ORIGIN: ORIGIN } }); assert.strictEqual(r.status, 500); assert(/GEMINI_API_KEY/.test((await text(r))[0].error.message)); }
  { const r = await post(good(), { e: { ...env, ALLOWED_ORIGIN: 'https://a.example, ' + ORIGIN } }); assert.strictEqual(r.status, 200, 'several allowed origins'); }

  // ---- what it forwards: only the fields the site uses, OpenAI-shaped
  { upstream = []; const bad = [
    [{ ...good(), stream: true }, /field not allowed: stream/], [{ ...good(), tools: [{ name: 'x' }] }, /field not allowed: tools/], [{ ...good(), system: 'x' }, /field not allowed: system/],
    [{ ...good(), model: 'gpt-4o' }, /model not allowed/], [{ ...good(), model: undefined }, /model not allowed/], [{ ...good(), max_tokens: 8193 }, /max_tokens/], [{ ...good(), max_tokens: 0 }, /max_tokens/], [{ ...good(), max_tokens: '100' }, /max_tokens/],
    [{ ...good(), messages: [] }, /messages/], [{ ...good(), messages: [{ role: 'tool', content: 'x' }] }, /role/], [{ ...good(), messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, /string content/], [{ ...good(), messages: [{ role: 'user', content: 'x', extra: 1 }] }, /role/],
    [{ ...good(), temperature: 3 }, /temperature/], [{ ...good(), top_p: 2 }, /top_p/], [{ ...good(), response_format: { type: 'yaml' } }, /response_format/], [{ ...good(), response_format: { type: 'json_object', schema: {} } }, /response_format/],
    [[1, 2], /JSON object/], [null, /JSON object/]];
    for (const [b, re] of bad) { const r = await post(b); const [j] = await text(r); assert.strictEqual(r.status, 400, JSON.stringify(b).slice(0, 80)); assert(re.test(j.error.message), `${JSON.stringify(b).slice(0, 60)} -> ${j.error.message}`); }
    assert.strictEqual((await post(null, { raw: '{not json' })).status, 400); assert.strictEqual((await post(null, { raw: 'x'.repeat(600001) })).status, 413); assert.strictEqual(upstream.length, 0, 'nothing invalid ever reaches the provider'); }
  assert.strictEqual(problem(good(), env), null); assert.strictEqual(problem({ ...good(), top_p: 0.9, response_format: { type: 'text' } }, env), null);
  assert.strictEqual(problem({ ...good(), model: 'gemini-2.5-flash' }, { ...env, ALLOWED_MODELS: 'gemini-2.0-flash' }) !== null, true, 'the model list is configurable'); assert.strictEqual(problem({ ...good(), max_tokens: 5000 }, { ...env, MAX_TOKENS: '4000' }) !== null, true);

  // ---- other routes / methods
  { for (const [m, path] of [['GET', '/v1/chat/completions'], ['POST', '/v1/models'], ['POST', '/'], ['DELETE', '/v1/chat/completions']]) { const r = await worker.fetch(new Request('https://relay.example.workers.dev' + path, { method: m, headers: { Origin: ORIGIN } }), env); assert.strictEqual(r.status, 404, m + ' ' + path); } }

  // ---- per-visitor limit (best effort) and what a provider error looks like to the page
  { upstream = []; const e = { ...env, RATE_PER_MINUTE: '3' }; for (let i = 0; i < 3; i++) assert.strictEqual((await post(good(), { e, ip: '9.9.9.9' })).status, 200);
    const r = await post(good(), { e, ip: '9.9.9.9' }); assert.strictEqual(r.status, 429); assert(+r.headers.get('retry-after') >= 1); assert.strictEqual(upstream.length, 3, 'the limited call never reached the provider');
    assert.strictEqual((await post(good(), { e, ip: '9.9.9.10' })).status, 200, 'another visitor is not affected'); }
  { reply = () => new Response(JSON.stringify({ error: { code: 429, message: 'quota' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' } });
    const r = await post(good()); assert.strictEqual(r.status, 429); assert.strictEqual(r.headers.get('retry-after'), '17', 'the provider\'s Retry-After reaches the page (the site falls back to local)'); assert.strictEqual(r.headers.get('access-control-expose-headers'), 'retry-after'); }
  { reply = () => { throw new Error('network down'); }; const r = await post(good()); assert.strictEqual(r.status, 502); assert(!(await text(r))[1].includes(SECRET)); }
  { reply = () => new Response('{}', { status: 200 }); const r = await post(good(), { e: { ...env, DISABLED: '1' } }); assert.strictEqual(r.status, 503, 'emergency switch'); }

  console.log('relay tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
