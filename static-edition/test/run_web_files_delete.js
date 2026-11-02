// node static-edition/test/run_web_files_delete.js <dist> <dist-without-ocr> <pdf> <scanned.pdf>
// «My files» tidies itself up (files take the room the browser gives the site):
//  1) every file has its own «delete» in its row (asks first; «cancel» keeps it); a quiz built from a deleted file keeps its questions;
//  2) tick several files (or «select all») and delete them in one go; the count and the bar follow the ticks;
//  3) files no quiz can be built from (unreadable) are cleared with one button that says how many;
//  4) the room used on the device goes down; the same page in English; it fits a phone.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, noOcr, pdf, scanned] = process.argv.slice(2); fs.mkdirSync('/tmp/shots', { recursive: true });
(async () => {
  const b = await chromium.launch(); const errs = [];
  const run = async (root, fn) => { const site = await serve(root, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};"); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); try { await fn(p, site.url); } finally { await ctx.close(); await site.close(); } };
  const upload = async (p, U, file, name) => { await p.goto(U + '/#/files'); await p.waitForSelector('h1'); const before = await p.locator('tbody tr').count();
    await p.setInputFiles('#file', { name, mimeType: 'application/pdf', buffer: fs.readFileSync(file) });
    await p.waitForFunction((n) => document.querySelectorAll('tbody tr').length > n && !/جارٍ رفع|جارٍ قراءة|جارٍ تجهيز/.test(document.body.innerText), before, { timeout: 120000 }); };
  const docs = (p) => p.evaluate(async () => (await (await fetch('/api/documents')).json()).map((d) => ({ id: d.id, title: d.title, status: d.status })));
  const room = (p) => p.evaluate(async () => (await window.QZ_STORES.storageInfo()).usage);

  await run(dist, async (p, U) => {
    for (const n of ['lecture-a.pdf', 'lecture-b.pdf', 'lecture-c.pdf', 'lecture-d.pdf']) await upload(p, U, pdf, n);
    await p.goto(U + '/#/new?doc=' + (await docs(p)).find((d) => d.title === 'lecture-a').id); await createQuiz(p, { count: 10 });
    const quiz = (await p.evaluate(async () => (await (await fetch('/api/quizzes')).json())[0])); const before = await room(p);
    // 1) one file from its row: cancel keeps it, confirm deletes it; its quiz keeps its questions
    await p.goto(U + '/#/files'); await p.waitForSelector('tbody tr'); assert.strictEqual(await p.locator('tbody tr').count(), 4);
    assert(/حدّد ملفات من القائمة/.test(await p.innerText('#files-sel-bar')), 'the bar says how to tidy up');
    const row = (t) => p.locator('tbody tr', { has: p.locator(`a:text-is("${t}")`) });
    await row('lecture-a').locator('.fdel').click(); await p.waitForSelector('.modal'); assert(/الكويزات المبنية عليه تحتفظ بأسئلتها/.test(await p.innerText('.modal')));
    await p.click('.modal button:text-is("إلغاء")'); assert.strictEqual(await p.locator('tbody tr').count(), 4, 'cancel keeps the file');
    await row('lecture-a').locator('.fdel').click(); await p.click('.modal button.danger'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    assert(!(await docs(p)).some((d) => d.title === 'lecture-a'), 'the file is gone');
    const kept = await p.evaluate(async (id) => (await (await fetch(`/api/quizzes/${id}/questions`)).json()).length, quiz.id); assert.strictEqual(kept, 10, 'its quiz keeps its questions');
    console.log('1) one file deleted from its row (after a confirmation; «cancel» kept it); its quiz still has', kept, 'questions');
    // 2) tick two, delete them together
    await row('lecture-b').locator('.fsel').check(); await row('lecture-c').locator('.fsel').check();
    assert(/حُدِّد 2/.test(await p.innerText('#files-sel-count'))); assert.strictEqual(await p.locator('tr.selected').count(), 2, 'ticked rows are marked');
    await p.click('#files-delete-selected'); await p.waitForSelector('.modal'); assert(/ستُحذف ملفان/.test(await p.innerText('.modal')), await p.innerText('.modal'));
    await p.click('.modal button.danger'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.deepStrictEqual((await docs(p)).map((d) => d.title), ['lecture-d']); console.log('2) two ticked files deleted in one go («ستُحذف ملفان»)');
    // «select all» then delete everything: the empty page invites a new upload; the room went down
    await upload(p, U, pdf, 'lecture-e.pdf'); await p.check('#files-sel-all'); assert(/حُدِّد 2/.test(await p.innerText('#files-sel-count')));
    await p.uncheck('#files-sel-all'); assert(/حدّد ملفات/.test(await p.innerText('#files-sel-bar')), 'unticking all clears the selection');
    await p.check('#files-sel-all'); await p.click('#files-delete-selected'); await p.click('.modal button.danger'); await p.waitForSelector('.empty');
    assert.deepStrictEqual(await docs(p), []); const after = await room(p);
    assert(after < before, `the room used went down: ${before} -> ${after}`); console.log(`   «select all» + delete: no files left; room used ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB`);
    // 4) English, and a phone
    await upload(p, U, pdf, 'lecture-f.pdf'); await upload(p, U, pdf, 'lecture-g.pdf');
    await p.click('#lang-switch [lang=en]'); await p.waitForFunction(() => /My files/.test(document.body.innerText) && document.documentElement.dir === 'ltr');
    await p.goto(U + '/#/files'); await p.waitForSelector('.fsel'); await p.locator('.fsel').first().check();
    const en = await p.innerText('main'); assert(/1 selected/.test(en) && /Delete selected \(1\)/.test(en) && /Delete/.test(await p.locator('.fdel').first().innerText()), en.slice(0, 400));
    await p.click('#files-delete-selected'); assert(/Delete the selected files\?/.test(await p.innerText('.modal'))); await p.click('.modal button:text-is("Cancel")');
    await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(200); await p.screenshot({ path: '/tmp/shots/files-delete-phone-en.png', fullPage: true });
    assert((await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'fits a phone');
    await p.setViewportSize({ width: 1280, height: 900 }); await p.click('#lang-switch [lang=ar]'); await p.waitForFunction(() => /ملفاتي/.test(document.body.innerText));
    await p.screenshot({ path: '/tmp/shots/files-delete-ar.png' }); console.log('4) the same in English; fits a phone');
  });
  // 3) unreadable files (a scanned lecture where pictures cannot be read): cleared with one button
  await run(noOcr, async (p, U) => {
    await upload(p, U, pdf, 'good.pdf'); await upload(p, U, scanned, 'scan-1.pdf'); await upload(p, U, scanned, 'scan-2.pdf');
    const d = await docs(p); assert.strictEqual(d.filter((x) => x.status === 'unreadable').length, 2, JSON.stringify(d));
    await p.goto(U + '/#/files'); await p.waitForSelector('#files-clear-unreadable'); assert(/حذف غير المقروءة \(2\)/.test(await p.innerText('#files-clear-unreadable')));
    await p.click('#files-clear-unreadable'); await p.waitForSelector('.modal'); assert(/ستُحذف ملفان/.test(await p.innerText('.modal')));
    await p.click('.modal button.danger'); await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.deepStrictEqual((await docs(p)).map((x) => x.title), ['good']); assert.strictEqual(await p.locator('#files-clear-unreadable').count(), 0, 'the button goes when there is nothing to clear');
    console.log('3) two unreadable files cleared with one button; the readable one stays');
  });
  assert.deepStrictEqual(errs, []); console.log('files delete E2E ok'); await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
