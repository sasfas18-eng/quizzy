// node static-edition/test/run_web_learner.js <dist> <pdf>
// The self-learning agent on the real site: students' answers (practice, a handed-in exam) and a report on a question teach it, with nothing to set up;
// before 30 answers it only collects; then the operator page shows what it learned (forms, difficulty, discrimination, lures); it survives a reload;
// a visitor cannot read or reset it; the operator can reset it; and quizzes keep their full count while it steers the generator.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
(async () => {
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',llm:[]};"); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const api = (method, url, body) => p.evaluate(async ([m, u, x]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, body: await r.json() }; }, [method, url, body]);
  // a quiz from the lecture, no AI
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
  await p.goto(site.url + '/#/new'); await createQuiz(p, { count: 20 });
  const quiz = (await api('GET', '/api/quizzes')).body[0]; const qs = (await api('GET', `/api/quizzes/${quiz.id}/questions`)).body;
  assert.strictEqual(qs.length, 20); assert(qs.every((q) => q.form), 'every local question names the form that wrote it');
  // 1) a visitor (no operator mode) cannot read or reset what the agent learned
  assert.strictEqual((await api('GET', '/api/learner')).status, 403, 'visitor: no access'); assert.strictEqual((await api('POST', '/api/learner/reset')).status, 403);
  // 2) practice: the first answer through the real screen, the rest through the same route the screen uses; ~60 % right
  let att = (await api('POST', `/api/quizzes/${quiz.id}/attempts`, { mode: 'practice' })).body; await p.goto(site.url + `/#/attempt/${att.id}`); await p.waitForSelector('.opts button[role=radio]');
  await p.click('.opts button[role=radio] >> nth=0'); await p.waitForFunction(() => document.querySelector('.opts button[role=radio]').disabled, null, { timeout: 15000 });      // revealed (practice)
  const pick = (q, i) => (i % 5 < 3 ? q.correct_option_id : q.options.find((o) => o.id !== q.correct_option_id).id);
  const order = att.questions ? att.questions.map((q) => q.id) : qs.map((q) => q.id); const first = order[0];
  for (const [i, q] of qs.entries()) if (q.id !== first) { const r = await api('PUT', `/api/attempts/${att.id}/answer`, { question_id: q.id, option_id: pick(q, i) }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); }
  await api('POST', '/api/operator', { on: true }); let st = (await api('GET', '/api/learner')).body;
  console.log(`2) practice: learned from ${st.answers} answers, ready=${st.ready}`); assert.strictEqual(st.answers, 20, 'every practice answer taught it once'); assert.strictEqual(st.ready, false, 'still collecting below 30');
  // 3) an exam, handed in: every answer counts, and discrimination is measured against the rest of the exam
  att = (await api('POST', `/api/quizzes/${quiz.id}/attempts`, { mode: 'exam' })).body;
  for (const [i, q] of qs.entries()) await api('PUT', `/api/attempts/${att.id}/answer`, { question_id: q.id, option_id: i % 4 ? q.correct_option_id : q.options.find((o) => o.id !== q.correct_option_id).id });
  st = (await api('GET', '/api/learner')).body; assert.strictEqual(st.answers, 20, 'an exam teaches nothing before it is handed in');
  await api('POST', `/api/attempts/${att.id}/submit`); await api('POST', `/api/attempts/${att.id}/submit`);
  st = (await api('GET', '/api/learner')).body; console.log(`3) exam handed in: ${st.answers} answers, ready=${st.ready}`); assert.strictEqual(st.answers, 40, 'handing in twice counts once'); assert.strictEqual(st.ready, true);
  const raw = (await api('GET', '/api/learner?export=1')).body.state; assert(Object.values(raw.forms).some((f) => f.hi && f.hi.n), 'the exam fed the upper group (75 % right)');
  // 4) a report on a question counts against the form that wrote it
  const rq = qs[1]; await api('POST', '/api/reports', { target_type: 'question', target_id: rq.id, kind: 'wrong_answer', message: 'test' });
  st = (await api('GET', '/api/learner')).body; assert.strictEqual(st.reports, 1); assert.strictEqual(st.forms.find((f) => f.form === rq.form).reports, 1, 'the report reached ' + rq.form);
  console.log('4) report on a ' + rq.form + ' question counted');
  // 5) the operator page shows it; it survives a reload
  await p.goto(site.url + '/#/operator'); await p.reload(); await p.waitForSelector('#learner-box #learner-state');
  assert.strictEqual(await p.getAttribute('#learner-state', 'data-ready'), '1'); const rows = await p.$$eval('#learner-forms tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  assert(rows.length >= 2, 'forms listed'); assert(await p.isVisible('#learner-muts li'), 'lure rates listed'); assert(/تعلّم من 40 إجابة و1 بلاغ/.test(await p.innerText('#learner-state')), await p.innerText('#learner-state'));
  console.log('5) operator panel: ' + (await p.innerText('#learner-state')).replace(/\s+/g, ' ') + ' | ' + rows.slice(0, 3).join(' / '));
  await p.locator('#learner-box').scrollIntoViewIfNeeded(); await p.locator('#learner-box').screenshot({ path: '/tmp/shots/learner_desktop.png' });
  // 6) quizzes keep their count while the agent steers the generator
  await p.goto(site.url + '/#/new'); await createQuiz(p, { count: 20 }); const q2 = (await api('GET', '/api/quizzes')).body[0]; const qs2 = (await api('GET', `/api/quizzes/${q2.id}/questions`)).body;
  assert.strictEqual(qs2.length, 20, 'still 20'); qs2.forEach((q) => assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4)); console.log('6) a quiz after learning: ' + qs2.length + ' questions');
  // 7) mobile, then reset
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await seedAccount(m); const mp = await m.newPage(); mp.on('pageerror', (e) => errs.push(e.message));
  await mp.goto(site.url + '/#/'); await mp.evaluate(() => fetch('/api/operator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}' }));
  await mp.goto(site.url + '/#/operator'); await mp.waitForSelector('#learner-state'); const over = await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert(over <= 1, 'no sideways scroll on a phone: ' + over);
  assert.strictEqual(await mp.getAttribute('#learner-state', 'data-ready'), '0', 'another device learns on its own'); assert(!/\bnull\b|undefined/.test(await mp.innerText('#learner-box')), 'no stray null/undefined');
  await mp.locator('#learner-box').scrollIntoViewIfNeeded(); await mp.locator('#learner-box').screenshot({ path: '/tmp/shots/learner_mobile.png' }); await m.close();
  await p.goto(site.url + '/#/operator'); await p.waitForSelector('#learner-reset'); await p.click('#learner-reset'); await p.click('.modal button.danger');
  await p.waitForSelector('#learner-state[data-ready="0"]'); assert.strictEqual((await api('GET', '/api/learner')).body.answers, 0, 'reset'); console.log('7) phone layout ok; reset ok');
  console.log('ERRS', JSON.stringify(errs)); assert.deepStrictEqual(errs, []);
  await b.close(); await site.close(); console.log('learner E2E ok');
})().catch((e) => { console.error(e); process.exit(1); });
