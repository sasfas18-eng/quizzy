// node scripts/ui_shots.js <dist> <pdf> <outDir> [prefix] — screenshots of every main screen (desktop / mobile / dark) of the built web edition, for design review.
// The flow is the real one (upload -> pick pages -> build a quiz locally -> solve -> result -> flashcards -> operator pages), so the pictures show real content, not mock-ups.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const serve = require('../static-edition/test/serve.js'); const { seedAccount, EMAIL, PASSWORD } = require('../static-edition/test/signin.js'); const { createQuiz } = require('../claude-edition/test/flow.js');
(async () => {
  const [dist, pdf, out, prefix = ''] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
  const site = await serve(dist, 0); const b = await chromium.launch(); const errs = [];
  const profiles = [['desktop', { width: 1280, height: 860 }, 'light', false], ['mobile', { width: 390, height: 844 }, 'light', true], ['dark', { width: 1280, height: 860 }, 'dark', false]];
  for (const [name, viewport, colorScheme, mobile] of profiles) {
    const ctx = await b.newContext({ viewport, colorScheme, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(name + ' PE ' + e.message)); const U = site.url + '/#';
    const shot = async (id, full = false) => { await p.waitForTimeout(450); await p.screenshot({ path: path.join(out, `${prefix}${name}-${id}.png`), fullPage: full }); };
    await p.goto(U + '/'); await p.waitForSelector('h1'); await p.waitForSelector('.empty'); await shot('01-home', true);
    if (await p.locator('#menu-btn').isVisible()) { await p.click('#menu-btn'); await shot('01b-menu-open'); }      // phones: the menu is a drawer
    await p.click('header button:has-text("خروج")'); await p.waitForSelector('.hero h1'); await shot('00-landing', true);
    await p.click('.hero a:has-text("لدي حساب")'); await p.waitForSelector('#email'); await shot('00-login'); await p.fill('#email', EMAIL); await p.fill('#password', PASSWORD); await p.click('#go'); await p.waitForSelector('text=أهلًا سارة');
    await p.goto(U + '/files'); await p.waitForSelector('h1'); await shot('02-files-empty');
    await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await shot('03-files');
    await p.click('a:has-text("التفاصيل") >> nth=0'); await p.waitForSelector('h1'); await shot('04-file', true);
    await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await shot('05-new-quiz', true);
    await createQuiz(p, { count: 10, timeout: 120000 }); await shot('06-quiz-ready', true);
    await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await shot('07-solve');
    await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await shot('08-solve-answered', true);
    await p.click('aside button:has-text("تسليم")'); await p.waitForSelector('.modal'); await p.click('.modal button.primary'); await p.waitForFunction(() => location.hash.includes('/result')); await p.waitForSelector('h1'); await shot('09-result', true);
    await p.goto(U + '/quizzes'); await p.waitForSelector('h1'); await shot('10-quizzes');
    await p.goto(U + '/cards'); await p.waitForSelector('h1'); await shot('11-cards');
    await p.goto(U + '/operator'); await p.waitForSelector('h1'); await shot('12-operator-gate');
    await p.click('#op-on'); await p.waitForSelector('h1:has-text("ذكاء المشغل")'); await shot('13-operator-on', true);
    await p.goto(U + '/'); await p.waitForSelector('h1'); await shot('14-home-with-data', true);
    await ctx.close();
  }
  await b.close(); await site.close(); if (errs.length) { console.error('PAGE ERRORS', errs); process.exit(1); } console.log('shots in', out);
})().catch((e) => { console.error(e); process.exit(1); });
