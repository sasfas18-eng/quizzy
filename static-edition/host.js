/* Quizzy · web edition host (GitHub Pages / any static hosting).
 *   accounts : Supabase (email + password, email links, RLS-isolated storage) when static-edition/config.js is filled; otherwise device-only
 *   generation: AI providers called straight from the browser through a pool (shared/pool.js): the site owner's shared provider(s)
 *               from config.js (visitors need nothing) and/or the visitor's OWN key(s) pasted once on the "connect AI" card
 *   PDF      : browser print view (#/print/<quiz>) -> "Save as PDF"  (correct Arabic shaping for free) */
(() => {
const { Mem, idbStore } = window.QZ_STORES; const { LLMPool, pickModel } = window.QZ_POOL; const { SupabaseClient, SbError } = window.QZ_SB;
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

// ---- owner-provided providers (config.js `llm`): PUBLIC by nature (anything in a static site is readable) — use a free-tier key restricted to this site's domain.
const SHARED = (Array.isArray(CFG.llm) ? CFG.llm : []).filter((e) => e && e.base && e.model && (e.key || /localhost|127\.0\.0\.1/.test(e.base)))
  .map((e, i) => ({ id: 'shared' + i, name: e.name || 'مزوّد الموقع', kind: e.kind === 'anthropic' ? 'anthropic' : 'openai', base: String(e.base).replace(/\/+$/, ''), key: e.key || '', model: e.model, rpm: Math.max(1, +e.rpm || 10) }));

// ---- generation keys (device-local; never sent anywhere except the provider they belong to)
const EP_KEY = 'quizzy_llm_endpoints_v1';
const loadEps = () => { try { return JSON.parse(localStorage.getItem(EP_KEY)) || []; } catch { return []; } };
const saveEps = (a) => { try { localStorage.setItem(EP_KEY, JSON.stringify(a)); } catch { /* storage blocked */ } };
let POOL = null, SIG = '';
const allEps = () => [...SHARED, ...loadEps()];
const pool = () => { const eps = allEps(); const sig = JSON.stringify(eps); if (sig !== SIG) { POOL = new LLMPool(eps); SIG = sig; } return POOL; };
const llm = { json: (task, system, prompt) => pool().json(task, system, prompt) };
const maskKey = (k) => (k ? '…' + String(k).slice(-4) : '(بلا مفتاح)');
const epOut = (e) => ({ id: e.id, name: e.name, kind: e.kind, base: e.base, model: e.model, rpm: e.rpm, key_hint: maskKey(e.key) });
const okUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };

// ---- platform / store
let LOCAL = null; const localUser = { id: 'local', email: '', name: 'حسابي على هذا الجهاز', role: 'student' };
async function platform() {
  const aiAvailable = allEps().length > 0;
  if (!useSb) return { signedIn: true, user: localUser, aiAvailable, mode: 'device' };
  if (sb.session && !sb.session.user) { try { await sb.fetchUser(); } catch { /* handled on first request */ } }
  const user = sb.session ? sb.uiUser() : null; return { signedIn: !!user, user, aiAvailable, mode: 'supabase' };
}
async function store() {
  if (useSb) { if (!sb.session) throw new Error('سجّل الدخول أولًا.'); return sb.store(); }
  if (!LOCAL) { try { LOCAL = await idbStore('quizzy_web_v1'); } catch { LOCAL = new Mem(); } } return LOCAL;
}

// ---- accounts (Supabase)
const fail = (e) => ({ status: e.status && e.status !== 0 ? e.status : 400, body: { code: e.code || 'error', message: e.message } });
const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof SbError) return fail(e); throw e; } };
const auth = !useSb ? { delete: async () => { if (!LOCAL) await store(); if (LOCAL.clear) await LOCAL.clear(); return { body: { ok: true } }; } } : {
  login: wrap(async (b) => { await sb.signIn({ email: String(b.email || '').trim(), password: b.password }); return { body: sb.uiUser() }; }),
  register: wrap(async (b) => { const r = await sb.signUp({ email: String(b.email || '').trim(), password: b.password, name: String(b.name || '').trim() });
    return r.pendingConfirmation ? { body: { pending_confirmation: true, message: 'أرسلنا رابط تأكيد إلى بريدك. افتحه لتفعيل الحساب ثم سجّل الدخول.' } } : { body: sb.uiUser() }; }),
  logout: wrap(async () => { await sb.signOut(); return { body: { ok: true } }; }),
  forgot: wrap(async (b) => { await sb.recover(String(b.email || '').trim(), location.origin + location.pathname); return { body: { ok: true, message: 'إن كان البريد مسجلًا فقد أُرسل إليه رابط الاستعادة.' } }; }),
  reset: wrap(async (b) => { await sb.updatePassword(b.password, b.token); sb._save(null); return { body: { ok: true } }; }),
  password: wrap(async (b, pl) => { await sb.verifyPassword(pl.user.email, b.current_password); await sb.updatePassword(b.new_password); await sb.signOut('others'); return { body: { ok: true } }; }),
  delete: wrap(async (b, pl) => { await sb.verifyPassword(pl.user.email, b.password); await sb.deleteAccount(); return { body: { ok: true } }; }),
};

