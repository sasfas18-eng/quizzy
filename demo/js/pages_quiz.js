import { h, api, state, toast, confirmDialog, modal, emptyState, num, pct, fmtDate, spinner, errorBox, TYPE_AR, REVIEW_AR } from './core.js';
import { onLeave, quizTable } from './main.js';
import { qualityNote } from './pages_files.js';

const LEVEL = { strong: ['مدعوم جيدًا', 'ok'], limited: ['دعم محدود', 'warn'], none: ['غير مدعوم', 'bad'] };

export async function quizzesPage() {
  const list = await api('GET', '/api/quizzes');
  return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'كويزاتي'), h('a', { class: 'btn primary', href: '#/new' }, '＋ كويز جديد')),
    list.length ? h('div', { class: 'card' }, quizTable(list)) : h('div', { class: 'card' }, emptyState('📝', 'لا توجد كويزات', 'ارفع ملفًا ثم أنشئ أول كويز.', h('a', { class: 'btn primary', href: '#/new' }, 'كويز جديد'))));
}

function badPages(doc) { return [...doc.quality.image_only, ...doc.quality.empty, ...doc.quality.garbled]; }
function rangeExcluding(total, bad) {
  const keep = []; for (let i = 1; i <= total; i++) if (!bad.includes(i)) keep.push(i);
  const out = []; let s = null, p = null;
  for (const n of keep) { if (s === null) { s = p = n; } else if (n === p + 1) p = n; else { out.push(s === p ? `${s}` : `${s}-${p}`); s = p = n; } }
  if (s !== null) out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(',');
}

