// node claude-edition/test/speed_bench.js <dist> <pdf> [count=30] [limit=0] [thinkMs=800]
// BENCHMARK of the Claude path (the viewer's own Claude through claude.ai `sample`), in Chromium with the local shim. Every model call is given a
// realistic latency, scaled 1/10 (1 s of a real call = 100 ms here): a fixed part + a part per item the model writes (questions written, questions
// checked, objectives found). `limit` > 0 simulates a service that refuses more than `limit` calls at once (rate_limited).
// QZ_BASE / QZ_PER (JSON, per item in 1/10 ms) set other latencies, e.g. closer to a real account's measured answer times.
// The student spends `thinkMs` on the new-quiz page (choosing pages and count) before pressing create.
// With QZ_ASSERT=1 it also checks «read ahead»: the lecture was analysed while the student chose, so no analysis request starts after the click, and none twice.
// Two criteria are printed: TIME (create -> ready) and QUESTIONS (delivered / requested, written by the AI vs filled locally, every quote found
// in its page, no repeated stem, every AI question blind-solved), plus the number of model calls.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const [dist, pdf, count = '30', limit = '0', think = '800'] = process.argv.slice(2);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
const LAT = `(() => { const ST = window.setTimeout.bind(window); const LIMIT = ${+limit}; const base = ${+(process.env.QZ_BASE || 250)}, per = Object.assign({ generate: 300, verify: 60, explain: 50, analyze: 90, profile: 0, reading: 20, other: 0 }, ${process.env.QZ_PER || '{}'});
  const kind = (s) => s.includes('You analyse lecture material') ? 'analyze' : s.includes('You profile lecture material') ? 'profile' : s.includes('Write one question per slot') ? 'generate' : s.includes('strict, independent exam reviewer') ? 'verify' : s.includes('check whether each explanation') ? 'explain' : s.includes('Classify only the supplied uncertain lecture fragments') ? 'reading' : 'other';
  const size = (k, r) => k === 'generate' ? (r.questions || []).length : k === 'verify' || k === 'explain' ? (r.results || []).length : k === 'analyze' ? (r.objectives || []).length : k === 'profile' ? 15 : k === 'reading' ? (r.decisions || []).length : 1;
  window.__bench = { calls: {}, inflight: 0, max: 0, refused: 0, log: [] };
  const wrap = () => { const c = window.claude; if (!c || c.__wrapped) return; const use = c.use.bind(c); c.__wrapped = true;
    c.use = async (n) => { const s = await use(n); if (n !== 'sample' || !s || s.__w) return s; const j = s.json.bind(s);
      s.json = async (input, o) => { const B = window.__bench, k = kind(input);
        if (LIMIT && B.inflight >= LIMIT) { B.refused++; await new Promise((r) => ST(r, 30)); const e = new Error('rate limited'); e.code = 'rate_limited'; throw e; }
        B.inflight++; B.max = Math.max(B.max, B.inflight); B.calls[k] = (B.calls[k] || 0) + 1;
        const t0 = performance.now(); try { const r = await j(input, o); const d = base + per[k] * size(k, r); await new Promise((res) => ST(res, d)); B.log.push([Math.round(t0), Math.round(performance.now()), k, size(k, r)]); return r; } finally { B.inflight--; } };
      s.__w = true; return s; }; };
  const t = setInterval(() => { if (window.claude) { wrap(); clearInterval(t); } }, 1); })();`;
