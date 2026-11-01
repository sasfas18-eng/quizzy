// node static-edition/test/run_web_ai_pipeline.js <dist> <pdf> — the AI path in a real browser against an HTTP provider (mock): the lecture PROFILER and the analysis cache.
//  1) the first quiz: the objective analysis AND the profiler's request both go to the provider (the profiler is a separate, dedicated request), the quiz is made by the AI;
//     nothing of the profile / analysis / statistics is shown on the page
//  2) a second quiz from the SAME lecture (a different count): the whole analysis phase is skipped - no analyze request, no profiler request - and it still delivers
//  3) it survives a reload (kept on the device); other pages of the file are analysed again
const { chromium } = require('playwright'); const assert = require('assert');
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const { seedAccount, EMAIL, PASSWORD } = require('./signin.js'); const { assertHidden, createQuiz, reportOf } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2); const fs = require('fs');
(async () => {
  const llm = await startLLM(); const site = await serve(dist, 0); const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/429|favicon/.test(m.text())) errs.push('C ' + m.text().slice(0, 200)); });
  const U = site.url + '/#'; const kinds = () => ({ ...llm.stats.calls });
  await p.goto(U + '/operator'); await p.waitForSelector('#op-on'); await p.click('#op-on'); await p.waitForSelector('h1:has-text("ذكاء المشغل")'); await p.click('details summary'); await p.selectOption('#preset', 'custom'); await p.fill('#base', llm.url); await p.fill('#key', 'sk-123456'); await p.fill('#rpm', '300');
  await p.click('form:has-text("إضافة مزوّد") button[type=submit]'); await p.waitForSelector('text=المفاتيح المربوطة');
  const toNewQuiz = async () => { await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); };
  await p.goto(U + '/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table');
  for (const k of Object.keys(llm.stats.calls)) delete llm.stats.calls[k];      // the connection test is not part of the count

  // ---- 1) the first quiz
  await toNewQuiz(); await createQuiz(p, { count: 10, timeout: 120000 }); const c1 = kinds();
  assert(c1.analyze >= 1, 'the objectives were analysed by the provider: ' + JSON.stringify(c1)); assert(c1.profile >= 1, 'the profiler made its own request: ' + JSON.stringify(c1)); assert(c1.generate >= 1 && c1.verify >= 1);
  assert(/ذكاء اصطناعي/.test(await reportOf(p)), 'made by the AI'); await assertHidden(p, 'the ready page of an AI quiz');
  const html = (await p.textContent('body')).replace(/\s+/g, ' '); assert(!/capacity|profile|الملف التحليلي|دعم النوع/i.test(html), 'no trace of the profile on the page');
  const q1 = await p.evaluate(async () => { const id = location.hash.split('/quiz/')[1]; const q = await (await fetch('/api/quizzes/' + id)).json(); return { plan: q.plan, delivered: q.report.delivered }; });
  assert(q1.plan && q1.plan.profile && q1.plan.profile.basic_recall && q1.plan.profile.basic_recall.capacity > 0, 'the plan kept the profile internally (API only)'); assert(q1.plan.profile.sequence.capacity === 0, 'a lecture of plain statements: no sequence'); assert.strictEqual(q1.plan.distribution.sequence, 0);
  console.log('1) first quiz: analysis + a dedicated profiler request (' + JSON.stringify(c1) + '); nothing of it on the page; the plan keeps the profile internally');

  // ---- 2) the same lecture again: the analysis phase is skipped
  for (const k of Object.keys(llm.stats.calls)) delete llm.stats.calls[k];
  await toNewQuiz(); await createQuiz(p, { count: 20, timeout: 120000 }); const c2 = kinds();
  assert(!c2.analyze && !c2.profile, 'the same lecture: no analysis request and no profiler request: ' + JSON.stringify(c2)); assert(c2.generate >= 1, 'generation still ran'); assert(/ذكاء اصطناعي/.test(await reportOf(p)));
  const n2 = await p.evaluate(async () => { const id = location.hash.split('/quiz/')[1]; return (await (await fetch('/api/quizzes/' + id)).json()).report.delivered; }); assert(n2 >= 10, 'and delivered: ' + n2);
  console.log('2) the same lecture again (another count): no analyze / profile request at all (' + JSON.stringify(c2) + ')');

  // ---- 3) kept on the device; other pages are another analysis
  await p.reload(); for (const k of Object.keys(llm.stats.calls)) delete llm.stats.calls[k];
  await toNewQuiz(); await createQuiz(p, { count: 10, timeout: 120000 }); assert(!kinds().analyze && !kinds().profile, 'still cached after a reload');
  const kept = await p.evaluate(async () => new Promise((res) => { const r = indexedDB.open('quizzy_web_v1', 1); r.onsuccess = () => { const t = r.result.transaction('kv', 'readonly'); const k = t.objectStore('kv').getAllKeys(); t.oncomplete = () => res(k.result.filter((x) => String(x).startsWith('acache_')).length); }; })); assert.strictEqual(kept, 1, 'one analysis kept');
  // a different part of the lecture is a different analysis: it is analysed again (and kept next to the first)
  for (const k of Object.keys(llm.stats.calls)) delete llm.stats.calls[k];
  await toNewQuiz(); await p.click('button:has-text("استبعد")'); await p.fill('input[aria-label="نطاق الصفحات"]', '1-2'); await p.click('.chips button:text-is("10")'); await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  assert(kinds().analyze >= 1 && kinds().profile >= 1, 'other pages: analysed again ' + JSON.stringify(kinds()));
  console.log('3) kept after a reload (' + kept + ' analysis on the device); other pages of the file are analysed again');

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('AI pipeline (profiler + analysis cache) E2E ok'); await b.close(); await site.close(); await llm.close();
})().catch((e) => { console.error(e); process.exit(1); });
