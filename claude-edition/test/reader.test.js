// node claude-edition/test/reader.test.js — the lecture reader's pure parts: tables rebuilt from page geometry, OCR line hygiene.
const R = require('../../shared/reader.js'); const assert = require('assert');
let n = 0; const it = (str, x, y, w = 60, h = 12, eol = false) => ({ i: n++, str, x, y, w, h, eol });
const reset = () => { n = 0; };

// ---- 1) a 4x3 table under a title and above a paragraph: rows come out as "a | b | c" in place, other text untouched
{ reset(); const items = [it('Drug dosing overview', 50, 760, 200, 16, true), it('Drug', 50, 700), it('Dose', 200, 700), it('Route', 350, 700), it('Aspirin', 50, 680), it('75 mg', 200, 680), it('Oral', 350, 680),
    it('Heparin', 50, 660), it('5000 IU', 200, 660), it('IV', 350, 660), it('Insulin', 50, 640), it('10 units', 200, 640), it('Subcutaneous', 350, 640, 90),
    it('Doses must be adjusted for renal function in older patients.', 50, 600, 330, 12, true)];
  const { text, tables } = R.composePage(items); assert.strictEqual(tables, 1);
  assert.strictEqual(text, 'Drug dosing overview\nDrug | Dose | Route\nAspirin | 75 mg | Oral\nHeparin | 5000 IU | IV\nInsulin | 10 units | Subcutaneous\nDoses must be adjusted for renal function in older patients.\n'); }

// ---- 2) multi-word cells (two PDF items with a small gap) stay one cell
{ reset(); const items = [it('Parameter', 50, 700, 80), it('Normal range', 220, 700, 70), it('Heart', 220, 700, 30), // noise guard: separate item at the same place is fine
  it('Heart', 50, 680, 40), it('rate', 94, 680, 25), it('60-100 bpm', 220, 680, 70), it('Systolic', 50, 660, 55), it('pressure', 109, 660, 50), it('90-120 mmHg', 220, 660, 80), it('Respiratory', 50, 640, 70), it('rate', 124, 640, 25), it('12-20 per min', 220, 640, 85)];
  const { text, tables } = R.composePage(items.filter((x, k) => k !== 2)); assert.strictEqual(tables, 1); assert(text.includes('Heart rate | 60-100 bpm') && text.includes('Systolic pressure | 90-120 mmHg') && text.includes('Respiratory rate | 12-20 per min'), text); }

// ---- 3) Arabic table: stream order is right-to-left, the first column is the RIGHTMOST one
{ reset(); const row = (y, a, b, c) => [it(a, 350, y, 60), it(b, 200, y, 60), it(c, 50, y, 60)];
  const items = [...row(700, 'الدواء', 'الجرعة', 'الطريق'), ...row(680, 'أسبرين', '٧٥ ملغ', 'فموي'), ...row(660, 'هيبارين', '٥٠٠٠ وحدة', 'وريدي'), ...row(640, 'إنسولين', '١٠ وحدات', 'تحت الجلد')];
  const { text, tables } = R.composePage(items); assert.strictEqual(tables, 1); const lines = text.trim().split('\n');
  assert.deepStrictEqual(lines, ['الدواء | الجرعة | الطريق', 'أسبرين | ٧٥ ملغ | فموي', 'هيبارين | ٥٠٠٠ وحدة | وريدي', 'إنسولين | ١٠ وحدات | تحت الجلد']); }

// ---- 4) not tables: two-column prose (long cells), a single justified line, and plain flowing text
{ reset(); const L = 'This sentence is deliberately long so that the left column reads like prose and not like a cell.'; const items = [];
  for (let k = 0; k < 5; k++) { items.push(it(L + k, 50, 700 - k * 18, 400, 12)); items.push(it(L + 'x' + k, 520, 700 - k * 18, 400, 12)); }
  assert.strictEqual(R.composePage(items).tables, 0, 'long cells = prose columns');
  reset(); const j = [it('Heart', 50, 700, 40), it('rate', 95, 700, 25), it('is', 400, 700, 12), it('Cardiac output', 50, 680, 90), it('equals', 150, 680, 40), it('Stroke volume', 50, 660, 80), it('times', 140, 660, 30)];
  assert.strictEqual(R.composePage(j).tables, 0, 'fewer than 3 aligned rows is not a table'); }

