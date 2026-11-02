// node claude-edition/test/chrome_ai.test.js — the free improvements after a quiz is written: (1) the SELF-CHECK (no AI) solves every question again from the
// lecture text and drops what the text does not decide; (2) the composer's AI path with the model built into the browser (Chrome's on-device `LanguageModel`,
// zero cost): blind check + wording polish, within 10 s, verified against the lecture - and nothing at all changes where the browser has no such model.
// The model is simulated here (a fake `LanguageModel` with the same API), so the test runs anywhere.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert');
const mk = (arr) => arr.map((t, i) => ({ ref: 'd1p' + (i + 1), text: t, doc_id: 'd', page_no: i + 1 }));
const src = require('fs').readFileSync(__dirname + '/types.test.js', 'utf8'); const lit = src.slice(src.indexOf('const S = mk([') + 'const S = mk('.length, src.indexOf(']);', src.indexOf('const S = mk([')) + 1);
const pages = mk(eval(lit)); const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
const gen = async (n) => R.generate(E.buildPlan(R.analyse(pages), st(n), E.support(pages.map((p) => p.text), 'health')), pages, st(n), () => {});
const byRef = Object.fromEntries(pages.map((p) => [p.ref, p.text]));
(async () => {
  // 1) the self-check: what the text does not decide
  const q = (o) => ({ form: 'pickExample', qtype: 'basic_recall', stem: 'Which of the following does the lecture give as an example of "Obligate Aerobes"?', correct_index: 0, evidence: [{ page: 'd1p4', quote: 'A. Obligate Aerobes: Require oxygen to live. Example: Pseudomonas' }], ...o });
  assert(R.selfCheck(q({ options: ['Pseudomonas', 'Clostridium', 'Staphylococcus', 'Campylobacter'] }), byRef) === null, 'a sound question passes');
  assert(/second option/.test(R.selfCheck(q({ options: ['Pseudomonas', 'oxygen', 'Staphylococcus', 'Campylobacter'] }), byRef)), 'a second option in the cited sentence is caught');
  assert(/part of the key/.test(R.selfCheck(q({ options: ['strict aerobes', 'aerobes', 'Staphylococcus', 'Campylobacter'], evidence: [{ page: 'd1p4', quote: 'Bacteria are grouped by what they need to live.' }] }), byRef)), 'an option inside the key is caught');
  assert(/NOT-question/.test(R.selfCheck({ form: 'listNot', qtype: 'not_except', stem: 'Which is NOT listed under "Oxygen Requirements"?', options: ['Pseudomonas', 'x', 'y', 'z'], correct_index: 0, evidence: [{ page: 'd1p4', quote: 'Oxygen Requirements' }] }, byRef)), 'a NOT-question whose answer is in the lecture is caught');
  console.log('1) self-check: a second option in the cited sentence, an option inside the key, a NOT-answer that is in the lecture - all caught; a sound question passes');

  // 2) no model in this browser: nothing changes, no time spent
  const t0 = Date.now(); const plain = await gen(30); assert.strictEqual(plain.accepted.length, 30); assert(!plain.stats.chrome_ai, 'no AI pass without the model'); const plainMs = Date.now() - t0;
  const ref = plain.accepted.map((c) => c.stem);
  console.log(`2) no built-in model: ${plain.accepted.length} questions in ${plainMs} ms, no AI pass`);

  // 3) a model that agrees and polishes: the blind check passes, English stems get the new wording ONLY when it keeps the quotes / terms and hides the answer
  let calls = 0; const polishes = []; const fake = (behave) => ({ availability: async () => behave.state || 'available', create: async () => ({ destroy() {}, prompt: async (p) => { calls++; if (behave.delay) await new Promise((r) => setTimeout(r, behave.delay));
    if (/^SOURCE:/.test(p)) { const opts = p.split('\n').filter((l) => /^[ABCD]\) /.test(l)); return behave.answer ? behave.answer(p, opts) : 'A'; }
    const stem = p.split('QUESTION: ')[1]; const r = behave.polish ? behave.polish(stem) : stem; polishes.push([stem, r]); return r; } }) });
  // the fake always answers with the KEY's letter: find it from the generated question (the test knows the key; the model is told only the options)
  const keyOf = new Map(); const answerKey = (p, opts) => { const stem = p.split('QUESTION: ')[1].split('\n')[0]; const k = keyOf.get(stem); const i = opts.findIndex((l) => l.slice(3) === k); return 'ABCD'[Math.max(0, i)]; };
  global.LanguageModel = fake({ answer: (p, opts) => { const stem = p.split('QUESTION: ')[1].split('\n')[0]; for (const [s, k] of keyOf) if (stem === s) { const i = opts.findIndex((l) => l.slice(3) === k); return 'ABCD'[i]; } return 'A'; },
    polish: (stem) => (/^Which statement/.test(stem) ? stem.replace(/^Which statement/, 'Which one of these statements') : /^A patient/.test(stem) ? 'A patient comes in. ' + stem.replace(/"[^"]+"/g, '') : stem) });
  plain.accepted.forEach((c) => keyOf.set(c.stem, c.options[c.correct_index]));
  const withAi = await gen(30); const r = withAi.stats.chrome_ai; console.log('3) with the model:', JSON.stringify(r));
  assert.strictEqual(r.state, 'available'); assert(r.checked >= 10, 'questions checked blind: ' + r.checked); assert.strictEqual(r.dropped, 0, 'the model agreed with every key: nothing dropped');
  assert(withAi.accepted.some((c) => c.stem_original && /^Which one of these statements/.test(c.stem)), 'a safe rewording is taken');
  assert(!withAi.accepted.some((c) => /^A patient comes in/.test(c.stem) && /"/.test(c.stem_original || '')), 'a rewording that drops the lecture\'s quoted text is refused');
  assert.strictEqual(withAi.accepted.length, 30, 'the count is unchanged');

  // 4) a model that picks ANOTHER answer for some questions: those are dropped and written again locally; the count is still met
  keyOf.clear(); plain.accepted.forEach((c) => keyOf.set(c.stem, c.options[c.correct_index])); let wrongN = 0;
  global.LanguageModel = fake({ answer: (p, opts) => { const stem = p.split('QUESTION: ')[1].split('\n')[0]; const k = keyOf.get(stem); const i = opts.findIndex((l) => l.slice(3) === k); if (i >= 0 && wrongN < 3 && /^Which/.test(stem)) { wrongN++; return 'ABCD'[(i + 1) % 4]; } return 'ABCD'[Math.max(0, i)]; } });
  const dis = await gen(30); console.log('4) model disagrees on some:', JSON.stringify(dis.stats.chrome_ai)); assert.strictEqual(dis.stats.chrome_ai.dropped, 3, 'three questions the model answered differently are dropped');
  assert.strictEqual(dis.accepted.length, 30, 'and written again: still 30'); assert(dis.dropped.filter((d) => /Chrome/.test((d.reasons || [])[0] || '')).length === 3);

  // 5) a slow model: the pass stops at its 10 s budget (here 10 s of 1 s answers ≈ a handful) and the quiz is delivered
  global.LanguageModel = fake({ delay: 1000 }); const t1 = Date.now(); const slow = await gen(20); const ms = Date.now() - t1;
  console.log(`5) slow model (1 s per answer): ${slow.stats.chrome_ai.checked} checked, quiz in ${ms} ms`); assert(ms < 13000, 'within the 10 s budget (+ the local work)'); assert.strictEqual(slow.accepted.length, 20);

  // 6) a model that is not on the device yet ("downloadable"): no quiz waits for a download
  global.LanguageModel = fake({ state: 'downloadable' }); calls = 0; const dl = await gen(20); assert.strictEqual(calls, 0, 'no prompt'); assert.strictEqual(dl.stats.chrome_ai.state, 'downloadable');
  console.log('6) model not downloaded: not used, no waiting'); delete global.LanguageModel;
  console.log('chrome ai tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
