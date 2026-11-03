/* Quizzy relay — a tiny Cloudflare Worker (the free plan is enough) that lets every visitor get AI-written quizzes WITHOUT a key in the site.
 *
 * WHY: the site is static (GitHub Pages). Anything placed in it can be read by every visitor, so a Gemini key put in the site would be spent by
 * strangers. This Worker holds the key on the SERVER side; the site only knows the Worker's address. Visitors never see, send, or receive the key.
 *
 * HOW (full steps in docs/SETUP-AI.md): Cloudflare dashboard → Workers & Pages → Create → Worker → paste THIS file → Deploy, then
 * Settings → Variables and Secrets:
 *   GEMINI_API_KEY   (type: Secret)  a FREE key from Google AI Studio (aistudio.google.com/apikey); no billing card needed
 *   ALLOWED_ORIGIN   (type: Text)    the site's address, no path: https://sasfas18-eng.github.io   (several: comma-separated)
 * Optional (type: Text):
 *   ALLOWED_MODELS   gemini-2.0-flash,gemini-2.5-flash,gemini-2.0-flash-lite   (the only models the site may use)
 *   RATE_PER_MINUTE  30      requests per visitor address per minute
 *   MAX_TOKENS       8192    cap on max_tokens of one request (Gemini Flash output cap is 8192)
 *   DISABLED         1       emergency switch: the relay answers 503 to everything
 *
 * WHAT IT ACCEPTS: only POST /v1/chat/completions from the allowed site, with the few fields the site uses (OpenAI-compatible shape); no tools, no
 * streaming. It forwards to Google's OpenAI-compatible Gemini endpoint. Everything else is refused before it can cost anything. Honest limits: the
 * Origin check stops OTHER WEBSITES from using your relay in a browser, but a script can fake an Origin — so the real ceilings are the per-visitor
 * rate limit, the token cap, the model list, and Google's own free-tier quota (≈15 requests/min, ≈1500/day per project; it falls back to the free
 * on-device generator when spent, so no visitor is ever blocked). */

const DEFAULT_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-flash-latest'];
const FIELDS = new Set(['model', 'max_tokens', 'messages', 'temperature', 'top_p', 'response_format']);
const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_BODY = 600000;
const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const HITS = new Map();   // visitor address -> request times (kept per Worker instance: a best-effort limiter, not a ledger)

const list = (v, dflt) => { const a = String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean); return a.length ? a : dflt; };
const num = (v, dflt) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };
const models = (env) => list(env.ALLOWED_MODELS, DEFAULT_MODELS);
const origins = (env) => list(env.ALLOWED_ORIGIN, []).map((o) => o.replace(/\/+$/, ''));

function cors(request, env) {
  const origin = request.headers.get('Origin') || ''; const ok = !!origin && origins(env).includes(origin);
  return { ok, headers: ok ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Expose-Headers': 'retry-after', 'Access-Control-Max-Age': '86400' } : { Vary: 'Origin' } };
}
const out = (status, obj, headers) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const fail = (status, type, message, headers) => out(status, { error: { type, message } }, headers);

function limited(ip, perMinute, now) {
  const recent = (HITS.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= perMinute) { HITS.set(ip, recent); return Math.max(1, Math.ceil((60000 - (now - recent[0])) / 1000)); }
  recent.push(now); HITS.set(ip, recent);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > 60000) HITS.delete(k);
  return 0;
}

/** returns null when the request is acceptable, else a short reason */
export function problem(body, env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) return `field not allowed: ${k}`;
  if (!models(env).includes(body.model)) return `model not allowed (allowed: ${models(env).join(', ')})`;
  const cap = num(env.MAX_TOKENS, 8192);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > cap) return `max_tokens must be an integer between 1 and ${cap}`;
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 40) return 'messages must be a list of 1 to 40 messages';
  for (const m of body.messages) if (!m || typeof m !== 'object' || !ROLES.has(m.role) || typeof m.content !== 'string' || !m.content || Object.keys(m).some((k) => !['role', 'content'].includes(k))) return 'each message needs a role (system/user/assistant) and string content';
  if (body.temperature !== undefined && !(typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2)) return 'temperature must be a number between 0 and 2';
  if (body.top_p !== undefined && !(typeof body.top_p === 'number' && body.top_p >= 0 && body.top_p <= 1)) return 'top_p must be a number between 0 and 1';
  if (body.response_format !== undefined && !(body.response_format && typeof body.response_format === 'object' && ['json_object', 'text'].includes(body.response_format.type) && Object.keys(body.response_format).length === 1)) return 'response_format may only be {"type":"json_object"} or {"type":"text"}';
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url); const c = cors(request, env);
    if (env.DISABLED === '1' && request.method !== 'OPTIONS') return fail(503, 'unavailable', 'the relay is switched off', c.headers);
    if (request.method === 'OPTIONS') return c.ok ? new Response(null, { status: 204, headers: c.headers }) : fail(403, 'forbidden', 'origin not allowed', c.headers);

    // status page: open the Worker's address in a browser to see whether it is set up (it never shows a secret).
    // (readable from any site on purpose: it holds no secret, and it lets the site's operator page say exactly what is wrong — e.g. an address that does not match)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return out(200, { ok: true, service: 'quizzy-relay', upstream: 'gemini', key_set: !!env.GEMINI_API_KEY, origin_set: origins(env).length > 0, origin_ok: c.ok, allowed_origins: origins(env), models: models(env) }, { ...c.headers, 'Access-Control-Allow-Origin': '*' });

    if (!(request.method === 'POST' && url.pathname === '/v1/chat/completions')) return fail(404, 'not_found', 'unknown route', c.headers);
    if (!env.GEMINI_API_KEY) return fail(500, 'not_configured', 'GEMINI_API_KEY is not set on the relay (Settings → Variables and Secrets)', c.headers);
    if (!c.ok) return fail(403, 'forbidden', origins(env).length ? 'origin not allowed' : 'ALLOWED_ORIGIN is not set on the relay (the site address, e.g. https://name.github.io)', c.headers);

    const wait = limited(request.headers.get('CF-Connecting-IP') || 'unknown', num(env.RATE_PER_MINUTE, 30), Date.now());
    if (wait) return fail(429, 'rate_limit_error', 'too many requests from this address; slow down', { ...c.headers, 'retry-after': String(wait) });

    let raw; try { raw = await request.text(); } catch { return fail(400, 'invalid_request_error', 'unreadable body', c.headers); }
    if (raw.length > MAX_BODY) return fail(413, 'request_too_large', 'request too large', c.headers);
    let body; try { body = JSON.parse(raw); } catch { return fail(400, 'invalid_request_error', 'the body must be JSON', c.headers); }
    const why = problem(body, env); if (why) return fail(400, 'invalid_request_error', why, c.headers);

    let up;
    try {
      up = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GEMINI_API_KEY}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(170000) });
    } catch { return fail(502, 'api_error', 'could not reach the model provider', c.headers); }
    const headers = { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...c.headers };
    const ra = up.headers.get('retry-after'); if (ra) headers['retry-after'] = ra;
    return new Response(up.body, { status: up.status, headers });
  },
};
