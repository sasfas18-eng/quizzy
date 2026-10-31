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
  const logout = async () => { await p.click('header details.menu summary'); await p.click('button:has-text("تسجيل الخروج")'); await p.waitForSelector('.hero2'); };

  // ---- A signs up (no email confirmation), sets a provider key, uploads + generates with the AI provider
  await reg('سارة', 'sara@uni.edu', 'password-1'); await junk(p, 'dashboard'); assert(!(await p.isVisible('#ce-banner')), 'no device-mode banner when accounts are real'); console.log('A registered; header user:', (await p.textContent('header .bidi')).trim());
  await p.goto(U + '/settings'); await p.waitForSelector('h1:has-text("ربط الذكاء الاصطناعي")'); await p.click('main details summary'); await p.selectOption('#preset', 'custom'); await p.fill('#base', llm.url); await p.fill('#key', 'sk-123456'); await p.fill('#rpm', '300'); await p.click('form:has-text("إضافة مزوّد") button[type=submit]'); await p.waitForSelector('text=المفاتيح المربوطة');
  await p.goto(U + '/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('a:has-text("التفاصيل")', { timeout: 60000 }); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await createQuiz(p, { count: 10 });
  const quizUrl = p.url(); const quizId = quizUrl.split('/quiz/')[1]; console.log('A quiz ready; rows stored in the database:', [...sb.kv.values()].length, 'all owned by A:', new Set([...sb.kv.values()].map((r) => r.user_id)).size === 1);
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain');
  await p.reload(); await p.waitForSelector('.stem'); console.log('session + attempt restored after reload:', (await p.textContent('.qhead .badge')).trim());

  // ---- B is isolated from A
  await p.goto(U + '/account'); await p.waitForSelector('text=تغيير كلمة المرور'); assert((await p.locator('text=مسح بياناتي من هذا الجهاز').count()) === 0); await logout();
  await reg('بوب', 'bob@uni.edu', 'password-2'); await p.goto(U + '/files'); await p.waitForSelector('.empty'); await p.goto(U + '/quizzes'); await p.waitForSelector('.empty, .card'); assert((await p.locator('table').count()) === 0, 'B sees no quizzes');
  await p.goto(U + '/quiz/' + quizId); await p.waitForSelector('.alert.bad'); console.log("B opening A's quiz ->", (await p.textContent('.alert.bad')).trim().slice(0, 40)); await logout();

  // ---- A again: data is there; password change signs out other devices
  await login('sara@uni.edu', 'password-1'); await p.goto(U + '/quizzes'); await p.waitForSelector('a.item'); console.log('A sees her quiz after re-login');
  await p.goto(U + '/account'); await p.fill('#current', 'password-1'); await p.fill('#next', 'new-password-3'); await p.click('form:has-text("تغيير كلمة المرور") button[type=submit]'); await p.waitForSelector('.alert.ok'); await logout();
  await p.goto(U + '/login'); await p.fill('#email', 'sara@uni.edu'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('.alert.bad'); console.log('old password rejected:', (await p.textContent('.alert.bad')).trim());

  // ---- forgot password: the emailed link lands with the recovery session in the URL fragment
  await p.goto(U + '/forgot'); await p.fill('#email', 'sara@uni.edu'); await p.click('button:has-text("أرسل الرابط")'); await p.waitForSelector('.alert.ok'); const tok = sb.recoveryToken('sara@uni.edu'); assert(tok, 'recovery email "sent"');
  await p.goto(site.url + '/#access_token=' + tok + '&refresh_token=x&expires_in=3600&type=recovery'); await p.waitForSelector('text=كلمة مرور جديدة'); console.log('recovery link -> reset page:', await p.evaluate(() => location.hash.slice(0, 14)));
  await p.fill('#password', 'after-reset-4'); await p.click('button:has-text("حفظ")'); await p.waitForSelector('#go'); await login('sara@uni.edu', 'after-reset-4'); console.log('logged in with the reset password');

  // ---- delete account: everything goes
  await p.goto(U + '/account'); await p.fill('#pass', 'after-reset-4'); await p.click('button:has-text("حذف حسابي وبياناتي")'); await p.click('.modal button:has-text("احذف حسابي")'); await p.waitForSelector('.hero2');
  assert.strictEqual([...sb.kv.values()].filter((r) => r.k === 'quiz_' + quizId).length, 0); console.log('A deleted -> her rows gone; remaining rows belong to B only:', new Set([...sb.kv.values()].map((r) => r.user_id)).size <= 1);
  await p.goto(U + '/login'); await p.fill('#email', 'sara@uni.edu'); await p.fill('#password', 'after-reset-4'); await p.click('#go'); await p.waitForSelector('.alert.bad');

  // ---- email-confirmation mode: pending message, then the link logs the user in
  const U2 = site2.url + '/#'; await p.goto(U2 + '/register'); await p.fill('#name', 'كريم'); await p.fill('#email', 'karim@uni.edu'); await p.fill('#password', 'password-5'); await p.click('#go'); await p.waitForSelector('.alert.ok'); console.log('pending confirmation:', (await p.textContent('.alert.ok')).trim().slice(0, 40));
  await p.fill('#password', 'password-5'); await p.click('#go'); await p.waitForSelector('.alert.bad, .alert.ok'); const t2 = await sb2.confirm('karim@uni.edu');
  await p.goto(site2.url + '/#access_token=' + t2.access_token + '&refresh_token=' + t2.refresh_token + '&expires_in=3600&type=signup'); await p.waitForSelector('text=أهلًا'); console.log('confirmation link -> signed in as', (await p.textContent('header .bidi')).trim());
  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0); await b.close(); for (const x of [site, site2, llm, sb, sb2]) await x.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
