// node claude-edition/test/run_explain_share.js <dist> — «شارك الشرح»: the lecture's explanation shared with someone who has no account and no Claude.
//  1) on the explanation page «شارك الشرح» makes ONE html file: every slide (its picture made smaller), its explanation, its questions
//  2) the file runs offline: the slide pinned on top, the idea and the points (a point lights its line on the picture), the terms, «تذكّر», the slide's questions
//     answered on the spot; next / previous / the slide list; where the reader was is kept; «اسمع الشرح» reads it aloud with the device's voice
//  3) the owner's short link: the publish page takes the same file, puts it ENCRYPTED on the site in several files (each under 1 MB), the link opens it
//     anywhere; taken down from the list, every file of it goes and the link says so
//  4) a phone: nothing scrolls sideways
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf'); const SHOT = process.env.QZ_SHOT;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const serve = (dir, all) => http.createServer((q, r) => { let f = path.join(dir, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': all || mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
const capture = () => { const orig = window.claude.use; window.claude.use = async (n) => { const r = await orig(n); if (n === 'downloads' && r) return { save: async (x) => { window.__file = { filename: x.filename, text: await x.data.text() }; return r.save(x); } }; return r; }; };
const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.qsim *')].every((e) => e.getBoundingClientRect().right <= innerWidth + 1 || e.closest('.qs-start,.qs-xlines,details')));

