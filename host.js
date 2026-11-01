/* Quizzy · web edition host (GitHub Pages / any static hosting).
 *   accounts : Supabase (email + password, email links, RLS-isolated storage) when static-edition/config.js is filled; otherwise device-only
 *   generation: with no AI the questions are built locally (rules.js). AI providers are called through a pool (shared/pool.js): the site's
 *               shared provider(s) — a RELAY (config.js `relay`: a server that holds the key, so visitors need nothing and can never see it) —
 *               and, for the OPERATOR only (#/operator), keys pasted on this device
 *   PDF      : browser print view (#/print/<quiz>) -> "Save as PDF"  (correct Arabic shaping for free) */
(() => {
const { Mem, idbStore } = window.QZ_STORES; const { LLMPool, pickModel, rankModels, withAlts, ANTHROPIC_MODELS } = window.QZ_POOL; const { SupabaseClient, SbError } = window.QZ_SB;
const CFG = window.QZ_CONFIG || {}; const sb = new SupabaseClient({ url: CFG.supabaseUrl, anonKey: CFG.supabaseAnonKey }); const useSb = sb.configured;
const rid = () => Math.random().toString(36).slice(2, 10);

// ---- email links (confirm / recovery) arrive as #access_token=...: adopt the session and clean the URL before the UI routes.
// Runs at load AND on hashchange (the link may be opened in a tab that already has the site open).
const toast = (msg) => { const t = document.createElement('div'); t.className = 'toast bad'; t.textContent = msg; (document.getElementById('toasts') || document.body).append(t); setTimeout(() => t.remove(), 6000); };
function adoptFromHash(initial) {
  if (!useSb) return; const frag = SupabaseClient.parseFragment(location.hash); if (!frag) return;
  const base = location.pathname + location.search;
  if (frag.type === 'error') { history.replaceState(null, '', base + '#/login'); if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => toast(frag.error)); else toast(frag.error); return; }
  sb.adoptTokens(frag.tokens); sb.fetchUser().catch(() => {});
  history.replaceState(null, '', base + (frag.type === 'recovery' ? '#/reset?token=' + encodeURIComponent(frag.tokens.access_token) : '#/'));
  if (initial !== true) location.reload();   // link opened in a tab that was already running: restart the UI so it sees the new session
}
adoptFromHash(true); window.addEventListener('hashchange', () => adoptFromHash(false));

// ---- site-wide AI. Two ways, in order of preference:
//   1) config.js `relay`: the address of a relay (relay/cloudflare-worker.mjs) that keeps the Claude key SERVER-side. The key is never in the site.
//   2) config.js `llm`: provider entries WITH the key inside — PUBLIC by nature (anything in a static site is readable): only for a free-tier key
//      restricted to this site's domain, never a paid Claude key.
const relayBase = (() => { try { const u = new URL(String(CFG.relay || '')); return u.protocol === 'https:' ? u.origin : ''; } catch { return ''; } })();
const RELAY = relayBase ? [{ id: 'relay', name: 'Claude (عبر وسيط الموقع)', kind: 'anthropic', relay: true, base: relayBase, key: '', model: String(CFG.relayModel || 'claude-opus-5-5'), rpm: Math.max(1, +CFG.relayRpm || 20) }] : [];
const SHARED = [...RELAY, ...(Array.isArray(CFG.llm) ? CFG.llm : []).filter((e) => e && e.base && e.model && (e.key || /localhost|127\.0\.0\.1/.test(e.base)))
  .map((e, i) => ({ id: 'shared' + i, name: e.name || 'مزوّد الموقع', kind: ['anthropic', 'gemini'].includes(e.kind) ? e.kind : 'openai', base: String(e.base).replace(/\/+$/, ''), key: e.key || '', model: e.model, rpm: Math.max(1, +e.rpm || 10) }))];

// ---- generation keys (device-local; never sent anywhere except the provider they belong to)
const EP_KEY = 'quizzy_llm_endpoints_v1';
const loadEps = () => { try { return JSON.parse(localStorage.getItem(EP_KEY)) || []; } catch { return []; } };
const saveEps = (a) => { try { localStorage.setItem(EP_KEY, JSON.stringify(a)); } catch { /* storage blocked */ } };
// ---- operator mode (this device): the AI box and the keys saved here are for the site's OPERATOR only. It is switched on by opening #/operator
// (an unlisted page), so visitors never see the box; it hides the box, it is not an access control — the secret key itself lives on the relay.
const OP_KEY = 'quizzy_operator_v1';
const isOperator = () => { try { return localStorage.getItem(OP_KEY) === '1'; } catch { return false; } };
const setOperator = (on) => { try { if (on) localStorage.setItem(OP_KEY, '1'); else localStorage.removeItem(OP_KEY); } catch { /* storage blocked */ } };
let POOL = null, SIG = '';
const allEps = () => [...SHARED, ...(isOperator() ? loadEps() : [])].map(withAlts);      // + the default alternate models of each key (Gemini flash -> flash-lite; Groq 70b <-> 8b); a saved `alts` list wins
const pool = () => { const eps = allEps(); const sig = JSON.stringify(eps); if (sig !== SIG) { POOL = new LLMPool(eps); SIG = sig; } return POOL; };
const llm = { json: (task, system, prompt) => pool().json(task, system, prompt), scale: () => pool().scale() };      // scale(): how big a request the provider that will serve the next call can take
const maskKey = (k) => (k ? '…' + String(k).slice(-4) : '(بلا مفتاح)');
const epOut = (e) => ({ id: e.id, name: e.name, kind: e.kind, base: e.base, model: e.model, rpm: e.rpm, key_hint: maskKey(e.key) });
const okUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };

