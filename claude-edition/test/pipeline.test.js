// node claude-edition/test/pipeline.test.js — PIPELINED RETRIES (the Claude-only path): a batch's rejected or refused slots are written again as soon as that batch is
// checked, on free lanes, instead of after the slowest batch of the round. With answer times that vary (as a real model's do):
//  1) the requested count is delivered, nothing is lost: a slot rejected twice still reaches round 2; refused slots are replaced; no question twice
//  2) the quiz is ready clearly sooner than with the round-by-round order (same model, same answers)
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const facts = (i) => [`The enzyme E${i} converts substrate S${i} into product P${i} in the cytoplasm.`, `Activity of E${i} rises when the cofactor C${i} is present.`, `Deficiency of E${i} causes the disorder D${i}.`, `The gene G${i} encodes the enzyme E${i}.`, `The inhibitor I${i} blocks the enzyme E${i} at its active site.`];
const pages = Array.from({ length: 12 }, (_, i) => ({ ref: 'd1p' + (i + 1), text: `Topic ${i + 1}\n` + facts(i + 1).join('\n') }));
const base = { chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' };
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function model() { const used = {}, seen = new Set(), stats = { generate: 0 }; const firstSeen = new Set(); let t = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return { stats, json: async (task, s, prompt) => {
    if (task === 'generate') { stats.generate++; const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
      await sleep(4 * slots.length * (8 + 22 * rnd()));      // a model's answer time varies a lot from one request to the next
      return { questions: slots.map((x) => { if (x.slot % 5 === 0 && !firstSeen.has('u' + x.slot)) { firstSeen.add('u' + x.slot); return { slot: x.slot, unwritable_reason: 'no numeric value to apply' }; }
        const ref = x.pages[0]; const lines = (pg[ref] || '').split('\n').slice(1); const k = (used[ref] = (used[ref] || 0) + 1) - 1; const sent = lines[k % lines.length]; const w = (j) => 'q' + x.slot + 'v' + k + 'w' + j;
        return { slot: x.slot, type: x.type, stem: `${w(0)} ${w(1)} ${w(2)}: which item fits the lecture?`, options: [w(0) + ' alpha', w(1) + ' beta', w(2) + ' gamma', w(3) + ' delta'], correct_index: 0, explanation: 'The lecture states: ' + sent, purpose: w(4) + ' ' + w(5), evidence: [{ page: ref, quote: sent }] }; }) }; }
    if (task === 'verify') { const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 12, prompt.indexOf('\nReturn JSON'))); await sleep(4 * (4 + qs.length * (1 + 3 * rnd())));
      // the blind solver disagrees with every third question the first time it sees it, and with one of them a second time
      return { results: qs.map((x) => { const n = +x.id.slice(1); const key = 'v' + n; const first = !seen.has(key); seen.add(key); const again = !first && !seen.has(key + 'b'); if (again) seen.add(key + 'b');
        return { id: x.id, ...base, chosen_index: (n % 3 === 0 && first) || (n % 12 === 0 && again) ? 1 : 0 }; }) }; }
    const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); await sleep(4 * (3 + it.length * (1 + 2 * rnd())));
    return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: null })) }; } }; }
const objs = pages.map((p, i) => ({ id: 'o' + (i + 1), statement: 'Topic ' + (i + 1), pages: [p.ref], capacity: 4, section: 'S' + (i + 1), section_label: 'Topic ' + (i + 1), supports: { basic_recall: { pages: [p.ref] }, understanding: { pages: [p.ref] }, mechanisms: { pages: [p.ref] } } }));
const st = { count: 40, focus: 'balanced', difficulty: 'mixed', field: 'science', language: 'en' };
async function run(pipeline) { seed = 7; const m = model(); const plan = E.buildPlan({ objectives: JSON.parse(JSON.stringify(objs)), profile: null }, st, null); E.assignForms(plan.slots);
  const t0 = Date.now(); const r = await E.generateToCount(m, plan, pages, st, () => {}, { concurrency: 12, aiOnly: true, pipeline, topupRounds: 3, shape: (sl, pr) => E.assignForms(sl, pr) }); return { ms: Date.now() - t0, r, m }; }
(async () => {
  const a = await run(false), b = await run(true);
  for (const [name, x] of [['round by round', a], ['pipelined', b]]) { assert.strictEqual(x.r.accepted.length, 40, name + ': the full count: ' + x.r.accepted.length + ' ' + JSON.stringify(x.r.stats)); assert.strictEqual(new Set(x.r.accepted.map((c) => c.stem)).size, 40, name + ': no question twice'); }
  assert(b.r.stats.early_retries > 0, 'retries started before the round ended'); assert(b.r.stats.rej_solver_disagrees > 0, 'the reasons are counted');
  console.log(`1) 40/40 both ways, no question twice; pipelined: ${b.r.stats.early_retries} slots written again early (reasons: ${Object.keys(b.r.stats).filter((k) => k.startsWith('rej_')).map((k) => k + '×' + b.r.stats[k]).join(', ')})`);
  assert(b.ms < a.ms * 0.9, `pipelined is clearly faster: ${b.ms} ms vs ${a.ms} ms`);
  console.log(`2) ready in ${b.ms} ms pipelined vs ${a.ms} ms round by round (${Math.round(100 - 100 * b.ms / a.ms)}% sooner); questions written ${b.r.stats.drafted + b.r.stats.unwritable} vs ${a.r.stats.drafted + a.r.stats.unwritable}, write requests ${b.m.stats.generate} vs ${a.m.stats.generate}`);
  console.log('pipeline ok');
})().catch((e) => { console.error(e); process.exit(1); });
