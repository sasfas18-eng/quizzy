// node static-edition/test/run_web_local.js <dist> <pdf>  — device mode (no Supabase): BYOK provider key -> real HTTP generation -> solve -> print PDF.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const assert = require('assert');
fs.mkdirSync('/tmp/shots', { recursive: true });
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const [dist, pdf, outPdf = '/tmp/web-quiz.pdf'] = process.argv.slice(2);
const junk = async (p, where) => { const t = ((await p.textContent('body')) || '').replace(/\s+/g, ' '); assert(!/(^| )(null|false|undefined|\[object)/.test(t), `stray null/false text on ${where}: ${t.slice(0, 80)}`); };
(async () => {
  const llm = await startLLM(); const site = await serve(dist, 0); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push('PE ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|favicon/.test(m.text())) errs.push('C ' + m.text()); });
  const U = site.url + '/#'; const S = (n) => p.screenshot({ path: `/tmp/shots/web-${n}.png`, fullPage: true });
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.waitForTimeout(300); console.log('banner:', (await p.textContent('#ce-banner')).slice(0, 50));
  await p.setInputFiles('#file', pdf); await p.waitForSelector('table'); await junk(p, 'files');
  // no key yet: only the rules generator is offered, with a pointer to Settings
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=طريقة التوليد'); assert(await p.locator('a:has-text("الإعدادات")').count() >= 1); console.log('chips without key:', await p.$$eval('.chips button', (x) => x.map((e) => e.textContent.trim()).filter((t) => /ذكي|توكن/.test(t)).join(' | ')));
  // add the provider key in Settings and test it
  await p.goto(U + '/settings'); await p.waitForSelector('text=إضافة مفتاح توليد'); await p.selectOption('#preset', 'custom'); await p.fill('#base', llm.url); await p.fill('#model', 'mock-model'); await p.fill('#key', 'sk-test-secret-1234'); await p.fill('#rpm', '300'); await p.click('button:has-text("إضافة")');
  await p.waitForSelector('text=مفاتيحك'); assert((await p.textContent('main')).includes('…1234') && !(await p.textContent('main')).includes('sk-test-secret'), 'key is masked in the UI');
  await p.click('button:has-text("اختبار")'); await p.waitForSelector('span:has-text("✓ يعمل")'); console.log('key test:', (await p.textContent('span:has-text("✓ يعمل")')).trim().slice(0, 30)); await S('settings');
  // AI generation through the pool
  await p.goto(U + '/files'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=طريقة التوليد'); await p.click('button:has-text("استبعد")'); await p.click('button:has-text("10")');
  console.log('chips with key:', await p.$$eval('.chips button', (x) => x.map((e) => e.textContent.trim()).filter((t) => /ذكي|توكن/.test(t)).join(' | ')));
  await p.click('button:has-text("متابعة: تحليل")'); await p.click('button:has-text("حلّل المحتوى")'); await p.waitForSelector('text=خطة الكويز', { timeout: 30000 });
  const gen = p.locator('button:has-text("ابدأ توليد")'); if (await gen.isDisabled()) await p.check('.card input[type=checkbox] >> nth=0'); await gen.click(); await p.waitForSelector('text=جاهز للحل', { timeout: 60000 }); await S('ready'); await junk(p, 'ready');
  const rep = (await p.textContent('text=تقرير الجودة >> xpath=..')).replace(/\s+/g, ' '); console.log('report:', rep.slice(0, 160)); assert(/ذكي \(بمفتاح المستخدم\)/.test(rep), 'generator label'); 
  console.log('provider calls:', JSON.stringify(llm.stats.calls), 'auth header ok:', llm.stats.lastAuth === 'Bearer sk-test-secret-1234', 'models:', [...new Set(llm.stats.models)].join(','));
  assert(llm.stats.calls.analyze >= 1 && llm.stats.calls.generate >= 1 && llm.stats.calls.verify >= 1 && llm.stats.calls.explain >= 1); assert(llm.stats.calls.verify <= llm.stats.calls.generate + 1, 'verification is batched');
  // solve + resume
  await p.click('button:has-text("ابدأ الحل")'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await p.click('.opt >> nth=0'); await p.waitForSelector('.explain'); await junk(p, 'solve'); await p.reload(); await p.waitForSelector('.stem'); console.log('resumed after reload:', await p.textContent('.qhead .badge'));
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
