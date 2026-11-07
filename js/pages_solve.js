import { h, api, state, fill, dirOf, toast, modal, confirmDialog, saveRemote, typeset, num, arQ, pct, fmtClock, fmtDate, spinner, errorBox } from './core.js?v=e0e89f22f3';
import { onLeave } from './main.js?v=e0e89f22f3';
import { afterAnswer, withKey } from './fix.js?v=e0e89f22f3';
import { lang } from './i18n.js?v=e0e89f22f3';

const LET = ['A', 'B', 'C', 'D'];
const REPORT_KINDS = { wrong_key: 'الإجابة الصحيحة غير صحيحة', not_in_source: 'السؤال/التفسير غير موجود في المصدر', unclear: 'السؤال غير واضح أو ملتبس', bad_distractor: 'خيارات ضعيفة أو أكثر من إجابة', duplicate: 'مكرر', language: 'مشكلة لغوية', other: 'أخرى' };

export function reportDialog(targetType, targetId) {
  const o = { kind: 'unclear', message: '' };
  modal((close) => h('div', {}, h('h2', {}, 'الإبلاغ عن مشكلة'),
    h('div', { class: 'field' }, h('label', { for: 'rk' }, 'نوع المشكلة'), h('select', { id: 'rk', onchange: (e) => { o.kind = e.target.value; } }, Object.entries(REPORT_KINDS).map(([k, v]) => h('option', { value: k }, v)))),
    h('div', { class: 'field' }, h('label', { for: 'rm' }, 'تفاصيل (اختياري)'), h('textarea', { id: 'rm', maxlength: 1000, oninput: (e) => { o.message = e.target.value; } })),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const r = await api('POST', '/api/reports', { target_type: targetType, target_id: targetId, kind: o.kind, message: o.message }); toast(r.duplicate ? 'بلاغك السابق ما زال قيد المراجعة' : 'وصلنا بلاغك. شكرًا', 'ok'); close(); } catch (e) { toast(e.message, 'bad'); } } }, 'إرسال'), h('button', { class: 'btn', onclick: close }, 'إلغاء'))));
}

function evidenceBlock(q, key) {
  const ev = (q.evidence || [])[0]; const pages = q.source_pages?.length ? q.source_pages.map(num).join('، ') : '';
  if (!ev && !pages) return null;
  // "from your lecture": the line the question was taken from, highlighted like on the student's own paper
  return h('div', { class: 'evidence' }, h('span', { class: 'src' }, `من محاضرتك${pages ? ' · ص ' + pages : ''}`),
    ev ? h('blockquote', { dir: dirOf(ev.quote) }, h('span', {}, '«', withKey(ev.quote, key), '»')) : null,
    ev && ev.doc_title ? h('div', { class: 'doc', dir: lang() === 'en' ? 'ltr' : 'rtl', 'data-ui': '' }, `${ev.doc_title} — ص${num(ev.page_no || ev.page)}`) : null);
}

