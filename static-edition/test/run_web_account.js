// node static-edition/test/run_web_account.js <dist> <pdf> — a site WITHOUT cloud accounts: the site ASKS for an e-mail and a password (an account on this device), and the GUEST is something else.
//  1) the first visit is the landing page (nobody is signed in): sign in / sign up / guest; nothing written above the site
//  2) signing up asks for the e-mail and a password (the name is optional), says plainly that the account lives on this device only, keeps NO plain password, and the first account adopts what the device already held
//  3) the guest is a SEPARATE space (its own files), called "ضيف", with "no guarantee" on its account page and a way to an account
//  4) signing in: a wrong password / an unknown e-mail are refused; the right one brings the account's own files back (never the guest's); it survives a reload
//  5) a second account on the same device has its own space; a taken e-mail is refused
//  6) changing the password, and deleting the account (password asked; the other account is untouched); no password recovery here (and the page says so)
const { chromium } = require('playwright'); const assert = require('assert'); const serve = require('./serve.js');
const [dist, pdf] = process.argv.slice(2);
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/401|429|favicon/.test(m.text())) errs.push('C ' + m.text().slice(0, 200)); });
  const U = site.url + '/#'; const who = async () => (await p.textContent('header a.acct .nm')).trim(); const rows = async () => { await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(250); return p.locator('tbody tr').count(); };
  const flag = () => p.evaluate(() => localStorage.getItem('quizzy_guest_flag_v2')); const accounts = () => p.evaluate(() => JSON.parse(localStorage.getItem('quizzy_acc_v1') || '{"accounts":{}}'));
  const signUp = async (email, password, name) => { await p.goto(U + '/register'); await p.waitForSelector('#email'); await p.fill('#email', email); if (name) await p.fill('#name', name); await p.fill('#password', password); await p.click('#go'); await p.waitForSelector('h1:has-text("أهلًا")'); };
  const signIn = async (email, password) => { await p.goto(U + '/login'); await p.waitForSelector('#email'); await p.fill('#email', email); await p.fill('#password', password); await p.click('#go'); };
  const signOut = async () => { await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); };
  const upload = async () => { await p.goto(U + '/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); };
  const api = (path, body) => p.evaluate(async ([u, b]) => { const r = await fetch(u, { method: 'POST', body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, [path, body]);

  // ---- 1) the first visit: nobody is signed in
  await p.goto(U + '/'); await p.waitForSelector('.hero h1'); assert.strictEqual(await p.locator('header a.acct').count(), 0, 'nobody is signed in: the site asks who you are'); assert.strictEqual((await p.textContent('#notice')).trim(), '', 'nothing is written above the site');
  assert.strictEqual(await p.locator('header a:text-is("دخول")').count(), 1); assert.strictEqual(await p.locator('header a:has-text("إنشاء حساب")').count(), 1); assert.strictEqual(await p.locator('#guest-enter').count(), 1, 'sign in, sign up, or the guest door');
  assert(/في هذا الجهاز/.test(await p.textContent('.hero .lead')), 'the landing page does not promise "from any device" on a site without a cloud');
  await p.evaluate(() => localStorage.setItem('quizzy_guest_v1', '1')); await p.reload(); await p.waitForSelector('.hero h1');      // the flag an EARLIER build left in a browser that once pressed "guest": it must not open the site as a guest by itself
  assert.strictEqual(await p.locator('header a.acct').count(), 0, 'a guest flag of an earlier build does not skip the question "who are you?"'); assert.strictEqual(await p.evaluate(() => localStorage.getItem('quizzy_guest_v1')), null, '... and it is removed'); assert.strictEqual(await flag(), null);
  console.log('1) the first visit is the landing page: sign in / sign up / guest, nothing above the site; an old guest flag does not skip it');

  // ---- 2) signing up asks for the e-mail and the password
  await p.goto(U + '/register'); await p.waitForSelector('#email'); assert.strictEqual(await p.getAttribute('#email', 'type'), 'email'); assert.strictEqual(await p.getAttribute('#password', 'type'), 'password'); assert.strictEqual(await p.locator('#name').getAttribute('required'), null, 'the name is optional');
  assert(/على هذا الجهاز فقط/.test(await p.textContent('#device-accounts')), 'the form says where the account lives');
  let r = await api('/api/auth/register', { email: 'not-an-email', password: 'password-1' }); assert(r.status === 422 && /بريدًا إلكترونيًا صحيحًا/.test(r.body.message), 'a bad e-mail is refused: ' + JSON.stringify(r));
  r = await api('/api/auth/register', { email: 'saad@uni.edu', password: '1234567' }); assert(r.status === 422 && r.body.code === 'weak_password', 'a short password is refused');
  await signUp('Saad@Uni.edu', 'password-1'); assert.strictEqual(await who(), 'Saad', 'no name was given: the e-mail\'s first part'); assert(/أهلًا Saad/.test(await p.textContent('h1')));
  const acc = await accounts(); const rec = acc.accounts['saad@uni.edu']; assert(rec && rec.hash && rec.salt && rec.iter >= 100000, 'a salted PBKDF2 hash is kept'); assert(!JSON.stringify(acc).includes('password-1'), 'the password itself is never stored');
  assert.strictEqual(rec.db, 'quizzy_web_v1', 'the first account adopts what this device already held'); assert.strictEqual((await p.textContent('#notice')).trim(), '');
  await upload(); assert.strictEqual(await rows(), 1, 'the account has its file');
  await p.goto(U + '/account'); await p.waitForSelector('h1:has-text("حسابي")'); assert.strictEqual(await p.locator('#guest-account').count(), 0, 'not a guest page'); assert(/هذا الجهاز فقط/.test(await p.textContent('#device-account-note')), 'the account page says it too');
  assert.strictEqual(await p.locator('text=تغيير كلمة المرور').count() > 0, true, 'an account can change its password'); assert.strictEqual(await p.locator('button:has-text("حذف حسابي")').count(), 1, 'and delete itself');
  console.log('2) sign up asks for the e-mail + password (name optional), says it lives on this device, keeps only a salted hash, the first account adopts the device\'s data');

  // ---- 3) the guest: a separate space
  await signOut(); await p.click('#guest-enter'); await p.waitForSelector('text=أهلًا بك');
  assert.strictEqual(await who(), 'ضيف'); assert.strictEqual(await flag(), '1'); assert.strictEqual((await p.textContent('#notice')).trim(), '', 'nothing above the site for a guest either'); assert.strictEqual(await rows(), 0, 'the guest does not see the account\'s files');
  await upload(); assert.strictEqual(await rows(), 1, 'the guest has its own'); assert((await p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).includes('quizzy_guest_v1'), 'the guest\'s store keeps its name, so what a guest made is still there'); await p.goto(U + '/account'); await p.waitForSelector('#guest-account'); assert(/لا ضمان/.test(await p.textContent('#guest-account')), 'the guest\'s page says nothing is guaranteed');
  assert.strictEqual(await p.locator('text=تغيير كلمة المرور').count(), 0, 'a guest has no password'); assert.strictEqual(await p.locator('header a:has-text("إنشاء حساب")').count(), 1, 'and a way to an account');
  console.log('3) the guest: its own space, called "ضيف", "no guarantee" on its page, a way to an account');

  // ---- 4) signing in
  await signOut(); assert.strictEqual(await flag(), null, 'leaving the guest space');
  await signIn('saad@uni.edu', 'wrong-password'); await p.waitForSelector('.alert.bad'); assert(/غير صحيحة/.test(await p.textContent('.alert.bad')), 'a wrong password is refused'); assert.strictEqual(await p.locator('header a.acct').count(), 0);
  await p.fill('#email', 'nobody@uni.edu'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('.alert.bad'); assert.strictEqual(await p.locator('header a.acct').count(), 0, 'an unknown e-mail is refused too');
  await p.fill('#email', 'SAAD@uni.edu'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('text=أهلًا Saad'); assert.strictEqual(await who(), 'Saad'); assert.strictEqual(await rows(), 1, 'the account\'s own file (the guest\'s is not mixed in)');
  await p.reload(); await p.waitForSelector('header a.acct'); assert.strictEqual(await who(), 'Saad', 'it survives a reload');
  console.log('4) wrong password / unknown e-mail refused; the right one brings the account\'s own files; survives a reload');

  // ---- 5) a second account
  await signOut(); await signUp('lina@uni.edu', 'password-2', 'لينا'); assert.strictEqual(await who(), 'لينا'); assert.strictEqual(await rows(), 0, 'a second account on the same device has its own, empty, space');
  await upload(); assert.strictEqual(await rows(), 1); const two = await accounts(); assert(two.accounts['lina@uni.edu'].db.startsWith('quizzy_acc_') && two.accounts['lina@uni.edu'].db !== 'quizzy_web_v1', 'its own store');
  await signOut(); await p.goto(U + '/register'); await p.waitForSelector('#email'); await p.fill('#email', 'Saad@uni.edu'); await p.fill('#password', 'password-3'); await p.click('#go'); await p.waitForSelector('.alert.bad'); assert(/مسجّل مسبقًا/.test(await p.textContent('.alert.bad')), 'a taken e-mail is refused');
  console.log('5) a second account has its own space; a taken e-mail is refused');

  // ---- 6) password change, delete, no recovery
  await signIn('saad@uni.edu', 'password-1'); await p.waitForSelector('text=أهلًا Saad'); await p.goto(U + '/account'); await p.waitForSelector('#current');
  await p.fill('#current', 'not-my-password'); await p.fill('#next', 'password-NEW1'); await p.click('form:has(#current) button[type=submit]'); await p.waitForSelector('.alert.bad'); assert(/غير صحيحة/.test(await p.textContent('.alert.bad')), 'the current password is asked for');
  await p.fill('#current', 'password-1'); await p.fill('#next', 'password-NEW1'); await p.click('form:has(#current) button[type=submit]'); await p.waitForSelector('.alert.ok'); assert(!/بقية الأجهزة/.test(await p.textContent('.alert.ok')), 'no "other devices" on a device account');
  await signOut(); await signIn('saad@uni.edu', 'password-1'); await p.waitForSelector('.alert.bad'); await p.fill('#password', 'password-NEW1'); await p.click('#go'); await p.waitForSelector('text=أهلًا Saad');
  await p.goto(U + '/forgot'); await p.waitForSelector('#no-reset'); assert(/لا تُستعاد/.test(await p.textContent('#no-reset')), 'no recovery: the page says so, and what to do instead');
  await signOut(); await signIn('lina@uni.edu', 'password-2'); await p.waitForSelector('text=أهلًا لينا'); await p.goto(U + '/account'); await p.waitForSelector('#pass'); await p.fill('#pass', 'wrong-pass'); await p.click('button:has-text("حذف حسابي وبياناتي")'); await p.click('.modal button:has-text("احذف حسابي")'); await p.waitForSelector('.toast.bad, .toast:has-text("غير صحيحة")');
  assert.strictEqual((await accounts()).accounts['lina@uni.edu'] !== undefined, true, 'a wrong password does not delete the account');
  await p.fill('#pass', 'password-2'); await p.click('button:has-text("حذف حسابي وبياناتي")'); await p.click('.modal button:has-text("احذف حسابي")'); await p.waitForSelector('.hero h1'); assert.strictEqual((await accounts()).accounts['lina@uni.edu'], undefined, 'the account is gone');
  await signIn('lina@uni.edu', 'password-2'); await p.waitForSelector('.alert.bad'); await p.fill('#email', 'saad@uni.edu'); await p.fill('#password', 'password-NEW1'); await p.click('#go'); await p.waitForSelector('text=أهلًا Saad'); assert.strictEqual(await rows(), 1, 'the other account is untouched');
  console.log('6) password change (current one asked), no recovery (said plainly), delete asks the password and leaves the other account alone');

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('device accounts vs guest E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
