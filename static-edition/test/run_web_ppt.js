// node static-edition/test/run_web_ppt.js <dist>
// A lecture saved in the OLD PowerPoint format (.ppt, PowerPoint 97-2003 - many teachers still send these) is read in the browser: the
// slides' text in presentation order, one page per slide, the slide-number field («*») left out; then a quiz is built from it with no AI.
// The fixture (fixtures/slides_en.ppt.gz) is the sample deck of backend/tests/fixtures.py saved as .ppt by LibreOffice, gzipped.
const { chromium } = require('playwright'); const assert = require('assert'); const path = require('path'); const fs = require('fs'); const zlib = require('zlib'); const os = require('os');
const serve = require('./serve.js'); const { seedAccount } = require('./signin.js'); const { createQuiz } = require('../../claude-edition/test/flow.js');
const [dist] = process.argv.slice(2);
(async () => {
  const file = path.join(os.tmpdir(), 'Lecture 3 - The Cell Membrane.ppt'); fs.writeFileSync(file, zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'slides_en.ppt.gz'))));
  const site = await serve(dist, 0, "window.QZ_CONFIG={supabaseUrl:'',supabaseAnonKey:'',llm:[]};"); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await seedAccount(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  // 1) the file picker offers .ppt and the file is read
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); assert(/\.ppt\b/.test(await p.getAttribute('#file', 'accept')), 'the picker accepts .ppt');
  await p.setInputFiles('#file', file); await p.waitForSelector('tbody tr', { timeout: 60000 }); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText), null, { timeout: 60000 });
  const doc = await p.evaluate(async () => { const d = (await (await fetch('/api/documents')).json())[0]; const pages = []; for (let n = 1; n <= d.page_count; n++) pages.push((await (await fetch(`/api/documents/${d.id}/pages/${n}`)).json()).text); return { d, pages }; });
  assert.strictEqual(doc.d.kind, 'ppt', 'stored as a .ppt document'); assert.strictEqual(doc.d.status, 'ready'); assert.strictEqual(doc.pages.length, 6, 'one page per slide');
  const firstLines = doc.pages.map((t) => t.split('\n')[0]);
  assert.deepStrictEqual(firstLines, ['Lecture 3: The Cell Membrane', 'Functions of the membrane', 'Fluid Mosaic Model', 'Transport across the membrane', 'Types of membrane proteins', 'Sodium-potassium pump'], 'the slides in presentation order: ' + firstLines);
  assert(/Passive transport: movement down a concentration gradient without energy/.test(doc.pages[3]) && /2\. ATP phosphorylates the pump/.test(doc.pages[5]), 'the bullets read word for word');
  assert(!doc.pages.some((t) => /^\*$/m.test(t)), 'no slide-number field');
  console.log('1) .ppt read: 6 slides in order, ' + doc.pages.join(' ').split(/\s+/).length + ' words');
  // 2) a quiz from it, without any AI
  await p.goto(site.url + '/#/new'); await createQuiz(p, { count: 20 });
  const { qs, rep } = await p.evaluate(async () => { const q = (await (await fetch('/api/quizzes')).json())[0]; const full = await (await fetch('/api/quizzes/' + q.id)).json(); return { qs: await (await fetch('/api/quizzes/' + q.id + '/questions')).json(), rep: full.report || {} }; });
  assert.strictEqual(qs.length, 20, '20 questions'); qs.forEach((q) => { assert.strictEqual(new Set(q.options.map((o) => o.text.toLowerCase())).size, 4); assert(q.evidence.length && q.evidence[0].page_no >= 1); });
  // slide 1 is the title with the lesson's objectives: not lecture content - no question from it, and the report says why it was left out
  assert(qs.every((q) => q.evidence.every((e) => e.page_no !== 1)), 'no question from the title / objectives slide');
  assert(qs.every((q) => !/objectives|will be able|Lecture 3/i.test(q.stem + ' ' + q.options.map((o) => o.text).join(' '))), 'nothing asks about the objectives or the lecture title');
  assert((rep.excluded_pages || []).some((x) => x.page === 1 && x.status === 'front_matter'), 'slide 1 reported as front matter: ' + JSON.stringify(rep.excluded_pages));
  console.log('2) quiz from the .ppt: ' + qs.length + ' questions, ' + new Set(qs.map((q) => q.qtype)).size + ' types; e.g. ' + qs[0].stem.slice(0, 80));
  // 3) a file that only pretends to be a .ppt is refused clearly
  const bad = path.join(os.tmpdir(), 'broken.ppt'); fs.writeFileSync(bad, 'not a powerpoint file at all');
  const r = await p.evaluate(async (bytes) => { const fd = new FormData(); fd.append('file', new File([new Uint8Array(bytes)], 'broken.ppt')); const res = await fetch('/api/documents', { method: 'POST', body: fd }); return { status: res.status, body: await res.json() }; }, [...fs.readFileSync(bad)]);
  assert.strictEqual(r.status, 415, 'a fake .ppt is refused: ' + JSON.stringify(r)); assert(/PowerPoint/.test(JSON.stringify(r.body)), 'the message names the supported formats');
  console.log('3) a fake .ppt is refused: ' + JSON.stringify(r.body).slice(0, 120));
  console.log('ERRS', JSON.stringify(errs)); assert.deepStrictEqual(errs, []);
  await b.close(); await site.close(); console.log('ppt E2E ok');
})().catch((e) => { console.error(e); process.exit(1); });
