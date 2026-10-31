// node static-edition/test/run_web_realistic.js <dist> <dir with slides_en.pptx slides_ar.pptx notes_en.pdf dense_en.pdf>
// Regression for "تعذر استخراج أهداف قابلة للاختبار": realistic slides/notes must yield a plan and a quiz in the no-token mode,
// and a model that mangles the analysis format (bad page refs, odd type names, or nothing usable) must not break the AI mode either.
const { chromium } = require('playwright'); const assert = require('assert'); const path = require('path');
const { start: startLLM } = require('./mock_llm.js'); const serve = require('./serve.js'); const [dist, dir] = process.argv.slice(2);
const FILES = [['slides_en.pptx', 4], ['slides_ar.pptx', 3], ['notes_en.pdf', 2], ['dense_en.pdf', 1]];
const JUNK = /Objectives|Lecture 3|"Result"|المحاضرة الثالثة|الأهداف/;
(async () => {
  const llm = await startLLM(); const site = await serve(dist, 0); const b = await chromium.launch(); const errs = [];
  const quiz = async (p, file, mode, expectMin) => {
    await p.goto(site.url + '/#/files'); await p.waitForSelector('h1:has-text("ملفاتي")'); await p.setInputFiles('#file', path.join(dir, file)); await p.waitForSelector('table'); await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('text=طريقة التوليد');
    if (mode === 'ai') await p.click('.chips button:has-text("ذكي")'); else await p.click('.chips button:has-text("بدون توكن")');
    await p.click('button:has-text("10")'); await p.click('button:has-text("متابعة: تحليل")'); await p.click('button:has-text("حلّل المحتوى")');
    await p.locator('h2:has-text("خطة الكويز"), .alert.warn:has-text("المصدر لا يكفي")').first().waitFor({ timeout: 30000 }); const bad = await p.locator('.alert.warn:has-text("المصدر لا يكفي")').count(); if (bad) throw new Error(`${file} [${mode}]: ` + (await p.textContent('.alert.warn')).trim().slice(0, 200));
    const feas = (await p.textContent('.stat')).trim(); const gen = p.locator('button:has-text("ابدأ توليد")'); if (await gen.isDisabled()) await p.check('.card input[type=checkbox] >> nth=0'); await gen.click(); await p.waitForSelector('text=جاهز للحل', { timeout: 60000 });
    const qs = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; return (await (await fetch('/api/quizzes/' + q.id + '/questions')).json()); });
    assert(qs.length >= expectMin, `${file} [${mode}]: only ${qs.length} questions (wanted >= ${expectMin})`); qs.forEach((q) => { assert(!JUNK.test(q.stem + q.options.map((o) => o.text).join(' ')), `${file}: course-metadata leaked into a question: ${q.stem.slice(0, 60)}`); assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4); assert(q.evidence.length && q.evidence[0].quote); });
    const types = [...new Set(qs.map((q) => q.qtype))]; console.log(`${file.padEnd(14)} [${mode.padEnd(5)}] plan=${feas}  questions=${qs.length}  types=${types.join(',')}`);
    await p.evaluate(async () => { const l = await (await fetch('/api/quizzes')).json(); for (const q of l) await fetch('/api/quizzes/' + q.id, { method: 'DELETE' }); const d = await (await fetch('/api/documents')).json(); for (const x of d) await fetch('/api/documents/' + x.id, { method: 'DELETE' }); });
  };
  // ---- no-token mode on realistic files (fresh browser profile = no keys)
  { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    for (const [f, min] of FILES) await quiz(p, f, 'rules', min); await ctx.close(); }
  // ---- AI mode with a model that mangles the analysis format
  for (const sloppy of ['refs', 'empty']) { await fetch(llm.url.replace('/v1', '/__control'), { method: 'POST', body: JSON.stringify({ sloppy }) });
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(site.url + '/#/settings'); await p.waitForSelector('text=إضافة مفتاح توليد'); await p.selectOption('#preset', 'custom'); await p.fill('#base', llm.url); await p.fill('#model', 'mock'); await p.fill('#key', 'k-1234'); await p.fill('#rpm', '300'); await p.click('button:has-text("إضافة")'); await p.waitForSelector('text=مفاتيحك');
    await quiz(p, 'notes_en.pdf', 'ai', 2); await ctx.close(); console.log('   (AI mode with sloppy analysis:', sloppy + ')'); }
  assert.strictEqual(errs.length, 0, errs.join('|')); console.log('realistic-files regression ok'); await b.close(); await site.close(); await llm.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
