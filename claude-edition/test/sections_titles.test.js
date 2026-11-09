// node claude-edition/test/sections_titles.test.js — the lecture's own sections, read from its slide titles the way PDF text actually comes out
// (patterns measured on a real 46-slide lecture; the slides below are made up):
//  1) a title wrapped onto two lines is one title («Organization of The Circulatory» + «System»; «Basic Functions of the» + «Cardiac Cycle»;
//     the lines above the first bullet: «…Rehabilitation, Cardiac» + «Restoration, and Palliative Care»)
//  2) a first line that ends with «:» opens a list, it is not a title; the slide's title further down is used («The Blood Vessels»)
//  3) a title the text puts lower down (a text box read out of order) starts its section («The Heart», «The Conduction System») - the parietal,
//     temporal and brain-stem slides of the real lecture were lost inside their neighbours without this
//  4) an exercise slide («Check Your Understanding», «تحقق من فهمك») is not a section: it stays with the section it reviews
//  5) a running footer and a list of short items are never titles
const assert = require('assert'), path = require('path');
global.window = global; global.location = { href: 'http://x/' }; global.document = { addEventListener() {}, getElementById() { return null; } };
window.fetch = async () => ({}); require('../engine.js'); require('../../shared/owner_rules.js');
window.QZ_HOST = { aiOnly: true, platform: async () => ({}), bannerText: () => '', store: async () => ({}), llm: {} }; require('../../shared/api-core.js');
const S = window.QZ_API._sections; assert(S, 'lectureSections is exposed for tests');
const FOOT = 'Cardiovascular Physiology';
const deck = [
  'Introduction\n• Imagine you climb stairs quickly and your heart pounds in your chest.\n• What made the heart speed up so suddenly?',
  '• A muscular pump that moves blood through two separate circuits of vessels.\nThe Heart\n• Functions: pumps blood, maintains pressure and delivers oxygen to tissues.',
  'Organization of The Circulatory\nSystem\n1. The pulmonary circuit carries blood to the lungs.\n2. The systemic circuit carries blood to the body.',
  'Basic Functions of the\nCardiac Cycle\nThe cardiac cycle has two phases:\n1. Systole: the ventricles contract.\n2. Diastole: the ventricles relax.',
  'Check Your Understanding\n• You run for a bus and your pulse rises sharply.\n1. Which phase of the cycle shortens the most?',
  'There are two main types of vessels:\n– Arteries.\n– Veins.\nThe Blood Vessels\n• Arteries: carry blood away from the heart.\n• Veins: return blood to the heart.',
  'Heart Valves\n• Atrioventricular valves separate the atria from the ventricles.\n• Semilunar valves guard the great arteries.',
  '• The sinoatrial node starts each heartbeat.\n• The impulse spreads across the atria and\nThe Conduction System\nthe atria and reaches the atrioventricular node.\n• The bundle of His carries it to the ventricles.',
  'Tertiary Prevention: Rehabilitation, Cardiac\nRestoration, and Palliative Care\n• Cardiac rehabilitation restores exercise capacity.\n• Palliative care relieves the symptoms of heart failure.',
  `Blood Pressure\n• Systolic pressure is the peak arterial pressure.\n• Diastolic pressure is the lowest arterial pressure.\n${FOOT}`,
  `• Pressure falls along the arterial tree as vessels branch.\n• It is lowest in the veins near the heart.\n${FOOT}`,
  `• The vessel wall has three layers:\nTunica intima\nTunica media\nTunica externa\n• Each layer has its own tissue.\n${FOOT}`,
  `• Baroreceptors sense stretch in the arterial wall.\n• They adjust the heart rate within seconds.\n${FOOT}`,
  `• Long-term control of pressure is renal.\n• The kidneys change the blood volume over days.\n${FOOT}`,
].map((text, i) => ({ ref: 'd1p' + (i + 1), text }));
const sec = S(deck); assert(sec, 'the deck shows its structure');
const label = (n) => sec['d1p' + n].label, key = (n) => sec['d1p' + n].key;
assert.strictEqual(label(3), 'Organization of The Circulatory System', '1) a title wrapped onto its next line');
assert.strictEqual(label(4), 'Basic Functions of the Cardiac Cycle', '1) a title that ends on «the» goes on in the next line');
assert.strictEqual(label(9), 'Tertiary Prevention: Rehabilitation, Cardiac Restoration, and Palliative Care', '1) the lines above the first bullet are the title');
assert.strictEqual(label(6), 'The Blood Vessels', '2) «There are two main types of vessels:» opens a list; the title is further down');
assert.strictEqual(label(2), 'The Heart', '3) a title lower down on the slide starts its section');
assert.strictEqual(label(8), 'The Conduction System', '3) a title between the halves of a broken sentence');
assert.strictEqual(key(5), key(4), '4) the exercise slide stays with the section it reviews');
assert(!Object.values(sec).some((x) => /check your understanding/i.test(x.label)), '4) no section is called «Check Your Understanding»');
for (const n of [11, 12, 13, 14]) assert.strictEqual(key(n), key(10), `5) slide ${n} stays in «Blood Pressure» (no footer, no list item as a title)`);
assert(!Object.values(sec).some((x) => x.label === FOOT || /^Tunica/.test(x.label)), '5) neither the footer nor «Tunica intima» names a section');
const labels = [...new Set(Object.values(sec).map((x) => x.label))]; console.log(`1-5) ${labels.length} sections: ${labels.join(' | ')}`);
// Arabic: an exercise slide is not a section either
const ar = ['الجهاز العصبي\n• يتكون من الدماغ والحبل الشوكي والأعصاب.\n• ينقل الإشارات بسرعة كبيرة.', 'تحقق من فهمك\n• ما وظيفة الدماغ في الجسم؟\n• ما وظيفة الحبل الشوكي؟',
  'الخلايا العصبية\n• العصبون هو الوحدة الأساسية في الجهاز العصبي.\n• للعصبون محور وتغصنات.', 'الخلايا الداعمة\n• تغذي الخلايا الداعمة العصبونات.\n• وتحميها من الأذى.']
  .map((text, i) => ({ ref: 'd1p' + (i + 1), text }));
const sa = S(ar); assert(sa, 'the Arabic deck shows its structure'); assert.strictEqual(sa.d1p2.key, sa.d1p1.key, '«تحقق من فهمك» stays with its section');
assert(!Object.values(sa).some((x) => /تحقق من فهمك/.test(x.label)), 'no section is called «تحقق من فهمك»');
console.log('Arabic: «تحقق من فهمك» stays in «' + sa.d1p1.label + '»');
console.log('section titles ok');