export async function newQuizPage() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }
  const docs = (await api('GET', '/api/documents')).filter((d) => d.status === 'ready');
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('doc');
  if (!docs.length) return h('div', { class: 'card' }, emptyState('📄', 'ارفع ملفًا أولًا', 'لا توجد ملفات جاهزة لإنشاء كويز منها.', h('a', { class: 'btn primary', href: '#/files' }, 'رفع ملف')));
  const opts = await api('GET', '/api/quizzes/options');
  const S = { generator: state.caps?.claude_ok === false ? 'rules' : 'claude', count: 20, difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only' };
  const chosen = new Map(); // docId -> pages string
  if (preset) chosen.set(preset, '');
  const err = h('div', { role: 'alert' });

  const chipGroup = (key, items, fmt = (x) => x) => {
    const box = h('div', { class: 'chips', role: 'group' });
    const draw = () => box.replaceChildren(...items.map((v) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(S[key] === v), onclick: () => { S[key] = v; draw(); } }, fmt(v))));
    draw(); return box;
  };
  const sel = (key, entries) => h('select', { onchange: (e) => { S[key] = e.target.value; } }, entries.map(([v, l]) => h('option', { value: v, selected: S[key] === v }, l)));

  const docBox = h('div', {});
  function drawDocs() {
    docBox.replaceChildren(...docs.map((d) => {
      const on = chosen.has(d.id); const bad = badPages(d);
      const rng = h('input', { type: 'text', dir: 'ltr', placeholder: `الكل (1-${d.page_count})`, value: chosen.get(d.id) || '', 'aria-label': 'نطاق الصفحات', oninput: (e) => chosen.set(d.id, e.target.value) });
      return h('div', { class: 'card', style: 'margin-bottom:.6rem;' + (on ? 'border-color:var(--accent)' : '') },
        h('label', { class: 'row', style: 'cursor:pointer;margin:0' }, h('input', { type: 'checkbox', checked: on, style: 'width:20px;height:20px', onchange: (e) => { if (e.target.checked) chosen.set(d.id, ''); else chosen.delete(d.id); drawDocs(); } }),
          h('span', { class: 'bidi' }, h('strong', {}, d.title), h('span', { class: 'muted small' }, ` · ${num(d.page_count)} صفحة`))),
        on && h('div', { style: 'margin-top:.6rem' },
          h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:200px' }, h('label', {}, 'الصفحات المطلوبة'), rng, h('div', { class: 'hint' }, 'مثال: 1-12, 15, 20-30. اتركه فارغًا لكل الملف.')),
            bad.length ? h('button', { type: 'button', class: 'btn small', onclick: () => { chosen.set(d.id, rangeExcluding(d.page_count, bad)); drawDocs(); } }, `استبعد ${num(bad.length)} صفحة غير مقروءة`) : null),
          qualityNote(d.quality)));
    }));
  }
  drawDocs();

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    if (!chosen.size) { err.replaceChildren(h('div', { class: 'alert bad' }, 'اختر ملفًا واحدًا على الأقل.')); return; }
    const sources = [...chosen].map(([document_id, pages]) => ({ document_id, pages: pages.trim() || null }));
    btn.disabled = true;
    try {
      const body = { title: title.value.trim() || null, sources, settings: { ...S, timer_minutes: S.timer_minutes || null } };
      const q = await api('POST', '/api/quizzes', body);
      location.hash = `#/quiz/${q.id}`;
    } catch (ex) { err.replaceChildren(errorBox(ex)); btn.disabled = false; }
  } });
  const title = h('input', { type: 'text', maxlength: 120, placeholder: 'اختياري — يُؤخذ من اسم الملف' });
  const timer = h('input', { type: 'number', min: 1, max: 600, placeholder: 'بلا مؤقت', dir: 'ltr', oninput: (e) => { S.timer_minutes = e.target.value ? +e.target.value : null; } });
  const customCount = h('input', { type: 'number', min: 5, max: 60, dir: 'ltr', placeholder: 'عدد آخر', style: 'max-width:120px', oninput: (e) => { if (e.target.value) { S.count = +e.target.value; countBox.replaceWith((countBox = chipGroup('count', [10, 20, 30]))); } } });
  let countBox = chipGroup('count', [10, 20, 30]);
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'متابعة: تحليل المحتوى ←');
  form.append(
    h('h1', {}, 'كويز جديد'),
    h('div', { class: 'card' }, h('h2', {}, '١. المصدر'), docBox),
    h('div', { class: 'card' }, h('h2', {}, '٢. الإعدادات'),
      h('div', { class: 'field' }, h('label', {}, 'عنوان الكويز'), title),
      h('div', { class: 'grid g2' },
        h('div', { class: 'field' }, h('label', {}, 'عدد الأسئلة المطلوب'), h('div', { class: 'row' }, countBox, customCount), h('div', { class: 'hint' }, 'هذا سقف مطلوب: إن لم يكفِ المحتوى لعدد صحيح وغير مكرر نُخبرك بالعدد الممكن بدل الحشو.')),
        h('div', { class: 'field' }, h('label', {}, 'الصعوبة'), chipGroup('difficulty', ['easy', 'medium', 'hard', 'mixed'], (v) => opts.difficulty[v])),
        h('div', { class: 'field' }, h('label', {}, 'التركيز'), chipGroup('focus', ['balanced', 'understand_apply', 'critical', 'recall'], (v) => opts.focus[v])),
        h('div', { class: 'field' }, h('label', {}, 'لغة الأسئلة'), chipGroup('language', ['source', 'ar', 'en'], (v) => ({ source: 'لغة المصدر', ar: 'العربية', en: 'English' })[v])),
        h('div', { class: 'field' }, h('label', {}, 'وضع الحل'), chipGroup('mode', ['practice', 'exam'], (v) => (v === 'practice' ? 'تدريب (تفسير فوري)' : 'اختبار (مراجعة بعد التسليم)'))),
        h('div', { class: 'field' }, h('label', {}, 'مؤقت (دقائق)'), timer, h('div', { class: 'hint' }, 'في وضع الاختبار يُطبَّق على الخادم ويُسلَّم تلقائيًا عند انتهائه.')),
        h('div', { class: 'field' }, h('label', {}, 'مصدر المعلومات'), chipGroup('external_mode', ['source_only', 'supplement'], (v) => (v === 'source_only' ? 'المصدر فقط (الافتراضي)' : 'المصدر + معلومات خارجية موسومة'))),
      ),
      state.caps?.rules_mode && h('div', { class: 'field' }, h('label', {}, 'طريقة التوليد'), chipGroup('generator', state.caps?.claude_ok === false ? ['rules'] : ['claude', 'rules'], (v) => (v === 'claude' ? (state.caps?.ai_label || 'ذكي (Claude)') + ' — أعلى جودة' : 'آلي بدون توكن — أبسط وأنواعه أقل')),
        state.caps?.claude_ok === false && state.caps?.byok ? h('div', { class: 'alert info' }, 'للتوليد الذكي أضف مفتاحًا من ', h('a', { href: '#/settings' }, 'الإعدادات'), ' (يوجد مجاني عند بعض المزوّدين).') : null,
        h('div', { class: 'hint' }, 'بدون توكن: لا يستهلك أي استدعاء ذكاء اصطناعي. يستخرج تعريفات وأسبابًا وأرقامًا وقوائم وخطوات من ملفك فقط؛ لا يدعم التفكير النقدي ولا أفضل إجابة ولا السيناريوهات ولا المقارنة.')),
      h('label', { class: 'row', style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: true, style: 'width:20px;height:20px', onchange: (e) => { S.shuffle_options = e.target.checked; } }), 'ترتيب الخيارات عشوائيًا (المفتاح مرتبط بمعرّف الخيار فيبقى صحيحًا)'),
      h('div', { class: 'alert info' }, h('strong', {}, 'احتساب الدرجة: '), opts.scoring.text)),
    err, h('div', { class: 'row' }, btn, h('a', { class: 'btn', href: '#/files' }, 'إلغاء')));
  return form;
}