// ---- platform / store
// ---- guest mode: no account, no registration; what is made is kept on THIS device only, with no promise that it stays (clearing the browser's data, or another device, loses it)
const GUEST_KEY = 'quizzy_guest_v1';
const isGuest = () => { try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; } };
const setGuest = (on) => { try { if (on) localStorage.setItem(GUEST_KEY, '1'); else localStorage.removeItem(GUEST_KEY); } catch { /* storage blocked */ } };
const guestUser = { id: 'guest', email: '', name: 'ضيف', role: 'student', guest: true };
let LOCAL = null, GLOCAL = null; const localUser = { ...guestUser, id: 'local' };      // without accounts everybody is a guest
async function platform() {
  const aiAvailable = allEps().length > 0;
  if (!useSb) return { signedIn: true, user: localUser, aiAvailable, mode: 'device' };
  if (sb.session && !sb.session.user) { try { await sb.fetchUser(); } catch { /* handled on first request */ } }
  const user = sb.session ? sb.uiUser() : null; if (!user && isGuest()) return { signedIn: true, user: guestUser, aiAvailable, mode: 'guest' };
  return { signedIn: !!user, user, aiAvailable, mode: 'supabase' };
}
async function store() {
  if (useSb && !sb.session && isGuest()) { if (!GLOCAL) { try { GLOCAL = await idbStore('quizzy_guest_v1'); } catch { GLOCAL = new Mem(); } } return GLOCAL; }      // a guest's own store, never mixed with an account's
  if (useSb) { if (!sb.session) throw new Error('سجّل الدخول أولًا.'); return sb.store(); }
  if (!LOCAL) { try { LOCAL = await idbStore('quizzy_web_v1'); } catch { LOCAL = new Mem(); } } return LOCAL;
}

