// node claude-edition/test/reflow.test.js — reading a PDF page back into SENTENCES (E.reflowLines) and keeping the question builder away from what is not lecture content.
// Found by using the site as a student: a real PDF (two columns, words hyphenated at line ends, a references list) gave questions like «what is "This"?» and options cut
// mid-word ("are pop-"), because every visual line was read as a sentence.
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE; const R = E.rules; const assert = require('assert');
const line = (text, y, { x0 = 50, w = 230, h = 10 } = {}) => ({ text, x0, x1: x0 + w, y, h });
const col = (texts, { y = 700, step = 13.5, w = 230, h = 10, widths = {} } = {}) => texts.map((t, i) => line(t, y - i * step, { w: widths[i] ?? w, h }));

// ---------------------------------------------------------------- 1) reflow
let t = E.reflowLines(col(['Dynamic languages such as JavaScript, Python, and Ruby, are pop-', 'ular since they are expressive, accessible to non-experts, and make', 'deployment as easy as distributing a source file.'], { widths: { 2: 180 } }));
assert.strictEqual(t, 'Dynamic languages such as JavaScript, Python, and Ruby, are popular since they are expressive, accessible to non-experts, and make deployment as easy as distributing a source file.', 'a hyphen at the line end is removed and the lines are one sentence: ' + t);
t = E.reflowLines(col(['These cells have a strong ability to protect themselves from self-', 'damage under stress and they recover very quickly afterwards.']));
assert(t.includes('self-damage'), 'a real compound keeps its hyphen: ' + t);
t = E.reflowLines([line('Functions of the kidney', 700, { w: 200, h: 24 }), line('filtration of blood plasma every day', 660, { w: 210 }), line('regulation of blood pressure', 640, { w: 160 }), line('acid–base balance', 620, { w: 110 })]);
assert.strictEqual(t.split('\n').length, 4, 'a slide: a big title and short lower-case bullets stay separate lines: ' + JSON.stringify(t));
t = E.reflowLines(col(['• The glomerulus filters plasma into Bowman\'s capsule and the', 'filtrate then passes along the proximal convoluted tubule', '• The loop of Henle concentrates the urine in the medulla'], { widths: { 2: 225 } }));
assert.deepStrictEqual(t.split('\n'), ['• The glomerulus filters plasma into Bowman\'s capsule and the filtrate then passes along the proximal convoluted tubule', '• The loop of Henle concentrates the urine in the medulla'], 'a wrapped bullet is joined, the next bullet is not: ' + t);
t = E.reflowLines([line('The kidney keeps the internal environment of the body stable over time and', 700), line('so it regulates water, salts and acid-base balance throughout the day.', 686), line('another paragraph starts after a clear vertical gap in the text block here', 650)]);
assert.strictEqual(t.split('\n').length, 2, 'a paragraph gap is not crossed: ' + t);
t = E.reflowLines(col(['The heart pumps about five litres of blood every minute at rest.', 'and the next line is unrelated to the sentence before it here.']));
assert.strictEqual(t.split('\n').length, 2, 'a line that ends a sentence is not joined');
t = E.reflowLines(col(['تتكون الكلية من ملايين الوحدات الوظيفية التي تسمى النيفرونات وكل واحدة منها', 'تقوم بترشيح الدم وإعادة امتصاص المواد المفيدة إلى الدورة الدموية.', 'الكلية'], { widths: { 2: 40 } }));
assert.deepStrictEqual(t.split('\n'), ['تتكون الكلية من ملايين الوحدات الوظيفية التي تسمى النيفرونات وكل واحدة منها تقوم بترشيح الدم وإعادة امتصاص المواد المفيدة إلى الدورة الدموية.', 'الكلية'], 'Arabic: a full-width line that does not end a sentence continues; a short line does not');
t = E.reflowLines([line('The pressure falls when the afferent arteriole constricts and the', 400, { x0: 50 }), line('filtration rate drops in proportion to the change in pressure.', 700, { x0: 310 })]);
assert(t.includes('and the filtration rate'), 'a sentence that goes on at the top of the next column is joined');
assert.strictEqual(E.reflowLines([line('Only one line', 700)]), 'Only one line'); assert.strictEqual(E.reflowLines([]), '');
console.log('ok   1) reflow: hyphen, compound, slide title + short bullets, wrapped bullet, paragraph gap, sentence end, Arabic, next column');