const STAGES = { queued: 'في الانتظار', reading_source: 'قراءة المصدر', analyzing_lecture: 'تحليل اللكتشر واستخراج الأهداف', drafting: 'صياغة الأسئلة والتحقق منها', retrying: 'إعادة صياغة الأسئلة المرفوضة', finalizing: 'اعتماد النسخة النهائية', done: 'اكتمل' };

export async function quizPage(id) {
  const root = h('div', {});
  let timer = null;
  onLeave(() => clearTimeout(timer));
  async function draw() {
    const q = await api('GET', `/api/quizzes/${id}`);
    const body = view(q);
    root.replaceChildren(h('div', { class: 'row between' }, h('div', {}, h('h1', { class: 'bidi' }, q.title), q.generator === 'test-generator' && h('span', { class: 'badge test' }, 'محتوى اختباري — مولّد تجريبي وليس مولّد الإنتاج')),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/quizzes' }, 'كل الكويزات'), h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف الكويز؟', 'ستُحذف أسئلته ومحاولاته.', 'حذف', true)) { await api('DELETE', `/api/quizzes/${id}`); location.hash = '#/quizzes'; } } }, 'حذف'))), body);
    if (['analyzing', 'generating'].includes(q.status)) timer = setTimeout(() => draw().catch(() => {}), 1500);
  }
  function view(q) {
    const st = q.settings;
    if (q.status === 'draft') return draftView(q);
    if (['analyzing', 'generating'].includes(q.status)) return progressView(q);
    if (q.status === 'planned') return planView(q);
    if (q.status === 'ready') return readyView(q);
    const rulesMode = st.generator === 'rules', canAI = state.caps?.claude_ok, canRules = state.caps?.rules_mode;
    const switchTo = async (mode) => { try { await api('PATCH', `/api/quizzes/${id}`, { settings: { generator: mode } }); await start('analyze'); } catch (e) { root.prepend(errorBox(e)); } };
    return h('div', {}, h('div', { class: 'alert ' + (q.status === 'insufficient' ? 'warn' : 'bad') }, h('strong', {}, q.status === 'insufficient' ? 'المصدر لا يكفي: ' : 'فشلت المعالجة: '), q.error || 'سبب غير معروف'),
      q.report && reportCard(q.report),
      h('div', { class: 'card' }, h('h3', {}, 'ماذا تفعل الآن؟'), h('ul', {},
        rulesMode && canAI ? h('li', {}, 'استخدم الذكاء الاصطناعي: يفهم الشرائح مهما كانت صياغتها. ', h('button', { class: 'btn small primary', onclick: () => switchTo('claude') }, 'جرّب بالذكاء الاصطناعي')) : null,
        rulesMode && !canAI && state.caps?.byok ? h('li', {}, 'أضف مفتاح توليد مجانيًا (دقيقتان) ليفهم الموقع الشرائح مهما كانت صياغتها. ', h('a', { class: 'btn small primary', href: '#/settings' }, 'إضافة مفتاح')) : null,
        !rulesMode && canRules ? h('li', {}, 'جرّب وضع «بدون توكن» (أبسط لكنه لا يستهلك استدعاءات). ', h('button', { class: 'btn small', onclick: () => switchTo('rules') }, 'جرّب بدون توكن')) : null,
        h('li', {}, 'وسّع نطاق الصفحات أو أضف ملفًا آخر. ', h('a', { class: 'btn small', href: '#/new' }, 'تعديل الطلب')),
        h('li', {}, 'تأكد أن الملف يحوي نصًا حقيقيًا (لا صور ممسوحة): افتح الملف من «ملفاتي» وراجع نص الصفحات.'))),
      h('div', { class: 'row' }, q.plan ? h('button', { class: 'btn primary', onclick: () => start('generate', { accept_reduced: true }) }, 'إعادة محاولة التوليد') : null,
        h('button', { class: 'btn', onclick: () => start('analyze') }, 'إعادة التحليل')));
  }
  async function start(what, body) {
    try { await api('POST', `/api/quizzes/${id}/${what}`, body || {}); await draw(); }
    catch (e) {
      if (e.code === 'shortfall') { toast(e.message, 'bad'); return; }
      root.prepend(errorBox(e));
    }
  }
  function draftView(q) {
    const sp = q.source_preview;
    const llm = state.caps?.llm;
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'المصدر المحدد'), sp ? h('div', {}, h('p', {}, `${num(sp.readable_pages)} صفحة مقروءة (~${num(sp.words)} كلمة).`),
        sp.excluded_pages.length ? h('div', { class: 'alert bad' }, h('strong', {}, `${num(sp.excluded_pages.length)} صفحة ستُستبعد لأنها غير مقروءة: `), sp.excluded_pages.map((p) => `${p.document} ص${p.page}`).join('، '), '. لن نخمّن محتواها.') : h('div', { class: 'alert ok' }, 'كل الصفحات المحددة مقروءة.')) : null),
      sp && h('div', { class: 'card' }, h('h2', {}, 'ما الذي يدعمه محتواك؟'), h('p', { class: 'muted small' }, 'فحص أولي من النص (قبل التحليل الذكي). الأنواع غير المدعومة لن تُملأ باختلاق أسئلة.'),
        h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, Object.entries(sp.type_support).map(([k, v]) => h('tr', {}, h('td', {}, v.label), h('td', {}, h('span', { class: 'badge ' + LEVEL[v.level][1] }, LEVEL[v.level][0])), h('td', { class: 'small muted' }, v.missing || ''))))))),
      !llm && h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير مفعّل على هذا الخادم. '), 'يحتاج مفتاح خدمة الذكاء الاصطناعي (ANTHROPIC_API_KEY). يمكنك الاحتفاظ بالمسودة وإكمالها بعد التفعيل؛ لن تُعرض أسئلة ثابتة بدلًا من التوليد الحقيقي.'),
      q.error && h('div', { class: 'alert bad' }, q.error),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: !llm, onclick: () => start('analyze') }, 'حلّل المحتوى وابنِ الخطة'), h('a', { class: 'btn', href: '#/new' }, 'جديد')));
  }
  function progressView(q) {
    return h('div', { class: 'card' }, h('h2', {}, q.status === 'analyzing' ? 'جارٍ تحليل اللكتشر…' : 'جارٍ توليد الأسئلة والتحقق منها…'), h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': q.progress.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${q.progress.pct}%` })),
      h('p', { class: 'muted' }, STAGES[q.progress.stage] || q.progress.stage || ''), h('p', { class: 'small muted' }, 'يمكنك مغادرة الصفحة؛ المعالجة تستمر على الخادم وستجدها في «كويزاتي».'));
  }
  function planView(q) {
    const p = q.plan, a = q.analysis || {};
    let accept = false;
    const short = p.feasible_count < p.requested;
    const gen = h('button', { class: 'btn primary', disabled: short, onclick: () => start('generate', { accept_reduced: accept }) }, `ابدأ توليد ${num(p.feasible_count)} سؤالًا`);
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'خطة الكويز'), a.lecture_character && h('p', { class: 'bidi' }, a.lecture_character),
        h('div', { class: 'row' }, h('div', {}, h('div', { class: 'stat' }, num(p.feasible_count)), h('div', { class: 'stat-l' }, `سؤالًا ممكنًا (المطلوب ${num(p.requested)})`)),
          h('div', { style: 'margin-inline-start:2rem' }, h('div', { class: 'stat' }, num(p.objective_count)), h('div', { class: 'stat-l' }, 'هدفًا تعليميًا مستخرجًا'))),
        short && h('div', { class: 'alert warn' }, h('strong', {}, 'المحتوى لا يكفي للعدد المطلوب. '), `يدعم ${num(p.feasible_count)} سؤالًا صحيحًا غير مكرر فقط. `, p.shortfall.suggestions.join(' '),
          h('label', { class: 'row', style: 'margin-top:.5rem;cursor:pointer' }, h('input', { type: 'checkbox', style: 'width:20px;height:20px', onchange: (e) => { accept = e.target.checked; gen.disabled = !accept || !p.feasible_count; } }), 'أقبل العدد الأقل بدل الحشو')),
        h('h3', { style: 'margin-top:1rem' }, 'التوزيع المخطط على هوية الأسئلة'),
        Object.entries(p.distribution).map(([k, n]) => h('div', { class: 'bar-row' + (n ? '' : ' zero') }, h('span', {}, TYPE_AR[k]), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(100 * n) / Math.max(1, ...Object.values(p.distribution))}%` })), h('span', {}, num(n)))),
        p.unsupported_types.length ? h('div', { class: 'alert warn' }, h('strong', {}, 'أقسام لا يدعمها المصدر الحالي (لن نختلقها):'), h('ul', {}, p.unsupported_types.map((u) => h('li', {}, h('strong', {}, u.label), ': ', u.reason, ' ', h('span', { class: 'muted' }, u.suggestion))))) : h('div', { class: 'alert ok' }, 'كل أقسام الهوية مدعومة بالمحتوى.')),
      a.excluded_pages?.length ? h('div', { class: 'alert bad' }, `صفحات مستبعدة لعدم قابليتها للقراءة: ${a.excluded_pages.map((x) => `${x.document} ص${x.page}`).join('، ')}`) : null,
      a.gaps?.length ? h('div', { class: 'alert info' }, h('strong', {}, 'فجوات في المصدر: '), a.gaps.join(' · ')) : null,
      h('details', { class: 'card' }, h('summary', {}, `الأهداف التعليمية (${num(a.objectives.length)})`), h('ul', {}, a.objectives.map((o) => h('li', { class: 'bidi' }, o.statement, h('span', { class: 'muted small' }, ` — ${o.types.map((t) => TYPE_AR[t]).join('، ')}`))))),
      h('div', { class: 'row' }, gen, h('button', { class: 'btn', onclick: () => start('analyze') }, 'إعادة التحليل'), h('a', { class: 'btn', href: '#/new' }, 'تعديل الطلب')));
  }
  function reportCard(r) {
    const defs = (c) => `${num(c.numerator)} من ${num(c.denominator)} (${pct(c.numerator, c.denominator)})`;
    return h('div', { class: 'card' }, h('h2', {}, 'تقرير الجودة'),
      h('div', { class: 'grid g3' },
        h('div', {}, h('div', { class: 'stat' }, `${num(r.delivered)} / ${num(r.requested)}`), h('div', { class: 'stat-l' }, 'أسئلة سُلّمت / مطلوبة')),
        h('div', {}, h('div', { class: 'stat' }, pct(r.objective_coverage.numerator, r.objective_coverage.denominator)), h('div', { class: 'stat-l', title: r.objective_coverage.definition }, `تغطية الأهداف: ${defs(r.objective_coverage)}`)),
        h('div', {}, h('div', { class: 'stat' }, pct(r.identity_coverage.numerator, r.identity_coverage.denominator)), h('div', { class: 'stat-l', title: r.identity_coverage.definition }, `اكتمال الهوية المخططة: ${defs(r.identity_coverage)}`))),
      h('p', { class: 'small muted' }, `صيغ ${num(r.stats.drafted)} مرشحًا؛ رُفض ${num(r.stats.rejected_validation)} بفحص الدليل والبنية، ${num(r.stats.rejected_verifier)} بالحل المستقل، ${num(r.stats.rejected_duplicate)} للتكرار، ${num(r.stats.rejected_leak)} لتسريب إجابة. ${r.flagged ? `${num(r.flagged)} سؤالًا عليه ملاحظات بسيطة.` : ''}`),
      r.dropped.length ? h('details', {}, h('summary', {}, `خانات لم تُملأ (${num(r.dropped.length)}) — لم نحشُها بأسئلة ضعيفة`), h('ul', {}, r.dropped.map((d) => h('li', { class: 'small' }, TYPE_AR[d.qtype], ': ', (d.reasons || []).join(' / '))))) : null,
      h('p', { class: 'small muted' }, `المولّد: ${r.generator} · نسخة التعليمات ${r.prompt_version}. التحقق آلي؛ لا يعني «راجعه مختص».`));
  }
  function readyView(q) {
    const st = q.settings, r = q.report;
    const dl = h('a', { class: 'btn', href: `/api/quizzes/${q.id}/pdf?answer_key=true`, download: '' }, '⬇ PDF مع مفتاح الإجابة');
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'جاهز للحل'), r.shortfall && h('div', { class: 'alert warn' }, `سُلّم ${num(r.delivered)} سؤالًا فقط من ${num(r.requested)} المطلوبة، لأن المصدر لا يدعم أكثر.`),
        h('p', { class: 'muted' }, q.scoring.text),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => startDialog(q) }, 'ابدأ الحل'), dl,
          h('a', { class: 'btn', href: `/api/quizzes/${q.id}/pdf?answer_key=false`, download: '' }, '⬇ PDF بدون مفتاح'),
          h('a', { class: 'btn', href: `#/cards?doc=${st.sources[0].document_id}` }, 'بطاقات المراجعة'), h('button', { class: 'btn', onclick: () => bank(q) }, 'بنك الأسئلة'))),
      reportCard(r), attemptsCard(q.id));
  }
  function attemptsCard(qid) {
    const box = h('div', { class: 'card' }, h('h2', {}, 'محاولاتك السابقة'), spinner());
    api('GET', `/api/attempts?quiz_id=${qid}`).then((list) => {
      box.replaceChildren(h('h2', {}, 'محاولاتك السابقة'), list.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, list.map((a) => h('tr', {}, h('td', {}, fmtDate(a.updated_at)), h('td', {}, a.mode === 'exam' ? 'اختبار' : 'تدريب'),
        h('td', {}, a.status === 'submitted' ? `${num(a.score)} / ${num(a.max_score)} (${pct(a.score, a.max_score)})` : `غير مكتملة — ${num(a.answered)}/${num(a.total)}`),
        h('td', {}, h('a', { class: 'btn small', href: a.status === 'submitted' ? `#/attempt/${a.id}/result` : `#/attempt/${a.id}` }, a.status === 'submitted' ? 'المراجعة' : 'متابعة'))))))) : h('p', { class: 'muted' }, 'لا توجد محاولات بعد.'));
    });
    return box;
  }
  function startDialog(q) {
    const st = q.settings; const o = { mode: st.mode, timer: st.timer_minutes || '', shuffle: st.shuffle_options, shuffleQ: false };
    modal((close) => h('div', {}, h('h2', {}, 'بدء المحاولة'),
      h('div', { class: 'field' }, h('label', {}, 'الوضع'), h('div', { class: 'chips' }, ['practice', 'exam'].map((m) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(o.mode === m), onclick: (e) => { o.mode = m; [...e.target.parentNode.children].forEach((c) => c.setAttribute('aria-pressed', String(c === e.target))); } }, m === 'practice' ? 'تدريب' : 'اختبار')))),
      h('div', { class: 'field' }, h('label', {}, 'مؤقت (دقائق، اختياري)'), h('input', { type: 'number', min: 1, value: o.timer, dir: 'ltr', oninput: (e) => { o.timer = e.target.value; } })),
      h('label', { class: 'row', style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: o.shuffle, style: 'width:20px;height:20px', onchange: (e) => { o.shuffle = e.target.checked; } }), 'ترتيب الخيارات عشوائيًا'),
      h('label', { class: 'row', style: 'cursor:pointer' }, h('input', { type: 'checkbox', style: 'width:20px;height:20px', onchange: (e) => { o.shuffleQ = e.target.checked; } }), 'ترتيب الأسئلة عشوائيًا'),
      h('div', { class: 'alert info' }, q.scoring.text), h('p', { class: 'small muted' }, 'في التدريب يظهر التفسير بعد كل إجابة وتُقفل. في الاختبار لا يظهر شيء حتى التسليم، والمؤقت يُطبَّق على الخادم.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const a = await api('POST', `/api/quizzes/${q.id}/attempts`, { mode: o.mode, timer_minutes: o.timer ? +o.timer : null, shuffle_options: o.shuffle, shuffle_questions: o.shuffleQ }); close(); location.hash = `#/attempt/${a.id}`; } catch (e) { toast(e.message, 'bad'); } } }, 'ابدأ'), h('button', { class: 'btn', onclick: close }, 'إلغاء'))));
  }
  async function bank(q) {
    const qs = await api('GET', `/api/quizzes/${q.id}/questions`);
    modal(h('div', {}, h('h2', {}, `بنك الأسئلة (${num(qs.length)})`), h('p', { class: 'muted small' }, 'عرض كامل مع المفتاح والدليل — للمراجعة بعد الاختبار فقط.'),
      qs.map((x) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'badge info' }, x.type_label), h('span', { class: 'badge' }, REVIEW_AR[x.review_status]), h('span', { class: 'muted small' }, `ص ${x.source_pages.join('، ')}`)),
        h('div', { class: 'stem bidi' }, x.stem), x.options.map((o) => h('div', { class: 'bidi', style: o.id === x.correct_option_id ? 'color:var(--ok);font-weight:700' : '' }, (o.id === x.correct_option_id ? '✓ ' : '• ') + o.text)),
        h('div', { class: 'explain bidi' }, x.explanation, x.evidence[0] && h('blockquote', {}, `«${x.evidence[0].quote}» — ${x.evidence[0].doc_title || ''} ص${x.evidence[0].page}`)),
        h('p', { class: 'small muted' }, `الغرض: ${x.purpose} · فحوص: ${x.validation?.issues?.length ? x.validation.issues.map((i) => i.message).join('، ') : 'لا ملاحظات'}`)))), { wide: true });
  }
  await draw();
  return root;
}
