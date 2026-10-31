// node static-edition/test/run_web_local.js <dist> <pdf>  — device mode (no Supabase): BYOK provider key -> real HTTP generation -> solve -> print PDF.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const assert = require('assert'); const { assertHidden, createQuiz } = require('../../claude-edition/test/flow.js');
fs.mkdirSync('/tmp/shots', { recursive: true });
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const [dist, pdf, outPdf = '/tmp/web-quiz.pdf'] = process.argv.slice(2);
const junk = async (p, where) => { const t = ((await p.textContent('body')) || '').replace(/\s+/g, ' '); assert(!/\b(null|undefined|false)\b|\[object/.test(t), `stray null/false text on ${where}: ${t.slice(0, 80)}`); };
(async () => {
  const llm = await startLLM(); const site = await serve(dist, 0); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push('PE ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|favicon/.test(m.text())) errs.push('C ' + m.text()); });
  const U = site.url + '/#'; const S = (n) => p.screenshot({ path: `/tmp/shots/web-${n}.png`, fullPage: true });
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(300); console.log('banner:', (await p.textContent('#ce-banner')).slice(0, 50));
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await junk(p, 'files');
  // no AI yet: the new-quiz page offers ONE thing — paste a key once (no mode choice, no token wording, no question-type choices)
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#connect-ai'); await assertHidden(p, 'new-quiz page (no key)'); await S('connect');
  await p.click('.chips button:text-is("10")'); await p.click('#create-quiz'); await p.waitForTimeout(250); assert(p.url().includes('/new') && await p.locator('#connect-ai').count() === 1, 'without a key nothing starts; the connect card stays');
  assert((await p.evaluate(async () => (await (await fetch('/api/quizzes')).json()).length)) === 0, 'no empty draft left behind');
  // quick connect: the provider is Google's real address (native Gemini API); the browser is pointed at the mock through request
  // interception (CORS headers included) which translates generateContent <-> the OpenAI-style mock
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  const gemSeen = [];
  await p.context().route('https://generativelanguage.googleapis.com/**', async (route) => { const req = route.request(); const u = new URL(req.url()); const key = req.headers()['x-goog-api-key'] || '';
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    gemSeen.push(req.method() + ' ' + u.pathname + u.search);
    if (u.pathname === '/v1beta/models') return route.fulfill({ status: key ? 200 : 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ models: [['gemini-2.0-flash', 'generateContent'], ['gemini-2.5-flash', 'generateContent'], ['gemini-2.5-pro', 'generateContent'], ['text-embedding-004', 'embedContent']].map(([n, m]) => ({ name: 'models/' + n, supportedGenerationMethods: [m, 'countTokens'] })) }) });
    const m = u.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (m && req.method() === 'POST') { const body = JSON.parse(req.postData()); assert.strictEqual(body.generationConfig.responseMimeType, 'application/json'); assert(!req.url().includes('key='), 'the key never goes in the URL');
      const r = await fetch(llm.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: m[1], messages: [{ role: 'system', content: body.systemInstruction.parts[0].text }, { role: 'user', content: body.contents[0].parts[0].text }] }) });
      const h = { ...CORS, 'content-type': 'application/json' }; if (r.headers.get('retry-after')) h['retry-after'] = r.headers.get('retry-after');
      if (!r.ok) return route.fulfill({ status: r.status, headers: h, body: await r.text() });
      const out = (await r.json()).choices[0].message.content; return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: out }] }, finishReason: 'STOP' }] }) }); }
    return route.fulfill({ status: 404, headers: CORS, body: '{}' }); });
  await p.fill('#quick-key', 'AIza-test-secret-1234'); await p.click('#quick-go'); await p.waitForFunction(() => !document.querySelector('#connect-ai'), null, { timeout: 20000 });
  assert.strictEqual(llm.stats.lastAuth, 'Bearer AIza-test-secret-1234'); assert(llm.stats.models.includes('gemini-2.5-flash'), 'the newest stable flash model was picked from what the key can use, with no model typed: ' + llm.stats.models);
  assert(gemSeen[0].startsWith('GET /v1beta/models?pageSize=200'), 'discovery went through the native models list: ' + gemSeen[0]);
  console.log('quick connect ok: model =', [...new Set(llm.stats.models)].join(','), '| test call kind:', JSON.stringify(llm.stats.calls));
  // the key is listed (masked) on the connect page; an advanced provider with a blank model discovers one too
  await p.goto(U + '/settings'); await p.waitForSelector('text=المفاتيح المربوطة'); await assertHidden(p, 'settings page'); const mainTxt = await p.textContent('main'); assert(mainTxt.includes('…1234') && !mainTxt.includes('AIza-test-secret'), 'key is masked in the UI');
  await p.click('details summary'); await p.selectOption('#preset', 'custom'); await p.fill('#base', llm.url); await p.fill('#key', 'sk-test-secret-5678'); await p.fill('#rpm', '300'); await p.click('form:has-text("إضافة مزوّد") button[type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('.card .row.between').length >= 2, null, { timeout: 15000 }); assert((await p.textContent('main')).includes('mock-model'), 'model discovered for the advanced provider');
  await p.click('button:has-text("اختبار") >> nth=0'); await p.waitForSelector('span:has-text("✓ يعمل")'); console.log('key test:', (await p.textContent('span:has-text("✓ يعمل")')).trim().slice(0, 30)); await S('settings');
  await p.click('button:has-text("حذف") >> nth=1'); await p.click('.modal button:has-text("حذف")'); await p.waitForFunction(() => !document.body.textContent.includes('sk-test') && document.querySelectorAll('.card .row.between').length === 1);
  llm.stats.calls = {}; llm.stats.models.length = 0;
  // AI generation through the pool: ONE click creates the quiz, analysis + generation chain automatically, no plan screen
  await p.goto(U + '/files'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); assert((await p.locator('#connect-ai').count()) === 0, 'connected: the card is gone');
  await createQuiz(p, { wait: 'none' }); await p.waitForSelector('#stage, .progress, h2:has-text("جاهز للحل")'); await S('progress'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 60000 }); await S('ready'); await junk(p, 'ready'); await assertHidden(p, 'ready page');
  const rep = (await p.textContent('text=تقرير الجودة >> xpath=..')).replace(/\s+/g, ' '); console.log('report:', rep.slice(0, 160)); assert(/ذكي \(بمفتاح المستخدم\)/.test(rep), 'generator label');
  console.log('provider calls:', JSON.stringify(llm.stats.calls), 'models:', [...new Set(llm.stats.models)].join(','));
  assert(llm.stats.calls.analyze >= 1 && llm.stats.calls.generate >= 1 && llm.stats.calls.verify >= 1 && llm.stats.calls.explain >= 1); assert(llm.stats.calls.verify <= llm.stats.calls.generate + 1, 'verification is batched');
  // solve + resume
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await junk(p, 'solve'); await assertHidden(p, 'solve page'); await p.reload(); await p.waitForSelector('.stem'); console.log('resumed after reload:', await p.textContent('.qhead .badge'));
  // print view -> real PDF
  await p.goBack().catch(() => {}); await p.goto(U + '/quizzes'); await p.click('table a'); await p.click('a:has-text("PDF مع مفتاح")'); await p.waitForSelector('.printdoc .pq'); await S('print'); await junk(p, 'print');
  const nq = await p.locator('.printdoc .pq').count(); await p.pdf({ path: outPdf, format: 'A4', printBackground: true, preferCSSPageSize: true }); console.log('print view questions:', nq, 'pdf bytes:', fs.statSync(outPdf).size);
  // rate-limit failover handled by the pool: a 429 burst is waited out, not surfaced
  await p.goto(U + '/cards'); await p.waitForSelector('button:has-text("توليد بطاقات")'); await fetch(llm.url.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify({ rate429: 2 }) }); await p.click('button:has-text("توليد بطاقات")'); await p.waitForSelector('table', { timeout: 40000 });
  console.log('cards rows after 429 burst:', await p.locator('tbody tr').count()); await p.goto(U + '/cards/study'); await p.waitForSelector('.flip'); await junk(p, 'card study');
  // device-only account page: export + wipe
  await p.goto(U + '/account'); await p.waitForSelector('text=مسح بياناتي من هذا الجهاز'); assert((await p.locator('text=تغيير كلمة المرور').count()) === 0);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('a:has-text("تصدير بياناتي")')]); const exp = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); console.log('export:', exp.documents.length, 'docs', exp.quizzes.length, 'quizzes', exp.flashcards.length, 'cards'); assert(exp.documents[0].pages.length > 0 && exp.documents[0].pages[0].text.length > 0);
  await p.click('button:has-text("مسح بياناتي")'); await p.click('.modal button:has-text("امسح")'); await p.goto(U + '/files'); await p.waitForSelector('.empty'); console.log('wiped -> empty list');
  console.log('ERRS', JSON.stringify(errs)); await b.close(); await site.close(); await llm.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
