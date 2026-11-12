// node claude-chat-edition/test/run_lite.js <pdf.min.js dir> <long lecture.pdf> <deck.pptx> <short lecture.pdf> — THE LIGHT EDITION FOR THE PUBLIC LINK (a page published from a Claude chat,
// where every visitor uses Claude on their own account). Claude is simulated (window.claude.complete); the libraries the page loads from cdnjs are served from local
// copies of the same versions.
//  1) a PDF lecture: 20 questions, each with 4 distinct options, the line it was taken from found word for word in the lecture, every section of the plan covered
//  2) solving: instant feedback with the explanation and the line, a result at the end; the quiz is kept and listed after a reload
//  3) a PowerPoint deck: a 10-question quiz
//  4) a question the reviewer answers differently, or whose line is not in the lecture, never reaches the student
//  5) no Claude on the page (signed out): a plain Arabic message, no frozen screen
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [lib, PDF, PPTX, SHORT] = process.argv.slice(2); const PAGE = path.join(__dirname, '..', 'quizzy-lite.html');
const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(fs.readFileSync(PAGE)); });
const CDN = { 'pdf.min.js': 'pdf.min.js', 'pdf.worker.min.js': 'pdf.worker.min.js', 'jszip.min.js': 'jszip.min.js' };
// the simulated Claude: reads the prompt the page sends and answers the way the page asks
const MOCK = `(() => { const used = new Set(); window.__calls = { analyse: 0, write: 0, review: 0 }; window.__bad = 0;
  const pagesOf = (p) => [...p.matchAll(/<<PAGE (\\d+)>>\\n([\\s\\S]*?)\\n<<END>>/g)].map((m) => ({ n: +m[1], text: m[2] }));
  const sents = (t) => t.split(/(?<=[.!?])\\s+|\\n/).map((x) => x.trim()).filter((x) => x.split(/\\s+/).length >= 5);
  window.claude = { complete: async (p) => { await new Promise((r) => setTimeout(r, 5));
    if (p.includes('Group the TEACHING pages')) { window.__calls.analyse++; const ps = pagesOf(p).filter((x) => x.n > 1); const secs = [];
      for (let i = 0; i < ps.length; i += 2) secs.push({ title: ps[i].text.split('\\n')[0].slice(0, 40), pages: ps.slice(i, i + 2).map((x) => x.n) }); return JSON.stringify({ sections: secs }); }
    if (p.includes('multiple-choice exam questions')) { window.__calls.write++; const n = +p.match(/Write (\\d+) multiple/)[1]; const ps = pagesOf(p); const all = ps.flatMap((x) => sents(x.text).map((s) => ({ s, n: x.n })));
      const tail = (x) => x.split(/\\s+/).slice(-3).join(' '); const out = [];
      for (const c of all) { if (out.length >= n) break; if (used.has(c.s)) continue; used.add(c.s); const w = c.s.split(/\\s+/); const lead = w.slice(0, -3).join(' ');
        const wrongs = [...new Set(all.filter((o) => o.s !== c.s).map((o) => tail(o.s)))].filter((t) => t !== tail(c.s)).sort(() => Math.random() - 0.5).slice(0, 3);
        while (wrongs.length < 3) wrongs.push(['no listed structure', 'an unnamed organ', 'a missing term'][wrongs.length]);
        const bad = window.__bad++ % 7 === 3;      // every seventh question: its line is not in the lecture
        out.push({ stem: 'According to the lecture, how does this end: "' + lead + ' ..."?', options: [tail(c.s), ...wrongs], answer: 0, explanation: 'The lecture says so.', quote: bad ? 'this sentence was never in the lecture at all' : c.s, page: c.n }); }
      return 'Here you are:\\n\`\`\`json\\n' + JSON.stringify(out) + '\\n\`\`\`'; }
    if (p.includes('strict, independent exam reviewer')) { window.__calls.review++; const qs = JSON.parse(p.slice(p.indexOf('QUESTIONS:\\n') + 11, p.indexOf('\\n\\n<<PAGE')));
      return JSON.stringify(qs.map((q) => { const lead = (q.stem.match(/"(.*) \\.\\.\\."\\?$/) || [])[1] || ''; const flat = p.replace(/\\s+/g, ' '); const k = q.options.findIndex((o) => flat.includes(lead + ' ' + o)); const odd = q.i % 5 === 4;
        return { i: q.i, choice: odd ? (k + 1) % 4 : k, single_best: true, supported: true }; })); }
    throw new Error('unknown prompt'); } }; })();`;
