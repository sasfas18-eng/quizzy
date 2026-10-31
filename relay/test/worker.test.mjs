// node relay/test/worker.test.mjs — the relay holds the Claude key server-side: who may call it, what it forwards, what it never leaks.
import assert from 'assert';
import worker, { problem } from '../cloudflare-worker.mjs';

const SECRET = 'sk-ant-api03-THE-SECRET-KEY';
const ORIGIN = 'https://sasfas18-eng.github.io';
const env = { ANTHROPIC_API_KEY: SECRET, ALLOWED_ORIGIN: ORIGIN + '/' };       // a trailing slash in the setting is tolerated
const good = () => ({ model: 'claude-opus-5-5', max_tokens: 16000, system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hello' }], output_config: { effort: 'medium' } });

let upstream = []; let reply = () => new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: '{"ok":true}' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), init }); return reply(url, init); };
let ipN = 0; const post = (body, { origin = ORIGIN, headers = {}, e = env, raw, ip } = {}) => worker.fetch(new Request('https://relay.example.workers.dev/v1/messages', { method: 'POST',
  headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip || `10.0.0.${++ipN}`, ...(origin ? { Origin: origin } : {}), ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) }), e);
const text = async (r) => { const t = await r.text(); try { return [JSON.parse(t), t]; } catch { return [null, t]; } };
const allHeaders = (r) => JSON.stringify([...r.headers.entries()]);

