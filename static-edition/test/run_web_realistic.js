// node static-edition/test/run_web_realistic.js <dist> <dir with slides_en.pptx slides_ar.pptx notes_en.pdf dense_en.pdf sparse.pdf>
// The user's goal, end to end in a real browser: put a file -> see the questions, with NOTHING to set up (made locally: the site has no AI service).
// Also regression for "تعذر استخراج أهداف قابلة للاختبار": realistic slides/notes must give a quiz, and a file with almost no text must explain itself
// and offer a way forward.
const { chromium } = require('playwright'); const assert = require('assert'); const path = require('path');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { assertHidden, createQuiz, reportOf } = require('../../claude-edition/test/flow.js'); const [dist, dir] = process.argv.slice(2);
const FILES = [['slides_en.pptx', 3], ['slides_ar.pptx', 2], ['notes_en.pdf', 2], ['dense_en.pdf', 1]];
const JUNK = /Objectives|Lecture 3|"Result"|المحاضرة الثالثة|الأهداف/;
(async () => {
  const cfg = `window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};`;
  const site = await serve(dist, 0, cfg); const b = await chromium.launch(); const errs = [];
  const upload = async (p, file) => { await p.goto(site.url + '/#/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', path.join(dir, file)); await p.waitForSelector('table'); await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); };
  const clean = (p) => p.evaluate(async () => { const l = await (await fetch('/api/quizzes')).json(); for (const q of l) await fetch('/api/quizzes/' + q.id, { method: 'DELETE' }); const d = await (await fetch('/api/documents')).json(); for (const x of d) await fetch('/api/documents/' + x.id, { method: 'DELETE' }); });
  const quiz = async (p, file, expectMin, tag = '') => {
    await upload(p, file);
    assert.strictEqual(await p.locator('#connect-ai').count(), 0, 'no key card: the site has no AI'); assert.strictEqual(await p.locator('nav a[href="#/settings"]').count(), 0, 'no settings link'); await assertHidden(p, 'new-quiz page');
    await createQuiz(p); await assertHidden(p, 'ready page ' + file);
    const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
    assert(qs.length >= expectMin, `${file}${tag}: only ${qs.length} questions (wanted >= ${expectMin})`);
    qs.forEach((q) => { assert(!JUNK.test(q.stem + q.options.map((o) => o.text).join(' ')), `${file}: course-metadata leaked into a question: ${q.stem.slice(0, 60)}`); assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4); assert(q.evidence.length && q.evidence[0].quote); });
    const types = [...new Set(qs.map((q) => q.qtype))]; console.log(`${file.padEnd(14)}${tag.padEnd(22)} questions=${qs.length}  (types chosen automatically: ${types.length})`);
    await clean(p);
  };
  // ---- 1) realistic files straight to questions, fresh browser profile, nothing configured by the visitor
  { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    for (const [f, min] of FILES) await quiz(p, f, min); await ctx.close(); }
  // ---- 3) almost no text: say so plainly, with ways forward; nothing is invented
  { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await upload(p, 'sparse.pdf'); await createQuiz(p, { wait: 'none' }); await p.waitForSelector('.alert.warn:has-text("المصدر لا يكفي")', { timeout: 30000 });
    const msg = (await p.textContent('.alert.warn')).replace(/\s+/g, ' '); console.log('sparse.pdf message:', msg.slice(0, 150)); assert(/صفحة/.test(msg) && /كلمة/.test(msg), 'tells how much text was read');
    assert(await p.locator('#retry').count() === 1 && await p.locator('a:has-text("تعديل الطلب")').count() === 1, 'offers retry + edit-request'); await assertHidden(p, 'failure page'); await ctx.close(); }
  // ---- 3) THE COUNT ASKED FOR IS THE COUNT DELIVERED: a student asks for 30 -> gets 30, with no "only N of 30" warning
  const count30 = async (p, tag) => { await upload(p, 'lecture_en.pdf'); await createQuiz(p, { count: 30, timeout: 120000 });
    const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
    assert.strictEqual(qs.length, 30, `${tag}: asked 30, got ${qs.length}`); assert.strictEqual(await p.locator('#shortfall-note').count(), 0, `${tag}: no shortfall warning`); assert(!/فقط من/.test(await p.textContent('body')), `${tag}: no "only N of M" text`);
    qs.forEach((q) => { assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4); assert(q.evidence.length && q.evidence[0].quote, 'every question keeps its quote from the lecture'); });
    assert.strictEqual(new Set(qs.map((q) => q.stem.toLowerCase().replace(/\s+/g, ' ') + '|' + q.options[0].text)).size, 30, 'no question is repeated'); const rep = (await reportOf(p));
    assert(/30 \/ 30|٣٠ \/ ٣٠/.test(rep), `${tag}: the report says 30 of 30: ${rep.slice(0, 80)}`); console.log(`lecture_en.pdf  ${tag.padEnd(20)} asked 30 -> delivered ${qs.length}  (${(await p.locator('#extra-note').count()) ? 'with a calm note about extra angles' : 'no extra angles needed'})`); await clean(p); };
  { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await count30(p, 'local'); await ctx.close(); }
  assert.strictEqual(errs.length, 0, errs.join('|')); console.log('realistic-files regression ok'); await b.close(); await site.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
