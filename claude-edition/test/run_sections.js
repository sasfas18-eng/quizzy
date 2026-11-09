// node claude-edition/test/run_sections.js <dist> <deck.pdf> — the lecture's OWN sections on the Claude path, in Chromium with the shim (what is sent to Claude is recorded).
// The deck (make_sections_deck.py) has five content sections running over several slides - «Cardiac Cycle (1/3)…(3/3)», «Conduction System (continued)»,
// «Cardiac Output - Part 1/2» - plus a cover and an objectives slide. With 10 questions:
//  1) every slot sent to Claude carries the lecture's own section name (the headings, without «(2/3)», «Part 2», «(continued)») - never one per slide;
//  2) inside a section, slots of one type are given different forms (shapes), rotated evenly;
//  3) in the first round, a section's slots are written in one request (when they fit in one);
//  4) the quiz covers all five sections, and the ready page says so («يغطي الكويز أقسام المحاضرة كلها»).
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const [dist, deck] = process.argv.slice(2); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
const SECTIONS = ['Cardiac Cycle', 'Conduction System', 'Heart Sounds', 'Cardiac Output', 'Regulation of Heart Rate'];
// records every writing request sent to Claude (its slots), with the time it started
const RECORD = `(() => { window.__gen = []; const t = setInterval(() => { const c = window.claude; if (!c || c.__rec) return; clearInterval(t); c.__rec = true; const use = c.use.bind(c);
  c.use = async (n) => { const s = await use(n); if (n !== 'sample' || !s || s.__r) return s; const j = s.json.bind(s);
    s.json = async (input, o) => { if (input.includes('Write one question per slot')) { const a = input.indexOf('SLOTS:\\n') + 7, b = input.indexOf('\\nPAGES:\\n'); try { window.__gen.push({ at: performance.now(), slots: JSON.parse(input.slice(a, b)) }); } catch (_) { /* not this request */ } } return j(input, o); };
    s.__r = true; return s; }; }, 1); })();`;
(async () => {
  srv.listen(8796); const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript({ path: path.join(__dirname, 'shim.js') }); await p.addInitScript('localStorage.clear()'); await p.addInitScript({ content: RECORD });
  await p.goto('http://localhost:8796/#/files'); await p.setInputFiles('#file', deck); await p.waitForSelector('table', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 });
  await p.click('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await p.click('.chips button:text-is("10")'); await p.waitForTimeout(400);
  await p.click('#create-quiz'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 120000 });
  const r = await p.evaluate(async () => { const id = location.hash.split('/')[2]; const q = await (await fetch('/api/quizzes/' + id)).json();
    const note = document.getElementById('coverage-note'); return { cov: q.report.section_coverage, note: note ? note.textContent : null, gen: window.__gen, n: q.report.delivered }; });
  await b.close(); srv.close(); assert.deepStrictEqual(errs, []);
  // 1) the section names sent to Claude are the lecture's headings
  const slots = r.gen.flatMap((g) => g.slots); const names = [...new Set(slots.map((s) => s.section))];
  assert(slots.length >= 10 && slots.every((s) => SECTIONS.includes(s.section)), 'every slot carries one of the lecture\'s five section names: ' + JSON.stringify(names));
  console.log(`1) ${slots.length} slots sent to Claude, in ${names.length} sections named by the lecture's headings: ${names.join(' | ')}`);
  // 2) one section, one type: different forms
  const first = r.gen.filter((g) => g.at - r.gen[0].at < 50).flatMap((g) => g.slots); const by = {}; first.forEach((s) => { (by[s.section + ' / ' + s.type] ||= []).push(s.shape); });
  // a form comes back only after the others of its type were used there (a form the pages cannot carry - an abbreviation where there is none - is skipped, so a fitting one repeats)
  for (const [k, f] of Object.entries(by)) if (f.length >= 2) { const n = Object.values(f.reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {}));
    assert(new Set(f).size >= 2 && Math.max(...n) - Math.min(...n) <= 1, k + ': forms not rotated in one section: ' + f.join(' · ')); }
  console.log('2) forms inside a section: ' + Object.entries(by).filter(([, f]) => f.length >= 2).map(([k, f]) => `${k}: ${f.length} slots, ${new Set(f).size} forms`).join('; '));
  // 3) round 1: a section's slots in one request when they fit
  const reqOf = {}; r.gen.filter((g) => g.at - r.gen[0].at < 50).forEach((g, i) => g.slots.forEach((s) => { (reqOf[s.section] ||= new Set()).add(i); }));
  const bs = Math.max(...r.gen.filter((g) => g.at - r.gen[0].at < 50).map((g) => g.slots.length)); const per = {}; first.forEach((s) => { per[s.section] = (per[s.section] || 0) + 1; });
  for (const sct of Object.keys(per)) assert(reqOf[sct].size <= Math.ceil(per[sct] / bs), sct + ': ' + per[sct] + ' slots spread over ' + reqOf[sct].size + ' requests (batch ' + bs + ')');
  console.log('3) round 1: ' + Object.keys(per).map((sct) => `${sct} ${per[sct]} slot(s) in ${reqOf[sct].size} request(s)`).join('; '));
  // 4) coverage
  assert.strictEqual(r.n, 10); assert.deepStrictEqual(r.cov, { covered: 5, total: 5, missing: [] }, 'all five sections covered (none missing): ' + JSON.stringify(r.cov)); assert(r.note && /كلها/.test(r.note), 'the ready page says the whole lecture is covered: ' + r.note);
  console.log('4) ' + r.n + ' questions; ' + r.note);
  console.log('lecture sections on the Claude path ok');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
