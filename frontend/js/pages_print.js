import { h, api, num, typeset, dirOf, fill } from './core.js';

const LET = ['A', 'B', 'C', 'D'];

/* The quiz as paper, laid out exactly like the owner's template (Layout_of_quiz.pdf, US Letter):
 *  - question pages: the lecture's title centred at the top over a thin rule; about eight questions a page («1.» bold, «A.»-«D.» indented, Times);
 *    at the foot of each page an «ANSWER KEY» strip with one numbered box per question on that page (for the student's answers);
 *  - with the key: «Correction Sheet» pages, 25 rows each - Q, ANS, SLIDE, KEY POINT FROM LECTURE (the lecture's own sentence) - and «1/2» page numbers.
 * The browser lays out Arabic and mixed text itself, so this page is printed (or, in the Claude edition, rendered to a PDF file). */
export async function printPage(id) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  let withKey = q.get('key') !== '0';
  const [quiz, qs] = await Promise.all([api('GET', `/api/quizzes/${id}`), api('GET', `/api/quizzes/${id}/questions`)]);
  const keyLetters = qs.map((x) => LET[x.options.findIndex((o) => o.id === x.correct_option_id)]);
  const root = h('div', { class: 'printdoc' }); const sheets = h('div', { class: 'sheets', dir: 'ltr' }); const status = h('div', { class: 'noprint', role: 'status', 'aria-live': 'polite' });

  // eight a page, the extra spread over the last pages (50 -> 8 8 8 8 9 9, as in the template); a page whose questions are too long hands its last one on
  const plan = (n) => { const pages = Math.max(1, Math.round(n / 8)); const base = Math.floor(n / pages), extra = n % pages; const out = []; let i = 0;
    for (let p = 0; p < pages; p++) { const k = base + (p >= pages - extra ? 1 : 0); out.push(Array.from({ length: k }, (_, j) => i + j)); i += k; } return out; };
  const question = (x, i) => h('section', { class: 'pq' },
    h('div', { class: 'pstem' }, h('span', { class: 'pnum' }, `${i + 1}.`), x.stem ? h('span', { class: 'ptext', dir: dirOf(x.stem) }, x.stem) : null),
    h('div', { class: 'popts' }, x.options.map((o, k) => h('div', { class: 'popt' }, h('span', { class: 'plet' }, LET[k] + '.'), h('span', { class: 'ptext', dir: dirOf(o.text) }, o.text)))));
  const strip = (idx) => h('div', { class: 'pstrip' }, h('span', { class: 'ppill' }, 'ANSWER KEY'),
    h('div', { class: 'pboxes' }, idx.map((i) => h('div', { class: 'pbox' }, h('span', {}, String(i + 1)), h('i', {})))));
  const qpage = (idx, first) => h('div', { class: 'sheet qsheet' },
    first ? [h('h1', { class: 'ptitle', dir: dirOf(quiz.title) }, quiz.title), h('div', { class: 'prule' })] : h('div', { class: 'ptop' }),
    h('div', { class: 'parea' }, idx.map((i) => question(qs[i], i))), strip(idx));
  const keyPoint = (x) => { const ev = (x.evidence || [])[0] || {}; const t = String(ev.quote || x.explanation || '').replace(/\s+/g, ' ').trim(); return t; };
  const cpages = () => { const out = []; for (let s = 0; s < qs.length; s += 25) out.push(qs.slice(s, s + 25).map((x, j) => s + j)); return out; };
  const cpage = (idx, n, total) => h('div', { class: 'sheet csheet' },
    h('div', { class: 'ccard' }, h('h2', {}, 'Correction Sheet'), h('span', {}, `Questions ${idx[0] + 1}-${idx[idx.length - 1] + 1}`)),
    h('table', { class: 'pcorr' }, h('thead', {}, h('tr', {}, h('th', {}, 'Q'), h('th', {}, 'ANS'), h('th', {}, 'SLIDE'), h('th', {}, 'KEY POINT FROM LECTURE'))),
      h('tbody', {}, idx.map((i) => { const x = qs[i]; const kp = keyPoint(x);
        return h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, keyLetters[i] || ''), h('td', {}, x.source_pages && x.source_pages.length ? x.source_pages.join(', ') : ''), h('td', {}, kp ? h('div', { class: 'kp', dir: dirOf(kp) }, kp) : null)); }))),
    h('div', { class: 'pnumr' }, `${n}/${total}`));

  let pages = plan(qs.length);
  function draw() {
    const cp = withKey ? cpages() : [];
    fill(sheets, pages.map((idx, p) => qpage(idx, p === 0)), cp.map((idx, k) => cpage(idx, k + 1, cp.length)));
    typeset(sheets); fit();
  }
  // a question page that overflows (long stems) hands its last question to the next page - measured once the sheets are on screen
  function reflow() {
    let moved = false; const list = [...sheets.querySelectorAll('.qsheet')];
    list.forEach((el, p) => { const area = el.querySelector('.parea'); if (area && area.scrollHeight > area.clientHeight + 1 && pages[p].length > 1) { const last = pages[p].pop(); if (!pages[p + 1]) pages.push([]); pages[p + 1].unshift(last); moved = true; } });
    return moved;
  }
  function settle() { for (let k = 0; k < 60 && document.body.contains(sheets) && reflow(); k++) draw(); }
  // on screen the Letter-size sheets are scaled to the width available (a phone shows whole pages); print uses their real size
  function fit() { const w = root.clientWidth || 816; sheets.style.setProperty('--zoom', String(Math.min(1, w / 816))); }
  addEventListener('resize', fit);

  // the Claude edition saves a real PDF file through claude.ai (the `downloads` capability); the site prints («Save as PDF»)
  let downloads = null;      // resolved after the page is drawn (claude.ai may take a moment to answer, or never: the site prints)
  async function makePdf(btn) {
    btn.disabled = true; fill(status, h('div', { class: 'alert info' }, 'جارٍ تجهيز ملف PDF…'));
    try {
      const load = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('تعذّر تحميل أداة PDF.')); document.head.append(s); });
      if (!window.html2canvas) await load('./html2canvas.min.js');      // shipped with the Claude edition (no request leaves claude.ai for it)
      if (!window.jspdf) await load('./jspdf.umd.min.js');
      sheets.classList.add('rendering'); const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
      const list = [...sheets.querySelectorAll('.sheet')];
      for (let i = 0; i < list.length; i++) { const c = await window.html2canvas(list[i], { scale: 2, backgroundColor: '#ffffff', useCORS: true }); if (i) doc.addPage('letter'); doc.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 612, 792); }
      sheets.classList.remove('rendering');
      const name = (String(quiz.title || 'quiz').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'quiz') + (withKey ? ' - with key' : '') + '.pdf';
      await downloads.save({ filename: name, data: doc.output('blob') }); fill(status, h('div', { class: 'alert ok' }, 'تم حفظ الملف.'));
    } catch (e) { sheets.classList.remove('rendering'); fill(status, e && e.code === 'declined' ? null : h('div', { class: 'alert warn' }, (e && e.message) || 'تعذّر إنشاء الملف.')); }
    finally { btn.disabled = false; }
  }
  const keyToggle = h('label', { class: 'row', style: 'cursor:pointer;margin:0' }, h('input', { type: 'checkbox', checked: withKey, style: 'width:20px;height:20px', onchange: (e) => { withKey = e.target.checked; draw(); } }), 'مع ورقة التصحيح (Correction Sheet)');
  const dlSlot = h('span', { style: 'display:contents' }); const printBtn = h('button', { class: 'btn primary', onclick: () => window.print() }, '🖨 طباعة / حفظ PDF');
  const hint = h('div', { class: 'noprint small muted', style: 'margin-bottom:1rem' }, 'في نافذة الطباعة اختر «حفظ كـ PDF» كوجهة، والمقاس Letter، وأوقف «الرؤوس والتذييلات» إن ظهرت.');
  fill(root,
    h('div', { class: 'noprint row between', style: 'margin-bottom:1rem' },
      h('div', { class: 'row' }, dlSlot, printBtn, keyToggle),
      h('a', { class: 'btn', href: `#/quiz/${id}` }, '← رجوع')),
    hint,
    quiz.generator === 'test-generator' ? h('div', { class: 'alert warn noprint' }, 'محتوى اختباري: ولّده المولّد التجريبي.') : null,
    status, sheets);
  draw();
  requestAnimationFrame(() => requestAnimationFrame(() => { settle(); fit(); }));
  if (typeof window !== 'undefined' && window.claude && window.claude.use) window.claude.use('downloads').then((d) => { if (!d) return; downloads = d;
    fill(dlSlot, h('button', { class: 'btn primary', id: 'save-pdf', onclick: (e) => makePdf(e.currentTarget) }, '⬇ تنزيل PDF')); printBtn.className = 'btn';
    fill(hint, 'زر «تنزيل PDF» يحفظ الملف مباشرة بنفس تصميم القالب.'); }).catch(() => { /* the site prints */ });
  return root;
}
