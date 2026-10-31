/* Quizzy relay — a tiny Cloudflare Worker (free plan is enough).
 *
 * WHY: a website made of static files (GitHub Pages) cannot keep a secret — anything placed in it can be read by every visitor, and a
 * leaked Claude key can be spent by strangers. This Worker holds your Claude API key on the SERVER side; the website only knows the
 * Worker's address. Visitors never see, send, or receive the key.
 *
 * HOW (details in docs/SETUP-AI.md): Cloudflare dashboard → Workers & Pages → Create → Worker → paste THIS file → Deploy, then
 * Settings → Variables and Secrets:
 *   ANTHROPIC_API_KEY  (type: Secret)  your key from platform.claude.com/settings/keys (starts with sk-ant-)
 *   ALLOWED_ORIGIN     (type: Text)    the website's address, no path: https://sasfas18-eng.github.io   (several: comma-separated)
 * Optional (type: Text):
 *   ANTHROPIC_WORKSPACE_ID  wrkspc_…  ONLY if the key is not scoped to one workspace (an "Organization" key): Anthropic then wants the workspace id on every call
 *                      (copy it from the ID column of platform.claude.com/settings/workspaces). A key scoped to one workspace (e.g. Default) needs none.
 *   ALLOWED_MODELS     claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5   (the only models the site may use)
 *   RATE_PER_MINUTE    60      requests per visitor address per minute
 *   MAX_TOKENS         32000   cap on max_tokens of one request
 *   DISABLED           1       emergency switch: the relay answers 503 to everything
 *
 * WHAT IT ACCEPTS: only POST /v1/messages from the allowed website, with the few fields the site uses; no tools, no streaming, no
 * sampling parameters. Everything else is refused before it can cost anything. Honest limits: the Origin check stops OTHER WEBSITES
 * from using your relay in a browser, but a script can fake an Origin — so the real ceilings are the per-visitor rate limit, the token
 * cap, the model list, and the prepaid balance / monthly spend limit you set in the Anthropic console. */

const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const FIELDS = new Set(['model', 'max_tokens', 'system', 'messages', 'output_config', 'thinking']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MAX_BODY = 600000;
const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const WORKSPACE_RE = /^wrkspc_[A-Za-z0-9_-]{4,80}$/;   // ids look like wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ
const HITS = new Map();   // visitor address -> request times (kept per Worker instance: a best-effort limiter, not a ledger)

const list = (v, dflt) => { const a = String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean); return a.length ? a : dflt; };
const num = (v, dflt) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };
const models = (env) => list(env.ALLOWED_MODELS, DEFAULT_MODELS);
const workspace = (env) => String(env.ANTHROPIC_WORKSPACE_ID == null ? '' : env.ANTHROPIC_WORKSPACE_ID).trim();   // the operator's own setting, never taken from a visitor
const origins = (env) => list(env.ALLOWED_ORIGIN, []).map((o) => o.replace(/\/+$/, ''));

function cors(request, env) {
  const origin = request.headers.get('Origin') || ''; const ok = !!origin && origins(env).includes(origin);
  return { ok, headers: ok ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, anthropic-version', 'Access-Control-Expose-Headers': 'retry-after', 'Access-Control-Max-Age': '86400' } : { Vary: 'Origin' } };
}
const out = (status, obj, headers) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const fail = (status, type, message, headers) => out(status, { type: 'error', error: { type, message } }, headers);

function limited(ip, perMinute, now) {
  const recent = (HITS.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= perMinute) { HITS.set(ip, recent); return Math.max(1, Math.ceil((60000 - (now - recent[0])) / 1000)); }
  recent.push(now); HITS.set(ip, recent);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > 60000) HITS.delete(k);
  return 0;
}

const textBlocks = (c) => typeof c === 'string' ? c.length > 0
  : Array.isArray(c) && c.length > 0 && c.length <= 50 && c.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && Object.keys(b).every((k) => ['type', 'text', 'cache_control'].includes(k)) && (b.cache_control === undefined || (b.cache_control && b.cache_control.type === 'ephemeral')));

