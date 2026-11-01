// node static-edition/test/run_web_reflow.js <dist> <paper_2col.pdf> — a real-world-like PDF (two justified columns, words hyphenated at line ends, a running header,
// an e-mail line, a references list) on the site with NO AI: the page text is read back into sentences, and the local questions are made of whole sentences.
// Found by using the site as a student: such a PDF gave «what is "This"?» and options cut mid-word ("are pop-").
const { chromium } = require('playwright'); const assert = require('assert'); const serve = require('./serve.js'); const { seedAccount } = require('./signin.js');
const [dist, pdf] = process.argv.slice(2);
(async () => {
  const site = await serve(dist, 0); const b = await chromium.launch(); const ctx = await b.newContext(); await seedAccount(ctx); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); });
  await p.goto(site.url + '/#/files'); await p.waitForSelector('h1'); await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr'); await p.waitForFunction(() => !/جارٍ رفع/.test(document.body.innerText));
  const r = await p.evaluate(async () => {
    const d = (await (await fetch('/api/documents')).json())[0]; const text = (await (await fetch(`/api/documents/${d.id}/pages/1`)).json()).text;
    let q = await (await fetch('/api/quizzes', { method: 'POST', body: JSON.stringify({ title: 'reflow', sources: [{ document_id: d.id, pages: null }], settings: { count: 20 } }) })).json();
    await fetch('/api/quizzes/' + q.id + '/analyze', { method: 'POST', body: JSON.stringify({ auto_generate: true }) });
    for (let i = 0; i < 300 && !['ready', 'failed', 'partial', 'insufficient'].includes(q.status); i++) { await new Promise((s) => setTimeout(s, 200)); q = await (await fetch('/api/quizzes/' + q.id)).json(); }
    const qs = await (await fetch('/api/quizzes/' + q.id + '/questions')).json();
    const cards = await (await fetch(`/api/documents/${d.id}/cards/generate`, { method: 'POST', body: JSON.stringify({ count: 15 }) })).json();
    return { text, status: q.status, generator: q.generator, qs: qs.map((x) => ({ stem: x.stem, options: x.options.map((o) => o.text), quote: (x.evidence[0] || {}).quote || '' })), cards: (await (await fetch('/api/cards?document_id=' + d.id)).json()).map((c) => [c.front, c.back]) };
  });
  // 1) the page text: whole sentences, hyphens of line ends removed, columns followed
  assert(/the glomerular filtration barrier, the Starling forces/.test(r.text), 'a word hyphenated at the line end is whole again ("glome-" + "rular"): ' + r.text.slice(0, 400));
  assert(/Podocytes are specialised epithelial cells that wrap around the glomerular capillaries\./.test(r.text), 'a sentence that was cut at two line ends is one line');
  assert(!/[a-z]{2,}-\n/.test(r.text), 'no line ends inside a hyphenated word'); assert(/^1\. The filtration barrier$/m.test(r.text), 'a heading stays its own line');
  console.log('1) page text read back into sentences (hyphens removed, headings kept)');
  // 2) the questions: built locally, whole sentences, real terms, nothing from the apparatus
  assert.strictEqual(r.status, 'ready'); assert(r.qs.length >= 15, 'a full quiz: ' + r.qs.length);
  const all = r.qs.flatMap((q) => [q.stem, ...q.options]);
  all.forEach((s) => assert(!/\b[a-z]{2,}-(\s|$)/.test(s) || /self-|non-/.test(s), 'no text cut at a hyphen: ' + s));
  r.qs.forEach((q) => { assert(!/what is "(This|That|They|It|There|These|Those)"/i.test(q.stem), 'no pronoun as a term: ' + q.stem); assert(!/\[\d\]|Guyton|Koeppen|doi:|@/.test(q.stem + q.quote + q.options.join(' ')), 'nothing from the references / address lines: ' + q.stem);
    assert(/^[A-Z0-9«"(]/.test(q.quote.trim()), 'every quoted lecture sentence starts like a sentence: ' + q.quote); });
  r.cards.forEach(([f, k]) => assert(!/\b[a-z]{2,}-(\s|$)/.test(f + ' ' + k) && !/\[\d\]|Guyton|@/.test(f + k), 'cards too: ' + f + ' => ' + k));
  console.log(`2) ${r.qs.length} local questions + ${r.cards.length} cards, all from whole sentences; e.g. ${r.qs[0].stem.slice(0, 120)}`);
  assert.strictEqual(errs.length, 0, errs.join(' | ')); console.log('reflow E2E ok'); await b.close(); await site.close();
})().catch((e) => { console.error(e); process.exit(1); });
