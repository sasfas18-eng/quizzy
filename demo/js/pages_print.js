import { h, api, num, typeset, dirOf, fill } from './core.js?v=e62c4542da';

const LET = ['A', 'B', 'C', 'D'];

/** Print-friendly quiz (use the browser's "Save as PDF"): the browser shapes Arabic and mixes Latin terms correctly. */
export async function printPage(id) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  let withKey = q.get('key') !== '0';
  const [quiz, qs] = await Promise.all([api('GET', `/api/quizzes/${id}`), api('GET', `/api/quizzes/${id}/questions`)]);
  const root = h('div', { class: 'printdoc' });
  function draw() {
    const keyLetters = qs.map((x) => LET[x.options.findIndex((o) => o.id === x.correct_option_id)]);
    fill(root,
      h('div', { class: 'noprint row between', style: 'margin-bottom:1rem' },
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => window.print() }, '🖨 طباعة / حفظ PDF'), h('label', { class: 'row', style: 'cursor:pointer;margin:0' }, h('input', { type: 'checkbox', checked: withKey, style: 'width:20px;height:20px', onchange: (e) => { withKey = e.target.checked; draw(); } }), 'مع مفتاح الإجابة والتفسير')),
        h('a', { class: 'btn', href: `#/quiz/${id}` }, '← رجوع')),
      h('div', { class: 'noprint small muted', style: 'margin-bottom:1rem' }, 'في نافذة الطباعة اختر «حفظ كـ PDF» كوجهة، وأوقف «الرؤوس والتذييلات» إن ظهرت.'),
      quiz.generator === 'test-generator' ? h('div', { class: 'alert warn' }, 'محتوى اختباري: ولّده المولّد التجريبي.') : null,
      h('h1', { class: 'ptitle', dir: dirOf(quiz.title) }, quiz.title),
      h('div', { class: 'pmeta' }, `${num(qs.length)} سؤال · درجة واحدة لكل إجابة صحيحة، بلا خصم على الخطأ`),
      h('div', { class: 'pname' }, 'الاسم: ____________________        التاريخ: ____ / ____ / ________'),
      qs.map((x, i) => h('section', { class: 'pq' },
        h('div', { class: 'pstem', dir: dirOf(x.stem) }, h('span', { class: 'pnum' }, `${i + 1}.`), ' ', x.stem),
        h('div', { class: 'popts' }, x.options.map((o, k) => h('div', { class: 'popt', dir: dirOf(o.text) }, h('span', { class: 'plet' }, LET[k] + '.'), ' ', o.text))))),
      withKey ? h('section', { class: 'pkey' }, h('h2', {}, 'مفتاح الإجابة (Answer Key)'),
        h('div', { class: 'pgrid', dir: 'ltr' }, keyLetters.map((l, i) => h('span', {}, `${i + 1}: `, h('strong', {}, l)))),
        h('h3', {}, 'التفسير'), qs.map((x, i) => h('div', { class: 'pexp', dir: dirOf(x.explanation) }, h('strong', {}, `${i + 1} (${keyLetters[i]}) `), x.explanation, x.source_pages && x.source_pages.length ? h('span', { class: 'muted' }, `  [ص ${x.source_pages.join('، ')}]`) : null))) : null);
    typeset(root);
  }
  draw();
  return root;
}
