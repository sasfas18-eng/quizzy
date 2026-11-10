// node static-edition/test/run_web_smart.js <dist>
// The smart paths (#/smart): Claude and a clearly marked ChatGPT preview.
// The page links out only; it sends nothing to either service and holds no key. Reachable from the header and the homepage,
// translated in English, and laid out without horizontal scroll on a phone.
const { chromium } = require('playwright');
const assert = require('assert');
const serve = require('./serve.js');
const [dist] = process.argv.slice(2);

(async () => {
  const site = await serve(dist, 0); const browser = await chromium.launch(process.env.QZ_CHROMIUM ? { executablePath: process.env.QZ_CHROMIUM, args: ['--no-sandbox'] } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 404/.test(m.text())) errors.push(m.text()); });
  const outside = []; page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== new URL(site.url).origin && !u.protocol.startsWith('data')) outside.push(r.url()); });

  await page.goto(site.url + '/#/'); await page.waitForSelector('#smart-cta');
  await page.click('#top .topbar .chatgpt-jump'); await page.waitForSelector('#smart-claude');
  assert.strictEqual(await page.evaluate(() => location.hash), '#/smart', 'the header link opens the smart paths');
  assert.strictEqual(await page.locator('#smart-chatgpt').count(), 1, 'ChatGPT path is visible beside Claude');
  const cg = await page.evaluate(() => { const a = document.querySelector('#smart-chatgpt-go'); return { href: a.href, target: a.target, rel: a.rel }; });
  assert.strictEqual(cg.href, 'https://quizzy-chatgpt-study.sasfas18.chatgpt.site/');
  assert.strictEqual(cg.target, '_blank'); assert(/noopener/.test(cg.rel));
  assert.strictEqual(await page.locator('#smart-chatgpt .smart-status').textContent(), 'قيد التفعيل');
  assert(/رابط المعاينة لا يفعّل التوليد/.test(await page.locator('#smart-chatgpt').textContent()));
  const cl = await page.evaluate(() => { const a = document.querySelector('#smart-claude-go'); return { href: a.href, target: a.target, rel: a.rel }; });
  assert(/^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9]+$/.test(cl.href), 'Claude path -> the Quizzy edition inside claude.ai: ' + cl.href);
  assert.strictEqual(cl.target, '_blank'); assert(/noopener/.test(cl.rel));
  const txt = await page.textContent('main'); assert(/مسار ChatGPT ظاهر للمعاينة/.test(txt));
  assert(!/sk-|AIza|api[_ -]?key/i.test(await page.content()), 'no key in the page');
  await page.click('a[href="#/new"]:has-text("محليًا")'); await page.waitForFunction(() => location.hash !== '#/smart');

  await page.goto(site.url + '/#/'); await page.click('#smart-cta'); await page.waitForSelector('#smart-claude');
  await page.evaluate(() => document.querySelector('#lang-quick').click()); await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.waitForSelector('#smart-claude-go:has-text("Open Quizzy with Claude")');
  await page.waitForSelector('#smart-chatgpt-go:has-text("Preview the ChatGPT edition")');
  const left = await page.evaluate(() => (document.querySelector('main').textContent.match(/[؀-ۿ]+/g) || []).join(' ')); assert.strictEqual(left, '', 'Arabic left in English: ' + left);
  await page.waitForTimeout(800);      // the language switch finishes its view transition before it accepts another
  await page.evaluate(() => document.querySelector('#lang-quick').click()); await page.waitForFunction(() => document.documentElement.lang === 'ar');

  await page.setViewportSize({ width: 375, height: 800 }); await page.waitForTimeout(200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on a phone');
  if (process.env.QZ_SHOT) await page.screenshot({ path: process.env.QZ_SHOT, fullPage: true });

  assert.deepStrictEqual(outside, [], 'the page sent nothing to ChatGPT or Claude'); assert.deepStrictEqual(errors, []);
  await browser.close(); site.close(); console.log('smart paths ok');
})().catch((e) => { console.error(e); process.exit(1); });