(async () => {
  // ---- status page: shows whether it is set up, never a secret
  { const r = await worker.fetch(new Request('https://relay.example.workers.dev/', { headers: { Origin: ORIGIN } }), env); const [j, t] = await text(r);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual([j.ok, j.key_set, j.origin_set], [true, true, true]); assert(!t.includes(SECRET) && !t.includes('sk-ant'), 'the status page never shows the key'); assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'readable by any site: it holds no secret'); assert.strictEqual(j.origin_ok, true); assert.deepStrictEqual(j.allowed_origins, [ORIGIN]);
    const rf = await worker.fetch(new Request('https://relay.example.workers.dev/', { headers: { Origin: 'https://evil.example' } }), env); const jf = (await text(rf))[0]; assert.strictEqual(jf.origin_ok, false, 'it tells a site whether ITS address is accepted'); assert.deepStrictEqual(jf.allowed_origins, [ORIGIN]);
    const r2 = await worker.fetch(new Request('https://relay.example.workers.dev/'), {}); const j2 = (await text(r2))[0]; assert.deepStrictEqual([j2.key_set, j2.origin_set], [false, false], 'an unconfigured relay says so'); }

  // ---- preflight: only the website may ask
  { const ok = await worker.fetch(new Request('https://relay.example.workers.dev/v1/messages', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }), env);
    assert.strictEqual(ok.status, 204); assert.strictEqual(ok.headers.get('access-control-allow-origin'), ORIGIN); assert(/content-type/i.test(ok.headers.get('access-control-allow-headers')));
    const no = await worker.fetch(new Request('https://relay.example.workers.dev/v1/messages', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env); assert.strictEqual(no.status, 403); assert.strictEqual(no.headers.get('access-control-allow-origin'), null); }

  // ---- a good request: the SERVER key is added, the client's own auth headers are not forwarded, the key never comes back
  { upstream = []; const r = await post(good(), { headers: { 'x-api-key': 'sk-ant-visitor-supplied', authorization: 'Bearer visitor', 'anthropic-version': '2099-01-01' } }); const [j, t] = await text(r);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(j.content[0].text, '{"ok":true}'); assert.strictEqual(upstream.length, 1);
    const u = upstream[0]; assert.strictEqual(u.url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(u.init.headers['x-api-key'], SECRET); assert.strictEqual(u.init.headers['anthropic-version'], '2023-06-01'); assert(!JSON.stringify(u.init.headers).includes('visitor'), 'nothing the visitor sent as credentials is forwarded');
    assert.deepStrictEqual(JSON.parse(u.init.body), good()); assert(!t.includes(SECRET) && !allHeaders(r).includes(SECRET), 'the key is never in what the page receives'); assert.strictEqual(r.headers.get('access-control-allow-origin'), ORIGIN); }

  // ---- an Organization-wide key (not scoped to one workspace) needs the workspace id on every call: it comes from the RELAY's setting, never from a visitor
  { const WS = 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ'; const e = { ...env, ANTHROPIC_WORKSPACE_ID: ' ' + WS + ' ' };
    upstream = []; const r = await post(good(), { e, headers: { 'anthropic-workspace-id': 'wrkspc_VISITOR_CHOSEN' } }); assert.strictEqual(r.status, 200); assert.strictEqual(upstream[0].init.headers['anthropic-workspace-id'], WS, 'the operator\'s workspace, not the visitor\'s');
    upstream = []; assert.strictEqual((await post(good(), { headers: { 'anthropic-workspace-id': WS } })).status, 200); assert(!('anthropic-workspace-id' in upstream[0].init.headers), 'no setting => no header (a key scoped to one workspace needs none), and a visitor\'s header is not forwarded');
    upstream = []; for (const bad of ['01JwQvzr7rXLA5AGx3HKfFUJ', 'wrkspc_', 'org_123', 'wrkspc_abc\r\nx-evil: 1']) { const rb = await post(good(), { e: { ...env, ANTHROPIC_WORKSPACE_ID: bad } }); assert.strictEqual(rb.status, 500, 'rejected: ' + JSON.stringify(bad)); assert(/ANTHROPIC_WORKSPACE_ID/.test((await text(rb))[0].error.message)); } assert.strictEqual(upstream.length, 0, 'a wrong setting never reaches the provider');
    const st = await text(await worker.fetch(new Request('https://relay.example.workers.dev/', { headers: { Origin: ORIGIN } }), e)); assert.strictEqual(st[0].workspace_set, true); assert(!st[1].includes('01JwQvzr'), 'the status page says it is set, it does not echo the id');
    assert.strictEqual((await text(await worker.fetch(new Request('https://relay.example.workers.dev/'), env)))[0].workspace_set, false); }

  // ---- who may call
  { upstream = []; for (const o of [null, 'https://evil.example', 'http://sasfas18-eng.github.io', ORIGIN + '.evil.example']) { const r = await post(good(), { origin: o }); assert.strictEqual(r.status, 403, 'origin ' + o); assert.strictEqual(r.headers.get('access-control-allow-origin'), null); }
    assert.strictEqual(upstream.length, 0, 'a refused call costs nothing'); }
  { const r = await post(good(), { e: { ANTHROPIC_API_KEY: SECRET } }); assert.strictEqual(r.status, 403, 'no ALLOWED_ORIGIN set => fails closed'); assert(/ALLOWED_ORIGIN/.test((await text(r))[0].error.message)); }
  { const r = await post(good(), { e: { ALLOWED_ORIGIN: ORIGIN } }); assert.strictEqual(r.status, 500); assert(/ANTHROPIC_API_KEY/.test((await text(r))[0].error.message)); }
  { const r = await post(good(), { e: { ...env, ALLOWED_ORIGIN: 'https://a.example, ' + ORIGIN } }); assert.strictEqual(r.status, 200, 'several allowed origins'); }

  // ---- what it forwards: only the fields the site uses
  { upstream = []; const bad = [
    [{ ...good(), temperature: 0 }, /field not allowed: temperature/], [{ ...good(), stream: true }, /field not allowed: stream/], [{ ...good(), tools: [{ name: 'x' }] }, /field not allowed: tools/], [{ ...good(), mcp_servers: [] }, /field not allowed/],
    [{ ...good(), model: 'claude-fable-5-1' }, /model not allowed/], [{ ...good(), model: undefined }, /model not allowed/], [{ ...good(), max_tokens: 32001 }, /max_tokens/], [{ ...good(), max_tokens: 0 }, /max_tokens/], [{ ...good(), max_tokens: '100' }, /max_tokens/],
    [{ ...good(), messages: [] }, /messages/], [{ ...good(), messages: [{ role: 'system', content: 'x' }] }, /role/], [{ ...good(), messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }, /text content/], [{ ...good(), messages: [{ role: 'user', content: 'x', extra: 1 }] }, /role/],
    [{ ...good(), system: 5 }, /system/], [{ ...good(), output_config: { effort: 'turbo' } }, /effort/], [{ ...good(), output_config: { effort: 'low', format: {} } }, /effort/], [{ ...good(), thinking: { type: 'enabled', budget_tokens: 5000 } }, /thinking/],
    [[1, 2], /JSON object/], [null, /JSON object/]];
    for (const [b, re] of bad) { const r = await post(b); const [j] = await text(r); assert.strictEqual(r.status, 400, JSON.stringify(b).slice(0, 80)); assert(re.test(j.error.message), `${JSON.stringify(b).slice(0, 60)} -> ${j.error.message}`); }
    assert.strictEqual((await post(null, { raw: '{not json' })).status, 400); assert.strictEqual((await post(null, { raw: 'x'.repeat(600001) })).status, 413); assert.strictEqual(upstream.length, 0, 'nothing invalid ever reaches the provider'); }
  assert.strictEqual(problem(good(), env), null); assert.strictEqual(problem({ ...good(), model: 'claude-haiku-5-5', thinking: { type: 'adaptive' } }, env), null);
  assert.strictEqual(problem({ ...good(), model: 'claude-haiku-5-5' }, { ...env, ALLOWED_MODELS: 'claude-sonnet-5-5' }) !== null, true, 'the model list is configurable'); assert.strictEqual(problem({ ...good(), max_tokens: 5000 }, { ...env, MAX_TOKENS: '4000' }) !== null, true);

  // ---- other routes / methods
  { for (const [m, path] of [['GET', '/v1/messages'], ['POST', '/v1/models'], ['GET', '/v1/models'], ['POST', '/'], ['DELETE', '/v1/messages']]) { const r = await worker.fetch(new Request('https://relay.example.workers.dev' + path, { method: m, headers: { Origin: ORIGIN } }), env); assert.strictEqual(r.status, 404, m + ' ' + path); } }

  // ---- per-visitor limit (best effort) and what a provider error looks like to the page
  { upstream = []; const e = { ...env, RATE_PER_MINUTE: '3' }; for (let i = 0; i < 3; i++) assert.strictEqual((await post(good(), { e, ip: '9.9.9.9' })).status, 200);
    const r = await post(good(), { e, ip: '9.9.9.9' }); assert.strictEqual(r.status, 429); assert(+r.headers.get('retry-after') >= 1); assert.strictEqual(upstream.length, 3, 'the limited call never reached the provider');
    assert.strictEqual((await post(good(), { e, ip: '9.9.9.10' })).status, 200, 'another visitor is not affected'); }
  { reply = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' } });
    const r = await post(good()); assert.strictEqual(r.status, 429); assert.strictEqual(r.headers.get('retry-after'), '17', 'the provider\'s Retry-After reaches the page (the pool honours it)'); assert.strictEqual(r.headers.get('access-control-expose-headers'), 'retry-after'); }
  { reply = () => { throw new Error('network down'); }; const r = await post(good()); assert.strictEqual(r.status, 502); assert(!(await text(r))[1].includes(SECRET)); }
  { reply = () => new Response('{}', { status: 200 }); const r = await post(good(), { e: { ...env, DISABLED: '1' } }); assert.strictEqual(r.status, 503, 'emergency switch'); }

  console.log('relay tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