(async () => {
  srv.listen(8793); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  if (process.env.QZ_LANES) await p.addInitScript({ content: `localStorage.setItem('qz_claude_lanes_v2', '${process.env.QZ_LANES}')` });      // a second quiz on an account whose limit was learned
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript({ content: LAT });
  // the shim sleeps (backs off) a long time on rate_limited in the host: scale that down too
  await p.addInitScript({ content: 'const __st = window.setTimeout; window.setTimeout = (f, ms, ...a) => __st(f, ms >= 1500 ? ms / 10 : ms, ...a);' });
  // the page's clock runs 10x too (1 ms here = 10 ms of a real run), so time limits inside the app act as they would for real
  await p.addInitScript({ content: 'const __dn = Date.now.bind(Date), __d0 = __dn(); Date.now = () => __d0 + (__dn() - __d0) * 10;' });
  await p.goto('http://localhost:8793/#/files'); await p.setInputFiles('#file', pdf); await p.waitForSelector('table', { timeout: 60000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 60000 });
  await p.click('a:has-text("التفاصيل")'); await p.click('a:has-text("إنشاء كويز")'); await p.waitForSelector('#create-quiz');
  await p.click(`.chips button:text-is("${count}")`); await p.waitForTimeout(+think);
  const clickAt = await p.evaluate(() => performance.now()); const t0 = Date.now(); await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 600000 }); const ms = Date.now() - t0;
  const r = await p.evaluate(async () => {
    const id = location.hash.split('/')[2]; const q = await (await fetch('/api/quizzes/' + id)).json(); const qs = await (await fetch('/api/quizzes/' + id + '/questions')).json();
    const list = Array.isArray(qs) ? qs : qs.questions || []; const docs = await (await fetch('/api/documents')).json(); const d = await (await fetch('/api/documents/' + docs[0].id)).json();
    const text = {}; for (const pg of d.pages || []) { const full = await (await fetch('/api/documents/' + d.id + '/pages/' + pg.page_no)).json(); text[pg.page_no] = String(full.text || '').replace(/\s+/g, ' ').toLowerCase(); }
    const quoted = list.filter((x) => (x.evidence || []).length && x.evidence.every((e) => (text[e.page_no || e.page] || '').includes(String(e.quote || '').replace(/\s+/g, ' ').toLowerCase().slice(0, 60)))).length;
    const stems = new Set(list.map((x) => x.stem.toLowerCase())).size; const ai = list.filter((x) => x.prompt_version !== 'rules-1.0' && !(x.validation && x.validation.verified && x.validation.verified.blind_solver === false)).length;
    return { requested: q.report.requested, delivered: list.length, by_ai: ai, filled_locally: (q.report.stats || {}).local_filled || 0, quote_in_page: quoted, unique_stems: stems,
      owner_reading: (q.report.stats || {}).owner_reading || null, rejected_by_checks: ['rejected_validation', 'rejected_verifier', 'rejected_duplicate', 'rejected_leak'].reduce((n, k) => n + ((q.report.stats || {})[k] || 0), 0), bench: window.__bench };
  });
  console.log(JSON.stringify({ time_ms: ms, real_time_s_est: Math.round(ms / 100), questions: { ...r, bench: undefined }, calls: r.bench.calls, max_in_flight: r.bench.max, refused: r.bench.refused, errors: errs.slice(0, 3) }));
  // QZ_MAX_S: the quiz must be ready within that many seconds of a real run (the model's own answer times; the page's work is scaled with them, so this is a safe upper bound)
  if (process.env.QZ_MAX_S) { const last = Math.max(...r.bench.log.map((x) => x[1])) - clickAt; const s = Math.round(last / 100); const full = Math.round(ms / 100);
    if (s > +process.env.QZ_MAX_S || r.delivered < +count) { console.error(`too slow or short: AI done at ${s} s (page ready at ${full} s), ${r.delivered}/${count} questions, limit ${process.env.QZ_MAX_S} s`); process.exit(1); }
    console.log(`within the limit: the questions were written and checked ${s} s after the click (limit ${process.env.QZ_MAX_S} s), ${r.delivered}/${count} questions`); }
  if (process.env.QZ_ASSERT) { const an = r.bench.log.filter((x) => x[2] === 'analyze'); const late = an.filter((x) => x[0] > clickAt);
    if (!an.length || late.length) { console.error('FAIL read-ahead: ' + an.length + ' analysis requests, ' + late.length + ' after the click'); process.exit(1); }
    if (r.delivered !== r.requested || r.quote_in_page !== r.delivered || r.unique_stems !== r.delivered) { console.error('FAIL questions: ' + JSON.stringify(r)); process.exit(1); } console.log('read-ahead ok: ' + an.length + ' analysis request(s), all before the click; questions sound'); }
  if (process.env.QZ_TIMELINE) for (const [a, z, k, n] of r.bench.log.sort((x, y) => x[0] - y[0])) console.log(`  ${String(Math.round(a - clickAt)).padStart(6)} → ${String(Math.round(z - clickAt)).padStart(6)}  ${k} ×${n}`);
  await b.close(); srv.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
