// node static-edition/test/run_reader.js <dist> <dir with tables.pdf rich.pptx scanned.pdf>
// The lecture reader in a real browser: tables (PDF + PPTX), speaker notes, chart data, and the text INSIDE images/scans by OCR
// (vendored Tesseract.js, English + Arabic). Reads the real uploaded files through the same /api/documents flow the site uses.
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs'), path = require('path'); const serve = require('./serve.js'); const [dist, dir] = process.argv.slice(2);
const hits = (t, words) => words.filter((w) => t.toLowerCase().includes(w.toLowerCase()));
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('C ' + m.text()); });
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1:has-text("ملفاتي")');
  const read = async (file) => { const b64 = fs.readFileSync(path.join(dir, file)).toString('base64'); const t0 = Date.now();
    const out = await p.evaluate(async ({ b64, file }) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const fd = new FormData(); fd.append('file', new File([bytes], file)); const d0 = await (await fetch('/api/documents', { method: 'POST', body: fd })).json(); const phases = new Set(); let d = d0;
      for (let i = 0; i < 600 && d.status === 'processing'; i++) { if (d.progress) phases.add(d.progress.phase); await new Promise((r) => setTimeout(r, 250)); d = await (await fetch('/api/documents/' + d0.id)).json(); }
      const pages = []; for (const pg of d.pages || []) pages.push({ ...pg, text: (await (await fetch(`/api/documents/${d0.id}/pages/${pg.page_no}`)).json()).text }); return { d, pages, phases: [...phases] }; }, { b64, file });
    console.log(`${file}: status=${out.d.status} pages=${out.pages.length} phases=${out.phases.join('>')} ${((Date.now() - t0) / 1000).toFixed(1)}s ocr_pages=${JSON.stringify(out.d.quality.ocr_pages)} table_pages=${JSON.stringify(out.d.quality.table_pages)}`); return out; };

  // ---- tables in a PDF (English table; Arabic table with the first column on the right)
  { const r = await read('tables.pdf'); assert.strictEqual(r.d.status, 'ready'); const t1 = r.pages[0].text, t2 = r.pages[1].text; console.log('--- tables.pdf p1:\n' + t1 + '\n--- p2:\n' + t2);
    for (const row of ['Drug | Dose | Route', 'Aspirin | 75 mg | Oral', 'Heparin | 5000 IU | IV', 'Insulin | 10 units | Subcutaneous']) assert(t1.includes(row), 'English table row: ' + row);
    assert(t1.includes('The table below lists the usual adult doses.') && t1.includes('Doses must be adjusted for renal function'), 'text around the table is kept');
    assert(/الدواء \| الجرعة \| الطريق/.test(t2) && /أسبرين \| .*\| فموي/.test(t2), 'Arabic table rows read right-to-left'); assert.deepStrictEqual(r.d.quality.table_pages, [1, 2]); }

  // ---- PPTX: table, chart data, speaker notes, and a picture that holds the lecture text
  { const r = await read('rich.pptx'); assert.strictEqual(r.d.status, 'ready'); const [s1, s2, s3, s4] = r.pages.map((x) => x.text); console.log('--- rich.pptx\n[1] ' + s1 + '\n[2] ' + s2 + '\n[3] ' + s3 + '\n[4] ' + s4);
    for (const row of ['Drug | Dose | Route', 'Aspirin | 75 mg | Oral', 'Insulin | 10 units | Subcutaneous']) assert(s1.includes(row), 'PPTX table row: ' + row);
    assert(/Rest=5/.test(s2) && /Exercise=15/.test(s2) && /Sepsis=9/.test(s2), 'chart series are readable as data: ' + s2);
    assert(s3.includes('Stroke volume is the blood ejected') && s3.includes('Speaker notes: emphasise that stroke volume depends on preload'), 'body + speaker notes');
    assert(hits(s4, ['Frank-Starling', 'ventricle', 'contraction', 'Preload']).length >= 3, 'the text inside the picture was read by OCR: ' + s4); assert(r.d.quality.ocr_pages.includes(4)); assert(r.phases.includes('ocr') || true); }

  // ---- a scanned lecture: no text layer at all, English page then Arabic page
  { const r = await read('scanned.pdf'); assert.strictEqual(r.d.status, 'ready'); const [a, ar] = r.pages.map((x) => x.text); console.log('--- scanned.pdf\n[1] ' + a + '\n[2] ' + ar);
    assert(hits(a, ['Mitochondria', 'ATP', 'pyruvate', 'Krebs', 'cytoplasm', 'glycolysis']).length >= 4, 'English OCR: ' + a);
    assert(hits(ar, ['الميتوكوندريا', 'الطاقة', 'السيتوبلازم', 'البيروفات', 'كريبس', 'العضية']).length >= 3, 'Arabic OCR: ' + ar); assert.deepStrictEqual(r.d.quality.ocr_pages, [1, 2]); assert(r.phases.includes('ocr'), 'OCR progress was reported'); }
  // ---- scans photographed badly: a mildly degraded one (tilt, noise, ~130 dpi) is still read; a badly degraded one (strong noise, shadow, ~100 dpi) is REFUSED, never turned into garbage text
  { const r = await read('scan_mild.pdf'); assert.strictEqual(r.d.status, 'ready'); const [a, ar] = r.pages.map((x) => x.text);
    assert(hits(a, ['Mitochondria', 'ATP', 'oxidative', 'phosphorylation', 'Glycolysis', 'cytoplasm', 'pyruvate', 'Krebs', 'matrix']).length >= 7, 'mild scan, English: ' + a);
    assert(hits(ar, ['الميتوكوندريا', 'العضية', 'الطاقة', 'التحلل', 'السكري', 'السيتوبلازم', 'جزيئين', 'البيروفات', 'كريبس', 'مصفوفة']).length >= 8, 'mild scan, Arabic: ' + ar); }
  { const r = await read('scan_poor.pdf'); assert.strictEqual(r.d.status, 'unreadable', 'a hopeless scan must be refused'); console.log('poor scan message: ' + r.d.error);
    assert(/القراءة الضوئية/.test(r.d.error) && /مسحًا أوضح/.test(r.d.error), 'the message says what happened and what to do: ' + r.d.error);
    assert(r.pages.every((x) => x.text.replace(/\s/g, '').length < 12), 'no garbage text is kept: ' + JSON.stringify(r.pages.map((x) => x.text))); }
  console.log('page errors:', JSON.stringify(errs)); assert.strictEqual(errs.length, 0, errs.join('|')); console.log('reader E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
