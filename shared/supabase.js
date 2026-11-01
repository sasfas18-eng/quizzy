/* Quizzy — minimal Supabase client (no SDK): email/password accounts (GoTrue) + per-user JSONB storage (PostgREST + RLS).
 * Only the PUBLIC anon key is used in the browser; isolation between students is enforced by the database (supabase/schema.sql),
 * not by this code. Works in browsers and in Node (tests). */
(() => {
class SbError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
const AR = { invalid_credentials: 'البريد أو كلمة المرور غير صحيحة.', invalid_grant: 'البريد أو كلمة المرور غير صحيحة.', email_not_confirmed: 'لم يُؤكَّد بريدك بعد؛ افتح رسالة التأكيد المرسلة إلى بريدك.',
  user_already_exists: 'هذا البريد مسجّل مسبقًا.', email_exists: 'هذا البريد مسجّل مسبقًا.', weak_password: 'كلمة المرور ضعيفة؛ استخدم ٨ أحرف على الأقل بخليط من الحروف والأرقام.',
  over_email_send_rate_limit: 'تجاوز الموقع حدّ رسائل البريد المسموح مؤقتًا؛ حاول بعد قليل.', over_request_rate_limit: 'محاولات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.',
  signup_disabled: 'التسجيل غير متاح حاليًا.', validation_failed: 'بيانات غير صالحة.', same_password: 'كلمة المرور الجديدة مطابقة للقديمة.', otp_expired: 'انتهت صلاحية الرابط؛ اطلب رابطًا جديدًا.',
  session_not_found: 'انتهت الجلسة؛ سجّل الدخول مجددًا.', refresh_token_not_found: 'انتهت الجلسة؛ سجّل الدخول مجددًا.' };
const errOf = (body, status) => { const code = (body && (body.error_code || body.code || body.error)) || ''; const raw = (body && (body.msg || body.error_description || body.message)) || '';
  const m = AR[code] || (/invalid login credentials/i.test(raw) ? AR.invalid_credentials : null) || (/already registered/i.test(raw) ? AR.user_already_exists : null) || (/not confirmed/i.test(raw) ? AR.email_not_confirmed : null) || raw || `خطأ من الخادم (${status})`;
  return new SbError(m, status, code); };

/** A static site can only hold a PUBLIC key (the anon / publishable one: Row Level Security is what protects the data). A service_role / secret key put here by mistake would hand the whole database to every
 *  visitor, so a client given one is switched off (with a loud console error) instead of working. */
const isSecretKey = (k) => { k = String(k || ''); if (/^sb_secret_/.test(k)) return true; const m = k.split('.');
  if (m.length === 3) { try { const p = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))); return !!(p && p.role && p.role !== 'anon'); } catch { /* not a readable JWT: the server will judge it */ } } return false; };

