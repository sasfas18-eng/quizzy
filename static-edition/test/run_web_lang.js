// node static-edition/test/run_web_lang.js <dist> <pdf>
// The site's language switch (العربية / English) on the real site:
//  1) the switch is in the side menu (and, on a phone, one small button in the top bar); choosing English turns the whole site left-to-right and English;
//  2) every page a student or the operator can reach - home, files, a file, new quiz, quizzes, a quiz, solving (with the correction), the result, cards,
//     studying a card, the account, the operator page, the printable sheet, and signed out: the landing page, sign in, sign up, password reset - shows NO
//     Arabic interface text, no Arabic label/title/placeholder; the lecture's own content (questions, options, quotes, page text) is left exactly as it is;
//  3) numbers, dates and counts are English («1 question», «3 pages»), the menu drawer opens from the left on a phone, nothing overflows the screen;
//  4) the choice is remembered across a reload (and the first page is drawn in English, not Arabic first); choosing العربية again restores everything.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
// the Arabic interface text left on screen: text outside the lecture's content (the same rule the site uses), and labels
const sweep = () => {
  const AR = /[ء-ي]/; const CONTENT = '[dir]:not(html), [translate=no], textarea, script, style, pre, code';
  const isC = (el) => { const c = el.closest(CONTENT); if (!c) return false; const u = el.closest('[data-ui]'); return !(u && (u === c || c.contains(u))); };
  const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { if (!AR.test(n.data)) continue; const el = n.parentElement; if (!el || isC(el)) continue; out.push(n.data.trim().slice(0, 140)); }
  document.querySelectorAll('[title],[aria-label],[placeholder],[alt],[data-label]').forEach((el) => { for (const a of ['title', 'aria-label', 'placeholder', 'alt', 'data-label']) { const v = el.getAttribute(a); if (v && AR.test(v) && !el.closest('[translate=no]')) out.push('@' + a + ': ' + v.slice(0, 120)); } });
  return out;
};
(async () => {
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};"); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx, { name: 'Sara' }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const api = (method, url, body) => p.evaluate(async ([m, u, x]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: x ? JSON.stringify(x) : undefined }); let j = null; try { j = await r.json(); } catch (_) { j = null; } return j; }, [method, url, body]);
  // a lecture and a quiz, made in Arabic as before
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
  await p.goto(site.url + '/#/new'); await createQuiz(p, { count: 10 });
  const quiz = (await api('GET', '/api/quizzes'))[0]; const doc = (await api('GET', '/api/documents'))[0]; const qs = await api('GET', `/api/quizzes/${quiz.id}/questions`);
  assert.strictEqual(await p.getAttribute('html', 'dir'), 'rtl'); assert(await p.isVisible('#lang-switch [lang=ar][aria-checked=true]'), 'Arabic is chosen');
  // 1) choose English in the side menu
  await p.goto(site.url + '/#/'); await p.waitForSelector('#lang-switch'); await p.click('#lang-switch [lang=en]');
  await p.waitForFunction(() => document.documentElement.dir === 'ltr' && document.documentElement.lang === 'en' && /My files/.test(document.body.innerText), null, { timeout: 15000 });
  assert(await p.isVisible('#lang-switch [lang=en][aria-checked=true]')); assert.strictEqual(await p.title(), 'Quizzy — study from your own lecture');
  console.log('1) English chosen: dir=ltr, lang=en, the menu reads «' + (await p.innerText('nav.links')).replace(/\s+/g, ' ').trim() + '»');
  // 2) every page: no Arabic interface text left
  const att = await api('POST', `/api/quizzes/${quiz.id}/attempts`, { mode: 'practice' });
  const pages = [['#/', 'h1'], ['#/files', 'h1'], [`#/files/${doc.id}`, 'h1'], ['#/new', '#create-quiz'], ['#/quizzes', 'h1'], [`#/quiz/${quiz.id}`, 'h1'], [`#/attempt/${att.id}`, '.stem'],
    ['#/cards', 'h1'], ['#/account', 'h1'], ['#/operator', 'h1'], [`#/print/${quiz.id}`, '.ptitle']];
  const left = {}; const check = async (where) => { const l = await p.evaluate(sweep); if (l.length) left[where] = l; };
  for (const [hash, sel] of pages) { await p.goto(site.url + '/' + hash); await p.waitForSelector(sel, { timeout: 30000 }); await p.waitForTimeout(150); await check(hash); }
  // the whole flow in English: upload a lecture (its progress and result), create a quiz (its progress, then ready), the delete dialog
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForTimeout(200); await check('files: uploading');
  await p.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 2 && !/Uploading|Reading/.test(document.body.innerText), null, { timeout: 60000 }); await check('files: uploaded');
  await p.goto(site.url + '/#/new'); await p.waitForSelector('#create-quiz'); await check('#/new (two files)'); await p.click('.chips button:text-is("10")'); await p.click('#create-quiz');
  for (let i = 0; i < 6; i++) { await p.waitForTimeout(120); await check('new quiz: generating'); }
  await p.waitForSelector('h2:has-text("Ready to solve")', { timeout: 60000 }); await check('new quiz: ready');
  await p.goto(site.url + '/#/quizzes'); await p.waitForSelector('.qsel'); await p.click('.qsel >> nth=0'); await p.waitForTimeout(100); await check('quizzes: one selected');
  const del = await p.$('button:has-text("Delete selected")'); if (del) { await del.click(); await p.waitForSelector('.modal'); await check('delete dialog'); await p.click('.modal button:text-is("Cancel")'); }
  // solving: a wrong answer shows the correction; the submit dialog; the result
  await p.goto(site.url + `/#/attempt/${att.id}`); await p.waitForSelector('.opts button[role=radio]');
  const shown = await p.innerText('.stem'); const q0 = qs.find((q) => q.stem.replace(/\s+/g, ' ').trim() === shown.replace(/\s+/g, ' ').trim()) || qs[0];
  const wrong = q0.options.findIndex((o) => o.id !== q0.correct_option_id); await p.click(`.opts button[role=radio] >> nth=${wrong}`); await p.waitForSelector('.explain, .fix', { timeout: 15000 }); await check('solving: after a wrong answer');
  assert.strictEqual(await p.innerText('.stem'), shown, 'the question itself is not translated');
  await p.click('aside button:text-is("Submit")'); await p.waitForSelector('.modal'); await check('submit dialog'); await p.click('.modal button.primary');
  await p.waitForFunction(() => /Your result/.test(document.body.innerText), null, { timeout: 20000 }); await check('result');
  // cards: make some, study one
  await p.goto(site.url + '/#/cards'); await p.waitForSelector('h1'); const gen = await p.$('button:has-text("Generate cards")');
  if (gen) { await gen.click(); await p.waitForFunction(() => /Created|No new cards/.test(document.body.innerText), null, { timeout: 120000 }); await check('cards: generated'); }
  await p.goto(site.url + '/#/cards/study'); await p.waitForSelector('h1'); await p.waitForTimeout(150); await check('#/cards/study');
  // signed out: landing, sign in, sign up, reset
  await p.goto(site.url + '/#/account'); await p.waitForSelector('h1'); await p.click('button:text-is("Sign out")'); await p.waitForSelector('.hero');
  for (const [hash, sel] of [['#/', '.hero'], ['#/login', 'form'], ['#/register', 'form'], ['#/forgot', 'form']]) { await p.goto(site.url + '/' + hash); await p.waitForSelector(sel); await p.waitForTimeout(100); await check(hash + ' (signed out)'); }
  console.log('2) pages and states swept:', pages.length + 18, '- Arabic interface text left:', JSON.stringify(left, null, 1));
  assert.deepStrictEqual(left, {}, 'no Arabic interface text in English');
  // 3) counts and dates in English; a phone: the top-bar button and the drawer from the left
  await p.goto(site.url + '/#/login'); await p.fill('#email', 'sara@uni.edu'); await p.fill('#password', 'password-1'); await p.click('#go'); await p.waitForSelector('h1:has-text("Welcome")');
  const dash = await p.innerText('main'); assert(/Latest quizzes/.test(dash) && /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(dash), 'English dates: ' + dash.slice(0, 300));
  await p.setViewportSize({ width: 390, height: 844 }); await p.goto(site.url + '/#/quizzes'); await p.waitForSelector('h1'); await p.screenshot({ path: '/tmp/shots/lang-en-phone.png' });
  assert(await p.isVisible('#lang-quick'), 'the top-bar language button on a phone'); assert.strictEqual(await p.innerText('#lang-quick'), 'ع');
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert(over <= 1, 'nothing wider than the phone: ' + over);
  await p.click('#menu-btn'); await p.waitForTimeout(400); const box = await p.evaluate(() => { const r = document.querySelector('.drawer').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
  assert(box[0] === 0 && box[1] <= 390, 'the drawer opens from the left in English: ' + box); await p.screenshot({ path: '/tmp/shots/lang-en-drawer.png' }); await p.keyboard.press('Escape');
  await p.setViewportSize({ width: 1280, height: 900 }); await p.goto(site.url + '/#/'); await p.waitForSelector('#lang-switch'); await p.waitForTimeout(400); await p.screenshot({ path: '/tmp/shots/lang-en-desktop.png' });
  console.log('3) English dates; phone: the «ع» button in the top bar, the drawer from the left, no overflow');
  // 4) remembered across a reload; then back to Arabic
  await p.reload(); await p.waitForSelector('h1'); assert.strictEqual(await p.getAttribute('html', 'dir'), 'ltr'); assert(/Welcome/.test(await p.innerText('h1')), 'still English after a reload');
  await p.click('#lang-switch [lang=ar]'); await p.waitForFunction(() => document.documentElement.dir === 'rtl' && /ملفاتي/.test(document.body.innerText), null, { timeout: 15000 });
  const en = await p.evaluate(() => (document.body.innerText.match(/\b(My files|My quizzes|Review cards|Welcome|Latest quizzes|Sign out)\b/g) || []));
  assert.deepStrictEqual(en, [], 'no English interface text left in Arabic'); await p.waitForTimeout(600); await p.screenshot({ path: '/tmp/shots/lang-ar-desktop.png' });
  await p.reload(); await p.waitForSelector('h1'); assert.strictEqual(await p.getAttribute('html', 'dir'), 'rtl');
  console.log('4) remembered across a reload; العربية restores the Arabic site');
  assert.deepStrictEqual(errs, []); console.log('language switch E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
