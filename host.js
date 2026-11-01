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
const GUEST_KEY = 'quizzy_guest_flag_v2';      // not the flag of earlier builds ('quizzy_guest_v1'): left in a browser that once pressed "guest", it would open the site as a guest by itself and never ask who you are - it is ignored and removed below. (The guest's STORE keeps its old name: 'quizzy_guest_v1', so what a guest made is still there.)
try { localStorage.removeItem('quizzy_guest_v1'); } catch { /* storage blocked */ }
const isGuest = () => { try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; } };
const setGuest = (on) => { try { if (on) localStorage.setItem(GUEST_KEY, '1'); else localStorage.removeItem(GUEST_KEY); } catch { /* storage blocked */ } };
const guestUser = { id: 'guest', email: '', name: 'ضيف', role: 'student', guest: true };

// ---- accounts on THIS device: the site has no cloud yet, so an account is an e-mail + a password kept in this browser only. It is a real account where it matters on a shared computer (its own space, a
// password at the door) but there is no server: it does not follow the person to another device and a forgotten password cannot be recovered. With Supabase configured (config.js) the very same forms
// use the cloud instead. The password is never stored: only a salted PBKDF2-SHA256 hash.
const ACC_KEY = 'quizzy_acc_v1', LEGACY_DB = 'quizzy_web_v1';      // LEGACY_DB: what this site kept on the device before accounts existed - the FIRST account adopts it, so nothing already made is lost
const readAccs = () => { try { const j = JSON.parse(localStorage.getItem(ACC_KEY) || 'null'); if (j && j.accounts && typeof j.accounts === 'object') return j; } catch { /* unreadable: start empty */ } return { accounts: {}, current: null }; };
const writeAccs = (a) => { try { localStorage.setItem(ACC_KEY, JSON.stringify(a)); } catch { throw new DeviceErr('يمنع المتصفح الحفظ هنا، فلا يمكن إنشاء حساب على هذا الجهاز.', 500, 'storage_blocked'); } };
class DeviceErr extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
const emailKey = (e) => String(e || '').trim().toLowerCase();
const bytesToB64 = (u8) => { let t = ''; u8.forEach((c) => { t += String.fromCharCode(c); }); return btoa(t); };
const b64ToBytes = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const PBKDF2_ITER = 150000;
async function hashPassword(password, salt, iter = PBKDF2_ITER) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256)); }
const sameBytes = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
async function passwordOk(acc, password) { try { return sameBytes(await hashPassword(password, b64ToBytes(acc.salt), acc.iter), b64ToBytes(acc.hash)); } catch { return false; } }
const accUser = (acc) => ({ id: acc.id, email: acc.email, name: acc.name || acc.email.split('@')[0], role: 'student' });
const currentAcc = () => { const A = readAccs(); return A.current && A.accounts[A.current] ? A.accounts[A.current] : null; };
const STORES = new Map();
async function openStore(name) { if (!STORES.has(name)) { let st; try { st = await idbStore(name); } catch { st = new Mem(); } STORES.set(name, st); } return STORES.get(name); }
async function platform() {
  const aiAvailable = allEps().length > 0;
  if (!useSb) {
    const acc = currentAcc(); if (acc) { if (isGuest()) setGuest(false); return { signedIn: true, user: accUser(acc), aiAvailable, mode: 'device' }; }
    return isGuest() ? { signedIn: true, user: guestUser, aiAvailable, mode: 'guest' } : { signedIn: false, user: null, aiAvailable, mode: 'device' };
  }
  if (sb.session && !sb.session.user) { try { await sb.fetchUser(); } catch { /* handled on first request */ } }
  if (sb.session && isGuest()) setGuest(false);      // a real account is never "a guest": the flag of an earlier guest visit must not outlive a sign-in (a confirmation link, a restored session) - nor bring the guest back after a sign-out
  const user = sb.session ? sb.uiUser() : null; if (!user && isGuest()) return { signedIn: true, user: guestUser, aiAvailable, mode: 'guest' };
  return { signedIn: !!user, user, aiAvailable, mode: 'supabase' };
}
async function store() {
  if (isGuest() && !(useSb && sb.session) && !(!useSb && currentAcc())) return openStore('quizzy_guest_v1');      // a guest's own store, never mixed with an account's
  if (useSb) { if (!sb.session) throw new Error('سجّل الدخول أولًا.'); return sb.store(); }
  const acc = currentAcc(); if (!acc) throw new Error('سجّل الدخول أولًا.'); return openStore(acc.db);
}

