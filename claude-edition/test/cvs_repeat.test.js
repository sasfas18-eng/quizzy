// From a real CVS quiz (30 questions): Q16 «relaxation … called ___» and Q30 «relaxation called diastole … contraction called ___» - one sentence asked twice,
// each stem giving the other's answer away; and «ventricles above the atria, below the arteries» asked four times from one line. Both are refused now.
const assert = require('assert'); const path = require('path');
global.window = {}; require(path.join(__dirname, '..', 'engine.js')); const E = window.QZE;
const q16 = { slot: 16, stem: 'The cardiac cycle consists of a period of relaxation during which the heart fills with blood, called ______, followed by a period of contraction.', options: ['systole', 'protodiastole', 'atrial systole', 'diastole'], correct_index: 3, qtype: 'Fill-in-the-blank', evidence: [{ quote: 'The cardiac cycle consists of a period of relaxation called diastole during which the heart fills with blood.' }] };
const q30 = { slot: 30, stem: 'Complete the statement: the cardiac cycle consists of a period of relaxation called diastole followed by a period of contraction called ______.', options: ['protodiastole', 'systole', 'isovolumetric contraction', 'atrial systole'], correct_index: 1, qtype: 'Fill-in-the-blank', evidence: [{ quote: 'consists of a period of relaxation called diastole followed by a period of contraction called systole.' }] };
assert.strictEqual(E.leaks(q30, [q16], false), 16, 'the second blank of one sentence gives the first away'); assert.strictEqual(E.leaks(q30, [q16], true), 16, 'also as a reinforcement question');
const other = { ...q30, slot: 31, stem: 'Which phase follows isovolumetric contraction, when the semilunar valves open and blood leaves the ventricles?', options: ['Maximum ejection', 'Diastole', 'Protodiastole', 'Rapid inflow'], correct_index: 0, evidence: [{ quote: 'maximum ejection' }] };
assert.strictEqual(E.leaks(other, [q16], false), null, 'naming «diastole» in an unrelated stem is not a give-away');
console.log('1) one sentence asked twice with another word blanked is refused (Q16/Q30); the word named in an unrelated question is not');
const line = 'The pressure within the ventricles is still higher than the atria, so the A-V valves remain closed and no blood enters or leaves the ventricles.';
const mk = (slot, stem, options, ci, qtype) => ({ slot, stem, options, correct_index: ci, qtype, evidence: [{ quote: line }] });
const q23 = mk(23, 'Which contrast correctly distinguishes the pressure relationship that keeps the semilunar valves closed from the one that keeps the A-V valves closed during isovolumetric relaxation?', ['a', 'Semilunar: arterial pressure exceeds ventricular pressure; A-V: ventricular pressure exceeds atrial pressure', 'c', 'd'], 1, 'Compare & Contrast');
const q24 = mk(24, 'All of the following describe isovolumetric relaxation EXCEPT:', ['x', 'y', 'Blood enters the ventricles through the A-V valves', 'z'], 2, 'NOT / EXCEPT');
const q25 = mk(25, 'In a model of the ventricles, pressure inside them keeps falling, remains higher than atrial pressure, and stays lower than pressure in the large arteries. Which phase does this describe?', ['Isovolumetric relaxation', 'Rapid inflow', 'Atrial systole', 'Reduced inflow'], 0, 'Clinical Scenarios');
assert.strictEqual(E.dupOf(q24, [q23], true), null, 'a second question on one line (another angle) is kept');
assert.notStrictEqual(E.dupOf(q25, [q23, q24], true), null, 'a third on the same line is the same fact again');
assert.strictEqual(E.dupOf(q25, [q23, q24], true, false), null, 'the rules generator (each item of a list line) is not limited');
console.log('2) two questions on one line of the lecture at most; a third (Q25 after Q23, Q24) is refused');
console.log('cvs repeat ok');