class SupabaseClient {
  constructor({ url, anonKey, storage, fetch: f, now } = {}) {
    this.url = String(url || '').replace(/\/+$/, ''); this.anon = anonKey || ''; this.secretKey = isSecretKey(this.anon);
    if (this.secretKey && typeof console !== 'undefined') console.error('Quizzy: the Supabase key in config.js is NOT a public key (service_role / secret): accounts are switched off. Put the anon / publishable key there and revoke the one that was exposed.'); this.f = f || ((...a) => fetch(...a));
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem() {}, removeItem() {} }); this.now = now || (() => Date.now() / 1000);
    this.KEY = 'quizzy_sb_session_v1'; this._s = undefined; this._refreshing = null;
  }
  get configured() { return !!(this.url && this.anon) && !this.secretKey; }
  // ---- session
  get session() { if (this._s === undefined) { try { this._s = JSON.parse(this.storage.getItem(this.KEY)); } catch { this._s = null; } } return this._s; }
  _save(s) { this._s = s; try { if (s) this.storage.setItem(this.KEY, JSON.stringify(s)); else this.storage.removeItem(this.KEY); } catch { /* storage blocked: memory only */ } }
  _fromTokens(t) { return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at || (this.now() + (+t.expires_in || 3600)), user: t.user || (this.session && this.session.user) || null }; }
  get user() { const s = this.session; return s && s.user ? s.user : null; }
  uiUser() { const u = this.user; if (!u) return null; return { id: u.id, email: u.email || '', name: (u.user_metadata && u.user_metadata.name) || (u.email || '').split('@')[0] || 'طالب', role: 'student' }; }
  async _req(path, { method = 'GET', body, auth = true, headers = {}, query, retry = true } = {}) {
    if (!this.configured) throw new SbError('الحسابات السحابية غير مفعّلة في هذا الموقع.', 0, 'not_configured');
    if (auth && this.session) await this._fresh();
    const h = { apikey: this.anon, 'content-type': 'application/json', ...headers }; h.authorization = 'Bearer ' + (auth && this.session ? this.session.access_token : this.anon);
    let r; try { r = await this.f(this.url + path + (query ? '?' + query : ''), { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new SbError('تعذّر الاتصال بخادم الحسابات. تحقق من الإنترنت.', 0, 'network'); }
    if (r.status === 401 && auth && this.session && retry && this.session.refresh_token) { try { await this.refresh(); } catch { /* fall through */ } return this._req(path, { method, body, auth, headers, query, retry: false }); }
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!r.ok) throw errOf(data, r.status);
    return data;
  }
  async _fresh() { const s = this.session; if (s && s.expires_at - 45 < this.now() && s.refresh_token) await this.refresh(); }
  async refresh() {
    if (this._refreshing) return this._refreshing; const s = this.session; if (!s || !s.refresh_token) throw new SbError('لا توجد جلسة.', 401, 'no_session');
    this._refreshing = (async () => { try { const t = await this._req('/auth/v1/token', { method: 'POST', query: 'grant_type=refresh_token', body: { refresh_token: s.refresh_token }, auth: false }); this._save(this._fromTokens(t)); return this.session; }
      catch (e) { if (e.status === 400 || e.status === 401) this._save(null); throw e; } finally { this._refreshing = null; } })();
    return this._refreshing;
  }
  // ---- accounts
  async signUp({ email, password, name }) {
    const r = await this._req('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password, data: { name } } });
    if (r && r.access_token) { this._save(this._fromTokens(r)); return { session: this.session, pendingConfirmation: false }; }
    const u = r && (r.user || r); if (u && Array.isArray(u.identities) && u.identities.length === 0) throw new SbError(AR.user_already_exists, 422, 'user_already_exists');   // anti-enumeration response for an existing address
    return { session: null, pendingConfirmation: true };
  }
  async signIn({ email, password }) { const t = await this._req('/auth/v1/token', { method: 'POST', query: 'grant_type=password', auth: false, body: { email, password } }); this._save(this._fromTokens(t)); return this.session; }
  async verifyPassword(email, password) { await this._req('/auth/v1/token', { method: 'POST', query: 'grant_type=password', auth: false, body: { email, password } }); return true; }
  async signOut(scope) { const had = this.session; try { if (had) await this._req('/auth/v1/logout', { method: 'POST', query: scope ? 'scope=' + scope : undefined, body: {}, retry: false }); } catch { /* already invalid */ } if (!scope || scope === 'global') this._save(null); }
  async recover(email, redirectTo) { await this._req('/auth/v1/recover', { method: 'POST', auth: false, query: redirectTo ? 'redirect_to=' + encodeURIComponent(redirectTo) : undefined, body: { email } }); return true; }
  async updatePassword(password, accessToken) {
    if (accessToken) { const r = await this.f(this.url + '/auth/v1/user', { method: 'PUT', headers: { apikey: this.anon, 'content-type': 'application/json', authorization: 'Bearer ' + accessToken }, body: JSON.stringify({ password }) }); const t = await r.text(); if (!r.ok) throw errOf(t ? JSON.parse(t) : {}, r.status); return true; }
    await this._req('/auth/v1/user', { method: 'PUT', body: { password } }); return true;
  }
  async fetchUser() { const u = await this._req('/auth/v1/user'); const s = this.session; if (s) this._save({ ...s, user: u }); return u; }
  async deleteAccount() { await this._req('/rest/v1/rpc/delete_my_account', { method: 'POST', body: {} }); this._save(null); }
  /** Supabase email links land on the site with the session in the URL fragment. Returns {type, session, error} (or null). */
  static parseFragment(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#\/?/, '')); if (!p.has('access_token') && !p.has('error')) return null;
    if (p.has('error')) return { type: 'error', error: p.get('error_description') || p.get('error_code') || p.get('error') };
    return { type: p.get('type') || 'signup', tokens: { access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600 } };
  }
  adoptTokens(tokens) { this._save(this._fromTokens(tokens)); return this.session; }
  // ---- per-user documents (table kv; row owner enforced by RLS)
  store() {
    const c = this, enc = encodeURIComponent, row = (k, v) => ({ user_id: c.user && c.user.id, k, kind: v.kind || 'doc', data: v }); const clean = (v) => JSON.parse(JSON.stringify(v));
    const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    return {
      async get(k) { const r = await c._req('/rest/v1/kv', { query: `select=data&k=eq.${enc(k)}&limit=1` }); return r && r[0] ? r[0].data : null; },
      async getMany(keys) { const out = {}; for (const part of chunks(keys, 60)) { const r = await c._req('/rest/v1/kv', { query: `select=k,data&k=in.(${part.map(enc).join(',')})` }); (r || []).forEach((x) => (out[x.k] = x.data)); } return out; },
      async set(k, v) { await c._req('/rest/v1/kv', { method: 'POST', query: 'on_conflict=user_id,k', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: row(k, clean(v)) }); },
      async setMany(entries) { for (const part of chunks(entries, 40)) await c._req('/rest/v1/kv', { method: 'POST', query: 'on_conflict=user_id,k', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: part.map(([k, v]) => row(k, clean(v))) }); },
      async del(k) { await c._req('/rest/v1/kv', { method: 'DELETE', query: `k=eq.${enc(k)}`, headers: { prefer: 'return=minimal' } }); },
      async delMany(keys) { for (const part of chunks(keys, 60)) await c._req('/rest/v1/kv', { method: 'DELETE', query: `k=in.(${part.map(enc).join(',')})`, headers: { prefer: 'return=minimal' } }); },
      async list(kind) { const r = await c._req('/rest/v1/kv', { query: `select=data&kind=eq.${enc(kind)}&order=updated_at.desc&limit=1000` }); return (r || []).map((x) => x.data); },
    };
  }
}
window.QZ_SB = { SupabaseClient, SbError };
if (typeof module !== 'undefined') module.exports = window.QZ_SB;
})();
