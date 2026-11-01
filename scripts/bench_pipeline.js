// node scripts/bench_pipeline.js [oldEngineDir] — wall-clock of the AI pipeline (analysis -> plan -> generation + verification) against a SIMULATED provider:
// a fixed latency per kind of call (with deterministic jitter), valid answers written from the lecture's own lines. Compares the engine in this checkout with an older copy
// (e.g. `git worktree add /tmp/old <commit>` then `node scripts/bench_pipeline.js /tmp/old/claude-edition`), and checks that the questions made are of the same quality.
// It measures time only; the quality of real model answers is the models' business, the guarantee here is that the SAME questions pass the SAME checks.
const vm = require('vm'); const fs = require('fs'); const path = require('path'); const assert = require('assert');
const load = (dir) => { const sb = { window: {}, console }; vm.createContext(sb); for (const f of ['engine.js', 'rules.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f }); return sb.window.QZE; };
const NEW = load(path.resolve(__dirname, '..', 'claude-edition')); const OLD = process.argv[2] ? load(path.resolve(process.argv[2])) : null;
const SCALE = +process.env.BENCH_SCALE || 1 / 40;           // 1 = real seconds; the default runs 40x faster than a real provider would take
const LAT = { analyze: 3.2, profile: 2.0, generate: 9, verify: 4.5, verify_explanation: 2.6 };       // seconds a typical hosted model takes (measured ranges: 2-5s analysis, 6-14s writing 3 questions, 3-6s checking, 2-4s explanations)
const frac = (x) => x - Math.floor(x); const jitter = (n) => 0.7 + 0.6 * frac(Math.sin(n * 12.9898) * 43758.5453);      // 0.7x .. 1.3x, deterministic
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BANK = { subj: ['membrane', 'receptor', 'enzyme', 'ribosome', 'neuron', 'artery', 'hormone', 'antibody', 'nucleus', 'tendon', 'alveolus', 'platelet', 'synapse', 'lymph', 'cortex', 'valve', 'mitochondrion', 'capillary', 'ligament', 'plasma'],
  verb: ['regulates', 'transports', 'stabilises', 'synthesises', 'coordinates', 'maintains', 'accelerates', 'modulates', 'amplifies', 'filters', 'protects', 'converts', 'releases', 'absorbs', 'inhibits'],
  obj: ['calcium balance', 'oxygen delivery', 'protein folding', 'signal speed', 'blood pressure', 'waste removal', 'energy storage', 'immune response', 'cell division', 'water retention', 'nutrient uptake', 'muscle tone', 'heat loss', 'tissue repair', 'glucose levels'],
  ctx: ['during exercise', 'after a meal', 'in cold weather', 'while sleeping', 'under stress', 'in early childhood', 'at high altitude', 'during infection', 'in old age', 'after injury'] };
const pick = (a, k) => a[Math.abs(Math.floor(frac(Math.sin(k * 78.233) * 12345.6789) * 1e6)) % a.length];
const lecture = Array.from({ length: +process.env.BENCH_PAGES || 90 }, (_, i) => ({ ref: `d1p${i + 1}`, doc_id: 'd', page_no: i + 1, text: `Section ${i + 1} overview\n` + Array.from({ length: 6 }, (_, j) => { const k = i * 17 + j * 5 + 1;
  return `The ${pick(BANK.subj, k)} named Qx${i}z${j}ine ${pick(BANK.verb, k + 3)} ${pick(BANK.obj, k + 7)} ${pick(BANK.ctx, k + 11)} according to finding ${i * 10 + j} of the study.`; }).join('\n') }));
function model(E) {
  const used = new Set(); let n = 0; const calls = {}; const log = [];
  return { calls, log, async json(task, sys, prompt) {
    calls[task] = (calls[task] || 0) + 1; const t0 = Date.now(); await sleep(LAT[task] * 1000 * SCALE * jitter(++n));
    const out = (() => {
      if (task === 'profile') { const pg = Object.keys(JSON.parse(prompt.slice(prompt.indexOf('PAGES:\n') + 7))); return { types: Object.fromEntries(E.ORDER.map((c) => [c, ['basic_recall', 'understanding', 'mechanisms'].includes(c) ? { capacity: pg.length * 2, pages: pg } : { capacity: 0, pages: [] }])) }; }      // this lecture (and this mock writer) is plain statements: recall, understanding, mechanisms
      if (task === 'analyze') { const pg = JSON.parse(prompt.slice(prompt.indexOf('PAGES:\n') + 7)); return { lecture_character: 'x', objectives: pg.map((p, i) => ({ id: 'o' + i, statement: p.text.split('\n')[0], pages: [p.ref], capacity: 3, supports: { basic_recall: { pages: [p.ref] }, understanding: { pages: [p.ref] }, mechanisms: { pages: [p.ref] } } })) }; }
      if (task === 'generate') { const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
        return { questions: slots.map((s) => { for (const ref of s.pages) { for (const line of String(pg[ref] || '').split('\n').filter((l) => l.split(/\s+/).length >= 8)) { const words = (line.match(/[A-Za-z][A-Za-z0-9-]{6,}/g) || []).filter((w) => line.split(w).length === 2);
          for (const w of words) { const k = `${ref}|${line}|${w}`; if (used.has(k)) continue; used.add(k); const others = [...new Set(Object.values(pg).join(' ').match(/[A-Za-z][A-Za-z0-9-]{6,}/g) || [])].filter((x) => x !== w && !line.includes(x)).slice(0, 3);
            return { slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ' + line.replace(w, '_____'), options: [w, ...others], correct_index: 0, explanation: 'The lecture states: "' + line + '" so the missing word follows from the text.', purpose: `blank ${w} in ${ref}`, reasoning_pattern: 'recall', evidence: [{ page: ref, quote: line }], uses_external: false }; } } }
          return { slot: s.slot, unwritable_reason: 'nothing left to ask on these pages' }; }) }; }
      if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' })) }; }
      const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) };
    })(); log.push([task, t0, Date.now()]); return out; } };
}
async function run(E, label, width) {
  const llm = model(E); const st = { count: +process.env.BENCH_COUNT || 30, focus: 'balanced', field: 'science', difficulty: 'mixed', language: 'source', external_mode: 'source_only' }; const t0 = Date.now(); const stage = {};
  const analysis = await E.analyse(llm, lecture, st, { concurrency: width }); stage.analysis = Date.now() - t0;
  const plan = E.buildPlan(analysis, st, E.support(lecture.map((p) => p.text), 'science')); const t1 = Date.now();
  const res = await E.generateToCount(llm, plan, lecture, st, () => {}, { concurrency: width }); stage.generation = Date.now() - t1; const total = Date.now() - t0;
  const q = res.accepted; assert.strictEqual(new Set(q.map((c) => E.norm(c.stem))).size, q.length, 'no two questions alike'); q.forEach((c) => c.evidence.forEach((e) => assert(E.quoteIn(e.quote, lecture.find((p) => p.ref === e.page).text), 'evidence is verbatim')));
  return { label, total, ...stage, questions: q.length, calls: llm.calls, types: plan.distribution };
}
(async () => {
  const width = +process.env.BENCH_WIDTH || 4; const rows = [];
  if (OLD) rows.push(await run(OLD, 'previous engine', width)); rows.push(await run(NEW, 'this engine', width));
  const f = (ms) => (ms * (1 / SCALE) / 1000).toFixed(1) + 's';      // back to "real" seconds
  console.log(`simulated provider (latency per call: ${JSON.stringify(LAT)} seconds, x${(1 / SCALE).toFixed(0)} faster than real), ${lecture.length} pages, ${process.env.BENCH_COUNT || 30} questions, width ${width}`);
  for (const r of rows) console.log(r.label.padEnd(16), 'total', f(r.total).padStart(7), ' analysis', f(r.analysis).padStart(7), ' generation', f(r.generation).padStart(7), ' questions', r.questions, ' calls', JSON.stringify(r.calls));
  if (rows.length === 2) console.log(`faster by ${(100 * (1 - rows[1].total / rows[0].total)).toFixed(0)}%  (analysis ${(100 * (1 - rows[1].analysis / rows[0].analysis)).toFixed(0)}%, generation ${(100 * (1 - rows[1].generation / rows[0].generation)).toFixed(0)}%)`);
})().catch((e) => { console.error(e); process.exit(1); });
