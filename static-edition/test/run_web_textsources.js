// node static-edition/test/run_web_textsources.js <dist> <diagram.pptx> <text.pdf>
// The lecture's TEXT is read from everything the file carries, and text recognition (OCR) is only a support for a lecture that is all pictures:
//  1) a PowerPoint SmartArt diagram and a chart look like pictures but carry real text: read without any recognition (and asked about);
//  2) a PDF with its own text and one picture page: the picture page is NOT recognised (no «Bram», no broken Arabic labels) - and it says why;
//  3) nothing in any question shows as a box or a symbol, and no English question has an Arabic option.
const { chromium } = require('playwright'); const assert = require('assert');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js');
const [dist, pptx, pdf] = process.argv.slice(2);
(async () => {
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:''};"); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext(); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  const upload = async (file) => { await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', file); await p.waitForSelector('tbody tr', { timeout: 60000 });
    await p.waitForFunction(() => !/جارٍ رفع|قيد القراءة/.test(document.body.innerText), null, { timeout: 120000 }); };
  const quiz = (docIndex, n) => p.evaluate(async ([di, n]) => { const d = (await (await fetch('/api/documents')).json())[di]; const full = await (await fetch('/api/documents/' + d.id)).json();
    const pages = []; for (const m of full.pages) pages.push({ no: m.page_no, status: m.status, notes: m.notes, ocr: m.ocr || null, text: (await (await fetch(`/api/documents/${d.id}/pages/${m.page_no}`)).json()).text || '' });
    let q = await (await fetch('/api/quizzes', { method: 'POST', body: JSON.stringify({ title: 't', sources: [{ document_id: d.id, pages: null }], settings: { count: n } }) })).json();
    await fetch('/api/quizzes/' + q.id + '/analyze', { method: 'POST', body: JSON.stringify({ auto_generate: true }) });
    for (let i = 0; i < 600 && !['ready', 'failed', 'partial', 'insufficient'].includes(q.status); i++) { await new Promise((s) => setTimeout(s, 200)); q = await (await fetch('/api/quizzes/' + q.id)).json(); }
    const qs = await (await fetch('/api/quizzes/' + q.id + '/questions')).json(); return { pages, qs: qs.map((x) => ({ stem: x.stem, options: x.options.map((o) => o.text), pages: x.source_pages })) }; }, [docIndex, n]);
  const readable = (qs) => qs.forEach((x) => { const all = [x.stem, ...x.options].join(' '); assert(!/[-�]/.test(all), 'no box / symbol: ' + all);
    if (!/[؀-ۿ]/.test(x.stem)) assert(!x.options.some((o) => /[؀-ۿ]/.test(o)), 'an English question has no Arabic option: ' + all); });
  // 1) SmartArt + chart, no recognition
  await upload(pptx); const A = await quiz(0, 10);
  const s1 = A.pages[0].text, s2 = A.pages[1].text;
  ['Infectious agent', 'Reservoir', 'Portal of exit', 'Mode of transmission', 'Portal of entry', 'Susceptible host'].forEach((t) => assert(s1.includes(t), 'SmartArt node read: ' + t + ' in ' + JSON.stringify(s1)));
  ['Growth of microbes at different temperatures', 'Psychrophiles', 'Mesophiles', 'Thermophiles'].forEach((t) => assert(s2.includes(t), 'chart text read: ' + t + ' in ' + JSON.stringify(s2)));
  assert(A.pages.every((x) => !x.ocr), 'no page of the PowerPoint went through recognition');
  const fromDiagram = A.qs.filter((x) => (x.pages || []).includes(1) || (x.pages || []).includes(2)); readable(A.qs);
  assert(fromDiagram.length >= 2, 'the diagram / chart text is asked about: ' + fromDiagram.length);
  console.log(`1) SmartArt (6 nodes) and chart (title + 3 categories) read without OCR; ${A.qs.length} questions, ${fromDiagram.length} from the diagram / chart slides, e.g. ${(fromDiagram[0] || A.qs[0]).stem.slice(0, 90)}`);
  // 2) a PDF with its own text + a picture page: the picture page is not recognised, and says why
  await upload(pdf); const B = await quiz(0, 8); const pic = B.pages.find((x) => x.status === 'image_only');
  assert(pic, 'the picture page is a picture page: ' + JSON.stringify(B.pages.map((x) => [x.no, x.status]))); assert(!pic.ocr && !pic.text.trim(), 'not recognised'); assert(/لم تُقرأ آليًا/.test(pic.notes), 'it says why: ' + pic.notes);
  readable(B.qs); console.log(`2) a text PDF with a picture page: page ${pic.no} not recognised («${pic.notes.slice(0, 60)}…»); ${B.qs.length} questions from the text pages`);
  assert.deepStrictEqual(errs, []); console.log('3) no box / symbol, no Arabic option in an English question - text sources E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