// ---- 5) without tables the text is exactly the old stream-order output
{ reset(); const items = [it('Cardiac cycle', 50, 750, 90, 16, true), it('Systole is the phase of ventricular', 50, 700, 220), it('contraction.', 50, 680, 70, 12, true), it('Diastole follows.', 50, 650, 100, 12, true)];
  assert.strictEqual(R.composePage(items).text, 'Cardiac cycle\nSystole is the phase of ventricular\ncontraction.\nDiastole follows.\n'); }

// ---- 6) OCR hygiene: only new, readable, confident lines survive; the text layer is never duplicated
{ const layer = 'Cardiac output equals stroke volume multiplied by heart rate.';
  const out = R.mergeOcr(layer, [{ text: 'Cardiac output equals stroke volume multiplied by heart rate.', conf: 91 }, { text: 'Systole ejects blood into the aorta', conf: 88 }, { text: '~~ || ~~', conf: 90 }, { text: 'ab', conf: 99 }, { text: 'Low confidence guess here', conf: 30 }, { text: 'Diastole fills the ventricles', conf: 77 }]);
  assert.deepStrictEqual(out, ['Systole ejects blood into the aorta', 'Diastole fills the ventricles']);
  assert.deepStrictEqual(R.mergeOcr('', [{ text: 'الميتوكوندريا تنتج الطاقة داخل الخلية', conf: 80 }]), ['الميتوكوندريا تنتج الطاقة داخل الخلية']);
  assert(R.usefulLine('Left ventricle 120 mmHg') && !R.usefulLine('|| -- ~~') && !R.usefulLine('x')); }
// ---- 6b) doubtful lines are left out and counted (numbers below are real Tesseract measurements on generated scans)
{ const W = (t, ...c) => t.split(' ').map((x, i) => ({ t: x, c: c[i] })); const st = { rejected: 0 };
  const lines = [
    { text: 'Mitochondria produce ATP through oxidative phosphorylation.', conf: 96, words: W('Mitochondria produce ATP through oxidative phosphorylation.', 96, 96, 95, 96, 95, 96) },        // clean scan
    { text: '_ Glycolysis occurs in the and yields two pyruvate molecules.', conf: 66, words: W('_ Glycolysis occurs in the and yields two pyruvate molecules.', 0, 1, 86, 85, 96, 90, 95, 96, 95, 59) },   // poor scan: line below 70
    { text: 'Krebs cycle takes place in the mitochondrial matrix', conf: 82, words: W('Krebs cycle takes place in the mitochondrial matrix', 90, 85, 88, 80, 20, 30, 25, 85) },          // line ok but several real words are doubtful
    { text: 'The heart pumps blood through the body', conf: 88, words: W('The heart pumps blood through the body', 90, 91, 89, 90, 88, 87, 5, 90) },                           // only a short word is weak: fine
  ];
  assert.deepStrictEqual(R.mergeOcr('', lines, st), ['Mitochondria produce ATP through oxidative phosphorylation.', 'The heart pumps blood through the body']); assert.strictEqual(st.rejected, 2);
  assert(R.reliable({ text: 'x', conf: 70 }) && !R.reliable({ text: 'x', conf: 69 }) && R.reliable({ text: 'no word data', conf: 95 })); }
// ---- 7) OCR language choice
assert.strictEqual(R.pickLangs('الخلية هي الوحدة الأساسية للحياة '.repeat(10)), 'ara+eng'); assert.strictEqual(R.pickLangs('The cell is the basic unit of life. '.repeat(10)), 'eng'); assert.strictEqual(R.pickLangs(''), 'ara+eng');
console.log('reader tests ok');