// ---- /api/llm/* : manage and test the user's provider keys
async function handle(method, path, qs, b) {
  if (!path.startsWith('/api/llm/')) return null;
  if (path === '/api/llm/endpoints' && method === 'GET') return { body: loadEps().map(epOut) };
  if (path === '/api/llm/endpoints' && method === 'POST') {
    const e = { id: rid(), name: String(b.name || '').trim() || 'مزوّد', kind: b.kind === 'anthropic' ? 'anthropic' : 'openai', base: String(b.base || '').trim().replace(/\/+$/, ''), key: String(b.key || '').trim(), model: String(b.model || '').trim(), rpm: Math.max(1, Math.min(600, +b.rpm || 20)) };
    if (!okUrl(e.base)) return { status: 422, body: { code: 'bad_url', message: 'عنوان المزوّد يجب أن يبدأ بـ https:// (أو يكون localhost).' } };
    if (!e.model) return { status: 422, body: { code: 'bad_model', message: 'اسم النموذج مطلوب.' } };
    if (!e.key && !/localhost|127\.0\.0\.1/.test(e.base)) return { status: 422, body: { code: 'bad_key', message: 'المفتاح مطلوب.' } };
    saveEps([...loadEps(), e]); return { body: loadEps().map(epOut) };
  }
  let m = path.match(/^\/api\/llm\/endpoints\/(\w+)$/); if (m && method === 'DELETE') { saveEps(loadEps().filter((e) => e.id !== m[1])); return { body: loadEps().map(epOut) }; }
  if (path === '/api/llm/discover' && method === 'POST') {          // which models can this key use? (so nobody types model names)
    const kind = b.kind === 'anthropic' ? 'anthropic' : 'openai', base = String(b.base || '').trim().replace(/\/+$/, ''), key = String(b.key || '').trim();
    if (!okUrl(base)) return { status: 422, body: { code: 'bad_url', message: 'عنوان المزوّد يجب أن يبدأ بـ https:// (أو يكون localhost).' } };
    if (!key && !/localhost|127\.0\.0\.1/.test(base)) return { status: 422, body: { code: 'bad_key', message: 'المفتاح مطلوب.' } };
    try { const ids = await LLMPool.listModels({ kind, base, key }); return { body: { models: ids.slice(0, 300), suggested: pickModel(kind, base, ids) } }; }
    catch (err) { return { status: 400, body: { code: err.code || 'error', message: err.message } }; }
  }
  if (path === '/api/llm/test' && method === 'POST') {
    const e = loadEps().find((x) => x.id === b.id); if (!e) return { status: 404, body: { code: 'not_found', message: 'المزوّد غير موجود.' } };
    try { const r = await new LLMPool([], {}).test(e); return { body: { ok: r.ok, ms: r.ms } }; } catch (err) { return { status: 400, body: { code: err.code || 'error', message: err.message } }; }
  }
  return null;
}

window.QZ_HOST = {
  platform, store, llm, auth, handle, requireAuth: useSb, printPdf: true, generatorLabel: 'ذكي (بمفتاح المستخدم)',
  get concurrency() { return Math.min(6, Math.max(2, pool().size * 2)); },
  aiMissingMessage: 'لم يُربط الذكاء الاصطناعي بعد: الصق مفتاحًا مجانيًا مرة واحدة من صفحة «ربط الذكاء الاصطناعي».',
  async capabilities(pl) { return { edition: 'web', accounts: useSb ? 'supabase' : 'device', password_reset: useSb, byok: true, shared_ai: SHARED.length > 0, ai_label: 'ذكي (بمفتاحك الخاص)', local: !useSb, print_pdf: true, registration: 'open' }; },
  bannerText: (p) => (p.mode === 'device' ? 'وضع الجهاز: لا توجد حسابات سحابية في هذا الموقع بعد، فبياناتك محفوظة في هذا المتصفح فقط. PDF عبر زر الطباعة.' : ''),
};
})();