export async function attemptPage(id) {
  let a = await api('GET', `/api/attempts/${id}`);
  if (a.status === 'submitted') { location.hash = `#/attempt/${id}/result`; return null; }
  let idx = Math.min(a.current_index, a.total - 1);
  let elapsed = a.elapsed_seconds;
  let remaining = a.time.remaining;
  const practice = a.mode === 'practice';
  const root = h('div', {});
  const clockEl = h('span', { class: 'timer', 'aria-live': 'off' });
  let tick = setInterval(() => {
    elapsed += 1;
    if (remaining != null && !practice) {
      remaining -= 1; clockEl.textContent = '⏱ ' + fmtClock(remaining); clockEl.classList.toggle('low', remaining < 60);
      if (remaining <= 0) { clearInterval(tick); autoSubmit(); }
    } else if (a.time.limit && practice) { clockEl.textContent = '⏱ ' + fmtClock(Math.max(0, a.time.limit - elapsed)); }
    else clockEl.textContent = '⏱ ' + fmtClock(elapsed);
    if (elapsed % 20 === 0) saveRemote('pos', () => api('PUT', `/api/attempts/${id}/position`, { index: idx, elapsed_seconds: elapsed })).catch(() => {});
  }, 1000);
  const keyh = (e) => {
    if (e.target.matches('input,textarea,select') || document.querySelector('.modal')) return;
    const q = a.questions[idx];
    const k = e.key.toLowerCase();
    const n = '1234'.indexOf(k) >= 0 ? '1234'.indexOf(k) : 'abcd'.indexOf(k);
    if (e.key.length === 1 && n >= 0 && q.options[n]) choose(q, q.options[n].id);
    else if (e.key === 'ArrowLeft') go(idx + 1); else if (e.key === 'ArrowRight') go(idx - 1);
  };
  document.addEventListener('keydown', keyh);
  onLeave(() => { clearInterval(tick); document.removeEventListener('keydown', keyh); saveRemote('pos', () => api('PUT', `/api/attempts/${id}/position`, { index: idx, elapsed_seconds: elapsed })).catch(() => {}); });

  // the time on the result is the time spent: saved right before submitting (it was saved every 20 seconds, so the result could show 00:40 for a full minute)
  const saveTime = () => api('PUT', `/api/attempts/${id}/position`, { index: idx, elapsed_seconds: elapsed }).catch(() => {});
  async function autoSubmit() {
    toast('انتهى الوقت — يجري التسليم', 'bad');
    try { await saveTime(); await api('POST', `/api/attempts/${id}/submit`); } catch (_) { /* ignore */ }
    location.hash = `#/attempt/${id}/result`;
  }
  function go(i) {
    if (i < 0 || i >= a.total) return;
    idx = i; draw();
    saveRemote('pos', () => api('PUT', `/api/attempts/${id}/position`, { index: idx, elapsed_seconds: elapsed })).catch(() => {});
  }
  async function choose(q, optId) {
    if (q.correct_option_id && practice) return; // revealed & locked
    const prev = q.selected_option_id;
    q.selected_option_id = optId; draw();
    try {
      const r = await saveRemote(`ans:${q.id}`, () => api('PUT', `/api/attempts/${id}/answer`, { question_id: q.id, option_id: optId }));
      if (practice && r.correct_option_id) { Object.assign(q, { correct_option_id: r.correct_option_id, explanation: r.explanation, is_correct: r.is_correct, evidence: r.evidence, source_pages: r.source_pages }); }
      q.answered = true; a.answered = a.questions.filter((x) => x.answered).length; draw();
    } catch (e) {
      if (practice || [404, 409, 422].includes(e.status)) { q.selected_option_id = prev; toast(e.message, 'bad'); draw(); if (e.code === 'time_up' || e.code === 'already_submitted') location.hash = `#/attempt/${id}/result`; }
      else { q.answered = true; draw(); }
    }
  }
  async function toggleFlag(q) {
    q.flagged = !q.flagged; draw();
    try { await saveRemote(`flag:${q.id}`, () => api('PUT', `/api/attempts/${id}/answer`, { question_id: q.id, flagged: q.flagged })); } catch (_) { /* queued */ }
  }
  async function submit() {
    const un = a.questions.filter((q) => !q.answered).length, fl = a.questions.filter((q) => q.flagged).length;
    const ok = await confirmDialog('تسليم المحاولة؟', `${un ? `لديك ${num(un)} سؤالًا بلا إجابة (تُحتسب صفرًا). ` : 'أجبت عن كل الأسئلة. '}${fl ? `و${num(fl)} سؤالًا معلّمًا للمراجعة. ` : ''}بعد التسليم لا يمكن تعديل الإجابات.`, 'سلّم الآن');
    if (!ok) return;
    try { await saveTime(); await saveRemote('submit', () => api('POST', `/api/attempts/${id}/submit`)); clearInterval(tick); location.hash = `#/attempt/${id}/result`; }
    catch (e) { toast(e.message, 'bad'); }
  }
  function draw() {
    const q = a.questions[idx];
    const revealed = practice && q.correct_option_id;
    const stem = h('div', { class: 'stem', dir: dirOf(q.stem) }, q.stem);
    const opts = h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'الخيارات' }, q.options.map((o, i) => {
      let cls = 'opt';
      if (revealed) { if (o.id === q.correct_option_id) cls += ' right'; else if (o.id === q.selected_option_id) cls += ' wrong'; } else if (o.id === q.selected_option_id) cls += ' sel';
      return h('button', { type: 'button', dir: dirOf(o.text), class: cls, role: 'radio', 'aria-checked': String(o.id === q.selected_option_id), disabled: !!revealed, onclick: () => choose(q, o.id) },
        h('span', { class: 'let' }, LET[i]), h('span', { class: 'txt' }, o.text));
    }));
    const pal = h('div', { class: 'palette' }, a.questions.map((x, i) => {
      let cls = 'pal'; if (x.answered) cls += ' done'; if (x.flagged) cls += ' flag'; if (i === idx) cls += ' cur';
      if (practice && x.correct_option_id) cls += x.is_correct ? ' right' : ' wrong';
      return h('button', { type: 'button', class: cls, 'aria-label': `السؤال ${i + 1}${x.answered ? ' مُجاب' : ''}${x.flagged ? ' معلّم' : ''}`, onclick: () => go(i) }, String(i + 1));
    }));
    const nextBy = (pred) => { for (let k = 1; k <= a.total; k++) { const i = (idx + k) % a.total; if (pred(a.questions[i])) return go(i); } toast('لا يوجد'); };
    fill(root,
      a.generator === 'test-generator' && h('div', { class: 'alert warn' }, 'محتوى اختباري: ولّده المولّد التجريبي للتحقق من النظام وليس مولّد الإنتاج.'),
      h('div', { class: 'row between', style: 'margin-bottom:.6rem' }, h('div', {}, h('strong', { class: 'bidi' }, a.quiz_title), h('span', { class: 'badge info', style: 'margin-inline-start:.5rem' }, practice ? 'تدريب' : 'اختبار')), clockEl),
      h('div', { class: 'solve' },
        h('div', {}, h('div', { class: 'card' },
          h('div', { class: 'qhead' }, h('span', { class: 'badge info' }, `السؤال ${num(idx + 1)} من ${num(a.total)}`),
            h('span', { class: 'spacer' }), h('button', { class: 'btn small' + (q.flagged ? ' primary' : ''), 'aria-pressed': String(q.flagged), onclick: () => toggleFlag(q) }, q.flagged ? '⚑ معلّم للمراجعة' : '⚐ علّم للمراجعة')),
          stem, opts,
          revealed ? h('div', { class: 'explain', role: 'region', 'aria-label': 'التفسير' }, h('strong', { style: 'color:' + (q.is_correct ? 'var(--ok)' : 'var(--bad)') }, q.is_correct ? '✓ إجابة صحيحة' : '✗ إجابة غير صحيحة'),
            afterAnswer(q, id, evidenceBlock), h('button', { class: 'btn small ghost', onclick: () => reportDialog('question', q.id) }, '⚠ أبلغ عن مشكلة في هذا السؤال')) : null),
          h('div', { class: 'row between' }, h('button', { class: 'btn', disabled: idx === 0, onclick: () => go(idx - 1) }, '→ السابق'),
            idx === a.total - 1 ? h('button', { class: 'btn primary', onclick: submit }, 'مراجعة وتسليم') : h('button', { class: 'btn primary', onclick: () => go(idx + 1) }, 'التالي ←'))),
        h('aside', { class: 'card sticky' }, h('h3', {}, 'الأسئلة'), pal,
          h('p', { class: 'small muted' }, `أجبت ${num(a.answered)} من ${num(a.total)}`),
          h('div', { class: 'col' }, h('button', { class: 'btn small', onclick: () => nextBy((x) => !x.answered) }, 'أقرب سؤال بلا إجابة'), h('button', { class: 'btn small', onclick: () => nextBy((x) => x.flagged) }, 'أقرب سؤال معلّم'), h('button', { class: 'btn small primary', onclick: submit }, 'تسليم')))));
    typeset(root);
  }
  draw();
  if (remaining != null && !practice) clockEl.textContent = '⏱ ' + fmtClock(remaining); else clockEl.textContent = '⏱ ' + fmtClock(a.time.limit ? a.time.limit - elapsed : elapsed);
  return root;
}

