import { h, api, state, fill, toast, confirmDialog, modal, emptyState, num, arQ, pct, fmtDate, spinner, errorBox, ico, ring, REVIEW_AR } from './core.js';
import { onLeave, quizList } from './main.js';
import { startCard } from './start.js';
import { aiConnectCard } from './pages_settings.js';

export async function quizzesPage() {
  const list = await api('GET', '/api/quizzes');
  return h('div', {}, h('div', { class: 'pagehead' }, h('h1', {}, 'كويزاتي'), h('a', { class: 'btn primary', href: '#/new' }, '＋ كويز جديد')),
    list.length ? quizList(list) : h('div', { class: 'card' }, emptyState('📝', 'لا توجد كويزات بعد', 'ارفع لكتشرًا وسننشئ لك أول كويز.', h('a', { class: 'btn primary', href: '#/new' }, 'كويز جديد'))));
}

export async function newQuizPage() {
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('doc');
  return h('div', {}, h('div', { class: 'pagehead' }, h('div', {}, h('h1', {}, 'كويز جديد'), h('div', { class: 'muted' }, 'اختر لكتشرًا واضغط إنشاء — الباقي علينا.'))), h('section', { class: 'hero2', style: 'padding-top:1.4rem' }, startCard({ preset })));
}

// stage -> how far along (the three steps shown to the student)
const STEP_OF = { queued: 0, reading_source: 0, analyzing_lecture: 1, planned: 1, drafting: 2, retrying: 2, topup: 2, finalizing: 2, done: 2 };
const STEPS = ['نقرأ المحاضرة', 'نفهم محاورها', 'نكتب الأسئلة ونتحقق منها'];
const STAGES = { queued: 'في الانتظار…', reading_source: 'نقرأ المحاضرة…', analyzing_lecture: 'نفهم محاورها ونقسمها إلى أفكار…', planned: 'نجهّز الأسئلة…', drafting: 'نصوغ الأسئلة ونتحقق من كل واحد منها…', retrying: 'نعيد صياغة ما يحتاج تحسينًا…', topup: 'نستكمل تغطية المحاضرة كلها…', finalizing: 'نعتمد النسخة النهائية…', done: 'اكتمل' };

