// node claude-edition/test/run_dev.js <dist> — THE DEVELOPMENT TRACK in Chromium with the shim (a stand-in for the viewer's Claude):
//  1) a student (not the artifact's owner) has no «مسار التطوير» in the menu, and the page and its API refuse them
//  2) the owner runs it: every study file of the corpus is read in memory (nothing is added to «ملفاتي»), then step after step until it is READY - and ready
//     means ALL TEN TYPES x four forms x three kinds of lecture (120 cells) learned or proven unfit by Claude itself, never only the types a lecture seems to support
//  3) every slot the track sent to Claude used one of the type's four fixed forms (nothing new), and its reminders are from the fixed catalogue
//  4) a later quiz reads what was learned: a form that keeps failing is offered less, and its slot carries the reminder for the failure it keeps hitting
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
// records the slots of every writing request sent to Claude
const RECORD = `(() => { window.__gen = []; const t = setInterval(() => { const c = window.claude; if (!c || c.__rec) return; clearInterval(t); c.__rec = true; const use = c.use.bind(c);
  c.use = async (n) => { const s = await use(n); if (n !== 'sample' || !s || s.__r) return s; const j = s.json.bind(s);
    s.json = async (input, o) => { if (input.includes('Write one question per slot')) { const a = input.indexOf('SLOTS:\\n') + 7, b = input.indexOf('\\nPAGES:\\n'); try { window.__gen.push(JSON.parse(input.slice(a, b))); } catch (_) { /* not this request */ } } return j(input, o); };
    s.__r = true; return s; }; }, 1); })();`;