export async function resultPage(id) {
  const a = await api('GET', `/api/attempts/${id}`);
  if (a.status !== 'submitted') { location.hash = `#/attempt/${id}`; return null; }
  const total = a.total, score = a.score;
  // Where to look again: the source pages behind the questions answered wrongly or left blank (the question types stay an internal matter).
  const revisit = [...new Set(a.questions.filter((q) => !q.is_correct).flatMap((q) => q.source_pages || []))].sort((x, y) => x - y);
  // which pages to read again: the ones with the most mistakes first (with the count), not a list of every page of the lecture
  const missCount = new Map(); a.questions.filter((q) => !q.is_correct).forEach((q) => [...new Set(q.source_pages || [])].forEach((n) => missCount.set(n, (missCount.get(n) || 0) + 1)));
  const topPages = [...missCount].sort((x, y) => y[1] - x[1] || x[0] - y[0]); const shown = topPages.slice(0, 6);
  const EN = lang() === 'en';
  const pageList = shown.map(([n, k]) => `${EN ? 'p.' : 'ص'}${num(n)}${k > 1 ? ` (${arQ(k)})` : ''}`).join(EN ? ', ' : '، ') + (topPages.length > shown.length ? (EN ? ` and other pages (${num(topPages.length - shown.length)})` : ` وصفحات أخرى (${num(topPages.length - shown.length)})`) : '');
  let filter = 'all';
  const list = h('div', {});
  function drawList() {
    list.replaceChildren(...a.questions.filter((q) => filter === 'all' || (filter === 'wrong' && !q.is_correct) || (filter === 'flagged' && q.flagged)).map((q) => {
      return h('div', { class: 'card' }, h('div', { class: 'qhead' }, h('span', { class: 'badge ' + (q.is_correct ? 'ok' : 'bad') }, q.is_correct ? `✓ ${num(q.position)}` : (q.answered ? `✗ ${num(q.position)}` : `— ${num(q.position)} بلا إجابة`)),
        q.flagged && h('span', { class: 'badge warn' }, '⚑ معلّم')),
        h('div', { class: 'stem', dir: dirOf(q.stem) }, q.stem),
        h('div', { class: 'opts' }, q.options.map((o, i) => h('div', { dir: dirOf(o.text), class: 'opt ' + (o.id === q.correct_option_id ? 'right' : (o.id === q.selected_option_id ? 'wrong' : '')) }, h('span', { class: 'let' }, LET[i]), h('span', { class: 'txt' }, o.text),
          o.id === q.selected_option_id && h('span', { class: 'small muted' }, 'إجابتك')))),
        h('div', { class: 'explain' }, afterAnswer(q, id, evidenceBlock), h('button', { class: 'btn small ghost', onclick: () => reportDialog('question', q.id) }, '⚠ أبلغ عن مشكلة')));
    }));
    if (!list.children.length) list.append(h('div', { class: 'empty' }, 'لا توجد عناصر في هذا العرض.'));
    typeset(list);
  }
  const chip = (k, l) => h('button', { class: 'chip-btn', 'aria-pressed': String(filter === k), onclick: (e) => { filter = k; [...e.target.parentNode.children].forEach((c) => c.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); drawList(); } }, l);
  const wrongIds = a.questions.filter((q) => !q.is_correct).map((q) => q.id);
  const rating = h('div', { class: 'row' });
  [1, 2, 3, 4, 5].forEach((n) => rating.append(h('button', { class: 'btn small', 'aria-label': `${n} من 5`, onclick: async () => { try { await api('POST', '/api/events', { kind: 'quiz_rating', value: n, ref: a.quiz_id }); rating.replaceChildren(h('span', { class: 'badge ok' }, 'شكرًا لتقييمك')); } catch (e) { toast(e.message, 'bad'); } } }, '★'.repeat(n))));
  const root = h('div', {},
    a.generator === 'test-generator' && h('div', { class: 'alert warn' }, 'محتوى اختباري: ولّده المولّد التجريبي ولا يعكس جودة الإنتاج.'),
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('div', {}, h('h1', {}, 'نتيجتك'), h('div', { class: 'muted bidi' }, a.quiz_title)),
      h('div', { class: 'center' }, h('div', { class: 'stat', style: 'font-size:2.6rem' }, `${num(score)} / ${num(total)}`), h('div', { class: 'stat-l' }, `${pct(score, total)} · ${a.mode === 'exam' ? 'اختبار' : 'تدريب'} · ${fmtClock(a.elapsed_seconds)}`))),
      h('p', { class: 'small muted' }, a.scoring.text),
      revisit.length ? h('div', { class: 'alert info', id: 'revisit' }, h('strong', {}, topPages.length > 1 ? 'ابدأ مراجعتك بهذه الصفحات من المصدر: ' : 'راجع هذه الصفحة من المصدر: '), pageList) : h('div', { class: 'alert ok' }, 'أجبت عن كل الأسئلة إجابة صحيحة. أحسنت!'),
      h('div', { class: 'row', style: 'margin-top:1rem' }, wrongIds.length ? h('button', { class: 'btn primary', onclick: async () => { const n = await api('POST', `/api/quizzes/${a.quiz_id}/attempts`, { mode: 'practice', only_question_ids: wrongIds }); location.hash = `#/attempt/${n.id}`; } }, `أعد حل الأخطاء (${num(wrongIds.length)})`) : null,
        h('a', { class: 'btn', href: `#/quiz/${a.quiz_id}` }, 'صفحة الكويز'), h('a', { class: 'btn', href: `/api/quizzes/${a.quiz_id}/pdf?answer_key=true`, download: '' }, '⬇ PDF'))),
    h('div', { class: 'card' }, h('strong', {}, 'هل كانت الأسئلة واضحة ومفيدة؟'), rating),
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'مراجعة الإجابات'), h('div', { class: 'chips' }, chip('all', 'الكل'), chip('wrong', 'الأخطاء وغير المجابة'), chip('flagged', 'المعلّمة'))), list);
  drawList();
  return root;
}
