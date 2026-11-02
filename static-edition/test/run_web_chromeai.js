// node static-edition/test/run_web_chromeai.js <dist> <pdf>
// The composer's zero-cost AI on the real site: the model built into the browser (Chrome's on-device `LanguageModel`, simulated here with the same API).
//  1) the operator page shows its state on this device ("downloadable" -> the operator downloads it with one click -> "available");
//  2) a quiz made in a browser that has the model: the questions are checked blind (and the stems polished) within the 10 s budget, the count is kept,
//     and the operator page reports what the last quiz did; 3) nothing is sent anywhere: no request leaves the machine.
const { chromium } = require('playwright'); const assert = require('assert');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2);
const FAKE = () => { let state = 'downloadable'; window.__aiCalls = 0;
  window.LanguageModel = { availability: async () => state, create: async (o) => { if (o && o.monitor) { const t = new EventTarget(); o.monitor(t); t.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1 })); } state = 'available';
    return { destroy() {}, prompt: async (p) => { window.__aiCalls++; await new Promise((r) => setTimeout(r, 20));
      if (/^SOURCE:/.test(p)) { const src = p.split('\n')[0].toLowerCase(); const opts = p.split('\n').filter((l) => /^[ABCD]\) /.test(l)); const i = opts.findIndex((l) => src.includes(l.slice(3).toLowerCase().slice(0, 25))); return 'ABCD'[Math.max(0, i)]; }
      return p.split('QUESTION: ')[1]; } }; } }; };
(async () => {
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};"); const b = await chromium.launch(); const errs = [], outside = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); await ctx.addInitScript(FAKE); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  p.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) outside.push(r.url()); });
  // 1) the operator's card: downloadable -> one click -> available
  await p.goto(site.url + '/#/operator'); await p.click('#op-on'); await p.waitForSelector('#chrome-ai-state'); assert.strictEqual(await p.getAttribute('#chrome-ai-state', 'data-state'), 'downloadable');
  await p.click('#chrome-ai-download'); await p.waitForSelector('#chrome-ai-state[data-state="available"]'); console.log('1) operator: downloadable -> downloaded with one click -> available');
  // 2) a quiz in this browser: checked by the built-in model within the budget, the count kept
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
  await p.goto(site.url + '/#/new'); const t0 = Date.now(); await createQuiz(p, { count: 10, timeout: 60000 }); const ms = Date.now() - t0;
  const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
  assert.strictEqual(qs.length, 10, '10 questions'); const calls = await p.evaluate(() => window.__aiCalls); assert(calls >= 5, 'the built-in model was asked: ' + calls); assert(ms < 25000, 'within the budget: ' + ms);
  await p.goto(site.url + '/#/operator'); await p.waitForSelector('#chrome-ai-last'); const last = await p.textContent('#chrome-ai-last'); assert(/فُحص \d+ سؤالًا/.test(last), last);
  console.log(`2) quiz with the built-in model: 10 questions in ${ms} ms, ${calls} prompts on the device; operator page: ${last.trim()}`);
  // 3) nothing left this machine
  assert.deepStrictEqual(outside, [], 'no request left the machine: ' + outside.join(' | ')); console.log('3) no request left the machine');
  console.log('ERRS', JSON.stringify(errs)); assert.deepStrictEqual(errs, []); await b.close(); await site.close(); console.log('chrome ai E2E ok');
})().catch((e) => { console.error(e); process.exit(1); });
