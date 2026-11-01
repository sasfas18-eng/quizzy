// node static-edition/test/supabase_client.test.js — the browser Supabase client against the fake server.
global.window = {}; const { SupabaseClient, SbError } = require('../../shared/supabase.js'); const { start } = require('./fake_supabase.js'); const assert = require('assert');
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => (m[k] = v), removeItem: (k) => delete m[k] }; };
(async () => {
  const srv = await start({ confirmEmail: false }); const mk = (storage = mem()) => new SupabaseClient({ url: srv.url, anonKey: srv.anonKey, storage });
  // ---- accounts
  const a = mk(); assert.strictEqual(a.configured, true);
  let r = await a.signUp({ email: 'a@x.com', password: 'password-1', name: 'Ali' }); assert.strictEqual(r.pendingConfirmation, false); assert.strictEqual(a.uiUser().name, 'Ali');
  await assert.rejects(() => mk().signUp({ email: 'a@x.com', password: 'password-1', name: 'x' }), (e) => e instanceof SbError && /مسجّل مسبقًا/.test(e.message));
  await assert.rejects(() => mk().signUp({ email: 'w@x.com', password: '123', name: 'x' }), (e) => /ضعيفة/.test(e.message));
  await assert.rejects(() => mk().signIn({ email: 'a@x.com', password: 'wrong' }), (e) => /غير صحيحة/.test(e.message));
  const b = mk(); await b.signUp({ email: 'b@x.com', password: 'password-2', name: 'Bea' });

  // ---- storage: each account sees only its own rows; batching; kinds
  const sa = a.store(), sb = b.store();
  await sa.set('quiz_1', { kind: 'quiz', id: '1', title: 'A quiz' }); await sa.setMany([['page_d_1', { kind: 'page', text: 'p1' }], ['page_d_2', { kind: 'page', text: 'p2' }]]);
  assert.strictEqual((await sa.get('quiz_1')).title, 'A quiz'); assert.deepStrictEqual(Object.keys(await sa.getMany(['page_d_1', 'page_d_2', 'nope'])).sort(), ['page_d_1', 'page_d_2']);
  assert.deepStrictEqual((await sa.list('quiz')).map((x) => x.id), ['1']); assert.strictEqual(await sb.get('quiz_1'), null, "B cannot read A's row"); assert.deepStrictEqual(await sb.list('quiz'), []);
  await sb.set('quiz_1', { kind: 'quiz', id: 'B1', title: 'B quiz' }); assert.strictEqual((await sa.get('quiz_1')).title, 'A quiz', 'same key, independent rows');
  await sa.delMany(['page_d_1', 'page_d_2']); assert.deepStrictEqual(await sa.getMany(['page_d_1']), {}); await sa.del('quiz_1'); assert.strictEqual(await sa.get('quiz_1'), null); assert.strictEqual((await sb.get('quiz_1')).title, 'B quiz');
  // a forged row owner is refused (what RLS WITH CHECK does)
  await assert.rejects(() => a._req('/rest/v1/kv', { method: 'POST', body: { user_id: b.user.id, k: 'plant', kind: 'quiz', data: {} } }), (e) => e.status === 403);

  // ---- session persistence + automatic refresh
  const store = mem(); const c = mk(store); await c.signIn({ email: 'a@x.com', password: 'password-1' }); const c2 = mk(store); assert.strictEqual(c2.uiUser().email, 'a@x.com', 'session restored from storage');
  srv.expireAll(); c2.session.expires_at = 0; const before = srv.stats.refreshes; await c2.store().set('k1', { kind: 'doc' }); assert.strictEqual(srv.stats.refreshes, before + 1, 'expired token refreshed transparently'); assert.deepStrictEqual((await c2.store().list('doc')).length, 1);
  srv.expireAll(); await c2.store().get('k1'); // server says expired while client thinks valid => 401 => refresh => retry
  // ---- password change, other sessions, recovery, deletion
  const d = mk(); await d.signIn({ email: 'b@x.com', password: 'password-2' }); await d.updatePassword('new-password-3'); await assert.rejects(() => mk().signIn({ email: 'b@x.com', password: 'password-2' }));
  await mk().signIn({ email: 'b@x.com', password: 'new-password-3' }); await assert.rejects(() => d.updatePassword('new-password-3'), (e) => /مطابقة/.test(e.message));
  await a.recover('b@x.com', 'https://site/'); const tok = srv.recoveryToken('b@x.com'); assert(tok); await mk().updatePassword('after-reset-4', tok); await mk().signIn({ email: 'b@x.com', password: 'after-reset-4' });
  const del = mk(); await del.signIn({ email: 'b@x.com', password: 'after-reset-4' }); await del.deleteAccount(); assert.strictEqual(del.session, null); await assert.rejects(() => mk().signIn({ email: 'b@x.com', password: 'after-reset-4' }));
  await del.signOut();
  // ---- fragments from email links
  assert.deepStrictEqual(SupabaseClient.parseFragment('#access_token=AT&refresh_token=RT&expires_in=3600&type=recovery').type, 'recovery'); assert.strictEqual(SupabaseClient.parseFragment('#/files'), null);
  assert.strictEqual(SupabaseClient.parseFragment('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid').error, 'Email link is invalid');
  // ---- not configured
  await assert.rejects(() => new SupabaseClient({}).signIn({ email: 'x', password: 'y' }), (e) => e.code === 'not_configured');
  await srv.close();
  // ---- email confirmation flow
  const s2 = await start({ confirmEmail: true }); const m2 = new SupabaseClient({ url: s2.url, anonKey: s2.anonKey, storage: mem() });
  r = await m2.signUp({ email: 'c@x.com', password: 'password-1', name: 'Cy' }); assert.strictEqual(r.pendingConfirmation, true); await assert.rejects(() => m2.signIn({ email: 'c@x.com', password: 'password-1' }), (e) => /لم يُؤكَّد/.test(e.message));
  await assert.rejects(() => new SupabaseClient({ url: s2.url, anonKey: s2.anonKey, storage: mem() }).signUp({ email: 'c@x.com', password: 'password-1', name: 'Cy' }), (e) => /مسجّل مسبقًا/.test(e.message));
  s2.confirm('c@x.com'); await m2.signIn({ email: 'c@x.com', password: 'password-1' }); assert.strictEqual(m2.uiUser().name, 'Cy'); await s2.close();
  // a PUBLIC key only: a service_role / secret key put into a static site by mistake switches accounts OFF (it would hand the whole database to every visitor)
  { const jwt = (role) => { const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return e({ alg: 'HS256', typ: 'JWT' }) + '.' + e({ iss: 'supabase', ref: 'abcd', role }) + '.' + 'x'.repeat(43); };
    const errors = []; const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
    try { const mk = (anonKey) => new SupabaseClient({ url: 'https://abcd.supabase.co', anonKey, storage: mem() });
      assert.strictEqual(mk(jwt('anon')).configured, true, 'the anon key works'); assert.strictEqual(mk('sb_publishable_' + 'A1b2C3d4'.repeat(3)).configured, true, 'a publishable key works'); assert.strictEqual(errors.length, 0);
      assert.strictEqual(mk(jwt('service_role')).configured, false, 'a service_role key switches accounts off'); assert.strictEqual(mk('sb_secret_' + 'a'.repeat(30)).configured, false, 'a secret key too');
      assert.strictEqual(errors.length, 2, 'loudly: ' + errors.join(' | ')); assert(/NOT a public key/.test(errors[0]));
      await assert.rejects(() => mk(jwt('service_role')).signIn({ email: 'a@x.com', password: 'password-1' }), (e) => e.code === 'not_configured', 'and nothing is sent with it');
      assert.strictEqual(mk('opaque-key-that-is-not-a-jwt').configured, true, 'an unreadable key is left for the server to judge'); }
    finally { console.error = orig; } }
  console.log('supabase client tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
