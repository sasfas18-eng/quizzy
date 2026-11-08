// node claude-edition/test/owner_ai.test.js — the owner's quiz_engine rules in the AI writing (engine.js + shared/owner_rules.js):
// 1) the category guides of the slot types (STYLES), the METHOD and the ASSESSMENT_RULES are in the writing prompt; the review criteria are in the blind check;
// 2) REPETITION is judged by the AI: a question the explanation check names as a rewording of an accepted one (duplicate_of) is refused and written again;
// 3) an evidence rule given by the caller (the reader's approved units) refuses a quote outside them before any check is spent.
global.window = {}; require('../engine.js'); require('../../shared/owner_rules.js'); const E = window.QZE, O = window.QZ_OWNER; const assert = require('assert');
const L = [['Glomerulus', 'filters plasma into Bowman capsule under high capillary pressure', 'Podocytes', 'wrap capillaries with interdigitating foot processes'],
  ['Nephron', 'reabsorbs glucose completely along the proximal convoluted tubule', 'Medulla', 'holds a steep osmotic gradient built by countercurrent flow'],
  ['Aldosterone', 'raises sodium retention through principal cells of collecting ducts', 'Renin', 'converts angiotensinogen after juxtaglomerular release'],
  ['Ureter', 'propels urine toward bladder through rhythmic peristaltic waves', 'Detrusor', 'contracts during micturition under parasympathetic stimulation']];
const pages = L.map(([a, x, b, y], i) => ({ ref: `d1p${i + 1}`, text: `${a} ${x}.\n${b} ${y}.`, doc_id: 'd', page_no: i + 1 }));
const slots = pages.map((p, i) => ({ slot: i + 1, qtype: ['basic_recall', 'scenarios', 'sequence', 'not_except'][i], objective: 'o' + i, objective_id: 'o' + i, pages: [p.ref], difficulty: 'medium', task: null }));
const plan = { slots, requested: 4, feasible_count: 4 }; const recall = { ...plan, slots: slots.map((s) => ({ ...s, qtype: 'basic_recall' })) };      // the engine's type checks want a real scenario / order: this cloze model writes recall
const st = { field: 'health', language: 'en', external_mode: 'source_only' };
function model({ dupOnce = new Set(), quoteHeading = false } = {}) { const seen = { gen: [], verifySys: [], explain: [] }; let written = {};
  return { seen, async json(task, sys, prompt) {
    if (task === 'generate') { seen.gen.push(sys + '\n' + prompt); const S = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const P = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
      return { questions: S.map((s) => { const t = P[s.pages[0]]; const n = (written[s.slot] = (written[s.slot] || 0) + 1); const line = t.split('\n')[quoteHeading ? (n === 1 ? 1 : 0) : (n > 1 ? 1 : 0)]; const term = line.split(' ')[0];
        return { slot: s.slot, unwritable_reason: null, stem: `Version ${n}: complete according to the lecture: ${line.replace(term, '_____')}`, options: [term, ['Liver', 'Spleen', 'Pancreas', 'Thymus', 'Cortex', 'Pelvis'][s.slot % 6], ['Gallbladder', 'Tonsil', 'Adrenal'][s.slot % 3], ['Pituitary', 'Retina'][s.slot % 2]], correct_index: 0,
          explanation: 'الإجابة مبنية على نص المحاضرة: «' + line + '». الخيارات الأخرى لا تظهر في هذا السياق.', purpose: 'p' + s.slot + '/' + n, reasoning_pattern: 'x', evidence: [{ page: s.pages[0], quote: line }], uses_external: false }; }) }; }
    if (task === 'verify') { seen.verifySys.push(sys); const qs = JSON.parse(prompt.slice(prompt.indexOf('\nQUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' })) }; }
    seen.explain.push(sys + '\n' + prompt); const it = JSON.parse(prompt.slice(prompt.indexOf('\nITEMS:\n') + 8, prompt.indexOf('\nReturn JSON')));
    return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, duplicate_of: dupOnce.has(x.id) && /^Version 1/.test(x.question) ? 1 : null, notes: '' })) }; } }; }
(async () => {
  { const m = model(); const r = await E.generate(m, plan, pages, st, () => {}, { concurrency: 2 });
    const g = m.seen.gen.join('\n'); for (const k of ['Basic Recall', 'Clinical Scenarios', 'Sequence / Ordering', 'NOT / EXCEPT']) assert(g.includes(O.STYLES[k].instruction), 'the guide of ' + k + ' is in the writing prompt');
    assert(!g.includes(O.STYLES['Compare & Contrast'].instruction), 'only the categories of this batch'); assert(g.includes('Change the thinking required') && g.includes('Only allowed_units contain assessable source text'), 'METHOD and ASSESSMENT_RULES');
    assert(m.seen.verifySys.every((x) => x.includes('there are no semantic duplicates or trivial rewordings')), 'the review criteria are in the blind check'); assert(m.seen.explain.some((x) => /REPETITION/.test(x)), 'the explanation check is asked for repetition');
    assert(r.accepted.length >= 1); console.log('1) guides of the batch\'s categories + METHOD + ASSESSMENT_RULES in the writing; review criteria in the blind check'); }
  { const m = model({ dupOnce: new Set(['q3']) }); const r = await E.generate(m, recall, pages, st, () => {}, { concurrency: 1 });
    const q3 = r.accepted.find((c) => c.slot === 3); if (!q3) console.log(JSON.stringify({ stats: r.stats, acc: r.accepted.map((c) => [c.slot, c.stem.slice(0, 40)]), dropped: r.dropped })); assert(q3 && /^Version 2/.test(q3.stem), 'the question the AI named a repetition was written again: ' + (q3 && q3.stem)); assert.strictEqual(r.stats.rejected_verifier, 1);
    assert(m.seen.explain.some((x) => x.includes('ALREADY ACCEPTED')), 'the accepted questions are shown to the check'); console.log('2) a rewording named by the AI (duplicate_of) is refused and written again'); }
  { const m = model({ quoteHeading: true }); const second = new Set(pages.map((p) => p.text.split('\n')[1])); let asked = 0; const check = (c) => { asked++; return c.evidence.some((e) => second.has(e.quote)) ? 'not an approved unit' : null; }; const r = await E.generate(m, recall, pages, st, () => {}, { concurrency: 2, evidenceCheck: check });
    assert.strictEqual(r.stats.rejected_validation, 4, 'every quote outside the approved units refused before any check'); assert(asked >= 8); assert(r.accepted.length === 4 && r.accepted.every((c) => /^Version 2/.test(c.stem) && !second.has(c.evidence[0].quote)), 'all written again from approved text'); console.log('3) a quote outside the approved units is refused at once (no check spent) and written again'); }
  console.log('owner rules in the AI writing ok');
})().catch((e) => { console.error(e); process.exit(1); });
