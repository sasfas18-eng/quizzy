// TEST ONLY: a small in-memory stand-in for Supabase (GoTrue + PostgREST subset) that enforces the same ownership rules as
// supabase/schema.sql (RLS verified separately on real PostgreSQL). Used to drive the browser client and the UI end to end.
const http = require('http'); const crypto = require('crypto');
function start({ port = 0, anonKey = 'anon-test-key', confirmEmail = false, expiresIn = 3600 } = {}) {
  const users = new Map(), byEmail = new Map(), access = new Map(), refresh = new Map(), kv = new Map(), recovery = new Map(), confirmTokens = new Map(); const stats = { requests: 0, refreshes: 0 };
  const rnd = () => crypto.randomBytes(16).toString('hex'); const uid = () => crypto.randomUUID();
  const send = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*', ...extra }); res.end(body === undefined || body === null ? '' : JSON.stringify(body)); };
  const pubUser = (u) => ({ id: u.id, email: u.email, user_metadata: u.meta, identities: [{ id: u.id }], email_confirmed_at: u.confirmed ? 'now' : null });
  const issue = (u) => { const a = 'at_' + rnd(), r = 'rt_' + rnd(); access.set(a, { uid: u.id, exp: Date.now() / 1000 + expiresIn }); refresh.set(r, u.id); return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: expiresIn, user: pubUser(u) }; };
  const authed = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer /i, ''); const a = access.get(t); return a && a.exp > Date.now() / 1000 ? a.uid : null; };
  const filt = (q) => { const f = []; for (const [k, v] of q) { if (['select', 'order', 'limit', 'on_conflict', 'redirect_to', 'grant_type', 'scope'].includes(k)) continue; const m = v.match(/^(eq|in)\.(.*)$/); if (!m) continue; f.push([k, m[1] === 'eq' ? [m[2]] : m[2].replace(/^\(|\)$/g, '').split(',').map(decodeURIComponent)]); } return f; };
  const mine = (id, f) => [...kv.values()].filter((r) => r.user_id === id && f.every(([k, vals]) => vals.includes(String(r[k]))));
  const server = http.createServer((req, res) => {
    stats.requests++; if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://x'); let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
      if (req.headers.apikey !== anonKey) return send(res, 401, { message: 'Invalid API key' });
      let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ } const p = url.pathname, q = url.searchParams;
      // ---------- GoTrue
      if (p === '/auth/v1/signup') { const email = String(b.email || '').toLowerCase(); if (String(b.password || '').length < 6) return send(res, 422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
        if (byEmail.has(email)) return confirmEmail ? send(res, 200, { id: uid(), email, identities: [] }) : send(res, 422, { error_code: 'user_already_exists', msg: 'User already registered' });
        const u = { id: uid(), email, pw: b.password, meta: b.data || {}, confirmed: !confirmEmail }; users.set(u.id, u); byEmail.set(email, u);
        if (confirmEmail) { const t = 'ct_' + rnd(); confirmTokens.set(email, t); return send(res, 200, pubUser(u)); } return send(res, 200, issue(u)); }
      if (p === '/auth/v1/token') { if (q.get('grant_type') === 'password') { const u = byEmail.get(String(b.email || '').toLowerCase()); if (!u || u.pw !== b.password) return send(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          if (!u.confirmed) return send(res, 400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' }); return send(res, 200, issue(u)); }
        if (q.get('grant_type') === 'refresh_token') { const id = refresh.get(b.refresh_token); if (!id) return send(res, 400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }); refresh.delete(b.refresh_token); stats.refreshes++; return send(res, 200, issue(users.get(id))); } }
      if (p === '/auth/v1/logout') { const id = authed(req); const cur = (req.headers.authorization || '').replace(/^Bearer /i, ''); if (id) for (const [t, a] of access) if (a.uid === id && !(q.get('scope') === 'others' && t === cur)) access.delete(t); return send(res, 204); }
      if (p === '/auth/v1/recover') { const email = String(b.email || '').toLowerCase(); const u = byEmail.get(email); if (u) { const t = issue(u).access_token; recovery.set(email, t); } return send(res, 200, {}); }
      if (p === '/auth/v1/user') { const id = authed(req); if (!id) return send(res, 401, { msg: 'invalid JWT: token is expired' }); const u = users.get(id);
        if (req.method === 'PUT') { if (b.password === u.pw) return send(res, 422, { error_code: 'same_password', msg: 'New password should be different' }); if (String(b.password || '').length < 6) return send(res, 422, { error_code: 'weak_password', msg: 'weak' }); u.pw = b.password; return send(res, 200, pubUser(u)); } return send(res, 200, pubUser(u)); }
      // ---------- PostgREST (ownership = what RLS enforces)
      if (p === '/rest/v1/kv' || p === '/rest/v1/rpc/delete_my_account') { const id = authed(req);
        if (!id) return req.headers.authorization === 'Bearer ' + anonKey && req.method === 'GET' ? send(res, 200, []) : send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
        if (p.endsWith('delete_my_account')) { for (const [k, r] of kv) if (r.user_id === id) kv.delete(k); const u = users.get(id); users.delete(id); byEmail.delete(u.email); for (const [t, a] of access) if (a.uid === id) access.delete(t); return send(res, 200, null); }
        if (req.method === 'GET') { const rows = mine(id, filt(q)); const out = rows.map((r) => { const o = {}; for (const c of (q.get('select') || '*').split(',')) o[c] = r[c]; return c2(o, q, r); }); return send(res, 200, q.get('limit') ? out.slice(0, +q.get('limit')) : out); }
        if (req.method === 'POST') { const rows = Array.isArray(b) ? b : [b]; for (const r of rows) if (r.user_id && r.user_id !== id) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "kv"' });
          for (const r of rows) kv.set(id + '|' + r.k, { user_id: id, k: r.k, kind: r.kind, data: r.data, updated_at: Date.now() }); return send(res, 201); }
        if (req.method === 'DELETE') { for (const r of mine(id, filt(q))) kv.delete(r.user_id + '|' + r.k); return send(res, 204); } }
      send(res, 404, { message: 'not found: ' + p });
    });
  });
  const c2 = (o, q, r) => o;   // select projection already applied
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, anonKey, stats, users, kv, access,
    recoveryToken: (email) => recovery.get(email.toLowerCase()), confirmToken: (email) => confirmTokens.get(email.toLowerCase()), confirm(email) { const u = byEmail.get(email.toLowerCase()); u.confirmed = true; return issue(u); },
    expireAll() { for (const a of access.values()) a.exp = 0; }, close: () => new Promise((r) => server.close(r)) })));
}
module.exports = { start };
