// node claude-edition/test/run_share.js <dist> — the owner shares what the forms learned with every student; a student who opens the shared link (claude.ai
// gives them the `view` level: they read and write nothing, their own space included) still uploads and makes quizzes - on their own device - and their
// quizzes start from what the owner shared.
//  1) the owner presses «حدّث الصيغ لكل الطلاب» on #/dev: the shared forms profile is written to the artifact's shared store
//  2) a link visitor: told their files stay on this device, no «مسار التطوير», the API refuses it; their upload and their quiz work (nothing written to the
//     claude.ai store - every save is on the device)
//  3) their quiz reads the shared profile: the form that keeps failing is offered less, a form with a recurring failure carries its reminder
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
const RECORD = `(() => { window.__gen = []; const t = setInterval(() => { const c = window.claude; if (!c || c.__rec) return; clearInterval(t); c.__rec = true; const use = c.use.bind(c);
  c.use = async (n) => { const s = await use(n); if (n !== 'sample' || !s || s.__r) return s; const j = s.json.bind(s);
    s.json = async (input, o) => { if (input.includes('Write one question per slot')) { const a = input.indexOf('SLOTS:\\n') + 7, b = input.indexOf('\\nPAGES:\\n'); try { window.__gen.push(JSON.parse(input.slice(a, b))); } catch (_) { /* not this request */ } } return j(input, o); };
    s.__r = true; return s; }; }, 1); })();`;
(async () => {
  srv.listen(8803); const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const errs = [];
  await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') }); await ctx.addInitScript({ content: RECORD });
  // 1) the owner shares what the forms learned
  const o = await ctx.newPage(); o.on('pageerror', (e) => errs.push(e.message)); await o.goto('http://localhost:8803/#/'); await o.evaluate(() => localStorage.clear());
  await o.evaluate(() => { const cells = {}; for (const d of ['heavy', 'medium', 'light']) { cells['basic_recall|0|' + d] = { n: 30, ok: 29, f: { repeat: 1 } }; cells['basic_recall|1|' + d] = { n: 30, ok: 3, f: { giveaway: 27 } }; cells['basic_recall|2|' + d] = { n: 30, ok: 15, f: { options_same: 15 } }; }
    localStorage.setItem('qz_shim_db', JSON.stringify({ 'data/users/u1/fprofile': { kind: 'fprofile', id: 'fprofile', v: 1, cells, quizzes: 5 } })); });
  await o.goto('http://localhost:8803/#/dev'); await o.reload(); await o.waitForSelector('#dev-publish', { timeout: 20000 });
  assert(/لم يصل للطلاب تحديث بعد/.test(await o.textContent('#dev-shared')), 'nothing shared yet');
  await o.click('#dev-publish'); await o.waitForFunction(() => /آخر تحديث وصل للطلاب/.test((document.getElementById('dev-shared') || {}).textContent || ''), null, { timeout: 15000 });
  const shared = await o.evaluate(() => JSON.parse(localStorage.getItem('qz_shim_db'))['forms/shared']); assert(shared && shared.cells && shared.quizzes === 5, 'the shared profile is in the shared store');
  await o.close(); console.log('1) the owner pressed «حدّث الصيغ لكل الطلاب»: ' + Object.keys(shared.cells).length + ' cells shared');
  // 2) a link visitor: their own device, no development track
  const v = await ctx.newPage(); v.on('pageerror', (e) => errs.push(e.message)); await v.goto('http://localhost:8803/?viewer#/files'); await v.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await v.waitForFunction(() => { const b = document.getElementById('ce-banner'); return !!b && b.style.display === 'none'; }, null, { timeout: 10000 });      // no explanatory banner
  assert.strictEqual(await v.locator('nav a[href="#/dev"]').count(), 0, 'no development track for a student'); assert.strictEqual(await v.evaluate(async () => (await fetch('/api/dev')).status), 403);
  await v.setInputFiles('#file', path.join(dist, 'corpus', 'cardiac.pdf')); await v.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await v.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await v.click('tbody tr a.fquiz'); await v.waitForSelector('#create-quiz'); await v.click('.chips button:text-is("20")'); await v.waitForTimeout(300); await v.click('#create-quiz');
  await v.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  const written = await v.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('qz_shim_db') || '{}')).filter((k) => k.startsWith('data/users/u2/')));
  assert.deepStrictEqual(written, [], 'nothing of the student was written to the claude.ai store: ' + written.join(','));
  const n = await v.evaluate(async () => { const id = location.hash.split('/')[2]; return (await (await fetch('/api/quizzes/' + id + '/questions')).json()).length; }); assert.strictEqual(n, 20, 'the student\'s quiz: 20 questions');
  console.log('2) a link visitor: no banner, no development track (403), upload and a 20-question quiz on their own device, nothing written to the claude.ai store');
  // 3) the student's quiz starts from what the owner shared
  const forms = await v.evaluate(() => ({ list: window.QZE.AI_FORMS.basic_recall, tips: window.QZE.FORM_TIPS })); const slots = (await v.evaluate(() => window.__gen)).flat().filter((x) => x.type === 'basic_recall');
  const n0 = slots.filter((x) => x.shape === forms.list[0]).length, n1 = slots.filter((x) => x.shape === forms.list[1]).length, half = slots.filter((x) => x.shape === forms.list[2]);
  assert(slots.length >= 3 && n1 < n0, `the form that keeps failing (${n1}) is offered less than the one that works (${n0})`); assert(half.every((x) => x.form_tip === forms.tips.options_same), 'a recurring failure carries its reminder');
  console.log(`3) the student's quiz used what was shared: basic recall form 1 ${n0}x, form 2 (keeps failing) ${n1}x, form 3 ${half.length}x with its reminder`);
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('sharing with students ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