// ---- accounts (Supabase)
const fail = (e) => ({ status: e.status && e.status !== 0 ? e.status : 400, body: { code: e.code || 'error', message: e.message } });
const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof SbError) return fail(e); throw e; } };
const auth = !useSb ? { delete: async () => { if (!LOCAL) await store(); if (LOCAL.clear) await LOCAL.clear(); return { body: { ok: true } }; } } : {
  guest: async () => { setGuest(true); return { body: guestUser }; },
  login: wrap(async (b) => { await sb.signIn({ email: String(b.email || '').trim(), password: b.password }); setGuest(false); return { body: sb.uiUser() }; }),
  register: wrap(async (b) => { const r = await sb.signUp({ email: String(b.email || '').trim(), password: b.password, name: String(b.name || '').trim() });
    if (!r.pendingConfirmation) setGuest(false); return r.pendingConfirmation ? { body: { pending_confirmation: true, message: 'أرسلنا رابط تأكيد إلى بريدك. افتحه لتفعيل الحساب ثم سجّل الدخول.' } } : { body: sb.uiUser() }; }),
  logout: wrap(async () => { if (!sb.session && isGuest()) { setGuest(false); return { body: { ok: true } }; } await sb.signOut(); return { body: { ok: true } }; }),
  forgot: wrap(async (b) => { await sb.recover(String(b.email || '').trim(), location.origin + location.pathname); return { body: { ok: true, message: 'إن كان البريد مسجلًا فقد أُرسل إليه رابط الاستعادة.' } }; }),
  reset: wrap(async (b) => { await sb.updatePassword(b.password, b.token); sb._save(null); return { body: { ok: true } }; }),
  password: wrap(async (b, pl) => { await sb.verifyPassword(pl.user.email, b.current_password); await sb.updatePassword(b.new_password); await sb.signOut('others'); return { body: { ok: true } }; }),
  delete: wrap(async (b, pl) => { if (pl.mode === 'guest') { const st = await store(); if (st.clear) await st.clear(); return { body: { ok: true } }; }      // a guest wipes the data of this device; there is no account to delete
    await sb.verifyPassword(pl.user.email, b.password); await sb.deleteAccount(); return { body: { ok: true } }; }),
};

