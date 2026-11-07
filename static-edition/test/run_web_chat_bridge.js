// node static-edition/test/run_web_chat_bridge.js <dist> <pdf>
// The GitHub Pages edition can hand a source-bounded request to a consumer ChatGPT/Claude chat and import the JSON response without an API key.
// The website never calls either chat. Import is atomic: responses with no valid questions preserve the local quiz;
// a smaller set of valid questions is accepted with an explicit shortfall and keeps source evidence.
const { chromium } = require('playwright');
const assert = require('assert');
const serve = require('./serve.js');
const { seedAccount } = require('./signin.js');
const [dist, pdf] = process.argv.slice(2);

(async () => {
  const site = await serve(dist, 0); const browser = await chromium.launch(process.env.QZ_CHROMIUM ? { executablePath: process.env.QZ_CHROMIUM, args: ['--no-sandbox'] } : {}); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text())) errors.push(m.text()); });
  await seedAccount(page.context()); await page.goto(site.url + '/#/files'); await page.setInputFiles('#file', pdf); await page.waitForSelector('table'); await page.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await page.click('a:has-text("التفاصيل")'); await page.click('a:has-text("إنشاء كويز")'); await page.waitForSelector('#create-chat-quiz'); await page.click('.chips button:text-is("10")'); await page.click('#create-chat-quiz'); await page.waitForSelector('#draft-chatgpt');
  assert.strictEqual(await page.locator('#draft-claude').count(), 1, 'both manual chat providers are offered'); assert(await page.locator('#start-local.btn.primary').count() === 1, 'automatic local creation is the primary action'); assert(await page.locator('text=لا يوجد ربط تلقائي بالحساب').count() >= 1); if (process.env.QZ_SELECTION_SHOT) await page.screenshot({ path: process.env.QZ_SELECTION_SHOT, fullPage: true }); await page.click('#draft-chatgpt'); await page.waitForSelector('button:has-text("انسخ وافتح ChatGPT")'); assert(await page.locator('button:has-text("انسخ وافتح Claude")').count() === 1); assert(await page.locator('.modal:has-text("هذه الخطوات يدوية وليست ربط حساب")').count() === 1); if (process.env.QZ_AR_SHOT) await page.screenshot({ path: process.env.QZ_AR_SHOT, fullPage: true }); await page.click('.modal button:has-text("إلغاء")');
  await page.evaluate(() => document.querySelector('#lang-quick').click()); await page.waitForFunction(() => document.documentElement.lang === 'en'); await page.waitForSelector('#draft-claude:has-text("Manually copy to Claude")'); await page.click('#draft-claude'); await page.waitForSelector('.modal button:has-text("Copy and open ChatGPT")'); await page.waitForTimeout(150);
  const untranslated = await page.evaluate(() => { const c = document.querySelector('.modal').cloneNode(true); c.querySelectorAll('textarea,pre,code,[translate="no"]').forEach((x) => x.remove()); return (c.textContent.match(/[؀-ۿ]+/g) || []).join(' '); });
  assert.strictEqual(untranslated, '', 'chat bridge English UI has Arabic left: ' + untranslated); assert(!/[؀-ۿ]/.test(await page.locator('.modal textarea').nth(1).getAttribute('placeholder'))); if (process.env.QZ_SHOT) await page.screenshot({ path: process.env.QZ_SHOT, fullPage: true }); if (process.env.QZ_MOBILE_SHOT) { await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile chat bridge has horizontal overflow'); await page.screenshot({ path: process.env.QZ_MOBILE_SHOT, fullPage: true }); } await page.click('.modal button:has-text("Cancel")');

  const result = await page.evaluate(async () => {
    const get = async (url, init) => { const r = await fetch(url, init); let j; try { j = await r.json(); } catch { j = {}; } return { status: r.status, body: j }; };
    const quizzes = await (await fetch('/api/quizzes')).json(), q = quizzes[0], before = await (await fetch(`/api/quizzes/${q.id}/questions`)).json();
    const bridge = await get(`/api/quizzes/${q.id}/chat-bridge`); const bad = await get(`/api/quizzes/${q.id}/chat-bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'chatgpt', response: '{"questions":[]}' }) });
    const afterBad = await (await fetch(`/api/quizzes/${q.id}/questions`)).json(); const docs = await (await fetch('/api/documents')).json(); const doc = await (await fetch('/api/documents/' + docs[0].id)).json();
    const source = []; for (const meta of doc.pages) { if (!['ok', 'low_text'].includes(meta.status)) continue; const p = await (await fetch(`/api/documents/${doc.id}/pages/${meta.page_no}`)).json(); const lines = String(p.text || '').split(/\n|(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 35); for (const quote of lines) source.push({ ref: `d1p${meta.page_no}`, quote }); }
    if (!source.length) throw new Error('fixture has no source lines'); const stems = [
      'Which phrase is explicitly present in the cited lecture evidence?', 'Identify the source term documented by this passage.',
      'What wording is supported directly by the selected source section?', 'Select the expression that the lecture passage actually contains.',
      'Which option matches the factual detail in this part of the lecture?', 'The cited section explicitly names which of these items?'
    ]; const types = ['basic_recall', 'understanding', 'mechanisms', 'application', 'critical_thinking', 'best_answer'];
    const purposes = ['Recognise one stated term.', 'Interpret a documented concept.', 'Locate one mechanism detail.', 'Apply one source statement.', 'Evaluate a factual claim.', 'Choose the best supported conclusion.'];
    const questions = stems.map((stem, i) => { const ev = source[i % source.length], words = ev.quote.slice(0, 240).match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) || [ev.quote.slice(0, 20)]; const key = words[i % words.length]; const options = [`UnsupportedAlpha${i}`, `UnsupportedBeta${i}`, `UnsupportedGamma${i}`, key]; const correct_index = i % 4; [options[correct_index], options[3]] = [options[3], options[correct_index]];
      return { qtype: types[i], stem, options, correct_index, explanation: `The cited passage explicitly contains “${key}”; the other choices are not stated in this evidence.`, purpose: purposes[i], evidence: [{ page: ev.ref, quote: ev.quote }] }; });
    const partial = await get(`/api/quizzes/${q.id}/chat-bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'chatgpt', response: JSON.stringify({ questions: questions.slice(0, 2), shortfall_reason: 'Only two distinct ideas were answered.' }) }) });
    const afterPartial = await (await fetch(`/api/quizzes/${q.id}`)).json();
    const good = await get(`/api/quizzes/${q.id}/chat-bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'claude', response: '```json\n' + JSON.stringify({ questions }) + '\n```' }) });
    const imported = await (await fetch(`/api/quizzes/${q.id}/questions`)).json(); const full = await (await fetch(`/api/quizzes/${q.id}`)).json();
    return { bridge, bad, before: before.length, afterBad: afterBad.length, partial, afterPartial, good, imported, full };
  });
  assert.strictEqual(result.bridge.status, 200); assert(/SOURCE_PAGES/.test(result.bridge.body.prompt)); assert.strictEqual(result.bridge.body.provider_urls.chatgpt, 'https://chatgpt.com/'); assert.strictEqual(result.bridge.body.provider_urls.claude, 'https://claude.ai/new');
  assert.strictEqual(result.bad.status, 422); assert.strictEqual(result.afterBad, result.before, 'bad import is atomic');
  assert.strictEqual(result.partial.status, 200, JSON.stringify(result.partial.body)); assert.strictEqual(result.afterPartial.report.delivered, 2); assert.strictEqual(result.afterPartial.report.shortfall.requested, 10);
  assert.strictEqual(result.good.status, 200, JSON.stringify(result.good.body)); assert.strictEqual(result.imported.length, 6);
  result.imported.forEach((q) => { assert.strictEqual(q.options.length, 4); assert(q.correct_option_id); assert(q.evidence.length && q.evidence[0].quote); assert.strictEqual(q.validation.verified.blind_solver, false); assert.strictEqual(q.validation.verified.external_chat, true); });
  assert(/Claude/.test(result.full.generator)); assert(result.full.report.shortfall && result.full.report.delivered === 6); assert.strictEqual(errors.length, 0, errors.join(' | '));
  console.log('chat bridge ok: student chose a provider, prompt prepared locally, invalid import preserved', result.before, 'questions, valid Claude import delivered', result.imported.length);
  await browser.close(); await site.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