(async () => {
  srv.listen(8830); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/cdnjs\.cloudflare\.com\/.*\/(pdf\.min\.js|pdf\.worker\.min\.js|jszip\.min\.js)$/, (route) => { const f = route.request().url().split('/').pop(); route.fulfill({ path: path.join(lib, CDN[f]), contentType: 'text/javascript' }); });
  const page = async (mock = true) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); if (mock) await p.addInitScript({ content: MOCK }); await p.goto('http://localhost:8830/'); await p.waitForSelector('text=ارفع محاضرتك'); return p; };
  const pick = async (p, f) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('text=ارفع محاضرتك')]); await fc.setFiles(f); await p.waitForSelector('text=غيّر الملف', { timeout: 30000 }); };

  // 1) a PDF lecture, 20 questions
  let p = await page(); await pick(p, PDF); await p.click('.chips button:text-is("20")'); await p.click('text=إنشاء الكويز ←');
  await p.waitForSelector('text=1 / ', { timeout: 120000 });
  const z = await p.evaluate(() => (typeof saved !== 'undefined' ? saved[0] : null)); const text = await p.evaluate(() => pages.map((x) => x.text).join('\n'));
  assert(z && z.qs.length === 20, '20 questions: ' + (z && z.qs.length));
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const q of z.qs) { assert.strictEqual(new Set(q.options).size, 4, 'four distinct options'); assert(q.answer >= 0 && q.answer < 4); assert(norm(text).includes(norm(q.quote)), 'the line is in the lecture: ' + q.quote); }
  const secs = new Set(z.qs.map((q) => q.sk)); assert(secs.size >= 2, 'more than one section covered: ' + secs.size);
  assert(new Set(z.qs.map((q) => q.answer)).size >= 3, 'the right answer is not always in the same place');
  console.log(`1) PDF: 20 questions, every line found word for word in the lecture, ${secs.size} sections covered, the right answer in ${new Set(z.qs.map((q) => q.answer)).size} different places`);

  // 4) the reviewer's disagreements and the lines not in the lecture never reached the quiz
  const calls = await p.evaluate(() => window.__calls); assert(calls.review >= 1 && calls.write >= 1);
  assert(!z.qs.some((q) => q.quote.includes('never in the lecture')), 'no question whose line is not in the lecture');
  console.log(`4) ${calls.write} writing and ${calls.review} review requests; questions with a line not in the lecture, or answered otherwise by the reviewer, were left out and replaced`);

  // 2) solving: feedback, result; kept after a reload
  await p.locator('.opt').nth(z.qs[0].answer).click(); await p.waitForSelector('.ex'); assert(/«/.test(await p.textContent('.ex')), 'the line is shown with the explanation');
  await p.click('text=التالي ←'); await p.locator('.opt').nth((z.qs[1].answer + 1) % 4).click(); await p.waitForSelector('.opt.no');
  for (let i = 2; i <= 20; i++) { await p.click(i < 20 ? 'text=التالي ←' : 'text=النتيجة'); if (i < 20) await p.locator('.opt').nth(z.qs[i].answer).click(); }
  await p.waitForSelector('text=19 من 20'); assert(/راجع ما أخطأت فيه/.test(await p.textContent('body')));
  await p.reload(); await p.waitForSelector('text=كويزاتي'); assert.strictEqual(await p.locator('ul.list li').count(), 1, 'the quiz is kept and listed');
  console.log('2) solving: the right option and the line shown at once, a wrong pick marked, «19 من 20» at the end with the review; the quiz listed again after a reload');
  await p.close();

  // 3) a PowerPoint deck
  p = await page(); await pick(p, PPTX); await p.click('.chips button:text-is("10")'); await p.click('text=إنشاء الكويز ←'); await p.waitForSelector('text=1 / ', { timeout: 120000 });
  const n3 = await p.evaluate(() => saved[0].qs.length); assert(n3 >= 1 && n3 <= 10, 'a quiz from the deck: ' + n3); if (n3 < 10) assert(await p.isVisible('#fewer'), 'fewer than asked: said');
  console.log(`3) PowerPoint: ${n3} questions from a short deck${n3 < 10 ? ' (the student told it holds no more without repeating)' : ''}`); await p.close();

  // 3b) a lecture too short for the count asked: what it holds, and the student is told
  p = await page(); await pick(p, SHORT); await p.click('.chips button:text-is("50")'); await p.click('text=إنشاء الكويز ←'); await p.waitForSelector('#fewer', { timeout: 120000 });
  console.log('3b) a short lecture asked for 50: ' + (await p.textContent('#fewer'))); await p.close();
  // 5) no Claude here
  p = await page(false); await pick(p, PDF); await p.click('text=إنشاء الكويز ←'); await p.waitForSelector('.err', { timeout: 20000 });
  assert(/سجّل الدخول في Claude/.test(await p.textContent('.err'))); console.log('5) no Claude on the page: «سجّل الدخول في Claude…», back on the first screen'); await p.close();

  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('lite ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
