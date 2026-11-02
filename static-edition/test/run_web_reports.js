// node static-edition/test/run_web_reports.js <dist> <pdf>
// The students' reports on the real site, handled by the composer (the agent of the local generator) - there is no self-learning agent any more:
//  1) a visitor cannot read or reset the reports; answering questions teaches nothing (no learning from answers);
//  2) a report through the real screen («أبلغ عن مشكلة في هذا السؤال», kind «الإجابة الصحيحة غير صحيحة») and one through the same route: both handled at once;
//  3) the next quiz from the same lecture never contains a reported question, nor the wrongly-answered fact with the same form - and still has its full count;
//  4) reporting the same question again changes nothing; the operator page shows what was done, survives a reload, fits a phone, and can be reset.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
const norm = (t) => String(t || '').toLowerCase().replace(/^(مراجعة|review): /i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
(async () => {
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};"); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const api = (method, url, body) => p.evaluate(async ([m, u, x]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: x ? JSON.stringify(x) : undefined }); let j = null; try { j = await r.json(); } catch (_) { j = null; } return { status: r.status, body: j }; }, [method, url, body]);
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
  await p.goto(site.url + '/#/new'); await createQuiz(p, { count: 10 });      // (the 3-page fixture holds 11 real questions - no padding)
  const quiz = (await api('GET', '/api/quizzes')).body[0]; const qs = (await api('GET', `/api/quizzes/${quiz.id}/questions`)).body;
  assert.strictEqual(qs.length, 10); assert(qs.every((q) => q.form), 'every local question names the form that wrote it');
  // 1) a visitor cannot read or reset; answers teach nothing
  assert.strictEqual((await api('GET', '/api/composer/reports')).status, 403, 'visitor: no access'); assert.strictEqual((await api('POST', '/api/composer/reports/reset')).status, 403);
  const before = await p.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => /learn/i.test(k))));
  // 2) practice: answer the first question on the real screen, then report it from the same screen
  const att = (await api('POST', `/api/quizzes/${quiz.id}/attempts`, { mode: 'practice' })).body; await p.goto(site.url + `/#/attempt/${att.id}`); await p.waitForSelector('.opts button[role=radio]');
  const shownStem = await p.innerText('.stem'); await p.click('.opts button[role=radio] >> nth=0');
  await p.waitForFunction(() => document.querySelector('.opts button[role=radio]').disabled, null, { timeout: 15000 });
  for (const q of qs) await api('PUT', `/api/attempts/${att.id}/answer`, { question_id: q.id, option_id: q.correct_option_id });
  assert.strictEqual(await p.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => /learn/i.test(k)))), before, 'nothing is learned from answers');
  assert.notStrictEqual((await api('GET', '/api/learner')).status, 200, 'the self-learning agent is gone');
  await p.click('text=أبلغ عن مشكلة في هذا السؤال'); await p.waitForSelector('#rk'); await p.selectOption('#rk', 'wrong_key'); await p.click('.modal button.primary'); await p.waitForSelector('text=وصلنا بلاغك');
  const first = qs.find((q) => norm(q.stem) === norm(shownStem)); assert(first, 'the question on screen: ' + shownStem);
  const other = qs.find((q) => q.id !== first.id && q.form !== first.form) || qs.find((q) => q.id !== first.id);
  const r2 = (await api('POST', '/api/reports', { target_type: 'question', target_id: other.id, kind: 'unclear', message: '' })).body;
  assert(r2.handled && r2.handled.never_again && !r2.handled.fact_blocked, 'an unclear question: never written again, its fact stays: ' + JSON.stringify(r2.handled));
  await api('POST', '/api/operator', { on: true }); let st = (await api('GET', '/api/composer/reports')).body;
  console.log(`2) two reports handled: ${JSON.stringify({ total: st.total, blocked_questions: st.blocked_questions, blocked_facts: st.blocked_facts, kinds: st.kinds })}`);
  assert.strictEqual(st.total, 2); assert.strictEqual(st.blocked_questions, 2); assert.strictEqual(st.blocked_facts, 1, 'the wrong-answer report keeps that form off that fact');
  assert.deepStrictEqual(st.kinds, { wrong_key: 1, unclear: 1 }); assert(st.forms.find((f) => f.form === first.form).penalty > 0, 'the reported form is weighed down');
  // 3) the next quiz: neither reported question, nor the same form on the wrongly-answered fact; full count
  await p.goto(site.url + '/#/new'); await createQuiz(p, { count: 10 }); const q2 = (await api('GET', '/api/quizzes')).body[0]; const qs2 = (await api('GET', `/api/quizzes/${q2.id}/questions`)).body;
  const keyOf = (q) => norm((q.options.find((o) => o.id === q.correct_option_id) || {}).text); const sig = (q) => norm(q.stem) + '|' + keyOf(q);
  assert(qs2.length >= 8 && qs2.length <= 10, 'the real questions left without the two reported ones: ' + qs2.length); assert(!qs2.some((q) => sig(q) === sig(first) || sig(q) === sig(other)), 'no reported question comes back');
  assert(!qs2.some((q) => q.form === first.form && keyOf(q) === keyOf(first)), 'the same form does not ask the wrongly-answered fact again');
  console.log(`3) next quiz: ${qs2.length} questions, neither reported question, no ${first.form} on "${keyOf(first).slice(0, 40)}"`);
  // 4) the same report again changes nothing; operator page; reload; phone; reset
  await api('POST', '/api/reports', { target_type: 'question', target_id: other.id, kind: 'unclear' }); assert.strictEqual((await api('GET', '/api/composer/reports')).body.total, 2, 'a repeated report counts once');
  await p.goto(site.url + '/#/operator'); await p.reload(); await p.waitForSelector('#reports-box #reports-state'); assert.strictEqual(await p.getAttribute('#reports-state', 'data-total'), '2');
  assert(/2 بلاغ عولج/.test(await p.innerText('#reports-state')), await p.innerText('#reports-state')); assert.strictEqual((await p.$$eval('#reports-forms th', (t) => t.map((x) => x.textContent))).join('|'), 'الصياغة|النوع|بلاغات|إضعافها');
  assert(!(await p.$('#learner-box')), 'no learning-agent panel'); console.log('4) operator panel: ' + (await p.innerText('#reports-state')).replace(/\s+/g, ' '));
  await p.locator('#reports-box').scrollIntoViewIfNeeded(); await p.locator('#reports-box').screenshot({ path: '/tmp/shots/reports_desktop.png' });
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await seedAccount(m); const mp = await m.newPage(); mp.on('pageerror', (e) => errs.push(e.message));
  await mp.goto(site.url + '/#/'); await mp.evaluate(() => fetch('/api/operator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}' }));
  await mp.goto(site.url + '/#/operator'); await mp.waitForSelector('#reports-state'); const over = await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert(over <= 1, 'no sideways scroll on a phone: ' + over);
  assert(!/\bnull\b|undefined/.test(await mp.innerText('#reports-box')), 'no stray null/undefined'); await m.close();
  await p.click('#reports-reset'); await p.click('.modal button.danger'); await p.waitForSelector('#reports-state[data-total="0"]'); assert.strictEqual((await api('GET', '/api/composer/reports')).body.total, 0, 'reset');
  console.log('5) phone layout ok; reset ok');
  console.log('ERRS', JSON.stringify(errs)); assert.deepStrictEqual(errs, []);
  await b.close(); await site.close(); console.log('reports E2E ok');
})().catch((e) => { console.error(e); process.exit(1); });
