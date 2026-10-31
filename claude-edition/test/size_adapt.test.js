// node claude-edition/test/size_adapt.test.js — a provider that takes only small requests (Groq's free tier answers 413 "Request too large" above a few thousand tokens per minute):
// the engine builds smaller pieces up front (llm.scale()), and when a piece is still refused it SPLITS it (analysis chunks, generation batches, verification groups) instead of failing.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE; const assert = require('assert');
const L = (k) => String.fromCharCode(97 + (k % 26)); const W = (n) => 'Qua' + L(n) + L(Math.floor(n / 26)) + L(Math.floor(n / 676)) + 'ation' + L(n * 5 + 1) + 'x';      // a distinct made-up word per number (up to 17576)
const V = ['stabilises', 'amplifies', 'suppresses', 'transports', 'degrades', 'binds', 'activates', 'filters', 'recruits', 'modulates', 'synthesises', 'releases'];
const pages = Array.from({ length: 30 }, (_, i) => ({ ref: `d1p${i + 1}`, doc_id: 'd', page_no: i + 1, text: `Topic ${i + 1}\n` + Array.from({ length: 7 }, (_, j) => `${W(i * 7 + j)} is the ${['rapid', 'gradual', 'central', 'minor', 'key', 'local'][j % 6]} regulator that ${V[(i + j) % 12]} ${W(i * 7 + j + 300)} inside ${W(i * 5 + j + 700)} tissue under normal conditions.`).join('\n') }));
const byRef = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
const st = { count: 20, focus: 'balanced', field: 'science', language: 'en', external_mode: 'source_only', difficulty: 'mixed' };

// a provider with a request-size limit (characters ~ 3 per token); scaleValue = what it tells the engine (undefined = unknown provider that must be LEARNED from refusals)
function provider(limit, scaleValue) {
  const calls = { analyze: 0, generate: 0, verify: 0, explain: 0, refused: 0, maxLen: 0, ok: 0 }; const used = new Set(); let serial = 0;      // serial: every question gets its own lead words so the (strict) duplicate check does not see template twins
  const llm = { calls, async json(task, sys, prompt) {
    const len = sys.length + prompt.length; if (len > limit) { calls.refused++; throw Object.assign(new Error('HTTP 413 Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 20000'), { code: 'too_large' }); }
    calls.maxLen = Math.max(calls.maxLen, len); calls.ok++;
    if (task === 'analyze') { calls.analyze++; const refs = [...new Set(prompt.match(/d1p\d+/g) || [])]; return { lecture_character: 'x', objectives: refs.map((r) => ({ statement: 'Objective of ' + r, pages: [r], key_terms: [], capacity: 2, supports: { basic_recall: { pages: [r] }, understanding: { pages: [r] } } })) }; }
    if (task === 'generate') { calls.generate++; const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
      return { questions: slots.map((s) => { for (const ref of s.pages) { for (const line of String(pg[ref] || '').split('\n').filter((l) => l.split(/\s+/).length >= 8)) { for (const w of (line.match(/[A-Za-z][A-Za-z-]{6,}/g) || []).filter((x) => line.split(x).length === 2)) { const k = `${ref}|${line}`; if (used.has(k)) continue; used.add(k);      // one question per sentence (a second one about the same sentence would be a duplicate for a planned slot)
        const others = [...new Set(Object.values(pg).join(' ').match(/[A-Za-z][A-Za-z-]{6,}/g) || [])].filter((x) => x !== w && !line.includes(x)).slice(0, 3); serial++;
        return { slot: s.slot, unwritable_reason: null, stem: 'Regarding ' + [0, 1, 2, 3, 4, 5].map((q) => W(900 + serial * 6 + q)).join(' ') + ', complete according to the lecture: ' + line.replace(w, '_____'), options: [w, ...others], correct_index: 0, explanation: 'The lecture states: "' + line + '" so the missing word follows.', purpose: `blank ${w} in ${ref}`, reasoning_pattern: 'recall', evidence: [{ page: ref, quote: line }], uses_external: false }; } } }
        return { slot: s.slot, unwritable_reason: 'nothing left' }; }) }; }
    if (task === 'verify') { calls.verify++; const qs = JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' })) }; }
    calls.explain++; const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) }; } };
  if (scaleValue !== undefined) llm.scale = () => scaleValue; return llm;
}
const heur = E.support(pages.map((p) => p.text), 'science');

