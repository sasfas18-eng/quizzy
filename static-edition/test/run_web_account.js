// node static-edition/test/run_web_account.js <dist> <pdf> — a site WITHOUT cloud accounts (device mode): the ACCOUNT is this device, the GUEST is something else.
//  1) the first visit is a normal account (not a guest): no "ضيف", nothing written above the site, "أهلًا بك"
//  2) the guest door leads to a SEPARATE space (its own files), called "ضيف", nothing above the site; the account page says nothing is guaranteed; the way to the account of this device is in the menu
//  3) the way back opens the account of this device with NO form (nothing to type: real accounts, by e-mail, are the cloud); it leaves the guest space and the account's own files are back; it survives a reload and a sign-out / in
//  4) wiping the guest's data does not touch the account; wiping the account's data does not touch the guest
const { chromium } = require('playwright'); const assert = require('assert'); const serve = require('./serve.js');
const [dist, pdf] = process.argv.slice(2);
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/429|favicon/.test(m.text())) errs.push('C ' + m.text().slice(0, 200)); });
  const U = site.url + '/#'; const who = async () => (await p.textContent('header a.acct .nm')).trim(); const rows = async () => { await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(250); return p.locator('tbody tr').count(); };
  const flag = () => p.evaluate(() => localStorage.getItem('quizzy_guest_v1'));
  const wipe = async () => { await p.goto(U + '/account'); await p.click('button:has-text("مسح بياناتي")'); await p.click('.modal button:has-text("امسح")'); await p.waitForSelector('.toast:has-text("مُسحت")'); };
  const DEVICE = 'حسابي على هذا الجهاز';

  // ---- 1) the first visit: a normal account
  await p.goto(U + '/'); await p.waitForSelector('header a.acct'); await p.waitForSelector('h1');
  assert.strictEqual(await who(), DEVICE, 'the account of this device, not a guest'); assert.strictEqual((await p.textContent('#notice')).trim(), '', 'nothing is written above the site'); assert.strictEqual(await flag(), null);
  assert(/أهلًا بك/.test(await p.textContent('h1'))); assert.strictEqual(await p.locator('#guest-note').count(), 0);
  await p.goto(U + '/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); assert.strictEqual(await rows(), 1, 'the account has its file');
  await p.goto(U + '/account'); await p.waitForSelector('h1:has-text("حسابي")'); assert.strictEqual(await p.locator('#guest-account').count(), 0, 'the account page of an account is not a guest page');
  console.log('1) a site without cloud accounts: the first visit is a NORMAL account (not "ضيف"), nothing above the site');

  // ---- 2) the guest: a separate space
  await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await p.click('#guest-enter'); await p.waitForSelector('text=أهلًا بك');
  assert.strictEqual(await who(), 'ضيف'); assert.strictEqual(await flag(), '1'); assert.strictEqual((await p.textContent('#notice')).trim(), '', 'nothing above the site for a guest either'); assert.strictEqual(await p.locator('#guest-note').count(), 0);
  assert.strictEqual(await rows(), 0, 'the guest does not see the account\'s files: a separate space'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); assert.strictEqual(await rows(), 1, 'the guest has its own');
  await p.goto(U + '/account'); await p.waitForSelector('#guest-account'); assert(/لا ضمان/.test(await p.textContent('#guest-account')), 'the account page of a guest says nothing is guaranteed');
  assert.strictEqual(await p.locator('header a:has-text("إنشاء حساب")').count(), 0, 'no cloud accounts: none is offered'); assert.strictEqual(await p.locator('header a:has-text("حسابي على هذا الجهاز")').count(), 1, 'but the way to the account of this device is');
  console.log('2) the guest: its own space (separate files), called "ضيف", nothing above the site, "no guarantee" on the account page, the way to the account in the menu');

  // ---- 3) the way back: the account of this device, with no form
  await p.click('header a:has-text("حسابي على هذا الجهاز")'); await p.waitForSelector('text=أهلًا بك'); assert.strictEqual(await p.locator('input').count(), 0, 'no form: there is nothing to type');
  assert.strictEqual(await who(), DEVICE); assert.strictEqual(await flag(), null, 'the guest space is left'); assert.strictEqual(await p.locator('header a.btn:has-text("حسابي على هذا الجهاز")').count(), 0, 'the menu button is gone (you are there)');
  assert.strictEqual(await rows(), 1, 'the account\'s own file is back (the guest\'s is not mixed in)'); await p.reload(); await p.waitForSelector('header a.acct'); assert.strictEqual(await who(), DEVICE, 'and it survives a reload');
  await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await p.click('.hero a:has-text("لدي حساب")'); await p.waitForSelector('text=أهلًا بك'); assert.strictEqual(await who(), DEVICE); assert.strictEqual(await flag(), null);
  await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await p.click('.hero a:has-text("ابدأ مجانًا")'); await p.waitForSelector('text=أهلًا بك'); assert.strictEqual(await who(), DEVICE, '"ابدأ مجانًا" opens it too');
  console.log('3) the way back opens the account of this device with no form, leaves the guest space, brings the account\'s own files back; survives a reload and sign-out / in');

  // ---- 4) wiping one does not touch the other
  await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await p.click('#guest-enter'); await p.waitForSelector('text=أهلًا بك'); assert.strictEqual(await rows(), 1, 'the guest space kept its file'); await wipe();
  assert.strictEqual(await rows(), 0, 'the guest data is wiped'); assert.strictEqual(await flag(), '1', 'still a guest'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); assert.strictEqual(await rows(), 1, '(the guest makes a new file)');
  await p.click('header a:has-text("حسابي على هذا الجهاز")'); await p.waitForSelector('text=أهلًا بك'); assert.strictEqual(await rows(), 1, 'wiping the guest left the account\'s files alone'); await wipe(); assert.strictEqual(await rows(), 0, 'the account data is wiped');
  await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await p.click('#guest-enter'); await p.waitForSelector('text=أهلًا بك'); assert.strictEqual(await rows(), 1, 'wiping the account left the guest\'s files alone');
  console.log('4) wiping the guest leaves the account alone, wiping the account leaves the guest alone');

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('device account vs guest E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
