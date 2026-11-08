import { h, api, toast, modal, emptyState, num, pct, fmtDate, REVIEW_AR, TYPE_AR, typeset } from './core.js?v=fcf8247f1f';

const KIND = { wrong_key: 'مفتاح خاطئ', not_in_source: 'غير موجود بالمصدر', unclear: 'غير واضح', bad_distractor: 'خيارات ضعيفة', duplicate: 'مكرر', language: 'لغوي', bad_card: 'بطاقة سيئة', other: 'أخرى' };

export async function adminPage() {
  const tabs = ['reports', 'metrics', 'changes'];
  let tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'reports';
  const body = h('div', {});
  const bar = h('div', { class: 'chips', style: 'margin-bottom:1rem' });
  async function draw() {
    bar.replaceChildren(...tabs.map((t) => h('button', { class: 'chip-btn', 'aria-pressed': String(t === tab), onclick: () => { tab = t; draw(); } }, { reports: 'البلاغات والمحتوى', metrics: 'القياس', changes: 'سجل التعديلات' }[t])));
    body.replaceChildren(h('div', { class: 'muted' }, 'جارٍ التحميل…'));
    body.replaceChildren(await { reports, metrics, changes }[tab]());
  }
  await draw();
  return h('div', {}, h('h1', {}, 'إدارة المحتوى والبلاغات'), bar, body);
}

async function reports() {
  const list = await api('GET', '/api/admin/reports');
  if (!list.length) return h('div', { class: 'card' }, emptyState('✅', 'لا توجد بلاغات', 'ستظهر هنا بلاغات الطلاب عن الأسئلة والبطاقات.'));
  return h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['النوع', 'العنصر', 'التفاصيل', 'الحالة', 'التاريخ', ''].map((t) => h('th', {}, t)))), h('tbody', {}, list.map((r) => h('tr', {},
    h('td', {}, h('span', { class: 'badge warn' }, KIND[r.kind] || r.kind)), h('td', { class: 'bidi small', style: 'max-width:340px' }, r.target ? (r.target.stem || r.target.front || '').slice(0, 140) : '(محذوف)'), h('td', { class: 'small bidi' }, r.message),
    h('td', {}, h('span', { class: 'badge ' + (r.status === 'open' ? 'bad' : 'ok') }, r.status === 'open' ? 'مفتوح' : r.status === 'resolved' ? 'مُعالج' : 'مرفوض'), r.resolution && h('div', { class: 'small muted' }, r.resolution)), h('td', { class: 'small muted' }, fmtDate(r.created_at)),
    h('td', { class: 'row' }, r.target_type === 'question' && h('button', { class: 'btn small primary', onclick: () => editor(r.target_id) }, 'فتح السؤال'), h('button', { class: 'btn small', onclick: () => resolveDialog(r) }, 'إغلاق')))))));
}

function resolveDialog(r) {
  const o = { status: 'resolved', resolution: '' };
  modal((close) => h('div', {}, h('h2', {}, 'إغلاق البلاغ'), h('div', { class: 'field' }, h('label', {}, 'القرار'), h('select', { onchange: (e) => { o.status = e.target.value; } }, h('option', { value: 'resolved' }, 'مُعالج'), h('option', { value: 'rejected' }, 'مرفوض'), h('option', { value: 'open' }, 'إبقاؤه مفتوحًا'))),
    h('div', { class: 'field' }, h('label', {}, 'الملاحظة'), h('textarea', { oninput: (e) => { o.resolution = e.target.value; } }), h('div', { class: 'hint' }, 'ابدأها بـ «confirmed:» إن ثبت أن المفتاح خاطئ أو السؤال غير مدعوم، ليدخل في مقياس العيوب المثبتة.')),
    h('button', { class: 'btn primary', onclick: async () => { await api('PATCH', `/api/admin/reports/${r.id}`, o); close(); toast('تم', 'ok'); location.hash = '#/admin?tab=reports'; location.reload(); } }, 'حفظ')));
}

