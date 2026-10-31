// node scripts/render_brand.js — renders docs/brand/brand-sheet.html (the identity sheet) and transparent PNG lockups for light / dark backgrounds, with the site's own fonts.
const { chromium } = require('playwright'); const path = require('path'); const root = path.resolve(__dirname, '..'); const dir = path.join(root, 'docs', 'brand');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 }); await p.goto('file://' + path.join(dir, 'brand-sheet.html')); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(dir, 'brand-sheet.png'), fullPage: true });
  for (const [name, sel] of [['logo-lockup', '.sheet:not(.dark) .lock'], ['logo-lockup-on-dark', '.sheet.dark .lock']]) { const el = p.locator(sel).first(); await el.screenshot({ path: path.join(dir, name + '.png'), omitBackground: true }); }
  await b.close(); console.log('rendered'); })().catch((e) => { console.error(e); process.exit(1); });
