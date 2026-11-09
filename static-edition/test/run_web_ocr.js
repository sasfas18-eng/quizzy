// node static-edition/test/run_web_ocr.js <dist WITH vendor/ocr> <dist WITHOUT it> <scan_slides.pdf> — a SCANNED lecture (pages that are pictures, no text layer).
// Found by using the site as a student: such a file was "processed" and then could not give a quiz, with a note about "OCR" that means nothing to a student.
//  1) with the reading files: the pages are read in the browser, the student sees the progress, the text is right, a quiz is built from it (quotes from what was read)
//  2) without them (a build where the fetch failed): the file is refused honestly - why, and what to do - and nothing says "OCR"
const { chromium } = require('playwright'); const assert = require('assert'); const serve = require('./serve.js'); const { seedAccount } = require('./signin.js');
const [withOcr, withoutOcr, pdf] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (dist) => { const site = await serve(dist, 0); const ctx = await b.newContext(); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); }); return { site, ctx, p }; };
  // ---- 1) read in the browser
  let { site, ctx, p } = await open(withOcr); const seen = new Set();
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); const t0 = Date.now(); await p.setInputFiles('#file', pdf);
  const iv = setInterval(async () => { try { const m = (await p.innerText('main')).match(/جارٍ[^\n]*/); if (m) seen.add(m[0]); } catch { /* navigating */ } }, 250);
  await p.waitForSelector('tbody tr', { timeout: 300000 }); await p.waitForFunction(() => !/جارٍ/.test(document.querySelector('main').innerText), null, { timeout: 300000 }); clearInterval(iv);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  assert([...seen].some((s) => /جارٍ قراءة «/.test(s) && / من /.test(s)), 'the student sees the reading progress: ' + [...seen].join(' | '));
  assert(![...seen].some((s) => /صور|OCR/.test(s)), 'the progress says nothing about how the file is read: ' + [...seen].join(' | '));
  const r = await p.evaluate(async () => { const d = (await (await fetch('/api/documents')).json())[0]; const t = []; for (const n of [1, 2]) t.push((await (await fetch(`/api/documents/${d.id}/pages/${n}`)).json()).text); return { d, t }; });
  assert.strictEqual(r.d.status, 'ready'); assert.deepStrictEqual(r.d.quality.read_from_images, [1, 2], 'both pages read from their pictures');
  assert(/Mitochondria produce ATP through oxidative phosphorylation\./.test(r.t[0]) && /Competitive inhibitors bind to the active site of the enzyme\./.test(r.t[1]), 'the text is right: ' + r.t.join(' || ').slice(0, 300));
  await p.click('tbody tr td.bidi a'); await p.waitForSelector('a:has-text("إنشاء كويز")'); assert(!/قُرئت|صورها|جودة الاستخراج|OCR/.test(await p.innerText('main')), 'the file page shows no reading details (how the pages were read is internal)');
  const q = await p.evaluate(async (id) => { let q = await (await fetch('/api/quizzes', { method: 'POST', body: JSON.stringify({ title: 'scan', sources: [{ document_id: id, pages: null }], settings: { count: 10 } }) })).json();
    await fetch('/api/quizzes/' + q.id + '/analyze', { method: 'POST', body: JSON.stringify({ auto_generate: true }) });
    for (let i = 0; i < 300 && !['ready', 'failed', 'partial', 'insufficient'].includes(q.status); i++) { await new Promise((s) => setTimeout(s, 200)); q = await (await fetch('/api/quizzes/' + q.id)).json(); }
    return { status: q.status, qs: await (await fetch('/api/quizzes/' + q.id + '/questions')).json() }; }, r.d.id);
  assert.strictEqual(q.status, 'ready'); assert(q.qs.length >= 5, 'a quiz from a scanned lecture: ' + q.qs.length);
  q.qs.forEach((x) => assert(r.t.join('\n').replace(/\s+/g, ' ').includes(x.evidence[0].quote.replace(/\s+/g, ' ')), 'every quote is from what was read: ' + x.evidence[0].quote));
  console.log(`1) scanned lecture read in the browser in ${secs}s (progress shown), text right, ${q.qs.length} questions quoting what was read; e.g. ${q.qs[0].stem.slice(0, 100)}`);
  await ctx.close(); await site.close();
  // ---- 2) no reading files: an honest refusal
  ({ site, ctx, p } = await open(withoutOcr));
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('#unreadable-note', { timeout: 120000 });
  const note = await p.textContent('#unreadable-note'); assert(/لا يمكن بناء كويز/.test(note) && /الملف الأصلي/.test(note), 'why, and what to do: ' + note); assert(!/OCR|تمت معالجة/.test(await p.innerText('main')), 'no "OCR", no "processed"');
  await p.click('tbody tr td.bidi a'); await p.waitForSelector('#unreadable-note'); assert(!/OCR|جودة الاستخراج/.test(await p.innerText('main')), 'no "OCR" and no reading details on the file page either; why it cannot be used is said');
  console.log('2) without the reading files: refused honestly (why + what to do), no "OCR"');
  await ctx.close(); await site.close();
  assert.strictEqual(errs.filter((e) => !/ocr unavailable|vendor\/ocr|Failed to load resource/.test(e)).length, 0, errs.join(' | ')); console.log('scanned lecture E2E ok'); await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
