/* Quizzy · web edition host (GitHub Pages / any static hosting).
 *   accounts : Supabase (email + password, email links, RLS-isolated storage) when static-edition/config.js is filled; otherwise device-only
 *   generation: LOCAL by default (claude-edition/rules.js, in the browser). When config.js `relay` points at the Cloudflare Worker (relay/cloudflare-worker.mjs)
 *               that holds a free Gemini key server-side, every visitor gets AI-written quizzes with no key in the site; it falls back to local on any failure
 *   PDF      : browser print view (#/print/<quiz>) -> "Save as PDF"  (correct Arabic shaping for free) */
(() => {
const { Mem, idbStore } = window.QZ_STORES; const { SupabaseClient, SbError } = window.QZ_SB;
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
// ---- the composer's OPEN on-device model, for EVERY browser (Safari, Firefox, Chrome, phones): transformers.js running all-MiniLM-L6-v2 in WebAssembly, the files
// served by this site (vendor/semantic, fetched by scripts/fetch_semantic.sh) - no key, no server, nothing leaves the device. Loaded when a quiz is made (in parallel with
// the writing; never on a data-saver connection unless the operator asks), then kept by the browser. The composer (rules.js SEMANTIC) uses it to read MEANING.
window.QZ_SEMANTIC_PROVIDER = (() => {
  const BASE = new URL('./vendor/semantic/', location.href).href, MODEL = 'Xenova/all-MiniLM-L6-v2', SEEN = 'qz_semantic_ok_v1';
  let pipe = null, loading = null, missing = null, progress = 0, loadMs = null, err = null;
  const saveData = () => { try { return !!(navigator.connection && navigator.connection.saveData); } catch { return false; } };
  async function deployed() { if (missing !== null) return !missing; try { const r = await fetch(BASE + 'models/' + MODEL + '/config.json', { method: 'HEAD' }); missing = !r.ok; } catch { missing = true; } return !missing; }
  function load(opts = {}) {
    if (pipe) return Promise.resolve(pipe); if (loading) return loading;
    if (opts.auto && saveData()) return Promise.reject(new Error('save-data'));
    const t0 = performance.now();
    loading = (async () => {
      if (!(await deployed())) throw new Error('missing');
      const T = await import(BASE + 'transformers.min.js');
      T.env.allowLocalModels = true; T.env.allowRemoteModels = false; T.env.localModelPath = BASE + 'models/'; T.env.useBrowserCache = true;
      T.env.backends.onnx.wasm.wasmPaths = BASE; T.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const files = {}; const p = await T.pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm', progress_callback: (e) => { if (e && e.file && e.total) { files[e.file] = [e.loaded || 0, e.total]; const v = Object.values(files); progress = Math.round(100 * v.reduce((a, x) => a + x[0], 0) / Math.max(1, v.reduce((a, x) => a + x[1], 0))); } } });
      pipe = p; progress = 100; loadMs = Math.round(performance.now() - t0); err = null; try { localStorage.setItem(SEEN, String(Date.now())); } catch { /* private mode */ } return p;
    })();
    loading.catch((e) => { err = String((e && e.message) || e); loading = null; });
    return loading;
  }
  async function embed(texts) { const p = await load({ auto: false }); const out = await p(texts, { pooling: 'mean', normalize: true }); return out.tolist(); }
  async function status() {
    if (pipe) return { state: 'available', model: MODEL, engine: 'wasm', load_ms: loadMs };
    if (loading) return { state: 'downloading', progress, model: MODEL };
    if (!(await deployed())) return { state: 'missing', model: MODEL };
    let seen = null; try { seen = localStorage.getItem(SEEN); } catch { /* private mode */ }
    return { state: seen ? 'ready' : 'downloadable', model: MODEL, save_data: saveData(), error: err };
  }
  return { load, embed, status, MODEL };
})();

// Chrome's built-in model (Prompt API) is stable on websites since Chrome 148 and needs no token; a config.js `chromeAiToken` (an origin-trial token, public by nature) is
// still honoured if one is ever set, for a future Chrome trial
if (CFG.chromeAiToken) { try { const m = document.createElement('meta'); m.httpEquiv = 'origin-trial'; m.content = String(CFG.chromeAiToken); document.head.append(m); } catch { /* no head yet */ } }

// ---- AI generation for EVERY visitor, with the key kept OFF the site. config.js `relay` is the address of a Cloudflare Worker (relay/cloudflare-worker.mjs)
// that holds a FREE Gemini key SERVER-side and forwards to Gemini; the site sends only the lecture text and never has the key. When `relay` is empty, or
// the relay / the free daily quota fails, every quiz is built locally instead (the engine's own fallback), so no visitor is ever blocked. Setup: docs/SETUP-AI.md.
const AI = (() => {
  const base = (() => { try { const u = new URL(String(CFG.relay || '')); return (u.protocol === 'https:' || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u.href)) ? u.origin : ''; } catch { return ''; } })();
  const model = String(CFG.relayModel || 'gemini-2.0-flash');
  const MAXTOK = { generate: 8000, cards: 4000, analyze: 4000, profile: 3000, verify: 2500, verify_explanation: 2000, correction: 800, tutor: 1200, similar: 1500 };
  const TEMP = { generate: 0.4, correction: 0.5, cards: 0.3, tutor: 0.4, similar: 0.5 };
  const coded = (code, message, fallback) => Object.assign(new Error(message), { code, fallback: !!fallback });
  function extractJson(text) {
    const t = String(text == null ? '' : text).trim(); if (!t) throw coded('bad_json', 'النموذج لم يُرجع نصًا.');
    const b = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(b); } catch { /* the model wrapped the JSON in prose: take the first balanced value */ }
    const s = b.search(/[[{]/); if (s < 0) throw coded('bad_json', 'لا JSON في رد النموذج.');
    const open = b[s], close = open === '{' ? '}' : ']'; let depth = 0, str = false, esc = false;
    for (let i = s; i < b.length; i++) { const ch = b[i];
      if (str) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') str = false; continue; }
      if (ch === '"') str = true; else if (ch === open) depth++; else if (ch === close && !--depth) { try { return JSON.parse(b.slice(s, i + 1)); } catch { throw coded('bad_json', 'JSON غير صالح من النموذج.'); } } }
    throw coded('bad_json', 'JSON ناقص من النموذج.');
  }
  async function json(task, system, prompt) {
    const sys = String(system || '') + '\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.';
    const body = { model, max_tokens: MAXTOK[task] || 4000, temperature: TEMP[task] != null ? TEMP[task] : 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: String(prompt || '') }] };
    let res;
    try { res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw coded('network', 'تعذّر الاتصال بوسيط الذكاء الاصطناعي.', true); }
    if (!res.ok) {
      const code = res.status === 429 ? 'rate_limited' : res.status === 413 ? 'too_large' : (res.status === 401 || res.status === 403) ? 'auth' : res.status === 400 ? 'bad_request' : res.status === 500 ? 'llm_not_configured' : 'llm_error';
      let msg = 'خطأ في خدمة التوليد (' + res.status + ').'; try { const j = await res.json(); if (j && j.error && j.error.message) msg = 'خطأ في خدمة التوليد: ' + String(j.error.message).slice(0, 200); } catch { /* keep the status message */ }
      throw coded(code, msg, code !== 'bad_request');
    }
    let data; try { data = await res.json(); } catch { throw coded('bad_json', 'رد غير صالح من الوسيط.'); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    return extractJson(content);
  }
  return { on: !!base, base, model, llm: base ? { json, scale: () => 1 } : null, label: 'Gemini (عبر وسيط الموقع)' };
})();

// ---- operator mode (this device): the operator's page (#/operator, unlisted): the accounts check, the composer's reports and Chrome's built-in model.
const OP_KEY = 'quizzy_operator_v1';
const isOperator = () => { try { return localStorage.getItem(OP_KEY) === '1'; } catch { return false; } };
const setOperator = (on) => { try { if (on) localStorage.setItem(OP_KEY, '1'); else localStorage.removeItem(OP_KEY); } catch { /* storage blocked */ } };
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
  const aiAvailable = AI.on;      // AI-written quizzes when the site's relay (free Gemini key) is set; otherwise every quiz is made locally
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

// ---- the operator's routes: operator mode, the accounts check, the composer's reports, Chrome's built-in model
async function handle(method, path, qs, b) {
  if (path === '/api/operator' && method === 'POST') { setOperator(!!(b && b.on)); return { body: { operator: isOperator() } }; }
  if (path === '/api/accounts/status' || path === '/api/accounts/check') {
    if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'فحص الحسابات لصاحب الموقع فقط.' } };
    if (path === '/api/accounts/status') { let host = ''; try { host = new URL(sb.url).host; } catch { /* not a URL */ } return { body: { configured: useSb, secret_key: !!sb.secretKey, host, half: !useSb && !sb.secretKey && !!(sb.url || sb.anon) } }; }
    return { body: await accountsCheck() };
  }
  if (path === '/api/semantic' || path === '/api/semantic/prepare' || path === '/api/semantic/try') {      // the composer's open model on this device (every browser)
    if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'هذه البطاقة لصاحب الموقع فقط.' } };
    const P = window.QZ_SEMANTIC_PROVIDER, Sm = window.QZE && window.QZE.rules && window.QZE.rules.semantic;
    try {
      if (path === '/api/semantic/prepare' && method === 'POST') { await P.load({ auto: false }); return { body: await P.status() }; }
      if (path === '/api/semantic/try' && method === 'POST') { const r = await Sm.demo(); return { body: { ...r, status: await P.status() } }; }
    } catch (e) { return { status: 422, body: { code: 'semantic', message: String((e && e.message) || e) } }; }
    return { body: { ...(await P.status()), last: Sm ? Sm.last() : null, thresholds: Sm ? Sm.thresholds : null } };
  }
  if (path === '/api/chrome-ai' || path === '/api/chrome-ai/prepare') {      // the composer's zero-cost AI: the model built into this browser (Chrome's on-device model)
    if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'هذه البطاقة لصاحب الموقع فقط.' } };
    const A = window.QZE && window.QZE.rules && window.QZE.rules.chromeAi; if (!A) return { status: 503, body: { code: 'unavailable', message: 'غير محمّل.' } };
    if (path === '/api/chrome-ai/prepare' && method === 'POST') { try { return { body: await A.prepare() }; } catch (e) { return { status: 422, body: { code: 'chrome_ai', message: String((e && e.message) || e) } }; } }
    return { body: { ...(await A.status()), token: !!CFG.chromeAiToken } };
  }
  if (path === '/api/llm/relay-status' && method === 'GET') {      // the operator's view: is the site's AI relay set up and reachable? (its status page never shows a secret)
    if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'هذه البطاقة لصاحب الموقع فقط.' } };
    if (!AI.on) return { body: { configured: false } };
    try { const r = await fetch(AI.base + '/'); const j = await r.json(); return { body: { configured: true, reachable: r.ok, key_set: !!j.key_set, origin_set: !!j.origin_set, origin_ok: j.origin_ok !== false, allowed_origins: j.allowed_origins || [], models: j.models || [], model: AI.model } }; }
    catch { return { body: { configured: true, reachable: false, address: AI.base } }; }
  }
  if (path === '/api/composer/reports' || path === '/api/composer/reports/reset') {      // what the composer (claude-edition/rules.js COMPOSER) did with the students' reports on this device
    if (!isOperator()) return { status: 403, body: { code: 'operator_only', message: 'بلاغات وكيل الصياغة لصاحب الموقع فقط.' } };
    const C = window.QZE && window.QZE.rules && window.QZE.rules.composer; if (!C) return { status: 503, body: { code: 'unavailable', message: 'وكيل الصياغة غير محمّل.' } };
    if (path === '/api/composer/reports/reset' && method === 'POST') return { body: C.resetReports() };
    if (method === 'GET') return { body: C.reports() };
  }
  return null;
}

window.QZ_HOST = {
  platform, store, llm: AI.llm, auth, handle, requireAuth: true, printPdf: true, generatorLabel: AI.on ? AI.label : 'المولّد المحلي',
  ocrBase: new URL('vendor/ocr/', document.baseURI).href,      // scanned pages are read in the browser (scripts/fetch_ocr.sh puts the files there at build time)
  concurrency: 3,
  aiMissingMessage: '',
  async capabilities(pl) { const guest = !!(pl && pl.mode === 'guest'); return { edition: 'web', accounts: useSb && !guest ? 'supabase' : 'device', cloud_accounts: useSb, guest: true, can_register: true, password_reset: useSb, byok: false, operator: isOperator(), relay: AI.on, shared_ai: AI.on, ai: AI.on, ai_label: AI.on ? AI.label : '', ai_missing: '', local: true, print_pdf: true, registration: 'open' }; },
  bannerText: () => '',      // the guest notice (no account, nothing guaranteed) is drawn by the page itself
};
})();