(async () => {
  // 1) an unknown provider (no scale()) that refuses big requests: the whole pipeline still completes, by splitting what is refused
  { const llm = provider(12000); const a = await E.analyse(llm, pages, st); assert.strictEqual(a.objectives.length, 30, 'every page got an objective although the first chunks were refused'); assert(llm.calls.refused > 0, 'it really was refused first');
    const plan = E.buildPlan(a, st, heur); const g = await E.generate(llm, plan, pages, st, () => {}, { concurrency: 2 }); const svc = g.dropped.filter((d) => (d.reasons || []).some((r) => /خطأ في خدمة التوليد/.test(r)));
    assert.strictEqual(svc.length, 0, 'no slot was lost to "request too large": ' + JSON.stringify(svc.slice(0, 2))); assert(g.accepted.length >= 18, 'delivered ' + g.accepted.length + ' of 20');
    g.accepted.forEach((c) => c.evidence.forEach((e) => assert(E.quoteIn(e.quote, byRef[e.page]), 'evidence stays verbatim'))); console.log('1) unknown small provider: analysis + generation + checks completed by splitting; refused ' + llm.calls.refused + ' times, delivered ' + g.accepted.length + '/20, largest request ' + llm.calls.maxLen + ' chars'); }

  // 2) a provider that TELLS its size (scale 0.35): the engine sends right-sized pieces from the start, nothing is refused
  { const llm = provider(9000, 0.35); const a = await E.analyse(llm, pages, st); const plan = E.buildPlan(a, st, heur); const g = await E.generate(llm, plan, pages, st, () => {}, { concurrency: 2 });
    assert.strictEqual(llm.calls.refused, 0, 'sized up front: no request was refused (' + llm.calls.refused + ')'); assert(llm.calls.maxLen <= 9000); assert(g.accepted.length >= 18, 'delivered ' + g.accepted.length);
    console.log('2) provider that reports scale 0.35: 0 refusals, largest request ' + llm.calls.maxLen + ' chars (limit 9000), delivered ' + g.accepted.length + '/20 in ' + (llm.calls.generate) + ' generate calls'); }

  // 3) the verification group is split when refused: 6 questions in one group, a provider that takes ~2 at a time
  { const mk = (i) => ({ qtype: 'basic_recall', stem: 'Complete according to the lecture: ' + 'x'.repeat(40) + i, options: ['a1', 'b1', 'c1', 'd1'], correct_index: 0, explanation: 'e'.repeat(40), evidence: [], uses_external: false }); const items = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'q' + i, c: mk(i), s: { pages: [] } }));
    let calls = 0; const llm = { async json(task, sys, prompt) { calls++; const ids = [...new Set(prompt.match(/q\d/g))]; if (ids.length > 2) throw Object.assign(new Error('413'), { code: 'too_large' });
      if (task === 'verify') return { results: ids.map((id) => ({ id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' })) }; return { results: ids.map((id) => ({ id, explanation_supported: true, contradicts_source: false, notes: '' })) }; } };
    const r = await E.llmCheckBatch(llm, items, { d1p1: 'z'.repeat(3000) }, st); assert.strictEqual(r.length, 6); assert(r.every((x) => x.length === 0), 'every question was verified after splitting: ' + JSON.stringify(r.map((x) => x.map((i) => i.code)))); console.log('3) verification group of 6 refused -> split until accepted (' + calls + ' calls), all 6 verified'); }

  // 4) hopeless (even one tiny piece is refused): a clean failure the caller turns into the local fallback, never a hang
  { const llm = provider(500); await assert.rejects(() => E.analyse(llm, pages.slice(0, 3), st), (e) => e.code === 'too_large'); const g = await E.generate(llm, E.buildPlan(E.rules.analyse(pages.slice(0, 6)), st, heur), pages, st, () => {}, { concurrency: 2 });
    assert.strictEqual(g.accepted.length, 0); assert(g.dropped.every((d) => d.reasons.some((r) => /خطأ في خدمة التوليد/.test(r))), 'the slots report the service error'); console.log('4) hopeless provider: analysis throws too_large, generation reports the service error (caller falls back locally)'); }
  console.log('size adapt tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
