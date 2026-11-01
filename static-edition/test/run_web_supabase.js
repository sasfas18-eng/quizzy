// node static-edition/test/run_web_supabase.js <dist> <pdf> — real-accounts mode against the fake Supabase: sign-up, per-user data, isolation,
// session restore, password change, recovery link, email-confirmation link, account deletion.
const { chromium } = require('playwright'); const assert = require('assert'); const { createQuiz } = require('../../claude-edition/test/flow.js'); const { start: startLLM } = require('./mock_llm.js'); const { start: startSb } = require('./fake_supabase.js'); const serve = require('./serve.js');
const [dist, pdf] = process.argv.slice(2);
const junk = async (p, where) => { const t = ((await p.textContent('body')) || '').replace(/\s+/g, ' '); assert(!/(^| )(null|false|undefined|\[object)/.test(t), `stray text on ${where}`); };
(async () => {
  const llm = await startLLM(); const sb = await startSb({ confirmEmail: false }); const sb2 = await startSb({ confirmEmail: true });
  const cfg = (s) => `window.QZ_CONFIG={supabaseUrl:'${s.url}',supabaseAnonKey:'${s.anonKey}'};`; const site = await serve(dist, 0, cfg(sb)); const site2 = await serve(dist, 0, cfg(sb2));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push('PE ' + e.message));
  const U = site.url + '/#'; const reg = async (name, email, pw) => { await p.goto(U + '/register'); await p.fill('#name', name); await p.fill('#email', email); await p.fill('#password', pw); await p.click('#go'); await p.waitForSelector('text=أهلًا'); };
  const login = async (email, pw) => { await p.goto(U + '/login'); await p.fill('#email', email); await p.fill('#password', pw); await p.click('#go'); await p.waitForSelector('text=أهلًا'); };
  const logout = async () => { await p.click('button:has-text("خروج")'); await p.waitForSelector('.hero'); };

  // ---- A signs up (no email confirmation), sets a provider key, uploads + generates with the AI provider
  await reg('سارة', 'sara@uni.edu', 'password-1'); await junk(p, 'dashboard'); assert(!(await p.isVisible('#ce-banner')), 'no device-mode banner when accounts are real'); console.log('A registered; header user:', (await p.textContent('header .bidi')).trim());
  await p.goto(U + '/operator'); await p.waitForSelector('#op-on'); await p.click('#op-on'); await p.waitForSelector('h1:has-text("ذكاء المشغل")'); await p.click('details summary'); await p.selectOption('#preset', 'custom'); await p.fill('#base', llm.url); await p.fill('#key', 'sk-123456'); await p.fill('#rpm', '300'); await p.click('form:has-text("إضافة مزوّد") button[type=submit]'); await p.waitForSelector('text=المفاتيح المربوطة');
  await p.goto(U + '/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await createQuiz(p);
  const quizUrl = p.url(); const quizId = quizUrl.split('/quiz/')[1]; console.log('A quiz ready; rows stored in the database:', [...sb.kv.values()].length, 'all owned by A:', new Set([...sb.kv.values()].map((r) => r.user_id)).size === 1);
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain');
  await p.reload(); await p.waitForSelector('.stem'); console.log('session + attempt restored after reload:', (await p.textContent('.qhead .badge')).trim());

  // ---- B is isolated from A
  await p.goto(U + '/account'); await p.waitForSelector('text=تغيير كلمة المرور'); assert((await p.locator('text=مسح بياناتي من هذا الجهاز').count()) === 0); await logout();
  await reg('بوب', 'bob@uni.edu', 'password-2'); await p.goto(U + '/files'); await p.waitForSelector('.empty'); await p.goto(U + '/quizzes'); await p.waitForSelector('.empty, .card'); assert((await p.locator('table').count()) === 0, 'B sees no quizzes');
  await p.goto(U + '/quiz/' + quizId); await p.waitForSelector('.alert.bad'); console.log("B opening A's quiz ->", (await p.textContent('.alert.bad')).trim().slice(0, 40)); await logout();

  // ---- A again: data is there; password change signs out other devices
  await login('sara@uni.edu', 'password-1'); await p.goto(U + '/quizzes'); await p.waitForSelector('table'); console.log('A sees her quiz after re-login');
  await p.goto(U + '/account'); await p.fill('#current', 'password-1'); await p.fill('#next', 'new-password-3'); await p.click('form:has-text("تغيير كلمة المرور") button[type=submit]'); await p.waitForSelector('.alert.ok'); await logout();
  await p.goto(U + '/login'); await p.fill('#email', 'sara@uni.edu'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('.alert.bad'); console.log('old password rejected:', (await p.textContent('.alert.bad')).trim());

  // ---- forgot password: the emailed link lands with the recovery session in the URL fragment
  await p.goto(U + '/forgot'); await p.fill('#email', 'sara@uni.edu'); await p.click('button:has-text("أرسل الرابط")'); await p.waitForSelector('.alert.ok'); const tok = sb.recoveryToken('sara@uni.edu'); assert(tok, 'recovery email "sent"');
  await p.goto(site.url + '/#access_token=' + tok + '&refresh_token=x&expires_in=3600&type=recovery'); await p.waitForSelector('text=كلمة مرور جديدة'); console.log('recovery link -> reset page:', await p.evaluate(() => location.hash.slice(0, 14)));
  await p.fill('#password', 'after-reset-4'); await p.click('button:has-text("حفظ")'); await p.waitForSelector('#go'); await login('sara@uni.edu', 'after-reset-4'); console.log('logged in with the reset password');

  // ---- delete account: everything goes
  await p.goto(U + '/account'); await p.fill('#pass', 'after-reset-4'); await p.click('button:has-text("حذف حسابي وبياناتي")'); await p.click('.modal button:has-text("احذف حسابي")'); await p.waitForSelector('.hero');
  assert.strictEqual([...sb.kv.values()].filter((r) => r.k === 'quiz_' + quizId).length, 0); console.log('A deleted -> her rows gone; remaining rows belong to B only:', new Set([...sb.kv.values()].map((r) => r.user_id)).size <= 1);
  await p.goto(U + '/login'); await p.fill('#email', 'sara@uni.edu'); await p.fill('#password', 'after-reset-4'); await p.click('#go'); await p.waitForSelector('.alert.bad');

  // ---- email-confirmation mode: pending message, then the link logs the user in
  const U2 = site2.url + '/#'; await p.goto(U2 + '/register'); await p.fill('#name', 'كريم'); await p.fill('#email', 'karim@uni.edu'); await p.fill('#password', 'password-5'); await p.click('#go'); await p.waitForSelector('.alert.ok'); console.log('pending confirmation:', (await p.textContent('.alert.ok')).trim().slice(0, 40));
  await p.fill('#password', 'password-5'); await p.click('#go'); await p.waitForSelector('.alert.bad, .alert.ok'); const t2 = await sb2.confirm('karim@uni.edu');
  await p.goto(site2.url + '/#access_token=' + t2.access_token + '&refresh_token=' + t2.refresh_token + '&expires_in=3600&type=signup'); await p.waitForSelector('text=أهلًا'); console.log('confirmation link -> signed in as', (await p.textContent('header .bidi')).trim());
  // ---- guest: no account, no registration; kept on THIS device only, nothing guaranteed, apart from every account
  { const gctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const g = await gctx.newPage(); g.on('pageerror', (e) => errs.push('GPE ' + e.message)); const GU = site.url + '/#';
    await g.goto(GU + '/'); await g.waitForSelector('.hero h1'); assert(await g.locator('#guest-enter').isVisible(), 'the landing page offers the guest door'); assert(/بلا تسجيل/.test(await g.textContent('#guest-enter')) && /ضمان/.test(await g.textContent('.guest-cta')), 'and says nothing is guaranteed');
    assert.strictEqual(await g.locator('nav.links a[href="#/guest"]').count(), 1, 'the menu has the guest entry too');
    await g.click('#guest-enter'); await g.waitForSelector('text=أهلًا بك'); assert.strictEqual(await g.locator('#guest-note').count(), 0, 'no notice bar above the site'); assert.strictEqual((await g.textContent('#notice')).trim(), '', 'nothing above the site'); assert(/ضيف/.test(await g.textContent('header a.acct .nm')), 'a guest is called a guest');
    assert((await g.locator('header a:has-text("إنشاء حساب")').count()) >= 1, 'accounts exist: a guest is offered one, to keep the work');
    await g.goto(GU + '/files'); await g.waitForSelector('h1'); await g.setInputFiles('#file', pdf); await g.waitForSelector('table'); await g.reload(); await g.waitForSelector('table'); assert.strictEqual(await g.locator('tbody tr').count(), 1, 'the guest file is kept on this device');
    await g.goto(GU + '/account'); await g.waitForSelector('#guest-account'); assert(/لا ضمان/.test(await g.textContent('#guest-account')), 'the account page of a guest says nothing is guaranteed'); assert.strictEqual(await g.locator('text=تغيير كلمة المرور').count(), 0, 'a guest has no password to change'); assert.strictEqual(await g.locator('button:has-text("مسح بياناتي")').count(), 1);
    await g.goto(GU + '/register'); await g.waitForSelector('#guest-upgrade'); await g.fill('#name', 'ضيف سابق'); await g.fill('#email', 'was-guest@uni.edu'); await g.fill('#password', 'password-9'); await g.click('#go'); await g.waitForSelector('text=أهلًا ضيف سابق');
    await g.goto(GU + '/files'); await g.waitForSelector('.empty'); assert.strictEqual(await g.locator('#guest-note').count(), 0, 'an account has no guest notice (and its own empty list: the guest work is kept apart)');
    // the flag of an earlier guest visit must never make an ACCOUNT a guest (a confirmation link or a restored session does not pass through "sign in"), nor bring the guest back after a sign-out
    await g.evaluate(() => localStorage.setItem('quizzy_guest_v1', '1')); await g.reload(); await g.waitForSelector('.empty'); assert(/ضيف سابق/.test(await g.textContent('header a.acct .nm')), 'a stale guest flag does not turn an account into a guest'); assert.strictEqual(await g.evaluate(() => localStorage.getItem('quizzy_guest_v1')), null, '... and it is cleared');
    await g.click('button:has-text("خروج")'); await g.waitForSelector('.hero'); await g.click('#guest-enter'); await g.waitForSelector('text=أهلًا بك'); await g.goto(GU + '/files'); await g.waitForSelector('table'); assert.strictEqual(await g.locator('tbody tr').count(), 1, 'the guest work is still there');
    await g.goto(GU + '/account'); await g.click('button:has-text("مسح بياناتي")'); await g.click('.modal button:has-text("امسح")'); await g.goto(GU + '/files'); await g.waitForSelector('.empty');
    await g.click('button:has-text("خروج")'); await g.waitForSelector('.hero'); assert.strictEqual(await g.locator('#guest-note').count(), 0);
    await gctx.close(); console.log('guest: door on the landing page and in the menu, no notice bar (it is said on the landing page and in "حسابي"), kept on the device, apart from accounts, a stale guest flag never makes an account a guest, wipe, leave'); }
  // ---- the operator's "accounts" card: is the cloud ready? The project answers, the PUBLIC key is accepted, e-mail sign-up is on, the schema and the erase function exist; a broken project says what to fix; a SECRET key switches accounts off
  { const toOperator = async (url) => { const c = await b.newContext({ viewport: { width: 1280, height: 900 } }); const o = await c.newPage(); o.on('pageerror', (e) => errs.push('OPE ' + e.message)); const OU = url + '/#';
      await o.goto(OU + '/operator'); await o.waitForSelector('#op-on'); await o.click('#op-on'); await o.waitForTimeout(500); await o.goto(OU + '/operator'); await o.waitForSelector('#accounts-status h2'); return { o, c }; };      // (a site without a working cloud takes the operator to the AI page after the switch: come back)
    const check = async (o) => { await o.click('#accounts-check'); await o.waitForSelector('#accounts-result li'); await o.waitForTimeout(150); return o.locator('#accounts-result li').evaluateAll((l) => l.map((x) => ({ ok: x.className === 'ok', text: x.textContent.trim() }))); };
    { const { o, c } = await toOperator(site.url); assert(/مفعّلة/.test(await o.textContent('#accounts-status h2')), 'the card says accounts are on'); assert(!(await o.textContent('#accounts-status')).includes(sb.anonKey), 'the key is never shown');
      let r = await check(o); assert(r.length >= 6 && r.every((x) => x.ok), 'a healthy project: every step is green ' + JSON.stringify(r)); assert(r.some((x) => /تأكيد البريد معطّل/.test(x.text)), 'it says whether e-mail confirmation is on (here: off)');
      sb.flags.schema = false; r = await check(o); assert(r.filter((x) => !x.ok).length === 2 && r.some((x) => !x.ok && /supabase\/schema\.sql/.test(x.text)), 'no schema: it says to run schema.sql ' + JSON.stringify(r)); sb.flags.schema = true;
      sb.flags.signupOpen = false; r = await check(o); assert(r.some((x) => !x.ok && /التسجيل بالبريد مغلق/.test(x.text)), 'sign-ups switched off: it says so'); sb.flags.signupOpen = true; await c.close(); }
    { const { o, c } = await toOperator(site2.url); const r = await check(o); assert(r.some((x) => x.ok && /تأكيد البريد مفعّل/.test(x.text) && /SMTP/.test(x.text)), 'confirmation on: it warns about the default mailer\'s hourly limit'); await c.close(); }
    { const wrong = await serve(dist, 0, `window.QZ_CONFIG={supabaseUrl:'${sb.url}',supabaseAnonKey:'a-wrong-key'};`); const { o, c } = await toOperator(wrong.url); const r = await check(o); assert(r.length === 1 && !r[0].ok && /رفض المفتاح/.test(r[0].text), 'a wrong key: the project refuses it ' + JSON.stringify(r)); await c.close(); await wrong.close(); }
    { const e64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url'); const secret = e64({ alg: 'HS256', typ: 'JWT' }) + '.' + e64({ iss: 'supabase', ref: 'abcd', role: 'service_role' }) + '.' + 'x'.repeat(43);
      const bad = await serve(dist, 0, `window.QZ_CONFIG={supabaseUrl:'${sb.url}',supabaseAnonKey:'${secret}'};`); const { o, c } = await toOperator(bad.url);
      assert(await o.locator('#accounts-secret').count() === 1 && /أُوقفت/.test(await o.textContent('#accounts-status h2')), 'a SECRET key put in config.js: accounts are switched off and the operator is told to revoke it'); assert(!(await o.textContent('#accounts-status')).includes(secret), 'and it is never shown');
      const v = await b.newContext({ viewport: { width: 1280, height: 900 } }); const vp = await v.newPage(); await vp.goto(bad.url + '/#/'); await vp.waitForSelector('header a.acct'); assert.strictEqual((await vp.evaluate(() => JSON.stringify(Object.keys(localStorage)))).includes('quizzy_sb_session'), false, 'no session was ever made with it'); await v.close(); await c.close(); await bad.close(); }
    { const none = await serve(dist, 0, 'window.QZ_CONFIG={};'); const { o, c } = await toOperator(none.url); assert(/غير مفعّلة/.test(await o.textContent('#accounts-status h2')) && (await o.locator('#accounts-steps li').count()) === 4 && /QZ_SUPABASE_ANON_KEY/.test(await o.textContent('#accounts-steps')), 'no cloud yet: the card lists the four steps to turn it on'); await c.close(); await none.close(); }
    console.log('operator accounts card: healthy project all green; no schema / sign-ups off / wrong key each say what to fix; confirmation + SMTP warning; a SECRET key switches accounts off; not configured lists the four steps'); }
  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0); await b.close(); for (const x of [site, site2, llm, sb, sb2]) await x.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
