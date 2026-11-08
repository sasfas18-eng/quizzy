// node claude-edition/test/run_owner.js <dist> — the owner's lecture_reader + quiz_engine rules on the Claude path (shared/owner_rules.js), in Chromium with the shim.
// A lecture whose content pages also carry a presenter credit, an institution, learning objectives and a copyright footer:
//  1) the reader classifies every part; the AI settles the uncertain ones (one reading request); only approved text reaches the writing;
//  2) no question quotes a credit, an objective or a footer; answers are spread over A-D, never one letter three times in a row;
//  3) ?quotemeta - a model that asks "who is the lecturer?" and quotes the slide's heading: every such question is refused by the owner's evidence rule
//     (validate_question_evidence / QUESTION_META); none reaches a quiz - and since this edition never fills a quiz locally, the page says Claude wrote no question that passed.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'); const assert = require('assert'); const { execFileSync } = require('child_process');
const [dist] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const pdf = path.join(os.tmpdir(), 'owner-lecture.pdf');
execFileSync('python3', ['-c', `
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
c = canvas.Canvas(${JSON.stringify(pdf)}, pagesize=A4); W, H = A4
pages = [["Kidney overview", "The kidney filters about 180 liters of plasma every day.", "Each kidney contains approximately 1 million nephrons.", "The renal artery delivers blood to the kidney at high pressure."],
 ["The glomerulus", "The glomerulus is a tuft of capillaries inside Bowman's capsule.", "Podocytes form filtration slits around the glomerular capillaries.", "Large proteins are normally retained in the blood by the filtration barrier."],
 ["Renal physiology", "Prepared by Dr. Ahmed", "College of Nursing", "The proximal tubule reabsorbs most of the filtered sodium.", "Glucose is fully reabsorbed in the proximal tubule in health."],
 ["Tubular function", "Learning Outcomes", "Identify the parts of the nephron.", "The loop of Henle creates a concentration gradient in the medulla.", "Antidiuretic hormone increases water reabsorption in the collecting duct."],
 ["Hormonal control", "Course code: NUR 210", "Aldosterone increases sodium reabsorption in the distal tubule.", "Renin is released by the juxtaglomerular cells when blood pressure falls.", "Angiotensin II causes vasoconstriction of the efferent arteriole."],
 ["Clinical notes", "Office hours: Sunday 10-12", "Slide 12 of 40", "A low glomerular filtration rate indicates reduced kidney function.", "Proteinuria results from damage to the glomerular filtration barrier.", "Dehydration increases the concentration of the urine produced."],
 ["Urine storage", "The bladder stores urine until it is released through the urethra.", "The ureters carry urine from the kidneys to the bladder by peristalsis.", "The internal urethral sphincter is under involuntary control."]]
for pg in pages:
    y = H - 70
    for i, line in enumerate(pg):
        c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 18 if i == 0 else 12); c.drawString(50, y, line); y -= 28
    c.setFont("Helvetica", 8); c.drawString(50, 30, "(c) 2024 Pearson Education. All rights reserved."); c.showPage()
c.save()`]);
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
const BAD = /Prepared by|College of Nursing|Identify the parts|Learning Outcomes|Pearson|rights reserved|Course code|Office hours|Slide 12/i;
async function run(b, query) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()');
  await p.goto(`http://localhost:8794/${query}#/files`); await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(400);
  await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل"), #retry', { timeout: 120000 });
  if (await p.locator('#retry').count()) { const msg = await p.textContent('.alert.bad'); const quiz = await p.evaluate(async () => (await fetch('/api/quizzes/' + location.hash.split('/')[2])).json()); await p.close(); assert.deepStrictEqual(errs, []); return { failed: msg, list: [], stats: {}, dropped: quiz.report ? quiz.report.dropped : [] }; }
  const r = await p.evaluate(async () => { const id = location.hash.split('/')[2]; const q = await (await fetch('/api/quizzes/' + id)).json(); const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json();
    const list = Array.isArray(qs) ? qs : qs.questions; return { stats: q.report.stats, dropped: q.report.dropped, list: list.map((x) => ({ stem: x.stem, quotes: x.evidence.map((e) => e.quote), ai: x.prompt_version !== 'rules-1.0', key: x.options.findIndex((o) => o.id === x.correct_option_id) })), reading: window.__reading || 0 }; });
  await p.close(); assert.deepStrictEqual(errs, []); return r;
}
(async () => {
  srv.listen(8794); const b = await chromium.launch();
  { const r = await run(b, ''); const rd = r.stats.owner_reading;
    assert(rd && rd.applied, 'the owner reader ran on the AI path: ' + JSON.stringify(rd)); assert(rd.counts.exclude >= 1, 'course code / office hours / slide number excluded by the reader (credits and objectives are already removed by the site\'s own cleaning): ' + JSON.stringify(rd.counts)); assert(rd.counts.include >= 10, 'the taught sentences are approved');
    assert.strictEqual(r.list.length, 10); assert(r.list.every((x) => !BAD.test(x.stem) && x.quotes.every((qq) => !BAD.test(qq))), 'no question quotes a credit, an objective or a footer: ' + JSON.stringify(r.list.map((x) => x.quotes)));
    const keys = r.list.map((x) => x.key); assert(!keys.some((k, i) => i + 2 < keys.length && k === keys[i + 1] && k === keys[i + 2]), 'balanced letters: ' + keys);
    console.log(`1-2) reader: ${JSON.stringify(rd.counts)} · ${r.reading} reading request(s) · 10 questions, none from a credit/objective/footer · answers ${keys.map((k) => 'ABCD'[k]).join('')}`); }
  { const r = await run(b, '?quotemeta');
    assert(r.list.every((x) => !/lecturer/i.test(x.stem) && x.quotes.every((qq) => !BAD.test(qq))), 'none of them reached a quiz');
    assert(r.failed && /لم يكتب Claude سؤالًا اجتاز الفحوص/.test(r.failed), 'no quiz is padded locally - the page says Claude wrote no question that passed: ' + r.failed);
    console.log(`3) a model asking only "who is the lecturer?": every such question refused by the owner's evidence rule; no local padding - "${r.failed.slice(0, 70)}…"`); }
  await b.close(); srv.close(); console.log('owner rules on the Claude path ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
