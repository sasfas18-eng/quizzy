// node static-edition/test/run_web_many.js <dist> <pdf> — "I cannot create a new file once I have many quizzes" (device mode, real Chromium).
//  A) many files and ~200 quizzes on the device (made through the app's own API, like a student does): a NEW file is uploaded and read at once, and a new quiz can be made from it
//  B) the lists read only what they show (the Files page reads documents only - never the quizzes, never the pages' text), the quizzes come 50 at a time,
//     the unfinished ones (failed / draft) are removed with one button, the finished ones are never touched
//  C) the browser's storage is full (refused at once, or half-way through the pages): a plain-Arabic message, NOTHING half-saved, and the next try works as soon as there is room
//  D) the same file can be chosen twice in a row; the page promises 40MB and the browser edition now accepts it (it refused above 25MB)
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const serve = require('./serve.js'); const { seedAccount, EMAIL, PASSWORD } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist, pdf] = process.argv.slice(2);
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const errs = [];
  await ctx.addInitScript(() => {                          // instruments the browser's own IndexedDB: which reads happen, and a switch that makes writes fail like a full disk
    window.__getAll = []; window.__putsLeft = null;
    const ga = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function (q, c) { window.__getAll.push(q ? String(q.lower) : null); return ga.call(this, q, c); };
    const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { if (window.__putsLeft !== null) { if (window.__putsLeft <= 0) throw new DOMException('The current transaction exceeded its quota limitations.', 'QuotaExceededError'); window.__putsLeft--; } return put.apply(this, a); };
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('PE ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/storage_full|507/.test(m.text())) errs.push('C ' + m.text().slice(0, 200)); });
  const U = site.url + '/#'; const b64 = fs.readFileSync(pdf).toString('base64');
  await p.goto(U + '/files'); await p.waitForSelector('h1');

  // ---------------- A) many files, ~200 quizzes (+ 7 that never finished)
  const NF = 12, NQ = 200, NDEAD = 7;
  const made = await p.evaluate(async ([b64, nf, nq, nd]) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const ids = [];
    for (let i = 0; i < nf; i++) { const fd = new FormData(); fd.append('file', new File([bin], `lecture-${i}.pdf`, { type: 'application/pdf' })); const r = await fetch('/api/documents', { method: 'POST', body: fd }); const j = await r.json(); if (!r.ok) throw new Error('doc ' + JSON.stringify(j)); ids.push(j.id); }
    const body = (doc, t) => JSON.stringify({ title: t, sources: [{ document_id: doc, pages: null }], settings: { generator: 'rules', count: 10, difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, delivery: 'online', pdf_include_key: true, external_mode: 'source_only' } });
    const qs = []; for (let i = 0; i < nq; i++) { const r = await fetch('/api/quizzes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(ids[i % ids.length], 'quiz ' + i) }); const j = await r.json(); if (!r.ok) throw new Error('quiz ' + JSON.stringify(j)); qs.push(j.id);
      await fetch(`/api/quizzes/${j.id}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_generate: true }) }); }
    for (let i = 0; i < nd; i++) { const r = await fetch('/api/quizzes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(ids[0], 'never finished ' + i) }); if (!r.ok) throw new Error('draft'); }
    for (const id of qs) for (let k = 0; k < 300; k++) { const s = await (await fetch('/api/quizzes/' + id)).json(); if (!['analyzing', 'generating', 'planned'].includes(s.status)) break; await new Promise((r) => setTimeout(r, 50)); }
    const all = await (await fetch('/api/quizzes')).json(); const by = {}; all.forEach((q) => { by[q.status] = (by[q.status] || 0) + 1; }); return { docs: ids.length, by, total: all.length };
  }, [b64, NF, NQ, NDEAD]);
  const dead0 = (made.by.draft || 0) + (made.by.failed || 0) + (made.by.insufficient || 0); assert.strictEqual(made.total, NQ + NDEAD); assert(made.by.ready >= NQ - 5, 'the quizzes were made: ' + JSON.stringify(made.by));
  console.log('A) the device holds ' + made.docs + ' files and ' + made.total + ' quizzes ' + JSON.stringify(made.by));

  await p.reload(); await p.goto(U + '/'); await p.waitForSelector('.statcard'); await p.evaluate(() => { window.__getAll.length = 0; });
  await p.goto(U + '/files'); await p.waitForSelector('table'); await p.waitForSelector('#room'); assert.strictEqual(await p.locator('tbody tr').count(), NF);
  const reads = await p.evaluate(() => window.__getAll.slice()); assert(reads.length > 0 && reads.every((r) => r === 'doc_'), 'the Files page reads ONLY documents (never every quiz and every page): ' + JSON.stringify(reads));
  assert(/المساحة المستخدمة على جهازك/.test(await p.textContent('#room')), 'the page says how much room is used');
  await p.setInputFiles('#file', pdf); await p.waitForSelector('.toast:has-text("تمت معالجة الملف")'); assert.strictEqual(await p.locator('tbody tr').count(), NF + 1, 'the NEW file is there');
  assert.strictEqual(await p.evaluate(() => document.getElementById('file').value), '', 'the chooser is reset: choosing the same file again fires "change" again');
  await p.click('a:has-text("التفاصيل") >> nth=0'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await createQuiz(p, { count: 10, timeout: 120000 });
  console.log('A) a NEW file was uploaded and read at once, and a quiz was made from it, with ' + made.total + ' quizzes already on the device');

  // ---------------- B) lists: only what they show, 50 at a time, one button for the unfinished
  await p.evaluate(() => { window.__getAll.length = 0; }); await p.goto(U + '/quizzes'); await p.waitForSelector('table'); await p.waitForSelector('#clear-dead');
  assert.strictEqual(await p.locator('tbody tr').count(), 50, 'the first 50 quizzes'); const reads2 = await p.evaluate(() => window.__getAll.slice()); assert(reads2.every((r) => r === 'quiz_'), 'the quizzes page reads only quizzes: ' + JSON.stringify(reads2));
  assert(/\(\s*[7٧]\s*\)/.test((await p.textContent('#clear-dead')).replace(/\s+/g, ' ')) || dead0 !== NDEAD, 'the button counts the unfinished quizzes: ' + (await p.textContent('#clear-dead')));
  let rows = 50; while (await p.locator('#more').count()) { await p.click('#more'); rows = await p.locator('tbody tr').count(); }
  assert.strictEqual(rows, NQ + NDEAD + 1, 'all quizzes are reachable through "show more": ' + rows);
  { const t = ((await p.textContent('body')) || '').replace(/\s+/g, ' '); assert(!/\b(null|undefined|false)\b|\[object/.test(t), 'no stray null/false text on the quizzes page: ' + t.slice(-120)); }
  await p.evaluate(() => { window.__getAll.length = 0; }); await p.goto(U + '/'); await p.waitForSelector('.statcard'); const reads3 = await p.evaluate(() => window.__getAll.slice());
  assert(reads3.length > 0 && reads3.every((r) => ['doc_', 'quiz_', 'att_', 'card_'].includes(r)), 'the home page reads each kind once by key range, never the whole database: ' + JSON.stringify(reads3));
  await p.goto(U + '/quizzes'); await p.waitForSelector('#clear-dead'); const readyBefore = await p.evaluate(async () => (await (await fetch('/api/quizzes')).json()).filter((q) => q.status === 'ready').length);
  await p.click('#clear-dead'); await p.click('.modal button.danger'); await p.waitForSelector('.toast:has-text("حُذف")'); await p.waitForFunction(() => !document.getElementById('clear-dead'));
  const after = await p.evaluate(async () => { const a = await (await fetch('/api/quizzes')).json(); return { n: a.length, ready: a.filter((q) => q.status === 'ready').length, unfinished: a.filter((q) => ['failed', 'draft', 'insufficient'].includes(q.status)).length }; });
  assert.deepStrictEqual(after, { n: readyBefore, ready: readyBefore, unfinished: 0 }, 'only the unfinished ones went: ' + JSON.stringify(after));
  console.log('B) lists read only their own kind; quizzes shown 50 at a time (' + (NQ + NDEAD + 1) + ' reachable); one button removed the ' + dead0 + ' unfinished quizzes and kept all ' + readyBefore + ' finished ones');

  // ---------------- C) storage full
  const pageRows = () => p.evaluate(async () => new Promise((res) => { const r = indexedDB.open('quizzy_web_v1', 1); r.onsuccess = () => { const t = r.result.transaction('kv', 'readonly'); const k = t.objectStore('kv').getAllKeys(); t.oncomplete = () => res({ pages: k.result.filter((x) => String(x).startsWith('page_')).length, docs: k.result.filter((x) => String(x).startsWith('doc_')).length }); }; }));
  await p.goto(U + '/files'); await p.waitForSelector('table'); const before = await pageRows(); assert.strictEqual(before.pages, before.docs * 4, 'every file has its 4 pages: ' + JSON.stringify(before));
  for (const [label, left] of [['refused at once', 0], ['refused half-way (after 2 of 4 pages)', 2]]) {
    await p.evaluate((n) => { window.__putsLeft = n; }, left); await p.setInputFiles('#file', pdf); await p.waitForSelector('.alert.bad');
    const msg = await p.textContent('.alert.bad'); assert(/امتلأت مساحة التخزين/.test(msg) && /احذف/.test(msg) && !/client_error|QuotaExceeded|storage_full/.test(msg), label + ': plain-Arabic message with what to do: ' + msg.slice(0, 120));
    await p.evaluate(() => { window.__putsLeft = null; }); const now = await pageRows(); assert.deepStrictEqual(now, before, label + ': nothing half-saved (no stray pages, no stray file): ' + JSON.stringify(now));
  }
  await p.reload(); await p.waitForSelector('table'); assert.strictEqual(await p.locator('tbody tr').count(), before.docs, 'the failed uploads are not listed');
  await p.setInputFiles('#file', pdf); await p.waitForSelector('.toast:has-text("تمت معالجة الملف")'); const ok = await pageRows(); assert.deepStrictEqual(ok, { pages: (before.docs + 1) * 4, docs: before.docs + 1 }, 'with room again the same upload works');
  console.log('C) storage full (at once / half-way): plain message, nothing half-saved, the next try works');

  // ---------------- D) size: the page promises 40MB
  const big = (mb) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(mb * 1048576, 0x20)]);
  await p.setInputFiles('#file', { name: 'junk-26.pdf', mimeType: 'application/pdf', buffer: big(26) }); await p.waitForSelector('.alert.bad'); const m26 = await p.textContent('.alert.bad'); assert(/تعذّرت قراءة الملف/.test(m26) && !/الحجم/.test(m26), '26MB is no longer refused for its size (it is read, and this junk is not a PDF): ' + m26.slice(0, 100));
  await p.setInputFiles('#file', { name: 'junk-41.pdf', mimeType: 'application/pdf', buffer: big(41) }); await p.waitForFunction(() => /40MB/.test(document.querySelector('.alert.bad')?.textContent || '')); console.log('D) 26MB is read, 41MB is refused with the real limit (40MB); the chooser accepts the same file again');
  assert.deepStrictEqual(await pageRows(), ok, 'the refused big files left nothing behind');

  console.log('ERRS', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('many-quizzes / full-storage E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
