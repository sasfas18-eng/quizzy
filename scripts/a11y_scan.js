// node scripts/a11y_scan.js <dist> <pdf> — automated accessibility scan (axe-core, WCAG 2.0/2.1 A + AA incl. colour contrast) of the main screens of the built web edition, in light and dark,
// on a desktop and a phone viewport. Fails (exit 1) on any violation. Needs `npm install --no-save axe-core` (CI does it).
const { chromium } = require('playwright'); const fs = require('fs'); const serve = require('../static-edition/test/serve.js'); const { createQuiz } = require('../claude-edition/test/flow.js');
const axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
(async () => {
  const [dist, pdf] = process.argv.slice(2); const site = await serve(dist, 0); const b = await chromium.launch(); const found = [];
  for (const [name, vp, scheme] of [['light-desktop', { width: 1280, height: 860 }, 'light'], ['dark-desktop', { width: 1280, height: 860 }, 'dark'], ['light-phone', { width: 390, height: 844 }, 'light']]) {
    const ctx = await b.newContext({ viewport: vp, colorScheme: scheme }); const p = await ctx.newPage(); const U = site.url + '/#';
    const scan = async (id) => { await p.waitForTimeout(700); await p.addScriptTag({ content: axeSrc });
      const vs = await p.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((x) => x.target.join(' ') + ' :: ' + String(x.failureSummary || '').split('\n')[1]) })));
      for (const v of vs) found.push(`${name} / ${id}: ${v.id} (${v.impact}) x${v.n} :: ${v.sample.join(' | ').slice(0, 300)}`); };
    await p.goto(U + '/'); await p.waitForSelector('.hero'); await scan('home');
    await p.goto(U + '/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await scan('files');
    await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); await scan('new-quiz');
    await createQuiz(p, { count: 10, timeout: 120000 }); await scan('quiz-ready');
    await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await scan('solve');
    await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await scan('solve-answered');
    await p.click('aside button:has-text("تسليم")'); await p.waitForSelector('.modal'); await p.click('.modal button.primary'); await p.waitForFunction(() => location.hash.includes('/result')); await p.waitForSelector('h1'); await scan('result');
    await p.goto(U + '/cards'); await p.waitForSelector('h1'); await scan('cards');
    await p.goto(U + '/quizzes'); await p.waitForSelector('h1'); await scan('quizzes');
    await ctx.close();
  }
  await b.close(); await site.close(); found.forEach((l) => console.log(l)); if (found.length) { console.error('a11y violations: ' + found.length); process.exit(1); } console.log('axe: no WCAG 2.1 A/AA violations on any scanned screen (light / dark / phone)');
})().catch((e) => { console.error(e); process.exit(1); });
