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
  const ticked = () => p.locator('#source-card input[type=checkbox]:checked').count();
  const cards = () => p.locator('#source-card .card');

  // ---- 1) nothing uploaded yet
  await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForSelector('#no-files'); await assertHidden(p, 'new-quiz page without any file');
  assert(await p.locator('#create-quiz').isVisible()); await p.click('#create-quiz'); await p.waitForSelector('.alert.bad'); assert(/ارفع ملفًا جديدًا/.test(await p.textContent('.alert.bad')), 'with nothing chosen it points to the upload button');
  await p.setInputFiles('#new-file', file('first-lecture.pdf')); await p.waitForSelector('#source-card .alert.ok'); assert(/first-lecture/.test(await p.textContent('#source-card .alert.ok')));
  assert.strictEqual(await p.locator('#no-files').count(), 0); assert.strictEqual(await cards().count(), 1); assert.strictEqual(await ticked(), 1, 'the new file is ticked by itself'); assert(await p.locator('#source-card input[type=text]').isVisible(), 'and its page range is offered');
  assert.strictEqual(await p.evaluate(() => document.getElementById('new-file').value), '', 'the chooser is reset (the same file can be chosen again)');
  await createQuiz(p, { count: 10, timeout: 120000 }); assert((await p.evaluate(() => location.hash)).startsWith('#/quiz/'), 'the quiz was made from the file uploaded on the quiz page itself'); assert.strictEqual((await docs()).length, 1);
  console.log('1) no file on the device: the new-quiz page took the upload and made the quiz (one page, no detour)');

  // ---- 2) a file is already there: the new one is first, ticked; the old one is left alone
  await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForSelector('#source-card input[type=checkbox]'); assert.strictEqual(await cards().count(), 1); assert.strictEqual(await ticked(), 0, 'nothing is forced on you: the old file is not ticked');
  await p.setInputFiles('#new-file', file('second-lecture.pdf')); await p.waitForFunction(() => document.querySelectorAll('#source-card .card').length === 2); assert.strictEqual(await ticked(), 1);
  assert(/second-lecture/.test(await cards().first().textContent()), 'the new file is listed first'); assert(await cards().first().locator('input[type=checkbox]').isChecked()); assert(!(await cards().nth(1).locator('input[type=checkbox]').isChecked()), 'the old one stays unticked');
  await createQuiz(p, { count: 10, timeout: 120000 });
  const made = await p.evaluate(async () => { const all = await (await fetch('/api/quizzes')).json(); const q = await (await fetch('/api/quizzes/' + all[0].id)).json(); return q.settings.sources.map((s) => s.document_id); });
  const d2 = await docs(); const second = d2.find((d) => d.title === 'second-lecture'); assert.deepStrictEqual(made, [second.id], 'the quiz was made from the new file only');
  console.log('2) a file already there: the new one is first and ticked, the old one untouched, quiz made from the new file only');

  // ---- 3) several at once, drag and drop, bad files
  await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForFunction(() => document.querySelectorAll('#source-card .card').length === 2);
  await p.setInputFiles('#new-file', [file('batch-a.pdf'), file('batch-b.pdf')]); await p.waitForFunction(() => document.querySelectorAll('#source-card .card').length === 4); assert.strictEqual(await ticked(), 2, 'both new files are ticked');
  await p.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], 'dropped.pdf', { type: 'application/pdf' })); const card = document.getElementById('source-card');
    card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, buf.toString('base64'));
  await p.waitForFunction(() => document.querySelectorAll('#source-card .card').length === 5); assert(/dropped/.test(await cards().first().textContent()), 'a dropped file is added like a chosen one'); assert.strictEqual(await ticked(), 3);
  await p.setInputFiles('#new-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }); await p.waitForSelector('#source-card .alert.bad:has-text("غير مدعوم")');
  await p.setInputFiles('#new-file', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 this is not really a pdf') }); await p.waitForSelector('#source-card .alert.bad:has-text("تعذّرت قراءة الملف")');
  assert.strictEqual(await cards().count(), 5, 'the bad files were not added'); assert.strictEqual(await ticked(), 3, 'and the ticked ones are as they were');
  await assertHidden(p, 'new-quiz page after uploads'); await p.reload(); await p.waitForSelector('#source-card input[type=checkbox]'); assert.strictEqual(await cards().count(), 5, 'the uploaded files are kept on the device');
  console.log('3) several at once + drag and drop work; an unsupported file and a broken PDF give a clear message and change nothing');

  // ---- 4) fast navigation: a slow page that finishes AFTER you moved on must not replace the page you are on (the home page, held back 900ms here, used to overwrite "new quiz")
  await p.evaluate(() => { const f = window.fetch; window.fetch = (u, i) => (String(u).includes('/api/cards/stats') ? new Promise((r) => setTimeout(r, 900)).then(() => f(u, i)) : f(u, i)); });
  await p.goto(U + '/'); await p.goto(U + '/new'); await p.waitForSelector('#new-file-btn'); await p.waitForTimeout(1600);
  assert.strictEqual(await p.locator('#new-file-btn').count(), 1, 'the new-quiz page is still the page on screen'); assert.strictEqual(await p.locator('.statcard').count(), 0, 'the late home page did not replace it');
  console.log('4) a slow page that finishes late does not replace the page you moved to');

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('new-file-on-the-quiz-page E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
