// node static-edition/test/run_web_realistic.js <dist> <dir with slides_en.pptx slides_ar.pptx notes_en.pdf dense_en.pdf sparse.pdf>
// The user's goal, end to end in a real browser: put a file -> see the questions, with NOTHING to set up (the site's own AI provider comes
// from config.js). Also regression for "تعذر استخراج أهداف قابلة للاختبار": realistic slides/notes must give a quiz, a model that mangles the
// analysis format must not break it, and a file with almost no text must explain itself and offer a way forward.
const { chromium } = require('playwright'); const assert = require('assert'); const path = require('path');
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const { assertHidden, createQuiz } = require('../../claude-edition/test/flow.js'); const [dist, dir] = process.argv.slice(2);
const FILES = [['slides_en.pptx', 3], ['slides_ar.pptx', 2], ['notes_en.pdf', 2], ['dense_en.pdf', 1]];
const JUNK = /Objectives|Lecture 3|"Result"|المحاضرة الثالثة|الأهداف/;
(async () => {
  const llm = await startLLM();
  const cfg = `window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',llm:[{name:'Site AI',kind:'openai',base:'${llm.url}',model:'mock-model',key:'site-key-1',rpm:600}]};`;
  const site = await serve(dist, 0, cfg); const b = await chromium.launch(); const errs = [];
  const upload = async (p, file) => { await p.goto(site.url + '/#/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', path.join(dir, file)); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); };
  const clean = (p) => p.evaluate(async () => { const l = await (await fetch('/api/quizzes')).json(); for (const q of l) await fetch('/api/quizzes/' + q.id, { method: 'DELETE' }); const d = await (await fetch('/api/documents')).json(); for (const x of d) await fetch('/api/documents/' + x.id, { method: 'DELETE' }); });
  const quiz = async (p, file, expectMin, tag = '') => {
    await upload(p, file);
    assert.strictEqual(await p.locator('#connect-ai').count(), 0, 'the site provider is configured: no key card'); assert.strictEqual(await p.locator('nav a[href="#/settings"]').count(), 0, 'no settings link when the site provides the AI'); await assertHidden(p, 'new-quiz page');
    await createQuiz(p); await assertHidden(p, 'ready page ' + file);
    const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
    assert(qs.length >= expectMin, `${file}${tag}: only ${qs.length} questions (wanted >= ${expectMin})`);
    qs.forEach((q) => { assert(!JUNK.test(q.stem + q.options.map((o) => o.text).join(' ')), `${file}: course-metadata leaked into a question: ${q.stem.slice(0, 60)}`); assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4); assert(q.evidence.length && q.evidence[0].quote); });
    const types = [...new Set(qs.map((q) => q.qtype))]; console.log(`${file.padEnd(14)}${tag.padEnd(22)} questions=${qs.length}  (types chosen automatically: ${types.length})`);
    await clean(p);
  };
  // ---- 1) the site provides the AI: realistic files straight to questions, fresh browser profile, nothing configured by the visitor
  { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    for (const [f, min] of FILES) await quiz(p, f, min); await ctx.close(); }
  // ---- 2) a model that mangles the analysis format must not break generation
  for (const sloppy of ['refs', 'empty']) { await fetch(llm.url.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify({ sloppy }) });
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await quiz(p, 'notes_en.pdf', 2, ` [sloppy analysis: ${sloppy}]`); await ctx.close(); }
  // ---- 3) almost no text: say so plainly, with ways forward; nothing is invented
  { await fetch(llm.url.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify({ sloppy: 'empty' }) });
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await upload(p, 'sparse.pdf'); await createQuiz(p, { wait: 'none' }); await p.waitForSelector('.alert.warn:has-text("المصدر لا يكفي")', { timeout: 30000 });
    const msg = (await p.textContent('.alert.warn')).replace(/\s+/g, ' '); console.log('sparse.pdf message:', msg.slice(0, 150)); assert(/صفحة/.test(msg) && /كلمة/.test(msg), 'tells how much text was read');
    assert(await p.locator('#retry').count() === 1 && await p.locator('a:has-text("تعديل الطلب")').count() === 1, 'offers retry + edit-request'); await assertHidden(p, 'failure page'); await ctx.close(); }
  // ---- 4) THE COUNT ASKED FOR IS THE COUNT DELIVERED: a student asks for 30 -> gets 30, with no "only N of 30" warning — with the site's AI, and with no AI at all
  const count30 = async (p, tag) => { await upload(p, 'lecture_en.pdf'); await createQuiz(p, { count: 30, timeout: 120000 });
    const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
    assert.strictEqual(qs.length, 30, `${tag}: asked 30, got ${qs.length}`); assert.strictEqual(await p.locator('#shortfall-note').count(), 0, `${tag}: no shortfall warning`); assert(!/فقط من/.test(await p.textContent('body')), `${tag}: no "only N of M" text`);
    qs.forEach((q) => { assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4); assert(q.evidence.length && q.evidence[0].quote, 'every question keeps its quote from the lecture'); });
    assert.strictEqual(new Set(qs.map((q) => q.stem.toLowerCase().replace(/\s+/g, ' ') + '|' + q.options[0].text)).size, 30, 'no question is repeated'); const rep = (await p.textContent('text=تقرير الجودة >> xpath=..')).replace(/\s+/g, ' ');
    assert(/30 \/ 30|٣٠ \/ ٣٠/.test(rep), `${tag}: the report says 30 of 30: ${rep.slice(0, 80)}`); console.log(`lecture_en.pdf  ${tag.padEnd(20)} asked 30 -> delivered ${qs.length}  (${(await p.locator('#extra-note').count()) ? 'with a calm note about extra angles' : 'no extra angles needed'})`); await clean(p); };
  { await fetch(llm.url.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify({ sloppy: '' }) }); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await count30(p, 'site AI'); await ctx.close(); }
  { const bare = await serve(dist, 0, `window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',llm:[]};`); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    const up = async () => { await p.goto(bare.url + '/#/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', path.join(dir, 'lecture_en.pdf')); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=المصدر'); };
    await up(); await createQuiz(p, { count: 30, timeout: 120000 }); const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
    assert.strictEqual(qs.length, 30, 'no AI: asked 30, got ' + qs.length); assert.strictEqual(await p.locator('#shortfall-note').count(), 0); assert(!/فقط من/.test(await p.textContent('body'))); assert.strictEqual(new Set(qs.map((q) => q.stem.toLowerCase().replace(/\s+/g, ' ') + '|' + q.options[0].text)).size, 30);
    console.log('lecture_en.pdf  no AI at all         asked 30 -> delivered ' + qs.length); await ctx.close(); await bare.close(); }
  assert.strictEqual(errs.length, 0, errs.join('|')); console.log('realistic-files regression ok'); await b.close(); await site.close(); await llm.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