// ---------------------------------------------------------------- 2) what the question builder no longer takes as a term, a list or a number
const page = (text) => [{ ref: 'p1', text }];
let m = R.mine(page(['This is the first iteration of the outer loop and it records everything that happens.', 'There are no publications on LuaJIT but the creator has explained his ideas.', 'They are used for small scripts as well as for complex applications every day.',
  'Since no concrete type information is available, compilers emit generic code for everything.', 'Section 3 is a general overview of trace tree based compilation in this work.', 'The result is a native code fragment that can be entered if the types match.',
  'JavaScript is described in Section 6 together with the other benchmark programs.', 'The key insight is that each loop is represented by its own trace tree here.', 'The side exit is patched so that on future iterations it jumps directly to the branch.',
  'Cardiac output is the volume of blood pumped by the heart per minute.', 'Preload: the stretch of the ventricular wall before contraction begins'].join('\n')));
assert.deepStrictEqual(m.defs.map((d) => d.term).sort(), ['Cardiac output', 'Preload'], 'only real terms are defined: ' + m.defs.map((d) => d.term));
m = R.mine(page(['D.3.4 [Programming Languages]: Processors — Incremental compilers, code generation', '2. Overview: Example Tracing Run', 'trace that incorporates the outer loop: {i5, i7, i1, i6, i7, i1, α}', '[2] Mozilla — Firefox web browser and Thunderbird email client'].join('\n')));
assert.deepStrictEqual(m.defs, [], 'a classification code, a section heading, a symbol soup and a citation are not definitions: ' + JSON.stringify(m.defs));
m = R.mine(page('Dynamic languages such as JavaScript, Python, and Ruby, are popular since they are expressive and accessible to non-experts.'));
assert.deepStrictEqual(m.lists.map((l) => l.items), [['JavaScript', 'Python', 'Ruby']], 'a "such as" list ends where the sentence goes on: ' + JSON.stringify(m.lists));
m = R.mine(page('Once the variables v2 have not yet been assigned registers, the allocator assigns a free register to each of them.\nThe glomerular capillary pressure is about 55 mmHg in a healthy adult.'));
assert.deepStrictEqual(m.nums.map((n) => n.val + ' ' + n.unit), ['55 mmHg'], '"v2 have" is not "2 h": ' + JSON.stringify(m.nums.map((n) => n.val + n.unit)));
m = R.mine(page(['Renal blood flow is regulated by the myogenic response of the afferent arteriole.', 'References', '[1] Guyton AC, Hall JE. Textbook of Medical Physiology. Philadelphia: Elsevier; 2016.', 'Koeppen BM, Stanton BA. Renal Physiology is the classic reference for the topic. Mosby; 2018.'].join('\n')));
assert(m.cloze.every((c) => !/Guyton|Koeppen|Elsevier/.test(c.sentence)) && m.defs.every((d) => !/Renal Physiology/.test(d.term)), 'nothing is taken from the references list');
m = R.mine(page(['Permission to make digital or hard copies of all or part of this work is granted without fee.', 'Categories and Subject Descriptors D.3.4 Processors and incremental compilers for code generation.', 'Contact us at {gal,brendan}@mozilla.com for the complete benchmark data used here.'].join('\n')));
assert.strictEqual(m.cloze.length + m.defs.length, 0, 'copyright, classification and address lines are not lecture content');
m = R.mine(page('activities) is usually less than 5%, so we consider the interpreter fast enough for now.\nularly when the loop is hot the compiler records the trace for later use.'));
assert.strictEqual(m.cloze.length + m.nums.length, 0, 'the second half of a cut sentence is not a sentence');
m = R.mine(page('side_exit_1:\n• mov ecx, ebp(-4) // restore ecx\n• mov esp, ebp // restore esp\n• jmp epilog // jump to ret statement'));
assert.deepStrictEqual(m.lists, [], 'lines of code are not a list to examine');
console.log('ok   2) the builder: no pronoun/clause/document-pointer/generic "terms", no headings/citations/symbols as definitions, lists end with the list, whole-number values, no references/apparatus/fragments/code');

// ---------------------------------------------------------------- 3) slides still work the way they did
m = R.mine([{ ref: 's1', text: 'Functions of the kidney\nFiltration of blood\nRegulation of blood pressure\nAcid–base balance\nHormone secretion' }, { ref: 's2', text: 'Nephron: the functional unit of the kidney\nGlomerulus: a tuft of capillaries that filters plasma\nPodocytes: cells whose foot processes form the slit diaphragm' }]);
assert.strictEqual(m.lists.length, 1, 'a slide title + short lines is still a list'); assert.deepStrictEqual(m.defs.map((d) => d.term), ['Nephron', 'Glomerulus', 'Podocytes'], '"Term: definition" slides are still definitions');
console.log('ok   3) slides: title + short lines = a list, "Term: definition" = definitions');
console.log('reflow tests ok');