(async () => {
  srv.listen(8799); const b = await chromium.launch(); const errs = [];
  const page = async (q) => { const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); p.on('pageerror', (e) => errs.push(e.message)); await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript({ content: RECORD }); return p; };
  // 1) a student
  const s = await page(); await s.addInitScript('localStorage.clear()'); await s.goto('http://localhost:8799/?notowner#/dev'); await s.waitForSelector('.card h1', { timeout: 20000 });
  assert.strictEqual(await s.locator('nav a[href="#/dev"]').count(), 0, 'no «مسار التطوير» in a student\'s menu');
  assert(/لصاحب هذه النسخة فقط/.test(await s.textContent('#main')), 'the page refuses a student');
  assert.strictEqual(await s.evaluate(async () => (await fetch('/api/dev/step', { method: 'POST' })).status), 403, 'and so does the API'); await s.close();
  console.log('1) a student: no menu entry, the page and the API refuse');
  // 2) the owner runs the track to the end
  const p = await page(); await p.addInitScript('if (!sessionStorage.getItem("once")) { localStorage.clear(); sessionStorage.setItem("once", "1"); }');
  await p.goto('http://localhost:8799/#/dev'); await p.waitForSelector('#dev-corpus summary', { timeout: 20000 }); await p.click('#dev-corpus summary'); await p.waitForSelector('#dev-run', { timeout: 20000 });      // the study files are an optional, folded part of the page (they use the owner's quota) assert.strictEqual(await p.locator('nav a[href="#/dev"]').count(), 1, 'the owner has it in the menu');
  const t0 = Date.now(); await p.click('#dev-run'); await p.waitForSelector('#dev-ready', { timeout: 300000 }); const secs = Math.round((Date.now() - t0) / 1000);
  const st = await p.evaluate(async () => (await fetch('/api/dev')).json());
  assert(st.ready && st.pct === 100 && st.need === 120 && st.learned === 120, 'ready = all 120 cells: ' + JSON.stringify({ need: st.need, learned: st.learned, pct: st.pct }));
  const types = new Set(st.cells.filter((c) => c.n > 0 || c.status === 'unfit').map((c) => c.type)); assert.strictEqual(types.size, 10, 'all ten types were tried: ' + [...types].join(','));
  for (const d of ['heavy', 'medium', 'light']) assert.strictEqual(st.cells.filter((c) => c.dens === d && (c.n >= 4 || c.status === 'unfit')).length, 40, d + ': ten types x four forms settled');
  assert(st.corpus.every((l) => l.read) && st.corpus.length === 9, 'every study file was read'); assert(st.steps <= st.max_steps);
  assert.strictEqual((await p.evaluate(async () => (await fetch('/api/documents')).json())).length, 0, 'the study files were read in memory: nothing added to «ملفاتي»');
  console.log(`2) ready after ${st.steps} steps (${secs} s with the stand-in): ${st.learned}/${st.need} cells, all ten types x four forms x three kinds of lecture`);
  // 3) only the fixed forms and reminders went to Claude
  const E = await p.evaluate(() => ({ forms: window.QZE.AI_FORMS, tips: Object.values(window.QZE.FORM_TIPS) })); const slots = (await p.evaluate(() => window.__gen)).flat();
  assert(slots.length >= 400, 'many first attempts: ' + slots.length); slots.forEach((x) => { assert((E.forms[x.type] || []).includes(x.shape), 'a fixed form: ' + x.shape); if (x.form_tip) assert(E.tips.includes(x.form_tip), 'a fixed reminder'); });
  assert(slots.some((x) => x.form_tip), 'a form that kept failing in the track was sent with its reminder, as a real quiz sends it');
  const forced = st.cells.filter((c) => ['not_except', 'sequence'].includes(c.type)); assert(forced.every((c) => c.n >= 4 || c.status === 'unfit'), 'types no study file seemed to support were still tried');
  console.log(`3) ${slots.length} slots sent, every one with one of its type's four fixed forms; ${slots.filter((x) => x.form_tip).length} carried a fixed reminder`);
  // 4) a later quiz reads what was learned
  await p.evaluate(() => { const o = JSON.parse(localStorage.getItem('qz_shim_db')); const k = Object.keys(o).find((x) => x.endsWith('/fprofile')); const pr = o[k];
    for (const d of ['heavy', 'medium', 'light']) { pr.cells['basic_recall|1|' + d] = { n: 30, ok: 3, f: { giveaway: 27 } }; pr.cells['basic_recall|0|' + d] = { n: 30, ok: 29, f: { repeat: 1 } }; pr.cells['basic_recall|2|' + d] = { n: 30, ok: 15, f: { options_same: 15 } }; }
    o[k] = pr; localStorage.setItem('qz_shim_db', JSON.stringify(o)); window.__gen.length = 0; });
  await p.goto('http://localhost:8799/#/files'); await p.reload(); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', path.join(dist, 'corpus', 'cardiac.pdf')); await p.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("20")'); await p.waitForTimeout(300); await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  const later = (await p.evaluate(() => window.__gen)).flat().filter((x) => x.type === 'basic_recall'); const n0 = later.filter((x) => x.shape === E.forms.basic_recall[0]).length, n1 = later.filter((x) => x.shape === E.forms.basic_recall[1]).length;
  assert(later.length >= 3 && n1 < n0, `the form that keeps failing is offered less (${n1}) than the one that works (${n0})`);
  const half = later.filter((x) => x.shape === E.forms.basic_recall[2]); assert(half.length >= 1 && half.every((x) => x.form_tip === E.tips[1]), 'a form that fails half the time is still offered, with the reminder for its failure (two options alike): ' + half.length);
  assert(later.filter((x) => x.shape === E.forms.basic_recall[0]).every((x) => !x.form_tip), 'a form that works carries no reminder');
  const rep = await p.evaluate(async () => { const id = location.hash.split('/')[2]; return (await (await fetch('/api/quizzes/' + id)).json()).report.forms; }); assert(rep && rep.first_attempts > 0, 'the quiz reports its own first attempts (internal)');
  const after = await p.evaluate(async () => (await fetch('/api/dev')).json()); assert(after.quizzes > st.quizzes, 'and every quiz teaches the forms too');
  console.log(`4) a later quiz: basic recall form 1 (works) offered ${n0}x, form 2 (keeps failing) ${n1}x, form 3 (half) ${half.length}x with its reminder; the quiz added its first attempts (${rep.first_attempts}) to the profile`);
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []); console.log('development track ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
