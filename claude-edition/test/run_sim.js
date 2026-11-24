// node claude-edition/test/run_sim.js <dist> <pdf> — المحاكي (Chromium, Claude simulated by shim.js):
//  1) the page's author sees «المحاكي» in the start dialog and «انشر المحاكي للطلاب» on the quiz; a student (not the owner) and the owner of a copy see neither
//  2) the simulator: the exam app's screen over a real attempt - status line and timer, Student Name, Items/Time bars, the numbered panel, Q.n / N, Multi Choice,
//     Marks, text size, light/dark; an answer, a skip, a flag each colour the panel and are kept (a reload brings them back); Summary filters by colour; End Exam
//     asks first; the result is the app's «Exam Result» (ring, marks, final rate, total questions, exam name) and «Review Answers» opens the site's own review
//  3) «انشر المحاكي للطلاب»: ONE LINK (the exam in its #part) that the students' page (share/sim/, built by scripts/build_sim_runner.mjs) opens with no account:
//     the exam's details, the exam, scored with its own key (marks spread over the questions), the «Exam Result», the review; a reload keeps the result;
//     «Retake»; the time running out hands it in; a link cut short says so. Also a FILE for a computer: runs offline; where scripts do not run (a phone's file
//     preview) it says how to open it
//  4) a phone: nothing scrolls sideways (exam, result)
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'); const assert = require('assert');
const { createQuiz } = require('./flow.js');
const [dist, pdf] = process.argv.slice(2);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
const SHOT = process.env.QZ_SHOT;
const capture = () => { const orig = window.claude.use; window.claude.use = async (n) => { const r = await orig(n); if (n === 'downloads' && r) return { save: async (x) => { window.__simFile = { filename: x.filename, text: await x.data.text() }; return r.save(x); } }; return r; }; };
const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.qsim *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1 || getComputedStyle(e).position === 'fixed' || e.closest('.qs-panel,.qs-area,.qs-res,.qs-start,.qs-grid')));
const panel = (p) => p.evaluate(() => [...document.querySelectorAll('.qs-panel .qs-n')].map((b) => b.className.replace('qs-n', '').replace(/qs-/g, '').trim()));