export async function quizPage(id) {
  const root = h('div', {});
  let timer = null, autoStarted = false;
  onLeave(() => clearTimeout(timer));
  async function draw() {
    const q = await api('GET', `/api/quizzes/${id}`);
    fill(root, h('div', { class: 'pagehead' }, h('div', {}, h('h1', { class: 'bidi' }, q.title), q.generator === 'test-generator' && h('span', { class: 'badge test' }, 'محتوى اختباري — مولّد تجريبي وليس مولّد الإنتاج')),
      h('div', { class: 'row' }, h('a', { class: 'btn small ghost', href: '#/quizzes' }, 'كل الكويزات'), h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف الكويز؟', 'ستُحذف أسئلته ومحاولاته.', 'حذف', true)) { await api('DELETE', `/api/quizzes/${id}`); location.hash = '#/quizzes'; } } }, 'حذف'))), view(q));
    if (['analyzing', 'generating'].includes(q.status)) timer = setTimeout(() => draw().catch(() => {}), 1500);
  }
  function view(q) {
    if (q.status === 'draft') return draftView(q);
    if (['analyzing', 'generating'].includes(q.status)) return progressView(q);
    if (q.status === 'planned') {
      // A plan nobody has to confirm: carry on to generation.
      if (q.plan && q.plan.feasible_count > 0) { if (!autoStarted) { autoStarted = true; start('generate', { accept_reduced: true }); } return progressView({ ...q, progress: { stage: 'drafting', pct: 5 } }); }
      return failureView(q);
    }
    if (q.status === 'ready') return readyView(q);
    return failureView(q);
  }
  async function start(what, body) {
    try { await api('POST', `/api/quizzes/${id}/${what}`, body || {}); await draw(); }
    catch (e) {
      if (e.code === 'llm_not_configured') { state.caps = { ...state.caps, claude_ok: false }; await draw(); return; }
      root.prepend(errorBox(e));
    }
  }
  const retry = (q) => (q.plan && q.plan.feasible_count > 0 ? start('generate', { accept_reduced: true }) : start('analyze', { auto_generate: true }));
  const noAI = () => state.caps?.claude_ok === false;

  function draftView() {
    return h('div', { class: 'card' }, h('h2', {}, 'لم يبدأ توليد هذا الكويز'),
      noAI() ? aiConnectCard(() => draw()) : h('p', { class: 'muted' }, 'اضغط ابدأ ليقرأ «كويزي» الملف ويكتب الأسئلة ويتحقق منها.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary big', disabled: noAI(), onclick: () => start('analyze', { auto_generate: true }) }, 'ابدأ التوليد'), h('a', { class: 'btn', href: '#/new' }, 'كويز جديد')));
  }
  function progressView(q) {
    const browserRun = !!state.caps?.edition;      // browser editions run the job inside this page; the server edition keeps going on its own
    const cur = STEP_OF[q.progress.stage] ?? (q.status === 'analyzing' ? 1 : 2);
    return h('div', { class: 'card stage-card', role: 'status' }, h('div', { class: 'orb', 'aria-hidden': 'true' }), h('h2', {}, 'نجهّز كويزك…'),
      h('div', { class: 'progress', style: 'max-width:420px;margin:.8rem auto', role: 'progressbar', 'aria-valuenow': q.progress.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${Math.max(6, q.progress.pct)}%` })),
      h('p', { class: 'muted', id: 'stage' }, STAGES[q.progress.stage] || q.progress.stage || ''),
      h('div', { class: 'stages' }, STEPS.map((t, i) => h('span', { class: 'stage ' + (i < cur ? 'done' : i === cur ? 'now' : '') }, i < cur ? '✓ ' : '', t))),
      h('p', { class: 'small muted', style: 'margin-top:1.1rem' }, browserRun ? 'تستغرق عادةً من دقيقة إلى بضع دقائق. أبقِ هذه الصفحة مفتوحة حتى تنتهي.' : 'يمكنك مغادرة الصفحة؛ المعالجة تستمر على الخادم وستجدها في «كويزاتي».'));
  }
  function failureView(q) {
    const msg = q.error || (q.plan && !q.plan.feasible_count ? 'المحتوى في هذا النطاق لا يكفي لأي سؤال موثّق بالمصدر.' : 'سبب غير معروف');
    const src = q.settings && q.settings.sources && q.settings.sources[0]; const soft = q.status === 'insufficient' || q.status === 'planned';
    return h('div', {}, h('div', { class: 'alert ' + (soft ? 'warn' : 'bad') }, h('strong', {}, soft ? 'المصدر لا يكفي: ' : 'تعذّر إكمال الكويز: '), msg),
      noAI() ? aiConnectCard(() => draw()) : null,
      h('div', { class: 'card' }, h('h3', {}, 'ماذا تفعل الآن؟'), h('ul', {},
        h('li', {}, 'أعد المحاولة — قد يكون السبب مؤقتًا (ازدحام أو حدّ استخدام عند مزوّد الذكاء الاصطناعي). ', h('button', { class: 'btn small primary', id: 'retry', disabled: noAI(), onclick: () => retry(q) }, 'إعادة المحاولة')),
        h('li', {}, 'وسّع نطاق الصفحات أو أضف ملفًا آخر. ', h('a', { class: 'btn small', href: src ? `#/new?doc=${src.document_id}` : '#/new' }, 'تعديل الطلب')),
        h('li', {}, 'تأكد أن الملف يحوي نصًا حقيقيًا: افتح الملف من «ملفاتي» وراجع نص الصفحات.'))),
      q.report && reportDetails(q.report));
  }
  /** the technical numbers, folded away: the student cares about coverage, not about how many drafts were rejected */
  function reportDetails(r) {
    const why = [...new Set((r.dropped || []).flatMap((d) => d.reasons || []))].slice(0, 8);
    return h('details', { class: 'card' }, h('summary', {}, 'تفاصيل الجودة'),
      h('p', { class: 'small muted', style: 'margin-top:.8rem' }, `صيغ ${num(r.stats.drafted)} مرشحًا؛ رُفض ${num(r.stats.rejected_validation)} بفحص الدليل والبنية، ${num(r.stats.rejected_verifier)} بالحل المستقل، ${num(r.stats.rejected_duplicate)} للتكرار الحرفي، ${num(r.stats.rejected_leak)} لتسريب إجابة. ${r.flagged ? `${num(r.flagged)} سؤالًا عليه ملاحظات بسيطة.` : ''}`),
      why.length ? h('details', {}, h('summary', {}, `محاولات لم تنجح (${num(r.dropped.length)})`), h('ul', {}, why.map((t) => h('li', { class: 'small' }, t)))) : null,
      h('p', { class: 'small muted' }, `المولّد: ${r.generator} · نسخة التعليمات ${r.prompt_version}. التحقق آلي؛ لا يعني «راجعه مختص».`));
  }
  function readyView(q) {
    const st = q.settings, r = q.report;
    const pc = r.page_coverage && r.page_coverage.denominator ? r.page_coverage : null, oc = r.objective_coverage;
    const cover = pc ? Math.round((100 * pc.numerator) / pc.denominator) : oc && oc.denominator ? Math.round((100 * oc.numerator) / oc.denominator) : 100;
    const notes = [];
    if (r.shortfall) notes.push(h('div', { class: 'alert info' }, `المحتوى قصير: سلّمنا ${arQ(r.delivered)} من ${num(r.requested)} المطلوبة حتى بعد تنويع الصياغة. لزيادة العدد أضف صفحات أو لكتشرًا آخر.`));
    if (pc && pc.missing && pc.missing.length) notes.push(h('div', { class: 'alert warn' }, h('strong', {}, 'لم نصل إلى هذه الصفحات: '), pc.missing.slice(0, 12).map((m) => `ص${num(m.page)}`).join('، '), '. قد لا يتسع كلامها لسؤال موثّق — راجعها بنفسك.'));
    if (r.uncovered_objectives && r.uncovered_objectives.length) notes.push(h('div', { class: 'alert warn' }, h('strong', {}, 'محاور تعذّر الاختبار فيها: '), r.uncovered_objectives.slice(0, 5).join('؛ ')));
    if (r.coverage_partial) notes.push(h('div', { class: 'alert info' }, 'اخترتَ عددًا أقل من محاور المحاضرة، فوزّعنا الأسئلة على المحاضرة كلها. اختر «تلقائي» لتغطية كل المحاور.'));
    return h('div', {},
      h('div', { class: 'card' }, h('div', { class: 'readyhero' }, ring(cover, `تغطية المحاضرة ${cover}%`),
        h('div', { style: 'flex:1;min-width:220px' }, h('span', { class: 'kicker' }, '✓ كويزك جاهز'), h('div', { class: 'count' }, arQ(r.delivered)),
          h('div', { class: 'muted' }, pc ? `تغطي ${num(pc.numerator)} من ${num(pc.denominator)} صفحة` + (oc ? ` · ${num(oc.numerator)} من ${num(oc.denominator)} محورًا` : '') : (oc ? `تغطي ${num(oc.numerator)} من ${num(oc.denominator)} محورًا` : '')))),
        h('p', { class: 'small muted', style: 'margin:.9rem 0 0' }, q.scoring.text), ...notes,
        h('div', { class: 'actions' }, h('button', { class: 'btn primary big', id: 'start-solve', onclick: () => startDialog(q) }, 'ابدأ الحل ←'),
          h('a', { class: 'btn', href: `#/cards?doc=${st.sources[0].document_id}` }, 'بطاقات المراجعة'), h('button', { class: 'btn', onclick: () => bank(q) }, 'بنك الأسئلة')),
        h('div', { class: 'row', style: 'margin-top:.7rem' }, h('a', { class: 'btn small ghost', href: `/api/quizzes/${q.id}/pdf?answer_key=true`, download: '' }, '⬇ PDF مع مفتاح الإجابة'), h('a', { class: 'btn small ghost', href: `/api/quizzes/${q.id}/pdf?answer_key=false`, download: '' }, '⬇ PDF بدون مفتاح'))),
      attemptsCard(q.id), reportDetails(r));
  }
  function attemptsCard(qid) {
    const box = h('div', { class: 'card' }, h('h2', {}, 'محاولاتك السابقة'), spinner());
    api('GET', `/api/attempts?quiz_id=${qid}`).then((list) => {
      fill(box, h('h2', {}, 'محاولاتك السابقة'), list.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, list.map((a) => h('tr', {}, h('td', {}, fmtDate(a.updated_at)), h('td', {}, a.mode === 'exam' ? 'اختبار' : 'تدريب'),
        h('td', {}, a.status === 'submitted' ? `${num(a.score)} / ${num(a.max_score)} (${pct(a.score, a.max_score)})` : `غير مكتملة — ${num(a.answered)}/${num(a.total)}`),
        h('td', {}, h('a', { class: 'btn small', href: a.status === 'submitted' ? `#/attempt/${a.id}/result` : `#/attempt/${a.id}` }, a.status === 'submitted' ? 'المراجعة' : 'متابعة'))))))) : h('p', { class: 'muted' }, 'لا توجد محاولات بعد.'));
    });
    return box;
  }
  /** two big, plain choices; the timer only matters for the exam */
  function startDialog(q) {
    const st = q.settings; const o = { mode: st.mode || 'practice', timer: st.timer_minutes || '' };
    modal((close) => {
      const box = h('div', {}); const modes = h('div', { class: 'modes' }); const timerBox = h('div', {});
      const mode = (m, t, d) => h('button', { type: 'button', class: 'mode', 'aria-pressed': String(o.mode === m), onclick: () => { o.mode = m; paint(); } }, h('strong', {}, t), h('span', {}, d));
      const paint = () => { fill(modes, mode('practice', 'تدريب', 'يظهر التفسير بعد كل إجابة لتتعلّم أثناء الحل.'), mode('exam', 'اختبار', 'لا يظهر شيء حتى التسليم، مع مؤقت اختياري.'));
        fill(timerBox, o.mode === 'exam' ? h('div', { class: 'field' }, h('label', {}, 'مؤقت بالدقائق (اختياري)'), h('input', { type: 'number', min: 1, value: o.timer, dir: 'ltr', style: 'max-width:160px', oninput: (e) => { o.timer = e.target.value; } })) : null); };
      paint();
      fill(box, h('h2', {}, 'كيف تريد أن تحل؟'), modes, timerBox, h('div', { class: 'row' }, h('button', { class: 'btn primary big', onclick: async () => {
        try { const a = await api('POST', `/api/quizzes/${q.id}/attempts`, { mode: o.mode, timer_minutes: o.mode === 'exam' && o.timer ? +o.timer : null, shuffle_options: st.shuffle_options !== false, shuffle_questions: false }); close(); location.hash = `#/attempt/${a.id}`; } catch (e) { toast(e.message, 'bad'); } } }, 'ابدأ'),
      h('button', { class: 'btn', onclick: close }, 'إلغاء'))); return box;
    });
  }
  async function bank(q) {
    const qs = await api('GET', `/api/quizzes/${q.id}/questions`);
    modal(h('div', {}, h('h2', {}, `بنك الأسئلة (${num(qs.length)})`), h('p', { class: 'muted small' }, 'عرض كامل مع المفتاح والدليل — للمراجعة بعد الاختبار فقط.'),
      qs.map((x) => h('div', { class: 'card flat' }, h('div', { class: 'row' }, h('span', { class: 'badge' }, REVIEW_AR[x.review_status]), h('span', { class: 'muted small' }, `ص ${x.source_pages.join('، ')}`)),
        h('div', { class: 'stem bidi' }, x.stem), x.options.map((o) => h('div', { class: 'bidi', style: o.id === x.correct_option_id ? 'color:var(--ok);font-weight:700' : '' }, (o.id === x.correct_option_id ? '✓ ' : '• ') + o.text)),
        h('div', { class: 'explain bidi' }, x.explanation, x.evidence[0] && h('blockquote', {}, `«${x.evidence[0].quote}» — ${x.evidence[0].doc_title || ''} ص${x.evidence[0].page}`)),
        h('p', { class: 'small muted' }, `الغرض: ${x.purpose} · فحوص: ${x.validation?.issues?.length ? x.validation.issues.map((i) => i.message).join('، ') : 'لا ملاحظات'}`)))), { wide: true });
  }
  await draw();
  return root;
}