// ---- accounts (Supabase)
const fail = (e) => ({ status: e.status && e.status !== 0 ? e.status : 400, body: { code: e.code || 'error', message: e.message } });
const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof SbError) return fail(e); throw e; } };
const asFail = (e) => ({ status: e.status || 400, body: { code: e.code || 'error', message: e.message } });
const wrapDev = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof DeviceErr) return asFail(e); throw e; } };
const needEmail = (b) => { const email = String(b.email || '').trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new DeviceErr('اكتب بريدًا إلكترونيًا صحيحًا.', 422, 'validation'); return email; };
const needPassword = (pw) => { if (String(pw || '').length < 8) throw new DeviceErr('كلمة المرور ضعيفة: ٨ أحرف على الأقل.', 422, 'weak_password'); return String(pw); };
const deviceAuth = {
  guest: async () => { const A = readAccs(); A.current = null; writeAccs(A); setGuest(true); return { body: guestUser }; },
  register: wrapDev(async (b) => { const email = needEmail(b), password = needPassword(b.password), A = readAccs(), key = emailKey(email);
    if (A.accounts[key]) throw new DeviceErr('هذا البريد مسجّل مسبقًا على هذا الجهاز: سجّل الدخول.', 409, 'user_already_exists');
    const id = rid() + rid(), salt = crypto.getRandomValues(new Uint8Array(16)), first = !Object.keys(A.accounts).length;
    A.accounts[key] = { id, email, name: String(b.name || '').trim().slice(0, 60), salt: bytesToB64(salt), iter: PBKDF2_ITER, hash: bytesToB64(await hashPassword(password, salt)), db: first ? LEGACY_DB : 'quizzy_acc_' + id, created: Date.now() };
    A.current = key; writeAccs(A); setGuest(false); return { body: accUser(A.accounts[key]) }; }),
  login: wrapDev(async (b) => { const A = readAccs(), key = emailKey(b.email), acc = A.accounts[key];
    if (!acc || !(await passwordOk(acc, b.password))) throw new DeviceErr('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 400, 'invalid_credentials');
    A.current = key; writeAccs(A); setGuest(false); return { body: accUser(acc) }; }),
  logout: async () => { const A = readAccs(); A.current = null; writeAccs(A); setGuest(false); return { body: { ok: true } }; },
  password: wrapDev(async (b) => { const A = readAccs(), acc = A.current && A.accounts[A.current];
    if (!acc || !(await passwordOk(acc, b.current_password))) throw new DeviceErr('كلمة المرور الحالية غير صحيحة.', 400, 'invalid_credentials');
    const next = needPassword(b.new_password); if (next === String(b.current_password)) throw new DeviceErr('كلمة المرور الجديدة مطابقة للقديمة.', 422, 'same_password');
    const salt = crypto.getRandomValues(new Uint8Array(16)); acc.salt = bytesToB64(salt); acc.iter = PBKDF2_ITER; acc.hash = bytesToB64(await hashPassword(next, salt)); writeAccs(A); return { body: { ok: true } }; }),
  delete: wrapDev(async (b, pl) => { if (pl && pl.mode === 'guest') { const st = await store(); if (st.clear) await st.clear(); return { body: { ok: true } }; }      // a guest wipes the data of this device; there is no account to delete
    const A = readAccs(), acc = A.current && A.accounts[A.current];
    if (!acc || !(await passwordOk(acc, b.password))) throw new DeviceErr('كلمة المرور غير صحيحة.', 400, 'invalid_credentials');
    const st = await openStore(acc.db); if (st.clear) await st.clear(); delete A.accounts[A.current]; A.current = null; writeAccs(A); return { body: { ok: true } }; }),
};
const auth = !useSb ? deviceAuth : {
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

// ---- accounts: is the cloud ready? (the operator's "check" button). Nothing is written and no key is ever shown.
async function accountsCheck() {
  const steps = []; const add = (id, ok, text) => steps.push({ id, ok, text });
  if (sb.secretKey) { add('key', false, 'المفتاح الموضوع في الإعدادات سرّي (service_role): أُوقفت الحسابات. ضع مفتاح anon العام بدلًا منه، وأبطل السرّي من لوحة Supabase (Project Settings > API) لأنه صار مكشوفًا.'); return { steps }; }
  if (!useSb) { add('config', false, (sb.url || sb.anon) ? 'الإعداد ناقص: يلزم عنوان المشروع ومفتاحه العام معًا.' : 'الحسابات السحابية غير مفعّلة: لم يُضبط عنوان المشروع ولا مفتاحه العام (حسابات الموقع الآن على الجهاز فقط).'); return { steps }; }
  const call = async (path, opt = {}) => { const r = await fetch(sb.url + path, { ...opt, headers: { apikey: sb.anon, authorization: 'Bearer ' + sb.anon, ...(opt.headers || {}) } }); let j = null; try { j = await r.json(); } catch { /* empty */ } return { status: r.status, body: j }; };
  let settings = null;
  try { const r = await call('/auth/v1/settings');
    if (r.status === 401 || r.status === 403) { add('key', false, 'المشروع رفض المفتاح: انسخ مفتاح anon العام من Project Settings > API (لا service_role).'); return { steps }; }
    if (r.status !== 200) { add('reach', false, `المشروع لم يستجب كما يجب (${r.status}): تحقق من عنوانه.`); return { steps }; }
    settings = r.body || {}; add('reach', true, 'المشروع يستجيب والمفتاح العام مقبول.'); }
  catch { add('reach', false, 'تعذّر الوصول إلى عنوان المشروع: تحقق من العنوان ومن الإنترنت.'); return { steps }; }
  const emailOn = !(settings.external && settings.external.email === false), open = !settings.disable_signup;
  add('signup', emailOn && open, emailOn && open ? 'التسجيل بالبريد وكلمة المرور مفتوح.' : 'التسجيل بالبريد مغلق: فعّل مزوّد Email وأوقف «Disable signups» (Authentication > Providers / Sign In).');
  add('confirm', true, settings.mailer_autoconfirm ? 'تأكيد البريد معطّل: يدخل المسجَّل فورًا.' : 'تأكيد البريد مفعّل: تصل المسجَّل رسالة رابط. بريد Supabase الافتراضي محدود بعدد قليل من الرسائل في الساعة؛ للاستخدام الحقيقي اربط SMTP خاصًا أو أوقف التأكيد.');
  try { const r = await call('/rest/v1/kv?select=k&limit=1'); add('schema', r.status !== 404, r.status !== 404 ? 'جدول البيانات موجود (والحماية بالصف تحجب بيانات غيرك).' : 'جدول البيانات غير موجود: شغّل ملف supabase/schema.sql في SQL Editor.'); }
  catch { add('schema', false, 'تعذّر فحص جدول البيانات.'); }
  try { const r = await call('/rest/v1/rpc/delete_my_account', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); add('erase', r.status !== 404, r.status !== 404 ? 'حذف الحساب (حق المحو) جاهز.' : 'دالة حذف الحساب غير موجودة: أعد تشغيل supabase/schema.sql كاملًا.'); }
  catch { add('erase', false, 'تعذّر فحص دالة حذف الحساب.'); }
  try { add('host', true, 'عنوان المشروع: ' + new URL(sb.url).host); } catch { /* shown above */ }
  return { steps };
}

// ---- /api/llm/* : manage and test the user's provider keys
async function handle(method, path, qs, b) {
  if (path === '/api/operator' && method === 'POST') { setOperator(!!(b && b.on)); return { body: { operator: isOperator() } }; }
  if (path === '/api/accounts/status' || path === '/api/accounts/check') {
    if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'فحص الحسابات لصاحب الموقع فقط.' } };
    if (path === '/api/accounts/status') { let host = ''; try { host = new URL(sb.url).host; } catch { /* not a URL */ } return { body: { configured: useSb, secret_key: !!sb.secretKey, host, half: !useSb && !sb.secretKey && !!(sb.url || sb.anon) } }; }
    return { body: await accountsCheck() };
  }
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
  platform, store, llm, auth, handle, requireAuth: true, printPdf: true, generatorLabel: 'ذكاء اصطناعي',
  get concurrency() { return Math.min(8, Math.max(2, pool().width)); },
  aiMissingMessage: 'الإنشاء يعمل الآن بدون ذكاء اصطناعي (محليًا على جهازك).',
  async capabilities(pl) { const guest = !!(pl && pl.mode === 'guest'); return { edition: 'web', accounts: useSb && !guest ? 'supabase' : 'device', cloud_accounts: useSb, guest: true, can_register: true, password_reset: useSb, byok: isOperator(), operator: isOperator(), relay: !!relayBase, shared_ai: SHARED.length > 0, ai_label: 'ذكاء اصطناعي', ai_missing: '', local: !useSb || guest, print_pdf: true, registration: 'open' }; },
  bannerText: () => '',      // the guest notice (no account, nothing guaranteed) is drawn by the page itself
};
})();
