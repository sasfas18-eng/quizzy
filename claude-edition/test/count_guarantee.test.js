// node claude-edition/test/count_guarantee.test.js — a student who asks for N questions gets N: the planner always plans N (extra slots are other angles on the same material), the AI path tops up what
// was rejected with verified reinforcement questions, the local generator finishes the rest from the lecture's own lines, and nothing is ever a copy.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert');
const texts = require('./samples/pages.json').lecture_en; const pages = texts.map((t, i) => ({ ref: `d1p${i + 1}`, text: t, doc_id: 'd', page_no: i + 1 })); const byRef = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
const heur = E.support(texts, 'health'); const analysis = R.analyse(pages);
const sound = (list, label) => {      // every question: 4 distinct options, verbatim evidence, no copy of another question, the answer never printed in a fill-in stem
  list.forEach((c) => { assert.strictEqual(c.options.length, 4, label); assert.strictEqual(new Set(c.options.map(E.norm)).size, 4, label + ': distinct options'); assert(c.evidence.length >= 1, label);
    c.evidence.forEach((e) => assert(E.quoteIn(e.quote, byRef[e.page]), `${label}: evidence not verbatim: ${e.quote.slice(0, 60)}`));
    if (/____|_____/.test(c.stem)) assert(!E.norm(c.stem.replace(/_+/g, '')).split(' ').includes(E.norm(c.options[c.correct_index])) || E.norm(c.options[c.correct_index]).includes(' '), `${label}: answer printed in the stem: ${c.stem}`); });
  assert.strictEqual(new Set(list.map((c) => E.norm(c.stem) + '|' + E.norm(c.options[c.correct_index]))).size, list.length, label + ': no two questions are the same'); };

