// node static-edition/test/run_web_newfile.js <dist> <pdf> — a NEW file can be added while a quiz is being created.
// The "new quiz" page used to list only the files already uploaded: whoever wanted to use a new lecture had to leave, upload it on another page, and come back.
//  1) a device with no file at all: the page opens anyway, says so, and ONE upload there is enough to make a quiz
//  2) with files already there: the new one is listed first and ticked, the old ones stay unticked, and the quiz is made from the new file only
//  3) several files at once, drag and drop, an unsupported file and a broken PDF (a clear message each, nothing else breaks), the chooser can be used again
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount, EMAIL, PASSWORD } = require('./signin.js'); const { assertHidden, createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2);
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const nctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(nctx); const p = await nctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/429|favicon/.test(m.text())) errs.push('C ' + m.text().slice(0, 200)); });
  const U = site.url + '/#'; const buf = fs.readFileSync(pdf); const file = (name) => ({ name, mimeType: 'application/pdf', buffer: buf });
  const docs = () => p.evaluate(async () => (await (await fetch('/api/documents')).json()).map((d) => ({ id: d.id, title: d.title })));
  const chosenNames = () => p.locator('#source-card #chosen-file strong').allTextContents();

  // ---- 1) nothing uploaded yet: the page takes the upload and makes the quiz (the source is automatic: no list, no ranges, no title)
  await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForSelector('#no-files'); await assertHidden(p, 'new-quiz page without any file');
  assert.strictEqual(await p.locator('input[aria-label="نطاق الصفحات"]').count(), 0, 'no page-range box'); assert.strictEqual(await p.locator('#source-card input[type=checkbox]').count(), 0, 'no list of files to tick'); assert.strictEqual(await p.locator('summary:has-text("خيارات إضافية")').count(), 0, 'no extra options without an AI'); assert.strictEqual(await p.locator('#use-local').count(), 0, 'no "free generation" choice'); assert(!/عنوان الكويز/.test(await p.textContent('main')), 'no title field');
  assert(await p.locator('#create-quiz').isVisible()); await p.click('#create-quiz'); await p.waitForSelector('.alert.bad'); assert(/ارفع ملفك أولًا/.test(await p.textContent('.alert.bad')), 'with nothing chosen it points to the upload button');
  await p.setInputFiles('#new-file', file('first-lecture.pdf')); await p.waitForSelector('#source-card .alert.ok'); assert(/first-lecture/.test(await p.textContent('#source-card .alert.ok')));
  assert.strictEqual(await p.locator('#no-files').count(), 0); assert.deepStrictEqual(await chosenNames(), ['first-lecture'], 'the new file is the source by itself');
  assert.strictEqual(await p.evaluate(() => document.getElementById('new-file').value), '', 'the chooser is reset (the same file can be chosen again)');
  await createQuiz(p, { count: 10, timeout: 120000 }); assert((await p.evaluate(() => location.hash)).startsWith('#/quiz/'), 'the quiz was made from the file uploaded on the quiz page itself'); assert.strictEqual((await docs()).length, 1);
  assert.strictEqual(await p.evaluate(async () => { const all = await (await fetch('/api/quizzes')).json(); return all[0].title; }), 'first-lecture', 'the title is the file\'s name');
  console.log('1) no file on the device: the page took the upload and made the quiz (one page, no list, no ranges, no title box, no free-generation choice)');

  // ---- 2) a file is already there: it is the source by itself; a file uploaded here REPLACES that pick
  await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForSelector('#chosen-file'); assert.deepStrictEqual(await chosenNames(), ['first-lecture'], 'the newest file is picked automatically');
  await p.setInputFiles('#new-file', file('second-lecture.pdf')); await p.waitForSelector('#source-card .alert.ok:has-text("second-lecture")');
  assert.deepStrictEqual(await chosenNames(), ['second-lecture'], 'the file uploaded here replaces the automatic pick');
  await createQuiz(p, { count: 10, timeout: 120000 });
  const made = await p.evaluate(async () => { const all = await (await fetch('/api/quizzes')).json(); const q = await (await fetch('/api/quizzes/' + all[0].id)).json(); return q.settings.sources.map((s) => s.document_id); });
  const d2 = await docs(); const second = d2.find((d) => d.title === 'second-lecture'); assert.deepStrictEqual(made, [second.id], 'the quiz was made from the new file only');
  // ?doc= wins over "the newest"
  const first = d2.find((d) => d.title === 'first-lecture'); await p.goto(U + '/new?doc=' + first.id); await p.waitForSelector('#chosen-file'); assert.deepStrictEqual(await chosenNames(), ['first-lecture'], 'the file you came from is the source');
  console.log('2) a file already there is the source by itself; one uploaded here replaces it; the quiz is made from that file only; ?doc= is respected');

  // ---- 3) several at once, drag and drop, bad files
  await p.goto(U + '/new'); await p.waitForSelector('#chosen-file');
  await p.setInputFiles('#new-file', [file('batch-a.pdf'), file('batch-b.pdf')]); await p.waitForSelector('#source-card .alert.ok:has-text("batch-a")'); await p.waitForSelector('#source-card .alert.ok:has-text("batch-b")'); assert.deepStrictEqual((await chosenNames()).sort(), ['batch-a', 'batch-b'], 'several at once: all of them are the source');
  await p.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], 'dropped.pdf', { type: 'application/pdf' })); const card = document.getElementById('source-card');
    card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, buf.toString('base64'));
  await p.waitForSelector('#source-card .alert.ok:has-text("dropped")'); assert.strictEqual((await chosenNames()).length, 3, 'a dropped file is added like a chosen one');
  await p.setInputFiles('#new-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }); await p.waitForSelector('#source-card .alert.bad:has-text("غير مدعوم")');
  await p.setInputFiles('#new-file', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 this is not really a pdf') }); await p.waitForSelector('#source-card .alert.bad:has-text("تعذّرت قراءة الملف")');
  assert.strictEqual((await chosenNames()).length, 3, 'the bad files were not added and the source is as it was');
  await assertHidden(p, 'new-quiz page after uploads'); await p.reload(); await p.waitForSelector('#chosen-file'); assert.strictEqual((await docs()).length, 5, 'the uploaded files are kept on the device');
  console.log('3) several at once + drag and drop work; an unsupported file and a broken PDF give a clear message and change nothing');

  // ---- 4) fast navigation: a slow page that finishes AFTER you moved on must not replace the page you are on (the home page, held back 900ms here, used to overwrite "new quiz")
  await p.evaluate(() => { const f = window.fetch; window.fetch = (u, i) => (String(u).includes('/api/cards/stats') ? new Promise((r) => setTimeout(r, 900)).then(() => f(u, i)) : f(u, i)); });
  await p.goto(U + '/'); await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForTimeout(1600);
  assert.strictEqual(await p.locator('#new-file-btn').count(), 1, 'the new-quiz page is still the page on screen'); assert.strictEqual(await p.locator('.statcard').count(), 0, 'the late home page did not replace it');
  console.log('4) a slow page that finishes late does not replace the page you moved to');

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('new-file-on-the-quiz-page E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
