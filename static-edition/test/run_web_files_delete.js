// node static-edition/test/run_web_files_delete.js <dist> <dist-without-ocr> <pdf> <scanned.pdf>
// «My files» tidies itself up (files take the room the browser gives the site):
//  1) every file has its own «delete» in its row (asks first; «cancel» keeps it); a quiz built from a deleted file keeps its questions;
//  2) tick several files (or «select all») and delete them in one go; the count and the bar follow the ticks;
//  3) files no quiz can be built from (unreadable) are cleared with one button that says how many;
//  4) the same page in English; it fits a phone;
//  5) the room line says what really fills it - the tools downloaded once (the composer's model, the reading of picture pages) - and frees them on demand;
//  6) and the space really comes back: the browser's own count drops once it is closed and opened again (Chrome counts freed space until then).
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
    assert(after <= before, `the room used does not grow: ${before} -> ${after}`);      // a file's text is a few KB, and the browser may count freed database space a little later; the real freeing is checked in 5) and 6) console.log(`   «select all» + delete: no files left; room used ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB`);
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
    // 5) what really fills the room: the tools downloaded once (the composer's model, the data for reading picture pages) - said plainly,
    //    untouched by deleting files, freed on demand without losing anything, and back by themselves when a quiz needs them
    await upload(p, U, scanned, 'scanned.pdf');
    await p.waitForFunction(async () => (await window.QZ_STORES.toolsInfo()).reading > 1e6, null, { timeout: 30000, polling: 500 });      // the reading library stores its data as it finishes
    // the reading library goes on writing its data a moment after it reports it (CI once measured the page before that): the size is read once it has settled
    await p.waitForFunction(async () => { const a = (await window.QZ_STORES.toolsInfo()).reading; await new Promise((r) => setTimeout(r, 400)); return a > 1e6 && (await window.QZ_STORES.toolsInfo()).reading === a; }, null, { timeout: 30000, polling: 200 });
    let line = ''; for (let k = 0; k < 4 && !/قراءة الصفحات المصوّرة/.test(line); k++) { if (k) await p.reload(); else await p.goto(U + '/#/files'); await p.waitForSelector('#room-tools', { timeout: 30000 }); line = await p.innerText('#room-tools'); }
    assert(/نموذج وكيل الصياغة/.test(line) && /قراءة الصفحات المصوّرة/.test(line) && /حذف الملفات لا يمسّها/.test(line), line);
    const t0 = await p.evaluate(() => window.QZ_STORES.toolsInfo()); assert(t0.model > 10e6 && t0.reading > 1e6, JSON.stringify(t0)); const u0 = await room(p);
    const filesBefore = (await docs(p)).length, quizzesBefore = await p.evaluate(async () => (await (await fetch('/api/quizzes')).json()).length);
    await p.click('#clear-tools'); await p.waitForSelector('.modal'); assert(/لا يضيع شيء من ملفاتك/.test(await p.innerText('.modal')));
    await p.click('.modal button.danger'); await p.waitForFunction(() => !document.querySelector('#room-tools'), null, { timeout: 15000 });
    assert.deepStrictEqual(await p.evaluate(() => window.QZ_STORES.toolsInfo()), { model: 0, reading: 0 }); const u1 = await room(p);
    assert(u0 - u1 > 15e6, `the room shown is freed at once: ${u0} -> ${u1}`);
    assert(/حين تغلقه وتفتحه/.test(await p.innerText('#room')), 'it says the browser finishes its own count when reopened: ' + await p.innerText('#room'));
    assert.strictEqual((await docs(p)).length, filesBefore, 'files untouched'); assert.strictEqual(await p.evaluate(async () => (await (await fetch('/api/quizzes')).json()).length), quizzesBefore, 'quizzes untouched');
    console.log(`5) the room line names the tools (${line.slice(0, 120)}…); «clear» freed ${Math.round((u0 - u1) / 1048576)} MB (${Math.round(u0 / 1048576)} -> ${Math.round(u1 / 1048576)} MB), files and quizzes untouched`);
    // a later visit (the model still in this page's memory needs no download): a new quiz works and the model comes back by itself
    await p.goto(U + '/#/new?doc=' + (await docs(p)).find((d) => d.title === 'lecture-f').id); await p.reload(); await createQuiz(p, { count: 10, timeout: 120000 });
    await p.waitForFunction(async () => (await window.QZ_STORES.toolsInfo()).model > 10e6, null, { timeout: 60000, polling: 500 }); console.log('   a new quiz on a later visit: works, and the model is back by itself');
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
  // 6) the space really comes back: the same browser profile closed and opened again - the browser's OWN count (estimate) has dropped too
  { const os = require('os'), path = require('path'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-profile-')); const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};");
    const open = async () => { const c = await chromium.launchPersistentContext(dir, {}); await seedAccount(c); const pg = c.pages()[0] || await c.newPage(); pg.on('pageerror', (e) => errs.push(e.message)); return [c, pg]; };
    const raw = (pg) => pg.evaluate(async () => (await navigator.storage.estimate()).usage);
    let [c, pg] = await open(); await upload(pg, site.url, pdf, 'lecture.pdf'); await pg.goto(site.url + '/#/new'); await createQuiz(pg, { count: 10 }); await pg.waitForTimeout(1500);
    const r0 = await raw(pg); await pg.goto(site.url + '/#/files'); await pg.waitForSelector('#clear-tools'); await pg.click('#clear-tools'); await pg.click('.modal button.danger'); await pg.waitForSelector('#room-pending');
    await c.close(); [c, pg] = await open(); await pg.goto(site.url + '/#/files'); await pg.waitForSelector('#room'); const r1 = await raw(pg);
    assert(r0 - r1 > 15e6, `the browser's own count after reopening: ${r0} -> ${r1}`); assert.strictEqual(await pg.locator('#room-pending').count(), 0, 'no note once the browser has caught up');
    assert.strictEqual((await docs(pg)).length, 1, 'the file is still there'); await c.close(); await site.close(); fs.rmSync(dir, { recursive: true, force: true });
    console.log(`6) after closing and reopening the browser, its own count: ${Math.round(r0 / 1048576)} MB -> ${(r1 / 1048576).toFixed(1)} MB (the space really came back); the file is still there`); }
  assert.deepStrictEqual(errs, []); console.log('files delete E2E ok'); await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
