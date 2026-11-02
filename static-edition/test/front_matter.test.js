// node static-edition/test/front_matter.test.js — what is ABOUT the lecture is never a source of questions: the cover (title, the lecturer's name, the
// university, the book / chapter), the objectives and the outline, the closing slide, and lines that only name the lecturer or the institution.
// And what IS the lecture stays: a first page with real sentences, a later page titled «Goals», a procedure written as «Identify… Explain…», a sentence that cites a person.
const fs = require('fs'); const assert = require('assert'); const SRC = fs.readFileSync(__dirname + '/../../shared/api-core.js', 'utf8');
const clean = (t) => t.replace(/\n{3,}/g, '\n\n').trim(); eval(SRC.slice(SRC.indexOf('const boilKey'), SRC.indexOf('// ---- SCANNED pages')) + '; global.__fm = frontMatter;');
const doc = (texts) => texts.map((text, i) => ({ page_no: i + 1, text }));
const run = (texts) => { const pages = doc(texts); const fm = global.__fm(pages); return { fm: Object.fromEntries(fm), pages }; };

// 1) a typical deck: cover with the lecturer, objectives, content, a page titled «Goals» (content), a procedure, the closing slide
let r = run(['Microbial Mechanism of Pathogenicity\nLecture 3\nDr. Ahmed Ali\nCollege of Nursing',
  'Objectives:\nAt the end of this lecture the students will be able to:\nDescribe microbial growth\nExplain the chain of infection',
  'Microbial Growth\nIt refers to an increase in cell number, not in cell size.\nTemperature and pH are physical requirements of growth.\nDr. Ahmed Ali - Microbiology 2026',
  'Goals\nPatient goals are broad statements of the desired change in the patient.\nShort-term goals are achieved within a week.',
  'Hand Hygiene Procedure\nIdentify the patient using two identifiers\nExplain the procedure to the patient\nPerform hand hygiene before touching the patient',
  'Florence Nightingale is regarded as the founder of modern nursing and she improved sanitation in hospitals.',
  'Thank you']);
assert.deepStrictEqual(r.fm, { 1: 'cover', 2: 'objectives', 7: 'closing' }, 'cover, objectives and closing only: ' + JSON.stringify(r.fm));
assert(!/Dr\. Ahmed/.test(r.pages[2].text) && /increase in cell number/.test(r.pages[2].text), 'the lecturer line inside a content page is removed, the content stays');
assert(/Florence Nightingale/.test(r.pages[5].text), 'a sentence that cites a person is content');
console.log('1) cover, objectives, closing excluded; «Goals» page, a procedure and a sentence about a person kept; the lecturer line removed from a content page');

// 2) a first page that IS content is not a cover; a whole document is never excluded
r = run(['The plasma membrane separates the cell from its surroundings. It is made mainly of phospholipids and proteins. The membrane controls which substances enter and leave the cell.', 'Osmosis is the movement of water across a membrane.']);
assert.deepStrictEqual(r.fm, {}, 'a first page with sentences is content'); r = run(['Thank you']); assert.deepStrictEqual(r.fm, {}, 'never the whole document');
console.log('2) a first page of sentences is content; a one-page file is never emptied');

// 3) Arabic: the title with «الأهداف», an Arabic closing; a book cover; an outline page
r = run(['المحاضرة الثالثة: غشاء الخلية\nالأهداف\n• وصف تركيب الغشاء البلازمي\n• المقارنة بين النقل السلبي والنشط', 'وظائف الغشاء\nالغشاء حاجز بين الخلية والبيئة المحيطة ويتحكم في مرور المواد.', 'شكرًا']);
assert.deepStrictEqual(r.fm, { 1: 'objectives', 3: 'closing' }, 'Arabic objectives and closing: ' + JSON.stringify(r.fm));
r = run(['Book cover for Fundamentals of Nursing Care: Concepts, Connections & Skills, Fourth Edition.\nChapter 4\nThe Nursing Process: Critical Thinking, Decision Making, and Clinical Judgment', 'OUT LINE\nMICROBIAL GROWTH\nCHAIN OF INFECTION', 'The nursing process is a framework for decision making in nursing.']);
assert.deepStrictEqual(r.fm, { 1: 'cover', 2: 'objectives' }, 'a book cover and an outline: ' + JSON.stringify(r.fm));
console.log('3) Arabic objectives and closing, a book cover, an outline');

// 4) talk to the CLASS is not lecture content: a «CLASS CHECK POINT'S» slide (coffee, logging in, taking notes) is left out wherever it is; a stray line of it on a
//    content slide is dropped; a lecture that MENTIONS coffee, a camera, attendance or «Mic.» (microbial) keeps every line
r = run(['Muscle and Nerve\nLecture 5\nDr. Sara Ahmed', "CLASS CHECK POINT’S\n1. Good Morning :)\n2. CHECK you had your morning coffee :)\n3. CHECK and make sure you are logged in with FIRST NAME\n4. CHECK and make sure you are logged in with your ID\n5. CHECK and make sure you are taking notes\nDo Not be afraid to ask Questions by typing in the Chat!",
  'Skeletal Muscle\nSkeletal muscle is attached to bones by tendons.\nIt is under voluntary control.\nDo Not be afraid to ask Questions by typing in the Chat!',
  'Caffeine\nCoffee contains caffeine, which blocks adenosine receptors.\nA gamma camera detects the radiation emitted by the tracer.\nClinic attendance improves blood pressure control.',
  'B- Chemical requirements of Mic. Growth\nCarbon makes up 50% of the dry weight of the cell.\nNitrogen is needed for protein synthesis.']);
assert.strictEqual(r.fm[2], 'housekeeping', 'the class check points slide: ' + JSON.stringify(r.fm)); assert(!r.fm[3] && !r.fm[4] && !r.fm[5], 'content slides stay');
assert(!/afraid to ask/.test(r.pages[2].text) && /voluntary control/.test(r.pages[2].text), 'the stray line goes, the content stays: ' + r.pages[2].text);
assert.strictEqual(r.pages[3].text.split('\n').length, 4, 'coffee / camera / attendance as SUBJECT matter stay'); assert(/Mic\. Growth/.test(r.pages[4].text), '«Mic.» is not a microphone');
console.log('4) a «CLASS CHECK POINT’S» slide left out; a stray «ask in the chat» line dropped; coffee / camera / attendance / «Mic.» as subject matter kept');

// 5) text READ FROM A PICTURE is not a source when the file has its own slide text; a file that is all pictures (a scanned lecture) keeps it
const metas = (ocr, native) => Array.from({ length: ocr + native }, (_, i) => ({ page_no: i + 1, status: 'ok', ...(i < ocr ? { ocr: 80 } : {}) }));
assert.deepStrictEqual([...imageTextPages(metas(2, 30))], [1, 2], 'two picture pages in a text deck are left out');
assert.deepStrictEqual([...imageTextPages(metas(12, 0))], [], 'a scanned lecture keeps its recognised text');
console.log('5) recognised picture text: left out of a text deck, kept for a scanned lecture');

// 6) a bullet drawn with a symbol font (a private-use character, shown as an empty box «□ The blood is…») becomes a plain bullet
eval(SRC.slice(SRC.indexOf('const fixGlyphs'), SRC.indexOf('const clean =')).replace('const fixGlyphs', 'global.__fg'));
assert.strictEqual(global.__fg('The Nephron\n The blood is collected into a renal vein.\nBlood is drained into veins.'), 'The Nephron\n• The blood is collected into a renal vein.\n• Blood is drained into veins.');
console.log('6) symbol-font bullets -> «•» (no empty box in a question)');
console.log('front matter tests ok');