(async () => {
  await new Promise((ok) => srv.listen(0, ok)); const base = `http://localhost:${srv.address().port}`; const b = await chromium.launch(); const errs = [];
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-simrun-')); require('child_process').execFileSync('node', [path.join(__dirname, '../../scripts/build_sim_runner.mjs'), path.join(runDir, 'sim')]);
  const rsrv = http.createServer((q, r) => { let f = path.join(runDir, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(d); } }); });
  await new Promise((ok) => rsrv.listen(0, ok)); const SIMURL = `http://localhost:${rsrv.address().port}/sim/`;
  const ctx = await b.newContext({ viewport: { width: 1024, height: 768 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') }); await ctx.addInitScript(capture); await ctx.addInitScript((u) => { window.QZ_SIM_URL = u; }, SIMURL);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(base + '/#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 }); await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 30000 });
  await p.click('tbody tr td.bidi a'); await p.click('a:has-text("إنشاء كويز")'); await createQuiz(p, { count: 10 });
  const quizHash = await p.evaluate(() => location.hash);

  // 1) the author sees it
  assert(await p.isVisible('#sim-export') && await p.isVisible('#sim-start'), '1) «ابدأ المحاكي» and «انشر المحاكي للطلاب» on the quiz (author)');
  await p.click('#start-solve'); await p.waitForSelector('#mode-sim'); console.log('1) the author sees «المحاكي» and «انشر المحاكي للطلاب»');
  for (const [q, who] of [['?notowner', 'a student (not the owner)'], ['?copyowner', 'the owner of a copy']]) {
    const c2 = await b.newContext(); await c2.addInitScript({ path: path.join(__dirname, 'shim.js') }); const p2 = await c2.newPage(); p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(base + '/' + q + '#/files'); await p2.waitForSelector('#file', { state: 'attached', timeout: 20000 }); await p2.setInputFiles('#file', pdf); await p2.waitForSelector('table', { timeout: 30000 });
    await p2.click('tbody tr td.bidi a'); await p2.click('a:has-text("إنشاء كويز")'); await createQuiz(p2, { count: 10 });
    assert.strictEqual(await p2.locator('#sim-export').count() + await p2.locator('#sim-start').count(), 0, `1) no simulator buttons for ${who}`); await p2.click('#start-solve'); await p2.waitForSelector('.modal');
    assert.strictEqual(await p2.locator('#mode-sim').count(), 0, `1) no «المحاكي» for ${who}`); await c2.close(); console.log(`1) ${who}: neither is shown`);
  }

  // 2) the simulator
  await p.keyboard.press('Escape'); await p.goto(base + '/' + quizHash); await p.waitForSelector('#sim-start'); await p.click('#sim-start'); await p.waitForSelector('.qsim #qs-q');      // «ابدأ المحاكي»: at once
  assert(/#\/sim\/\w+$/.test(await p.evaluate(() => location.hash)), '2) its own page');
  const N = await p.locator('.qs-panel .qs-n').count(); assert(N >= 5, '2) one number per question: ' + N);
  const txt = await p.textContent('.qsim'); assert(/Student Name/.test(txt) && new RegExp(`Items 0 / ${N}`).test(txt) && /Time 0 \/ 15 \(mins\)/.test(txt) && new RegExp(`Q\\.1 / ${N}`).test(txt) && /Multi Choice/.test(txt) && /Marks: 1\.00/.test(txt), '2) the exam app\'s screen: ' + txt.slice(0, 200));
  assert(/^00:1[45]:\d\d$/.test(await p.textContent('.qs-timer')), '2) the remaining time (about a minute and a half a question)');
  await p.click('.qs-opt >> nth=0'); await p.click('#qs-next'); await p.click('#qs-skip');      // Q1 answered, Q2 skipped -> Q3
  await p.click('#qs-flag'); await p.click('.qs-opt >> nth=1'); await p.waitForTimeout(300);      // Q3 flagged and answered
  let pn = await panel(p); assert.deepStrictEqual(pn.slice(0, 3), ['done', 'skip', 'cur'], '2) the panel colours: ' + pn.slice(0, 4));
  await p.click('#qs-next'); pn = await panel(p); assert.strictEqual(pn[2], 'flag', '2) a flagged question is orange'); assert(/Items 2 \//.test(await p.textContent('.qs-head')), '2) Items counts the answers');
  const th0 = await p.getAttribute('.qsim', 'data-theme'); await p.click('#qs-theme'); assert.notStrictEqual(await p.getAttribute('.qsim', 'data-theme'), th0, '2) light / dark');
  if (SHOT) await p.screenshot({ path: SHOT + '-exam.png' });
  await p.waitForTimeout(600); await p.reload(); await p.waitForSelector('.qsim #qs-q'); await p.waitForTimeout(300);
  pn = await panel(p); assert.deepStrictEqual([pn[0], pn[1], pn[2]].map((x) => x.replace('cur', '')).filter(Boolean).length >= 2 && pn[0].includes('done') && pn[1].includes('skip') && pn[2].includes('flag'), true, '2) kept after a reload: ' + pn.slice(0, 4));
  // THE OWNER'S CASE: leave the simulator (it asks first), start the site's OWN design (never the simulator), resume it, and come back to the simulator where it was
  await p.click('.qs-panel .qs-n[data-i="3"]'); const qBefore = await p.textContent('.qs-qtop');
  await p.click('#qs-exit'); await p.waitForSelector('#qs-exitdlg'); await p.click('#qs-stay'); assert(await p.isVisible('.qsim #qs-q'), '2) «Stay» stays');
  await p.click('#qs-exit'); await p.click('#qs-leave'); await p.waitForSelector('#start-solve', { timeout: 15000 });
  assert.strictEqual(await p.evaluate(() => location.hash), quizHash, '2) «Exit» goes back to the quiz'); assert.strictEqual(await p.locator('.qsim').count(), 0, '2) the simulator is gone');
  assert.strictEqual(await p.evaluate(() => document.documentElement.style.overflow), '', '2) the page scrolls again');
  await p.waitForFunction(() => /تابع المحاكي/.test((document.querySelector('#sim-start') || {}).textContent || ''), null, { timeout: 15000 });
  assert.strictEqual(await p.locator('#resume-attempt').count(), 0, '2) «تابع محاولتك» never offers the simulator\'s attempt');
  await p.click('#start-solve'); await p.waitForSelector('.modal'); await p.click('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem', { timeout: 15000 });
  assert.strictEqual(await p.locator('.qsim').count(), 0, '2) «ابدأ الحل» opens the site\'s own design'); assert(/#\/attempt\/\w+$/.test(await p.evaluate(() => location.hash)), '2) a normal attempt');
  await p.goto(base + '/' + quizHash); await p.waitForSelector('#resume-attempt', { timeout: 15000 }); assert(/#\/attempt\//.test(await p.getAttribute('#resume-attempt', 'href')), '2) «تابع محاولتك» is the normal attempt');
  await p.click('#resume-attempt'); await p.waitForSelector('.stem'); assert.strictEqual(await p.locator('.qsim').count(), 0, '2) resuming it stays in the site\'s design');
  await p.goto(base + '/' + quizHash); await p.waitForFunction(() => /تابع المحاكي/.test((document.querySelector('#sim-start') || {}).textContent || ''), null, { timeout: 15000 });
  await p.click('#sim-start'); await p.waitForSelector('.qsim #qs-q'); assert.strictEqual(await p.textContent('.qs-qtop'), qBefore, '2) «تابع المحاكي» opens where it was left');
  console.log('2) leaving: «Exit» asks, goes back to the quiz; «ابدأ الحل» and «تابع محاولتك» stay in the site\'s design; «تابع المحاكي» opens where it was left');
  await p.click('#qs-summary'); await p.waitForSelector('#qs-sumdlg'); const sum = await p.textContent('#qs-sumdlg');
  assert(/Flagged \(1\)/.test(sum) && /Skipped \(1\)/.test(sum) && /Attempted \(2\)/.test(sum) && new RegExp(`Not Attempted \\(${N - 3}\\)`).test(sum), '2) the answer sheet: ' + sum);
  await p.check('#qs-sumdlg input[value=skip]'); assert.strictEqual(await p.locator('#qs-sumdlg .qs-grid .qs-n').count(), 1, '2) the Skipped filter');
  if (SHOT) await p.screenshot({ path: SHOT + '-summary.png' });
  await p.click('#qs-sumdlg .qs-grid .qs-n'); assert(/Q\.2 \//.test(await p.textContent('.qs-qtop')), '2) a number in the sheet opens its question');
  for (let i = 1; i < N; i++) { await p.click(`.qs-panel .qs-n[data-i="${i}"]`); if (!(await p.locator('.qs-opt.qs-on').count())) await p.click('.qs-opt >> nth=0'); }
  assert.strictEqual(await p.textContent('#qs-next'), 'End Exam', '2) End Exam on the last question'); await p.click('#qs-next'); await p.waitForSelector('#qs-confirm');
  assert(/Are you sure you want to finish exam\?/.test(await p.textContent('#qs-confirm'))); await p.click('#qs-no'); assert.strictEqual(await p.locator('#qs-confirm').count(), 0, '2) No goes back');
  await p.click('#qs-next'); await p.click('#qs-yes'); await p.waitForSelector('#qs-result', { timeout: 15000 });
  assert(/#\/sim\/\w+\/result$/.test(await p.evaluate(() => location.hash)), '2) the result page');
  const res = await p.textContent('#qs-result'); assert(/Exam Result/.test(res) && /Final Rate/.test(res) && /Total Questions/.test(res) && /Obtained Marks/.test(res) && /Exam Name/.test(res), '2) the «Exam Result»');
  assert.strictEqual(await p.textContent('#qs-totalq'), String(N)); const obtained = +(await p.textContent('#qs-obtained')); const rate = +(await p.textContent('#qs-rate')).replace('%', '');
  assert(Math.abs(rate - 100 * obtained / N) < 0.01, `2) the final rate is obtained / total (${obtained}/${N} = ${rate}%)`);
  if (SHOT) await p.screenshot({ path: SHOT + '-result.png' });
  await p.click('#qs-review'); await p.waitForSelector('h2:has-text("مراجعة الإجابات")', { timeout: 15000 }); assert.strictEqual(await p.locator('.qsim').count(), 0, '2) the review is the site\'s own page');
  await p.goto(base + '/' + quizHash); await p.waitForSelector('td:has-text("المحاكي")', { timeout: 15000 });
  console.log(`2) the simulator: ${N} questions on the exam app's screen; answer / skip / flag coloured and kept across a reload; Summary filters; End Exam asks; «Exam Result» ${obtained}/${N} = ${rate}%; the site's review; listed as «المحاكي»`);

  // 3) the link for the students
  await p.click('#sim-export'); await p.waitForSelector('#sim-export-dlg'); await p.fill('#sim-course', 'Fundamentals of Nursing Practice'); await p.fill('#sim-minutes', '1'); await p.fill('#sim-marks', '5');
  await p.click('#sim-make'); await p.waitForSelector('#sim-done, #sim-export-dlg .alert.bad', { timeout: 20000 }); if (await p.locator('#sim-export-dlg .alert.bad').count()) throw new Error('export: ' + await p.textContent('#sim-export-dlg .alert.bad')); await p.waitForSelector('#sim-link', { timeout: 20000 }); const link = await p.inputValue('#sim-link');
  assert(link.startsWith(SIMURL + '#z1.'), '3) the exam in one link: ' + link.slice(0, 60)); assert.strictEqual(await p.getAttribute('#sim-open', 'href'), link, '3) «افتح المحاكي»');
  const sctx = await b.newContext({ viewport: { width: 820, height: 1180 } }); const s = await sctx.newPage(); s.on('pageerror', (e) => errs.push('student: ' + e.message)); await s.clock.install();
  await s.goto(link); await s.waitForSelector('#qs-start'); const det = await s.textContent('.qsim');
  assert(/Fundamentals of Nursing Practice/.test(det) && /00:01:00/.test(det) && new RegExp(`Questions${N}`).test(det.replace(/\s+/g, '')) && /TotalMarks5\.0/.test(det.replace(/\s+/g, '')), '3) the exam\'s details: ' + det.slice(0, 200));
  await s.fill('#qs-name', 'Sara'); await s.click('#qs-start'); await s.waitForSelector('#qs-q'); assert(/Sara/.test(await s.textContent('.qs-who')), '3) the student\'s name');
  assert(/Marks: 0\.\d\d/.test(await s.textContent('.qs-qtop')), '3) the marks spread over the questions');
  const plan = await s.evaluate(() => { const D = window.QSIM_DATA; const st = JSON.parse(localStorage.getItem('qsim:file:' + D.id)); return st.order.map((qi, k) => ({ k, pos: st.opt[k].indexOf(QSIM.showKey(D.questions[qi])) })); });
  for (const { k, pos } of plan) { await s.click(`.qs-panel .qs-n[data-i="${k}"]`); await s.click(`.qs-opt >> nth=${k === 0 ? (pos + 1) % 4 : pos}`); }
  await s.click('#qs-summary'); await s.click('#qs-sumend'); await s.click('#qs-yes'); await s.waitForSelector('#qs-result');
  const want = Math.round((N - 1) * (5 / N) * 100) / 100; assert.strictEqual(+(await s.textContent('#qs-obtained')), want, '3) scored with its own key'); assert(/5\.0/.test(await s.textContent('.qs-stats')), '3) total marks 5.0');
  if (SHOT) await s.screenshot({ path: SHOT + '-link-result.png' });
  await s.click('#qs-review'); await s.waitForSelector('#qs-reviewlist'); assert.strictEqual(await s.locator('.qs-rv').count(), N, '3) the review: every question');
  assert.strictEqual(await s.locator('.qs-rv .qs-h .qs-bad').count(), 1, '3) one wrong in the review'); assert(await s.locator('.qs-rv .qs-o.qs-c').count() === N, '3) the right answer marked on each');
  await s.reload(); await s.waitForSelector('#qs-result'); assert.strictEqual(+(await s.textContent('#qs-obtained')), want, '3) the result is kept on the device');
  await s.click('#qs-retake'); await s.waitForSelector('#qs-q'); assert(/Items 0 \//.test(await s.textContent('.qs-head')), '3) Retake starts again');
  await s.clock.fastForward(62000); await s.clock.fastForward(2000); await s.waitForSelector('#qs-result', { timeout: 10000 }); assert.strictEqual(+(await s.textContent('#qs-obtained')), 0, '3) the time running out hands it in');
  const cut = await sctx.newPage(); await cut.goto(link.slice(0, link.length - 40)); await cut.waitForSelector('#qs-message'); assert(/not complete/.test(await cut.textContent('#qs-message')), '3) a link cut short says so'); await cut.close();
  console.log(`3) the link (${link.length} characters): no account; details, exam, own key (${want}/5), «Exam Result», review, kept after a reload, Retake, time-up; a cut link says so`);
  // THE SHORT LINK: «رابط قصير» -> the owner's publish page (a fake GitHub here): connected once with a token, the exam goes up ENCRYPTED, a ~90-character link
  const gh = { files: {}, puts: 0 };
  const ghRoute = async (route) => { const req = route.request(); const u = new URL(req.url()); const auth = req.headers()['authorization'] || '';
    if (auth !== 'Bearer good-token') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Bad credentials"}' });
    if (u.pathname === '/repos/sasfas18-eng/quizzy' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ full_name: 'sasfas18-eng/quizzy', permissions: { push: true } }) });
    const m = u.pathname.match(/^\/repos\/sasfas18-eng\/quizzy\/contents\/(share\/sim\/e\/([a-z0-9]+)\.json)$/); if (!m) return route.fulfill({ status: 404, body: '{}' });
    const f = path.join(runDir, 'sim', 'e', m[2] + '.json');
    if (req.method() === 'PUT') { const body = JSON.parse(req.postData()); assert.strictEqual(body.branch, 'gh-pages'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(body.content, 'base64')); gh.puts++; return route.fulfill({ status: 201, contentType: 'application/json', body: '{"content":{"sha":"s1"}}' }); }
    if (req.method() === 'GET') return fs.existsSync(f) ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"sha":"s1"}' }) : route.fulfill({ status: 404, body: '{}' });
    if (req.method() === 'DELETE') { if (fs.existsSync(f)) fs.unlinkSync(f); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    return route.fulfill({ status: 405, body: '{}' }); };
  const pubHref = await p.getAttribute('#sim-short', 'href'); assert(pubHref.startsWith(SIMURL + 'publish.html#z1.'), '3) «رابط قصير» opens the publish page with the exam');
  const octx = await b.newContext({ viewport: { width: 820, height: 1180 } }); await octx.route('https://api.github.com/**', ghRoute); const o = await octx.newPage(); o.on('pageerror', (e) => errs.push('publish: ' + e.message));
  await o.goto(pubHref); await o.waitForSelector('#pub-token'); assert.strictEqual(await o.evaluate(() => location.hash), '', '3) the long #part is not kept in the address bar');
  await o.fill('#pub-token', 'bad'); await o.click('#pub-save'); await o.waitForSelector('#pub-err'); assert(/غير صحيح/.test(await o.textContent('#pub-err')), '3) a wrong token is refused');
  await o.fill('#pub-token', 'good-token'); await o.click('#pub-save'); await o.waitForSelector('#pub-ready', { timeout: 30000 });
  const short = await o.inputValue('#pub-link'); assert(/^http:\/\/localhost:\d+\/sim\/#e\.[a-z0-9]{4,16}\.[A-Za-z0-9_-]{16,32}$/.test(short), '3) the short link: ' + short);
  assert(short.length - SIMURL.length < 50, '3) short: ' + short.length + ' characters'); assert.strictEqual(gh.puts, 1, '3) one file put on the site');
  const stored = fs.readFileSync(path.join(runDir, 'sim', 'e', fs.readdirSync(path.join(runDir, 'sim', 'e'))[0]), 'utf8');
  assert(/"ct":"[A-Za-z0-9_-]{100,}"/.test(stored) && !/Complete according|stem|options|Fundamentals/.test(stored), '3) on GitHub the exam is noise (encrypted): ' + stored.slice(0, 80));
  if (SHOT) await o.screenshot({ path: SHOT + '-publish.png' });
  const st2 = await b.newContext({ viewport: { width: 390, height: 844 } }); const s2 = await st2.newPage(); s2.on('pageerror', (e) => errs.push('short: ' + e.message));
  await s2.goto(short); await s2.waitForSelector('#qs-start', { timeout: 15000 }); assert(/Fundamentals of Nursing Practice/.test(await s2.textContent('.qsim')), '3) the short link opens the exam');
  await s2.click('#qs-start'); await s2.waitForSelector('#qs-q'); await s2.click('.qs-opt >> nth=0'); await s2.click('#qs-summary'); await s2.click('#qs-sumend'); await s2.click('#qs-yes'); await s2.waitForSelector('#qs-result');
  const bad = await st2.newPage(); await bad.goto(short.slice(0, -6) + 'AAAAAA'); await bad.waitForSelector('#qs-message'); await bad.waitForFunction(() => /not complete/.test(document.querySelector('#qs-message').textContent)); await bad.close();
  await o.goto(SIMURL + 'publish.html'); await o.waitForSelector('#pub-forget'); assert(/لا يوجد اختبار جديد/.test(await o.textContent('#pub')) && (await o.locator('[id^=pub-del-]').count()) === 1, '3) the publish page lists the owner\'s exams');
  o.on('dialog', (d) => d.accept()); await o.click('[id^=pub-del-]'); await o.waitForFunction(() => !document.querySelector('[id^=pub-del-]'));
  const gone = await st2.newPage(); await gone.goto(short); await gone.waitForSelector('#qs-message'); await gone.waitForFunction(() => /not on the site/.test(document.querySelector('#qs-message').textContent)); await gone.close();
  await st2.close(); await octx.close();
  console.log(`3) the short link (${short.length - SIMURL.length + 'x'.length - 1} characters after the page): a token once (a wrong one refused), the exam ENCRYPTED on GitHub, opens for a student; a broken key says so; taken down from the list`);
  // the file, for a computer
  await p.click('#sim-file'); await p.waitForSelector('#sim-done', { timeout: 20000 }); const file = await p.evaluate(() => window.__simFile);
  assert(file && /Exam Simulator\.html$/.test(file.filename) && file.text.startsWith('<!doctype html>'), '3) one html file: ' + (file && file.filename));
  assert(!/<script[^>]+src=|<link[^>]+href=|<img[^>]+src="?https?:/i.test(file.text), '3) the file loads nothing from anywhere (and it runs offline, below)');
  const fpath = path.join(os.tmpdir(), 'qz-sim-test.html'); fs.writeFileSync(fpath, file.text);
  const fctx = await b.newContext({ offline: true }); const f = await fctx.newPage(); f.on('pageerror', (e) => errs.push('file: ' + e.message));
  await f.goto('file://' + fpath); await f.waitForSelector('#qs-start'); await f.click('#qs-start'); await f.waitForSelector('#qs-q'); await f.click('#qs-summary'); await f.click('#qs-sumend'); await f.click('#qs-yes'); await f.waitForSelector('#qs-result');
  const nctx = await b.newContext({ javaScriptEnabled: false }); const nj = await nctx.newPage(); await nj.goto('file://' + fpath);
  assert(/open it in a web browser/.test(await nj.textContent('#qsim-nojs')), '3) where scripts do not run (a phone\'s file preview): how to open it'); await nctx.close(); await fctx.close();
  console.log(`3) the file (${Math.round(file.text.length / 1024)} KB): runs offline on a computer; a preview that runs no script says how to open it`);

  // 4) a phone
  await s.setViewportSize({ width: 390, height: 844 }); await s.click('#qs-retake'); await s.waitForSelector('#qs-q'); assert(await noSideways(s), '4) the exam on a phone'); if (SHOT) await s.screenshot({ path: SHOT + '-phone.png' });
  await s.click('#qs-summary'); await s.click('#qs-sumend'); await s.click('#qs-yes'); await s.waitForSelector('#qs-result'); assert(await noSideways(s), '4) the result on a phone');
  console.log('4) a phone: nothing scrolls sideways (exam, result)');
  assert.deepStrictEqual(errs, []); await b.close(); srv.close(); rsrv.close(); console.log('simulator ok');
})().catch((e) => { console.error(e); process.exit(1); });