// a model that writes cloze questions from the pages (a different sentence/word for every slot), can refuse some slots, can be down
function model(opts = {}) {
  const used = new Set(); const calls = { generate: 0, verify: 0, explain: 0 }; const seenPrompts = [];
  return { calls, seenPrompts, async json(task, sys, prompt) {
    if (opts.down) throw new Error('HTTP 503');
    if (opts.dieAfter != null && calls.generate + calls.verify + calls.explain >= opts.dieAfter) throw Object.assign(new Error('Google Gemini (gemini-2.5-flash): الخدمة مزدحمة مؤقتًا عند المزوّد (HTTP 503)'), { code: 'rate_limited', busy: true, status: 503 });      // dies for good after N calls
    if (task === 'generate') { calls.generate++; seenPrompts.push(prompt); const slots = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON')));
      return { questions: slots.map((s) => {
        if (opts.refuse && opts.refuse(s)) return { slot: s.slot, unwritable_reason: 'no new fact on these pages' };
        for (const ref of s.pages) { const lines = String(pg[ref] || '').split('\n').filter((l) => l.split(/\s+/).length >= 8);
          for (const line of lines) { const words = (line.match(/[A-Za-z][A-Za-z-]{6,}/g) || []).filter((w) => line.split(w).length === 2);
            for (const w of words) { const k = `${ref}|${line}|${w}`; if (used.has(k)) continue; used.add(k);
              const others = [...new Set(Object.values(pg).join(' ').match(/[A-Za-z][A-Za-z-]{6,}/g) || [])].filter((x) => x !== w && !line.includes(x)).slice(0, 3);
              return { slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ' + line.replace(w, '_____'), options: [w, ...others], correct_index: 0, explanation: 'The lecture states: "' + line + '" so the missing word follows from the text.', purpose: `blank ${w} in ${ref}`,
                reasoning_pattern: 'recall', evidence: [{ page: ref, quote: line }], uses_external: false }; } } }
        return { slot: s.slot, unwritable_reason: 'nothing left to ask on these pages' }; }) }; }
    if (task === 'verify') { calls.verify++; const qs = JSON.parse(prompt.slice(prompt.indexOf('QUESTIONS:\n') + 11, prompt.indexOf('\nReturn JSON'))); return { results: qs.map((q) => ({ id: q.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' })) }; }
    calls.explain++; const it = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 7, prompt.indexOf('\nReturn JSON'))); return { results: it.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) }; } };
}

(async () => {
  // ---- 1) the planner always plans the requested count; the extra slots are reinforcement (angle + variant), spread evenly, within the supported types
  { const objs = [1, 2, 3].map((i) => ({ id: 'o' + i, statement: 'Objective ' + i, pages: ['d1p' + i], key_terms: [], capacity: 1, supports: { basic_recall: { pages: ['d1p' + i] }, understanding: { pages: ['d1p' + i] } } }));
    const plan = E.buildPlan({ objectives: objs }, st(30), null);
    assert.strictEqual(plan.slots.length, 30); assert.strictEqual(plan.feasible_count, 30); assert.strictEqual(plan.shortfall, null, 'no shortfall message for a count the lecture can serve with extra angles'); assert.strictEqual(plan.natural_count + plan.extra_count, 30); assert(plan.extra_count >= 20);
    const per = objs.map((o) => plan.slots.filter((s) => s.objective_id === o.id).length); assert(Math.max(...per) - Math.min(...per) <= 1, 'even coverage over the lecture: ' + per);
    plan.slots.filter((s) => s.extra).forEach((s) => { assert(s.variant >= 1 && s.angle, 'a reinforcement slot says which angle'); assert(['basic_recall', 'understanding'].includes(s.qtype), 'only types the objective supports'); });
    assert.strictEqual(E.buildPlan(analysis, st(5), heur).extra_count, 0, 'a request the lecture can serve with distinct topics is planned exactly as before (no reinforcement)');
    assert.strictEqual(E.buildPlan({ objectives: [] }, st(30), null).shortfall.requested, 30, 'no objective at all: nothing to ask, and it says so'); console.log('1) planner: 30 requested -> 30 planned (' + plan.natural_count + ' natural + ' + plan.extra_count + ' reinforcement), even over the objectives'); }

  // ---- 2) local generator: exactly N from a real lecture, for several N; and an honest, graceful ceiling for a tiny source
  for (const n of [10, 20, 30, 40, 60]) { const plan = E.buildPlan(analysis, st(n), heur); const r = await R.generate(plan, pages, st(n), () => {}); assert.strictEqual(r.accepted.length, n, `local: asked ${n}, got ${r.accepted.length}`); sound(r.accepted, 'local ' + n); }
  { const tiny = [{ ref: 'd1p1', text: 'Systole: the contraction phase in which the ventricles eject blood into the arteries.\nDiastole: the relaxation phase in which the ventricles fill with blood.' }]; const a = R.analyse(tiny);
    if (a.objectives.length) { const plan = E.buildPlan(a, st(30), E.support([tiny[0].text], 'health')); const r = await R.generate(plan, tiny, st(30), () => {}); assert(r.accepted.length < 30 && r.accepted.length >= 0); sound(r.accepted, 'tiny'); } }
  console.log('2) local generator: 10/20/30/40/60 requested -> exactly that many, all sound, none a copy');

  // ---- 3) AI path: slots refused in the first round -> ONE bounded top-up round, then the local pass: exactly N, every AI question verified, nothing a copy
  const deliver = async (llm, plan, n) => { const r = await E.generateToCount(llm, plan, pages, st(n), () => {}, { concurrency: 3 }); const first = r.accepted.length;
    if (r.accepted.length < n) { const f = await R.fill(plan, r.accepted, n - r.accepted.length, pages, st(n), () => {}); r.accepted.push(...f.accepted); r.local = f.accepted.length; } r.fromAI = first; return r; };
  { const plan = E.buildPlan(analysis, st(30), heur); const m = model({ refuse: (s) => !s.reinforcement && s.slot % 3 === 0 }); const r = await deliver(m, plan, 30);
    assert.strictEqual(r.accepted.length, 30, 'AI + top-up + local: got ' + r.accepted.length); assert.strictEqual(r.stats.topup_rounds, 1, 'one bounded top-up round'); assert(r.accepted.some((c) => c.extra), 'reinforcement questions are marked');
    assert(m.seenPrompts.some((p) => /reinforcement/.test(p) && /DIFFERENT specific fact/.test(p)), 'the generator is told what a reinforcement slot is'); sound(r.accepted, 'ai topup'); assert(m.calls.verify >= 1, 'every AI question is still independently verified');
    console.log('3) AI: refused slots -> 1 top-up round -> exactly 30 (AI ' + r.fromAI + ' + local ' + (r.local || 0) + '), calls generate/verify/explain ' + [m.calls.generate, m.calls.verify, m.calls.explain].join('/')); }

  // ---- 4) a model that can never write the extra questions: bounded (one round), the local pass finishes -> still exactly N
  { const plan = E.buildPlan(analysis, st(40), heur); const m = model({ refuse: (s) => !!s.reinforcement }); const r = await deliver(m, plan, 40); assert.strictEqual(r.accepted.length, 40); assert(r.stats.topup_rounds <= 1); assert(r.local > 0 && r.accepted.filter((c) => c.local).every((c) => c.extra)); sound(r.accepted, 'ai refuses extras');
    console.log('4) AI refuses every extra: ' + r.stats.topup_rounds + ' round then ' + r.local + ' made locally -> exactly 40'); }
  // ---- 4b) the model's output is unusable (nothing passes the checks): no top-up spiral at all, the local pass delivers everything
  { const plan = E.buildPlan(analysis, st(30), heur); const m = model({ refuse: () => true }); const r = await deliver(m, plan, 30); assert.strictEqual(r.accepted.length, 30); assert.strictEqual(r.stats.topup_rounds, 0, 'nothing usable in round 1: no further AI rounds'); assert.strictEqual(r.fromAI, 0); console.log('4b) AI wrote nothing usable: 0 extra rounds, 30 made locally'); }

  // ---- 5) the service itself is down: no pile of failing top-up calls (the caller falls back as before)
  { const plan = E.buildPlan(analysis, st(30), heur); const m = model({ down: true }); let calls = 0; const llm = { async json(...a) { calls++; return m.json(...a); } };
    const r = await E.generateToCount(llm, plan, pages, st(30), () => {}, { concurrency: 3 }); assert.strictEqual(r.accepted.length, 0); assert(calls <= Math.ceil(30 / 3) * 2, 'a failing service is not hammered: ' + calls + ' calls'); console.log('5) service down: ' + calls + ' calls, no top-up spiral'); }

  // ---- 6) more than asked (the top-up asks a little extra to absorb rejections) is trimmed to exactly N; the order is lecture order without echoes side by side
  { const plan = E.buildPlan(analysis, st(30), heur); const m = model(); const r = await E.generateToCount(m, plan, pages, st(30), () => {}, { concurrency: 3 }); assert(r.accepted.length <= 30);
    const ordered = E.orderQuestions((await R.generate(E.buildPlan(analysis, st(60), heur), pages, st(60), () => {})).accepted); const pk = ordered.map((c) => c.pk); assert.deepStrictEqual(pk, pk.slice().sort((a, b) => a - b), 'lecture (page) order');
    const key = (c) => E.norm(c.evidence[0].quote).slice(0, 60); let adjacent = 0, possible = 0; for (let i = 1; i < ordered.length; i++) if (ordered[i].pk === ordered[i - 1].pk) { const same = ordered.filter((c) => c.pk === ordered[i].pk); if (new Set(same.map(key)).size >= 3) { possible++; if (key(ordered[i]) === key(ordered[i - 1])) adjacent++; } }
    assert(adjacent <= Math.ceil(possible * 0.15), `questions about the same sentence are kept apart: ${adjacent} of ${possible} neighbours`); console.log('6) trimmed to N, lecture order, echoes kept apart (' + adjacent + '/' + possible + ' neighbours share a sentence)'); }
  // ---- 7) the AI dies HALFWAY through the quiz (answers the first calls, then "HTTP 503" for good): what it made is kept, the free local generator makes the rest - still exactly N, all sound
  for (const dieAfter of [3, 9, 15]) { const plan = E.buildPlan(analysis, st(30), heur); const m = model({ dieAfter }); const r = await deliver(m, plan, 30);
    assert.strictEqual(r.accepted.length, 30, `AI died after ${dieAfter} calls: got ${r.accepted.length}`); assert(r.local > 0, 'the local generator finished the quiz'); sound(r.accepted, 'ai died after ' + dieAfter);
    console.log('7) AI died after ' + dieAfter + ' calls: ' + r.fromAI + ' from the AI + ' + r.local + ' made locally = 30'); }
  console.log('count guarantee tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
