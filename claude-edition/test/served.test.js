// node claude-edition/test/served.test.js — the Claude host learns how many requests the account ANSWERS at once (two, on the real account) and sends only a few
// more than that: the quiz is written by four writers, and a request the student waits for (the slide on screen) is answered ahead of the background ones.
const assert = require('assert'); const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function load(K, svc) {      // a fresh host on a fake claude.ai whose account answers K requests at once, each in svc ms
  for (const k of Object.keys(require.cache)) if (k.endsWith(path.join('claude-edition', 'host.js'))) delete require.cache[k];
  let busy = 0; const q = []; const sent = { max: 0, now: 0 };
  const serve = async (ms) => { sent.now++; sent.max = Math.max(sent.max, sent.now); if (busy >= K) await new Promise((r) => q.push(r)); busy++; try { await sleep(ms); } finally { busy--; sent.now--; const n = q.shift(); if (n) n(); } };
  const done = []; const sample = async (input) => { await serve(/SLIDE/.test(input) ? svc / 2 : svc); done.push(/SLIDE/.test(input) ? 'slide' : 'bg'); return { text: '{"ok":true}' }; }; sample.json = async (input) => { await serve(svc); done.push('bg'); return { ok: true }; }; sent.done = done;
  const store = {}; global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  global.window = { QZ_STORES: { Mem: class { }, idbStore: () => ({}) }, claude: { use: async (n) => (n === 'sample' ? sample : null) }, addEventListener() { }, localStorage: global.localStorage };
  global.navigator = { onLine: true }; global.document = { addEventListener() { }, visibilityState: 'visible' };
  require('../host.js'); return { H: window.QZ_HOST, sent };
}
(async () => {
  // 1) an account that answers two at once: learnt from 40 answers, kept on the device; the quiz then has four writers and at most four requests are sent at once
  { const { H, sent } = load(2, 40); assert.strictEqual(H.served, 7, 'not known yet: as before (seven at once)'); assert.strictEqual(H.genConcurrency, 7);
    await Promise.all(Array.from({ length: 40 }, () => H.llm.json('generate', 's', 'p'))); const before = sent.max; sent.max = 0;
    assert.strictEqual(H.served, 2); assert.strictEqual(H.genConcurrency, 4); assert.strictEqual(localStorage.getItem('qz_claude_served_v1'), '2', 'kept on the device');
    await Promise.all(Array.from({ length: 40 }, () => H.llm.json('generate', 's', 'p'))); assert.ok(sent.max <= 4, 'sent at once: ' + sent.max);
    console.log('1) answers two at once: learnt 2 from the first answers (sent', before, 'at once before), then four writers, at most', sent.max, 'requests sent at once'); }
  // 2) an account that answers six at once is not held at four: the number grows with what is seen
  { const { H } = load(6, 40); for (let r = 0; r < 4; r++) await Promise.all(Array.from({ length: 40 }, () => H.llm.json('generate', 's', 'p')));
    assert.ok(H.served >= 5, 'learnt ' + H.served); assert.ok(H.genConcurrency >= 6, 'writers ' + H.genConcurrency); console.log('2) answers six at once: learnt', H.served, '-', H.genConcurrency, 'writers'); }
  // 3) the slide the student opens is answered ahead of twelve background requests (it used to wait behind the seven already sent)
  { const { H, sent } = load(2, 40); await Promise.all(Array.from({ length: 30 }, () => H.llm.json('generate', 's', 'p'))); assert.strictEqual(H.served, 2);
    const bg = Array.from({ length: 12 }, () => H.llm.json('explain_slides', 's', 'p')); await sleep(5); const before = sent.done.length;
    await H.llm.json('explain_slide', 's', 'SLIDE', { priority: true }); const ahead = sent.done.length - 1 - before; await Promise.all(bg);
    assert.ok(ahead <= 4, ahead + ' background requests were answered before the slide'); console.log('3) the slide on screen was answered after', ahead, 'of 12 background requests (two being answered, two waiting; it used to wait behind every one already sent, seven)'); }
  // 4) the answer times of a real quiz (its first 48 requests, [sent s, seconds]): two at once - one at a time does not fit them
  { const { H } = load(2, 40); const real = [[2.4,7.5],[2.4,11.4],[2.4,18.6],[2.4,22.4],[2.4,29.7],[2.4,34.9],[9.8,28.1],[13.8,26],[21,19.8],[24.7,19.3],[32.1,14.4],[37.3,10.4],[37.9,13.5],[39.8,14.2],[40.7,15.7],[44,16.2],[47.7,16.1],[46.5,19.7],[51.5,18.3],[54,23.6],[60.2,21.7],[56.5,25.4],[66.2,26.9],[69.8,26.2],[77.6,20],[81.8,17.7],[81.9,21.2],[91.5,12.2],[96,13.1],[93.1,21.1],[99.6,19.6],[97.6,23],[103.1,20.8],[103.7,22.1],[109.2,19.1],[114.2,15],[119.2,14.8],[120.6,15.1],[123.9,13.4],[125.9,13.8],[139.7,11.1],[139.7,11.9],[139.7,21.6],[139.7,23.3],[139.7,32.9],[139.7,33.8],[153.3,26.2],[153.3,29.3]];
    assert.strictEqual(H._servedAtOnce(real.map(([a, d]) => ({ a: a * 1000, e: (a + d) * 1000 }))), 2); console.log('4) a real quiz\'s answer times: two at once'); }
  // 5) the writers see the questions already written WITH their keys, and those still being checked: no batch after the first ones is written blind
  { global.window = {}; for (const k of Object.keys(require.cache)) if (k.endsWith('engine.js')) delete require.cache[k]; require('../engine.js'); const E = window.QZE;
    const pagesList = Array.from({ length: 20 }, (_, i) => ({ ref: `d1p${i + 1}`, text: `Topic ${i}: Term${i} is the regulator that controls marker${i} inside tissue${i}.`, doc_id: 'd', page_no: i + 1 }));
    const slots = pagesList.map((p, i) => ({ slot: i + 1, qtype: 'basic_recall', objective: 'o' + i, objective_id: 'o' + i, pages: [p.ref], difficulty: 'easy', task: null }));
    const prompts = []; let busy = 0; const q = []; const serve = async (ms) => { if (busy >= 2) await new Promise((r) => q.push(r)); busy++; try { await sleep(ms); } finally { busy--; const n = q.shift(); if (n) n(); } };
    const llm = { async json(task, sys, prompt) {
      if (task === 'generate') { prompts.push(prompt); const sl = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON'))); await serve(30);
        return { questions: sl.map((s) => { const t = pg[s.pages[0]]; const term = t.match(/: (\w+)/)[1]; return { slot: s.slot, stem: 'Which term is the regulator that controls ' + t.match(/marker\d+/)[0] + '?', options: [term, 'Alpha' + s.slot, 'Beta' + s.slot, 'Gamma' + s.slot], correct_index: 0, explanation: 'الإجابة من نص المحاضرة: «' + t + '». الخيارات الأخرى لا تظهر فيه.', purpose: 'p' + s.slot, evidence: [{ page: s.pages[0], quote: t }] }; }) }; }
      const at = task === 'verify' ? 'QUESTIONS:\n' : 'ITEMS:\n'; const it = JSON.parse(prompt.slice(prompt.indexOf(at) + at.length, prompt.indexOf('\nReturn JSON'))); await serve(15);
      return { results: it.map((x) => (task === 'verify' ? { id: x.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' } : { id: x.id, explanation_supported: true, contradicts_source: false })) }; } };
    const r = await E.generate(llm, { slots, requested: 20 }, pagesList, { field: 'science', language: 'en', external_mode: 'source_only' }, () => {}, { concurrency: 2 });
    const seen = prompts.map((p) => { const m = p.match(/being checked[^\n]*\n(\[.*?\])\n/); return m ? JSON.parse(m[1]) : []; });
    assert.strictEqual(r.accepted.length, 20); assert.ok(seen.slice(2).every((x) => x.length > 0), 'a later batch was written blind: ' + seen.map((x) => x.length));
    assert.ok(seen.slice(2).every((x) => x.every((e) => /^Term\d+$/.test(e.key))), 'each question is shown with its key'); assert.ok(prompts.slice(2).every((p) => /must not state the key of any of these/.test(p)));
    console.log('5) writers after the first two see', seen.slice(2).map((x) => x.length).join(','), 'earlier questions with their keys'); }
  // 6) on an account that answers two at once: fewer, fuller requests (up to 8 questions written and 16 checked in one), the same questions accepted; the answer
  //    asks only for the fields that are used (no «unwritable_reason: null» and no «uses_external: false» repeated for every question)
  { global.window = {}; for (const k of Object.keys(require.cache)) if (k.endsWith('engine.js')) delete require.cache[k]; require('../engine.js'); const E = window.QZE;
    const pagesList = Array.from({ length: 40 }, (_, i) => ({ ref: `d1p${i + 1}`, text: `Topic ${i}: Term${i} is the regulator that controls marker${i} inside tissue${i}.`, doc_id: 'd', page_no: i + 1 }));
    const slots = pagesList.map((p, i) => ({ slot: i + 1, qtype: 'basic_recall', objective: 'o' + i, objective_id: 'o' + i, pages: [p.ref], difficulty: 'easy', task: null, section: 's' + Math.floor(i / 8) }));
    const run = async (served) => { const sizes = { g: [], c: [] }; const prompts = [];
      const llm = { async json(task, sys, prompt) { await sleep(2);
        if (task === 'generate') { prompts.push(prompt); const sl = JSON.parse(prompt.slice(prompt.indexOf('SLOTS:\n') + 7, prompt.indexOf('\nPAGES:\n'))); const pg = JSON.parse(prompt.slice(prompt.indexOf('\nPAGES:\n') + 8, prompt.indexOf('\nReturn JSON'))); sizes.g.push(sl.length);
          return { questions: sl.map((x) => { const t = pg[x.pages[0]]; const term = t.match(/: (\w+)/)[1]; return { slot: x.slot, stem: 'Which term is the regulator that controls ' + t.match(/marker\d+/)[0] + '?', options: [term, 'Alpha' + x.slot, 'Beta' + x.slot, 'Gamma' + x.slot], correct_index: 0, explanation: 'الإجابة من نص المحاضرة: «' + t + '». الخيارات الأخرى لا تظهر فيه.', purpose: 'p' + x.slot, evidence: [{ page: x.pages[0], quote: t }] }; }) }; }
        const at = task === 'verify' ? 'QUESTIONS:\n' : 'ITEMS:\n'; const it = JSON.parse(prompt.slice(prompt.indexOf(at) + at.length, prompt.indexOf('\nReturn JSON'))); if (task === 'verify') sizes.c.push(it.length);
        return { results: it.map((x) => (task === 'verify' ? { id: x.id, chosen_index: 0, answerable_from_source: true, single_best_answer: true, sufficient_data: true, flaws: [], severity: 'none' } : { id: x.id, explanation_supported: true, contradicts_source: false })) }; } };
      const r = await E.generate(llm, { slots, requested: 40 }, pagesList, { field: 'science', language: 'en', external_mode: 'source_only' }, () => {}, { concurrency: 4, served, checkWaitMs: 50 });
      return { r, sizes, prompts }; };
    const a = await run(0), b = await run(2);
    assert.strictEqual(a.r.accepted.length, 40); assert.strictEqual(b.r.accepted.length, 40); assert.deepStrictEqual(b.r.accepted.map((c) => c.slot).sort((x, y) => x - y), a.r.accepted.map((c) => c.slot).sort((x, y) => x - y));
    assert.ok(Math.max(...a.sizes.g) <= 5 && Math.max(...b.sizes.g) <= 8 && Math.max(...b.sizes.g) > 5, 'writing requests: ' + a.sizes.g + ' | ' + b.sizes.g);
    assert.ok(b.sizes.g.length < a.sizes.g.length && Math.max(...b.sizes.c) <= 16, 'checks: ' + a.sizes.c + ' | ' + b.sizes.c);
    assert.ok(b.prompts.every((p) => !/"unwritable_reason":null/.test(p) && !/uses_external/.test(p.slice(p.indexOf('Return JSON')))), 'no field repeated for nothing');
    console.log('6) two at once:', b.sizes.g.length, 'writing requests (of', b.sizes.g.join('/') + ') instead of', a.sizes.g.length, '; checks of', b.sizes.c.join('/'), 'instead of', a.sizes.c.join('/'), '; the same 40 questions'); }
  console.log('served ok');
})().catch((e) => { console.error(e); process.exit(1); });