(async () => {
  const srv = serve(dist); await new Promise((ok) => srv.listen(0, ok)); const base = `http://localhost:${srv.address().port}`; const b = await chromium.launch(); const errs = [];
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-xshare-')); require('child_process').execFileSync('node', [path.join(__dirname, '../../scripts/build_sim_runner.mjs'), path.join(runDir, 'sim')]);
  const rsrv = serve(runDir, 'text/html'); await new Promise((ok) => rsrv.listen(0, ok)); const SIMURL = `http://localhost:${rsrv.address().port}/sim/`;
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') }); await ctx.addInitScript(capture); await ctx.addInitScript((u) => { window.QZ_SIM_URL = u; }, SIMURL);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(base + '/#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 }); await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fexplain', { timeout: 30000 });
  await p.click('tbody tr a[href^="#/files/"]'); await p.click('#explain-lecture'); await p.waitForSelector('.xidea', { timeout: 20000 }); await p.waitForSelector('.xready.all', { timeout: 30000 });
  const N = await p.locator('.xdot').count();
  // 1) the file
  await p.click('#x-share'); await p.waitForSelector('#xs-file', { timeout: 60000 }); const msg = await p.textContent('#xs-msg'); assert(/جاهز/.test(msg) && !/بدون شرح/.test(msg), '1) every slide explained: ' + msg);
  assert(await p.locator('#xs-publish').count() === 1, '1) the owner is shown the short-link way'); assert.strictEqual(await p.getAttribute('#xs-publish', 'href'), SIMURL + 'publish.html');
  await p.click('#xs-file'); await p.waitForSelector('#xs-done'); const file = await p.evaluate(() => window.__file);
  assert(file && /- شرح\.html$/.test(file.filename) && file.text.startsWith('<!doctype html>'), '1) one html file: ' + (file && file.filename));
  assert(!/<script[^>]+src=|<link[^>]+href=|<img[^>]+src="?https?:/i.test(file.text), '1) the file loads nothing from anywhere');
  const data = JSON.parse(file.text.match(/window\.QSIM_FILE = (\{[\s\S]*\});\nQSIM\.boot\(\);/)[1]);
  assert.strictEqual(data.kind, 'explain'); assert.strictEqual(data.slides.length, N, '1) every slide'); assert(data.slides.every((s) => s.x && s.x.idea), '1) each with its explanation');
  const pics = data.slides.filter((s) => /^data:image\/jpeg;base64,/.test(s.img)).length; assert(pics >= 1, '1) the slides\' pictures: ' + pics);
  console.log(`1) «شارك الشرح»: one file «${file.filename}» (${Math.round(file.text.length / 1024)} KB): ${N} slides, ${pics} pictures, every slide explained; the owner is shown the short link`);
  // 2) the file, offline
  const fpath = path.join(os.tmpdir(), 'qz-xshare-test.html'); fs.writeFileSync(fpath, file.text);
  const fctx = await b.newContext({ offline: true, viewport: { width: 1024, height: 768 } }); const f = await fctx.newPage(); f.on('pageerror', (e) => errs.push('file: ' + e.message));
  await f.goto('file://' + fpath); await f.waitForSelector('#qs-xexp'); assert.strictEqual(await f.getAttribute('.qsim', 'dir'), 'rtl', '2) right to left');
  assert(/شرح المحاضرة/.test(await f.title()), '2) the page is titled: ' + await f.title());
  const first = data.slides.findIndex((s) => s.img); for (let i = 0; i < first; i++) await f.click('#qs-xnext');
  await f.waitForFunction(() => { const im = document.querySelector('.qs-xpic img'); return im && im.complete && im.naturalWidth > 0; });
  const pts = await f.locator('.qs-xpts li').count(); assert(pts >= 1, '2) the points'); assert(await f.locator('.qs-xidea').count() === 1, '2) the idea');
  const withBox = data.slides[first].boxes.length; await f.click('.qs-xpts li >> nth=0');
  const lit = await f.locator('.qs-xhl, .qs-xlit').count(); assert(lit >= 1 || !withBox, '2) a point lights its line');
  const sq = data.slides.findIndex((s) => s.x.questions.length); if (sq >= 0) { await f.selectOption('#qs-xjump', String(sq)); await f.click('.qs-xq >> nth=0 >> .qs-xo >> nth=0'); await f.waitForSelector('.qs-xwhy'); assert(await f.locator('.qs-xo.qs-xr').count() >= 1, '2) the right answer shown'); }
  await f.selectOption('#qs-xjump', '1'); await f.reload(); await f.waitForSelector('#qs-xexp'); assert.strictEqual(await f.inputValue('#qs-xjump'), '1', '2) where the reader was is kept');
  await f.click('#qs-xprev'); assert.strictEqual(await f.inputValue('#qs-xjump'), '0'); assert(await f.isDisabled('#qs-xprev'), '2) no slide before the first');
  await f.evaluate(() => { window.__said = []; window.speechSynthesis.speak = (u) => { window.__said.push(u.text); }; window.speechSynthesis.cancel = () => {}; });
  await f.click('#qs-xvoice'); const said = await f.evaluate(() => window.__said); assert(said.length >= 2 && /■/.test(await f.textContent('#qs-xvoice')), '2) «اسمع الشرح» reads the idea and the points: ' + said.length);
  await f.click('#qs-xnext'); assert(/🔊/.test(await f.textContent('#qs-xvoice')), '2) a new slide stops the voice');
  if (SHOT) await f.screenshot({ path: SHOT + '-explain-file.png' });
  console.log(`2) the file runs offline: slide pinned on top with its picture, ${pts} points (a point lights its line${withBox ? ' on the picture' : ''}), questions answered on the spot, the slide list, kept after a reload, read aloud`);
  await fctx.close();
  // 3) the short link: the publish page takes the file (a fake GitHub), several files, the link opens it, taken down
  const gh = { puts: [] }; const edir = path.join(runDir, 'sim', 'e');
  const ghRoute = async (route) => { const req = route.request(); const u = new URL(req.url()); if ((req.headers()['authorization'] || '') !== 'Bearer good-token') return route.fulfill({ status: 401, body: '{"message":"Bad credentials"}' });
    if (u.pathname === '/repos/sasfas18-eng/quizzy' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ permissions: { push: true } }) });
    const m = u.pathname.match(/^\/repos\/sasfas18-eng\/quizzy\/contents\/share\/sim\/e\/([a-z0-9]+(?:\.\d+)?\.json)$/); if (!m) return route.fulfill({ status: 404, body: '{}' }); const fp = path.join(edir, m[1]);
    if (req.method() === 'PUT') { const body = JSON.parse(req.postData()); const buf = Buffer.from(body.content, 'base64'); assert(buf.length < 1024 * 1024, 'each file under 1 MB: ' + buf.length); fs.mkdirSync(edir, { recursive: true }); fs.writeFileSync(fp, buf); gh.puts.push(m[1]); return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }); }
    if (req.method() === 'GET') return fs.existsSync(fp) ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"sha":"s1"}' }) : route.fulfill({ status: 404, body: '{}' });
    if (req.method() === 'DELETE') { if (fs.existsSync(fp)) fs.unlinkSync(fp); return route.fulfill({ status: 200, body: '{}' }); }
    return route.fulfill({ status: 405, body: '{}' }); };
  const octx = await b.newContext({ viewport: { width: 820, height: 1180 } }); await octx.route('https://api.github.com/**', ghRoute); await octx.addInitScript(() => { window.QSIM_PART = 60000; });      // (small parts here, to put it in several files)
  const o = await octx.newPage(); o.on('pageerror', (e) => errs.push('publish: ' + e.message)); o.on('dialog', (d) => d.accept());
  await o.goto(SIMURL + 'publish.html'); await o.waitForSelector('#pub-token'); await o.fill('#pub-token', 'good-token'); await o.click('#pub-save'); await o.waitForSelector('#pub-file', { state: 'attached' });
  await o.setInputFiles('#pub-file', fpath); await o.waitForSelector('#pub-ready', { timeout: 60000 }); assert(/شريحة · شرح/.test(await o.textContent('#pub')), '3) the publish page says what it is');
  const short = await o.inputValue('#pub-link'); assert(/#e\.[a-z0-9]{4,16}\.[A-Za-z0-9_-]{16,32}$/.test(short), '3) a short link: ' + short);
  const parts = gh.puts.filter((x) => /\.\d+\.json$/.test(x)).length; assert(parts >= 2 && /^[a-z0-9]+\.json$/.test(gh.puts[gh.puts.length - 1]), '3) in several files, the link\'s own file last: ' + gh.puts.join(' '));
  const stored = fs.readdirSync(edir).map((x) => fs.readFileSync(path.join(edir, x), 'utf8')).join(''); assert(!/idea|questions|Cardiac|data:image/.test(stored), '3) on GitHub it is noise (encrypted)');
  const sctx = await b.newContext({ viewport: { width: 390, height: 844 } }); const s = await sctx.newPage(); s.on('pageerror', (e) => errs.push('short: ' + e.message));
  await s.goto(short); await s.waitForSelector('#qs-xexp', { timeout: 20000 }); assert.strictEqual(await s.locator('#qs-xjump option').count(), N, '3) the link opens the whole explanation');
  // 4) a phone
  assert(await noSideways(s), '4) nothing sideways on a phone'); if (SHOT) await s.screenshot({ path: SHOT + '-explain-phone.png' });
  await o.reload(); await o.waitForSelector('[id^=pub-del-]'); await o.click('[id^=pub-del-]'); await o.waitForFunction(() => !document.querySelector('[id^=pub-del-]'));
  assert.deepStrictEqual(fs.readdirSync(edir), [], '3) every file of it taken down');
  const gone = await sctx.newPage(); await gone.goto(short); await gone.waitForSelector('#qs-message'); await gone.waitForFunction(() => /not on the site/.test(document.querySelector('#qs-message').textContent)); await gone.close();
  console.log(`3) the short link: the publish page took the file, ENCRYPTED in ${parts + 1} files (each under 1 MB), opens anywhere with no account; taken down: every file gone, the link says so`);
  console.log('4) a phone: nothing scrolls sideways');
  await sctx.close(); await octx.close();
  assert.deepStrictEqual(errs, []); await b.close(); srv.close(); rsrv.close(); console.log('explain share ok');
})().catch((e) => { console.error(e); process.exit(1); });