async function editor(qid) {
  const q = await api('GET', `/api/admin/questions/${qid}`);
  const o = { stem: q.stem, options: q.options.map((x) => x.text), correct: q.options.findIndex((x) => x.id === q.correct_option_id), explanation: q.explanation, reason: '' };
  modal((close) => h('div', {}, h('h2', {}, `سؤال — ${TYPE_AR[q.qtype]} (إصدار ${q.version})`),
    h('div', { class: 'row' }, h('span', { class: 'badge' }, REVIEW_AR[q.review_status]), q.reviewed_by && h('span', { class: 'small muted' }, `راجعه: ${q.reviewed_by}`), h('span', { class: 'small muted' }, `ص ${q.source_pages.join('، ')} · prompt ${q.prompt_version}`)),
    h('div', { class: 'field' }, h('label', {}, 'نص السؤال'), h('textarea', { dir: 'auto', oninput: (e) => { o.stem = e.target.value; } }, q.stem)),
    o.options.map((t, i) => h('div', { class: 'row field' }, h('input', { type: 'radio', name: 'k', checked: i === o.correct, style: 'width:20px;height:20px', 'aria-label': 'الإجابة الصحيحة', onchange: () => { o.correct = i; } }), h('input', { type: 'text', dir: 'auto', value: t, style: 'flex:1', oninput: (e) => { o.options[i] = e.target.value; } }))),
    h('div', { class: 'field' }, h('label', {}, 'التفسير'), h('textarea', { dir: 'auto', oninput: (e) => { o.explanation = e.target.value; } }, q.explanation)),
    h('div', { class: 'explain bidi' }, h('strong', {}, 'الدليل: '), (q.evidence || []).map((e) => h('div', {}, `«${e.quote}» — ص${e.page_no || e.page}`)), h('div', { class: 'small muted' }, 'فحوص: ', (q.validation?.issues || []).map((i) => i.message).join('، ') || 'لا ملاحظات')),
    h('div', { class: 'field' }, h('label', {}, 'سبب التعديل (مطلوب)'), h('input', { type: 'text', oninput: (e) => { o.reason = e.target.value; } })),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { await api('PUT', `/api/admin/questions/${qid}`, { stem: o.stem, options: o.options, correct_index: o.correct, explanation: o.explanation, reason: o.reason }); toast('حُفظ كإصدار جديد بانتظار المراجعة', 'ok'); close(); } catch (e) { toast(e.message, 'bad'); } } }, 'حفظ تعديل'),
      h('button', { class: 'btn', onclick: async () => { await api('POST', `/api/admin/questions/${qid}/review`, { decision: 'human_reviewed' }); toast('سُجّلت المراجعة البشرية', 'ok'); close(); } }, '✓ راجعتُه بشريًا'),
      h('button', { class: 'btn danger', onclick: async () => { await api('POST', `/api/admin/questions/${qid}/review`, { decision: 'rejected' }); toast('رُفض السؤال'); close(); } }, 'رفض')),
    h('h3', { style: 'margin-top:1rem' }, 'الإصدارات'), q.revisions.map((r) => h('div', { class: 'row between small', style: 'border-top:1px solid var(--line);padding:.3rem 0' }, h('span', {}, `v${r.version} — ${r.reason || ''} (${r.actor}) ${fmtDate(r.created_at)}`),
      r.version !== q.version && h('button', { class: 'btn small', onclick: async () => { await api('POST', `/api/admin/questions/${qid}/rollback`, { version: r.version }); toast('تم الرجوع (إصدار جديد)', 'ok'); close(); } }, 'ارجع إليه')))), { wide: true });
}

async function metrics() {
  const m = await api('GET', '/api/admin/metrics');
  const row = (label, c) => h('tr', {}, h('td', {}, h('strong', {}, label), h('div', { class: 'small muted' }, c.definition)), h('td', {}, c.value == null ? h('span', { class: 'muted' }, 'لا بيانات كافية') : (label.includes('تقييم') ? `${c.value} / 5` : pct(c.numerator, c.denominator))), h('td', { class: 'small' }, c.denominator != null ? `${num(c.numerator ?? 0)} من ${num(c.denominator)}` : ''), h('td', { class: 'small muted' }, c.sample));
  return h('div', {}, h('div', { class: 'alert info' }, m.note, m.excluded_test_quizzes ? ` (مستبعد: ${num(m.excluded_test_quizzes)} كويز من المولّد الاختباري)` : ''),
    h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['المقياس وتعريفه', 'القيمة', 'البسط / المقام', 'العينة'].map((t) => h('th', {}, t)))),
      h('tbody', {}, row('نجاح التوليد', m.generation_success), row('تغطية الأهداف', m.objective_coverage), row('معدل التكرار', m.duplicate_rate), row('العيوب المثبتة', m.confirmed_defect_rate), row('إتمام المحاولات', m.attempt_completion), row('نجاح الحفظ', m.save_success), row('تقييم الفائدة والوضوح', m.student_usefulness)))),
    h('p', { class: 'small muted' }, `بلاغات مفتوحة: ${num(m.reports.open)} من ${num(m.reports.total)}.`));
}

async function changes() {
  const list = await api('GET', '/api/admin/changes');
  return list.length ? h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'النوع', 'الوصف', 'بواسطة', 'التاريخ'].map((t) => h('th', {}, t)))), h('tbody', {}, list.map((c) => h('tr', {}, h('td', {}, c.id), h('td', {}, c.kind), h('td', { class: 'bidi' }, c.description), h('td', { class: 'small' }, c.actor), h('td', { class: 'small muted' }, fmtDate(c.created_at))))))) : h('div', { class: 'card' }, emptyState('🗒', 'لا تعديلات', 'تُسجَّل هنا تعديلات الأسئلة والرجوع عنها.'));
}