/** returns null when the request is acceptable, else a short reason */
export function problem(body, env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) return `field not allowed: ${k}`;
  if (!models(env).includes(body.model)) return `model not allowed (allowed: ${models(env).join(', ')})`;
  const cap = num(env.MAX_TOKENS, 32000);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > cap) return `max_tokens must be an integer between 1 and ${cap}`;
  if (body.system !== undefined && !textBlocks(body.system)) return 'system must be text';
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 40) return 'messages must be a list of 1 to 40 messages';
  for (const m of body.messages) if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || !textBlocks(m.content) || Object.keys(m).some((k) => !['role', 'content'].includes(k))) return 'each message needs a role (user/assistant) and text content';
  if (body.output_config !== undefined && !(body.output_config && Object.keys(body.output_config).length === 1 && EFFORTS.has(body.output_config.effort))) return 'output_config may only set effort (low, medium, high, xhigh, max)';
  if (body.thinking !== undefined && !(body.thinking && body.thinking.type === 'adaptive' && Object.keys(body.thinking).length === 1)) return 'thinking may only be {"type":"adaptive"}';
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url); const c = cors(request, env);
    if (env.DISABLED === '1' && request.method !== 'OPTIONS') return fail(503, 'unavailable', 'the relay is switched off', c.headers);
    if (request.method === 'OPTIONS') return c.ok ? new Response(null, { status: 204, headers: c.headers }) : fail(403, 'forbidden', 'origin not allowed', c.headers);

    // status page: open the Worker's address in a browser to see whether it is set up (it never shows a secret)
    // (readable from any site on purpose: it holds no secret, and it lets the site's operator page say exactly what is wrong — e.g. an address that does not match)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return out(200, { ok: true, service: 'quizzy-relay', key_set: !!env.ANTHROPIC_API_KEY, origin_set: origins(env).length > 0, origin_ok: c.ok, allowed_origins: origins(env), models: models(env), workspace_set: !!workspace(env) }, { ...c.headers, 'Access-Control-Allow-Origin': '*' });

    if (!(request.method === 'POST' && url.pathname === '/v1/messages')) return fail(404, 'not_found', 'unknown route', c.headers);
    if (!env.ANTHROPIC_API_KEY) return fail(500, 'not_configured', 'ANTHROPIC_API_KEY is not set on the relay (Settings → Variables and Secrets)', c.headers);
    const ws = workspace(env); if (ws && !WORKSPACE_RE.test(ws)) return fail(500, 'not_configured', 'ANTHROPIC_WORKSPACE_ID must look like wrkspc_… (copy it from the ID column of the Workspaces page), or be left empty for a key scoped to one workspace', c.headers);
    if (!c.ok) return fail(403, 'forbidden', origins(env).length ? 'origin not allowed' : 'ALLOWED_ORIGIN is not set on the relay (the website address, e.g. https://name.github.io)', c.headers);

    const wait = limited(request.headers.get('CF-Connecting-IP') || 'unknown', num(env.RATE_PER_MINUTE, 60), Date.now());
    if (wait) return fail(429, 'rate_limit_error', 'too many requests from this address; slow down', { ...c.headers, 'retry-after': String(wait) });

    let raw; try { raw = await request.text(); } catch { return fail(400, 'invalid_request_error', 'unreadable body', c.headers); }
    if (raw.length > MAX_BODY) return fail(413, 'request_too_large', 'request too large', c.headers);
    let body; try { body = JSON.parse(raw); } catch { return fail(400, 'invalid_request_error', 'the body must be JSON', c.headers); }
    const why = problem(body, env); if (why) return fail(400, 'invalid_request_error', why, c.headers);

    let up;
    try {
      up = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', ...(ws ? { 'anthropic-workspace-id': ws } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(170000) });
    } catch { return fail(502, 'api_error', 'could not reach the model provider', c.headers); }
    const headers = { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...c.headers };
    const ra = up.headers.get('retry-after'); if (ra) headers['retry-after'] = ra;
    return new Response(up.body, { status: up.status, headers });
  },
};