// ---- /api/llm/* : manage and test the user's provider keys
async function handle(method, path, qs, b) {
  if (path === '/api/operator' && method === 'POST') { setOperator(!!(b && b.on)); return { body: { operator: isOperator() } }; }
  if (!path.startsWith('/api/llm/')) return null;
  if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'ربط الذكاء الاصطناعي لصاحب الموقع فقط.' } };
  if (path === '/api/llm/relay-status' && method === 'GET') {            // is the relay up and set up? (its status page never shows a secret)
    if (!relayBase) return { body: { configured: false } };
    try { const r = await fetch(relayBase + '/'); const j = await r.json(); return { body: { configured: true, reachable: r.ok, key_set: !!j.key_set, origin_set: !!j.origin_set, origin_ok: j.origin_ok !== false, allowed_origins: j.allowed_origins || [], models: j.models || [], model: RELAY[0].model } }; }
    catch { return { body: { configured: true, reachable: false, address: relayBase } }; }
  }
  if (path === '/api/llm/endpoints' && method === 'GET') return { body: loadEps().map(epOut) };
  if (path === '/api/llm/endpoints' && method === 'POST') {
    const e = { id: rid(), name: String(b.name || '').trim() || 'مزوّد', kind: ['anthropic', 'gemini'].includes(b.kind) ? b.kind : 'openai', base: String(b.base || '').trim().replace(/\/+$/, ''), key: String(b.key || '').trim(), model: String(b.model || '').trim(), rpm: Math.max(1, Math.min(600, +b.rpm || 20)) };
    if (Array.isArray(b.alts)) e.alts = [...new Set(b.alts.map((x) => String(x || '').trim()).filter((x) => x && x !== e.model))].slice(0, 3);
    if (!okUrl(e.base)) return { status: 422, body: { code: 'bad_url', message: 'عنوان المزوّد يجب أن يبدأ بـ https:// (أو يكون localhost).' } };
    if (!e.model) return { status: 422, body: { code: 'bad_model', message: 'اسم النموذج مطلوب.' } };
    if (!e.key && !/localhost|127\.0\.0\.1/.test(e.base)) return { status: 422, body: { code: 'bad_key', message: 'المفتاح مطلوب.' } };
    saveEps([...loadEps(), e]); return { body: loadEps().map(epOut) };
  }
  let m = path.match(/^\/api\/llm\/endpoints\/(\w+)$/); if (m && method === 'DELETE') { saveEps(loadEps().filter((e) => e.id !== m[1])); return { body: loadEps().map(epOut) }; }
  if (path === '/api/llm/discover' && method === 'POST') {          // which models can this key use? (so nobody types model names)
    const kind = ['anthropic', 'gemini'].includes(b.kind) ? b.kind : 'openai', base = String(b.base || '').trim().replace(/\/+$/, ''), key = String(b.key || '').trim();
    if (!okUrl(base)) return { status: 422, body: { code: 'bad_url', message: 'عنوان المزوّد يجب أن يبدأ بـ https:// (أو يكون localhost).' } };
    if (!key && !/localhost|127\.0\.0\.1/.test(base)) return { status: 422, body: { code: 'bad_key', message: 'المفتاح مطلوب.' } };
    if (kind === 'anthropic') return { body: { models: ANTHROPIC_MODELS, suggested: 'claude-sonnet-5-5' } };      // not readable from a browser (no CORS headers on GET /v1/models); the key is checked by the test message right after
    try { const ids = await LLMPool.listModels({ kind, base, key }); return { body: { models: ids.slice(0, 300), suggested: pickModel(kind, base, ids), candidates: rankModels(kind, base, ids).slice(0, 4) } }; }
    catch (err) { return { status: 400, body: { code: err.code || 'error', message: err.code === 'network' ? LLMPool.networkMessage({ base }, await LLMPool.diagnose({ base })) : err.message } }; }
  }
  if (path === '/api/llm/test' && method === 'POST') {
    const e = [...RELAY, ...loadEps()].find((x) => x.id === b.id); if (!e) return { status: 404, body: { code: 'not_found', message: 'المزوّد غير موجود.' } };
    try { const r = await new LLMPool([], {}).test(e); return { body: r.busy ? { ok: false, busy: true, status: r.status, message: r.message, ms: r.ms } : { ok: r.ok, ms: r.ms } }; } catch (err) { return { status: 400, body: { code: err.code || 'error', message: err.message } }; }
  }
  if (path === '/api/llm/chain' && method === 'GET') return { body: { chain: allEps().length ? pool().status() : [], local: true } };   // the automatic path as it stands, best first
  if (path === '/api/llm/check' && method === 'POST') {            // really test every provider of the path (one tiny request each), best first; one that works is brought back at once (with its alternate models)
    const eps = allEps(); const results = [];
    for (const st of pool().status().filter((x) => !x.alt)) {
      const cfg = eps.find((x) => x.id === st.id); if (!cfg) continue;
      try { const r = await new LLMPool([], {}).test(cfg); if (r.ok) pool().revive(st.id); results.push({ id: st.id, name: cfg.name, model: cfg.model, ok: !!r.ok, busy: !!r.busy, message: r.busy ? r.message : undefined, ms: Math.round(r.ms) }); }
      catch (err) { results.push({ id: st.id, name: cfg.name, model: cfg.model, ok: false, message: String((err && err.message) || err) }); }
    }
    return { body: { results, chain: pool().status() } };
  }
  return null;
}

window.QZ_HOST = {
  platform, store, llm, auth, handle, requireAuth: useSb, printPdf: true, generatorLabel: 'ذكاء اصطناعي',
  get concurrency() { return Math.min(8, Math.max(2, pool().width)); },
  aiMissingMessage: 'الإنشاء يعمل الآن بدون ذكاء اصطناعي (محليًا على جهازك).',
  async capabilities(pl) { const guest = !!(pl && pl.mode === 'guest'); return { edition: 'web', accounts: useSb && !guest ? 'supabase' : 'device', guest: true, can_register: useSb, password_reset: useSb, byok: isOperator(), operator: isOperator(), relay: !!relayBase, shared_ai: SHARED.length > 0, ai_label: 'ذكاء اصطناعي', ai_missing: '', local: !useSb || guest, print_pdf: true, registration: 'open' }; },
  bannerText: () => '',      // the guest notice (no account, nothing guaranteed) is drawn by the page itself
};
})();
