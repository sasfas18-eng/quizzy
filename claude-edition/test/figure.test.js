// node claude-edition/test/figure.test.js — THE FIGURE READER (engine.js readFigure / checkFigure): precision before recall
//  1) only what is written in the picture and NOT on the slide already is kept: credits, links, a line the slide says, duplicates and lines without words are dropped
//  2) a reading is refused as a whole when the reader says it is not important, the picture is a decoration or a logo, or its confidence is below FIG.MIN_CONF
//  3) every kept line is confirmed by a second, independent look at the same picture: a line the checker cannot read in the image is dropped; no second look - nothing added
//  4) the picture goes with both looks, and the slide's neighbours go with the first (the reader judges the picture against the lecture around it)
global.window = {}; require('../engine.js'); const E = window.QZE; const assert = require('assert');
const ctx = { title: 'Kidney', page_no: 3, text: 'Regions of the kidney\nThe kidney has three regions shown in the figure below.', before: 'Functions of the kidney', after: 'The nephron' };
const model = (answers) => { const seen = []; return { seen, json: async (task, sys, pr, o) => { seen.push({ task, sys, pr, o }); const a = answers.shift(); if (a instanceof Error) throw a; return a; } }; };
const reading = (x) => ({ important: true, kind: 'labelled_diagram', title: null, confidence: 0.9, reason: 'labels', ...x });
(async () => {
  // 1) the code's own filter
  const kept = E.checkFigure(reading({ title: 'Coronal section of the kidney', lines: ['Renal cortex', 'renal cortex', 'Renal medulla', '© 2020 Pearson Education', 'Source: www.example.com', 'The kidney has three regions', 'kidney regions', '12', '   ', 'x'.repeat(200)] }), ctx);
  assert.deepStrictEqual(kept, ['Coronal section of the kidney', 'Renal cortex', 'Renal medulla'], '1) ' + JSON.stringify(kept));
  console.log('1) kept only what the picture adds: credits, links, what the slide says, repeats and lines without words are dropped');
  // 2) refused as a whole
  for (const bad of [{ important: false }, { kind: 'decorative' }, { kind: 'logo' }, { confidence: 0.6 }, { confidence: undefined }]) assert.deepStrictEqual(E.checkFigure(reading({ lines: ['Renal cortex'], ...bad }), ctx), [], '2) ' + JSON.stringify(bad));
  assert.deepStrictEqual(E.checkFigure(null, ctx), []); assert.deepStrictEqual(E.checkFigure('text', ctx), []);
  console.log('2) not important, a decoration, a logo or a low confidence: nothing is added');
  // 3) the second look
  let m = model([reading({ lines: ['Renal cortex', 'Nephron loop', 'Renal pelvis'] }), { checks: [{ i: 0, written: true, lecture: true }, { i: 1, written: false, lecture: true }, { i: 2, written: true, lecture: true }] }]);
  const img = [{ fake: 'blob' }]; let r = await E.readFigure(m, ctx, img);
  assert.deepStrictEqual(r.lines, ['Renal cortex', 'Renal pelvis'], '3) the line the checker cannot read is dropped');
  m = model([reading({ lines: ['Renal cortex'] }), { checks: [{ i: 0, written: true, lecture: false }] }]); assert.deepStrictEqual((await E.readFigure(m, ctx, img)).lines, [], '3) not lecture content: dropped');
  m = model([reading({ lines: ['Renal cortex'] }), new Error('busy')]); assert.deepStrictEqual((await E.readFigure(m, ctx, img)).lines, [], '3) no second look: nothing added');
  m = model([reading({ important: false, lines: ['Renal cortex'] })]); assert.deepStrictEqual((await E.readFigure(m, ctx, img)).lines, []); assert.strictEqual(m.seen.length, 1, '3) nothing to confirm: no second look asked');
  console.log('3) every line is confirmed by a second look at the picture; what it cannot read is dropped, and without it nothing is added');
  // 4) what goes with each look
  m = model([reading({ lines: ['Renal cortex'] }), { checks: [{ i: 0, written: true }] }]); await E.readFigure(m, ctx, img);
  assert(m.seen.every((x) => x.o && x.o.images === img), '4) the picture goes with both looks');
  assert(/PREVIOUS SLIDE TEXT:\nFunctions of the kidney/.test(m.seen[0].pr) && /NEXT SLIDE TEXT:\nThe nephron/.test(m.seen[0].pr) && /NEVER name or describe anything from your own knowledge/.test(m.seen[0].sys), '4) the neighbours and the rules go with the first');
  assert(/0\. Renal cortex/.test(m.seen[1].pr), '4) the checker gets the numbered lines');
  console.log('4) the picture goes with both looks; the reader also sees the slides around it and the rules (only what is written, nothing from its own knowledge)');
  console.log('figure ok');
})().catch((e) => { console.error(e); process.exit(1); });
