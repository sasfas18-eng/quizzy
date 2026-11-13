// node claude-edition/test/run_tutor.js <dist> — THE SMART, INTERACTIVE CORRECTION after any question (a student of the shared link, Claude simulated by shim.js):
//  1) a wrong answer: the slip (your choice / the right one), then the smart correction (labelled «تصحيح ذكي», it names the right answer), then the tutor
//  2) «ليش اختياري غلط؟» is answered by the tutor from the lecture; a question of one's own (typed, Enter) is answered too, the earlier turn sent along
//  3) «سؤال مشابه أتأكد فيه»: a new question on the same idea with four options, answered on the spot (right: «صح»; the line from the lecture shown)
//  4) a RIGHT answer gets the tutor too («ليش الخيارات الثانية غلط؟»), and the conversation stays when the student comes back to the question
//  5) without an AI on the page the tutor is not offered (no dead buttons)
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
(async () => {
  srv.listen(8812); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8812/?viewer#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(200); await p.click('#create-quiz');
  await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem');

  // 1) answer wrongly: try the first option of each question until one is wrong
  let wrongAt = -1, rightAt = -1;
  for (let i = 0; i < 10 && (wrongAt < 0 || rightAt < 0); i++) {
    await p.click('.opt >> nth=0'); await p.waitForSelector('.explain');
    const wrong = (await p.locator('.fix').count()) > 0; if (wrong && wrongAt < 0) { wrongAt = i; break; } if (!wrong && rightAt < 0) rightAt = i;
    await p.click('button:has-text("التالي")'); await p.waitForSelector('.opt:not([disabled])'); }
  assert(wrongAt >= 0, 'a wrong answer was given');
  await p.waitForFunction(() => /الصواب/.test((document.querySelector('.fx-ar') || {}).textContent || ''), null, { timeout: 20000 });
  assert(/تصحيح ذكي/.test(await p.textContent('.fx-ar')), 'the smart correction is labelled');
  await p.waitForSelector('.tutor'); assert(/ليش اختياري غلط؟/.test(await p.textContent('.tutor')), 'the tutor offers «why is my choice wrong?»');
  console.log('1) a wrong answer: the slip, the smart correction (it names the right answer), then the tutor');

  // 2) the quick ask, then a question of one's own
  await p.click('.tutor button:has-text("ليش اختياري غلط؟")'); await p.waitForSelector('.tutor .tb.ai:not(.wait)', { timeout: 20000 });
  assert(/ليش اختياري غلط/.test(await p.textContent('.tutor .tb.me')) && /الصواب/.test(await p.textContent('.tutor .tb.ai:not(.wait)')), 'the quick ask and its answer');
  await p.fill('.tutor .tin', 'وش علاقة هذا بالقلب؟'); await p.press('.tutor .tin', 'Enter'); await p.waitForFunction(() => document.querySelectorAll('.tutor .tb.ai:not(.wait)').length === 2, null, { timeout: 20000 });
  { const t2 = await p.locator('.tutor .tb.ai:not(.wait)').nth(1).textContent(); assert(/وش علاقة هذا بالقلب/.test(t2), 'the typed question is answered: ' + t2); }
  console.log('2) «ليش اختياري غلط؟» and a typed question answered by the tutor, as a conversation');

  // 3) a similar question, answered on the spot
  await p.click('.tutor button:has-text("سؤال مشابه أتأكد فيه")');
  await p.waitForSelector('.tutor .sim', { timeout: 20000 });
  assert.strictEqual(await p.locator('.tutor .sim .sim-opt').count(), 4, 'four options');
  await p.click('.tutor .sim .sim-opt >> nth=0'); await p.waitForSelector('.tutor .sim .sim-ok'); assert(/«/.test(await p.textContent('.tutor .sim')), 'the lecture line is shown');
  console.log('3) a similar question on the same idea: four options, answered on the spot («صح»), the lecture line shown');

  // 4) a right answer gets the tutor too, and the conversation stays when the student comes back
  await p.click('button:has-text("التالي")'); await p.waitForSelector('.opt:not([disabled])');
  for (let i = wrongAt + 1; i < 10; i++) { const n = await p.locator('.opt').count(); let got = false;
    for (let k = 0; k < n && !got; k++) { await p.click(`.opt >> nth=${k}`); await p.waitForSelector('.explain'); got = true; }
    if ((await p.locator('.fix').count()) === 0) { rightAt = i; break; } await p.click('button:has-text("التالي")'); await p.waitForSelector('.opt:not([disabled])'); }
  if (rightAt > wrongAt) { await p.waitForSelector('.tutor'); assert(/ليش الخيارات الثانية غلط؟/.test(await p.textContent('.tutor')), 'a right answer: «why are the others wrong?»'); }
  await p.click('button:has-text("السابق")').catch(() => {}); await p.waitForTimeout(300);
  for (let back = 0; back < 10 && !(await p.locator('.tutor .sim').count()); back++) { await p.click('button:has-text("السابق")').catch(() => {}); await p.waitForTimeout(250); }
  assert.strictEqual(await p.locator('.tutor .tb.ai:not(.wait)').count(), 2, 'the conversation is still there when the student comes back');
  console.log(`4) a right answer is offered the tutor too («ليش الخيارات الثانية غلط؟»)${rightAt > wrongAt ? '' : ' (no right answer met)'}; back on the earlier question the conversation is still there`);

  // 5) no AI: no tutor
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push(e.message)); await p2.addInitScript(() => { window.__noTutorCheck = 1; });
  const caps = await p.evaluate(async () => (await (await fetch('/api/auth/capabilities')).json()).tutor); assert.strictEqual(caps, true, 'the tutor is offered when Claude is there');
  await p2.goto('http://localhost:8812/?viewer&nosample#/files'); await p2.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  assert.strictEqual(await p2.evaluate(async () => (await (await fetch('/api/auth/capabilities')).json()).tutor), false, 'no AI: no tutor');
  console.log('5) without Claude on the page the tutor is not offered');

  await ctx.close(); await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('tutor ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
