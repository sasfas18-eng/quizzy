import { h, api, state, fill, toast, confirmDialog, modal, emptyState, num, arQ, pct, fmtDate, spinner, errorBox, REVIEW_AR } from './core.js?v=fdccca81b6';
import { onLeave, quizTable } from './main.js?v=fdccca81b6';
import { qualityNote } from './pages_files.js?v=fdccca81b6';
import { aiConnectCard } from './pages_settings.js?v=fdccca81b6';

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
  // The question types are NOT a student choice: the analysis decides which of them the lecture supports and the planner adds them.
  const S = { count: 20, difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only' };
  if (state.caps?.rules_mode) S.generator = 'claude';      // browser editions can also build quizzes locally, without any AI
  const chosen = new Map(); // docId -> pages string
  if (preset) chosen.set(preset, '');
  const err = h('div', { role: 'alert' });

  const chipGroup = (key, items, fmt = (x) => x) => {
    const box = h('div', { class: 'chips', role: 'group' });
    const draw = () => box.replaceChildren(...items.map((v) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(S[key] === v), onclick: () => { S[key] = v; draw(); } }, fmt(v))));
    draw(); return box;
  };

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

  // No key, no problem: with no AI connected the quiz is built by the local generator (straight from the file's text, on this device).
  // The AI is an optional upgrade, never a gate. Only the server edition without any generator at all still has to say so.
  const rulesOK = () => !!state.caps?.rules_mode;
  const aiOff = () => state.caps?.claude_ok === false;
  const noEngine = () => state.caps?.llm === false && !rulesOK();
  const aiBox = h('div', {});
  function drawAI() {
    if (noEngine()) fill(aiBox, h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير مفعّل على هذا الخادم. '), 'يحتاج مفتاح خدمة الذكاء الاصطناعي (ANTHROPIC_API_KEY).'));
    else if (aiOff() && rulesOK()) fill(aiBox, h('div', { class: 'alert info', id: 'local-note' }, h('strong', {}, 'جاهز بلا أي مفتاح. '),
      'يُنشأ الكويز على جهازك مباشرةً من نص ملفك (تعريفات، إكمال فراغات، أسباب وأرقام وقوائم وترتيب خطوات) — فوري ومجاني بلا حدود. أسئلته أبسط من أسئلة الذكاء الاصطناعي. ',
      state.caps?.byok ? h('details', { style: 'margin-top:.5rem' }, h('summary', {}, 'أسئلة أعمق تفهم الشرائح مهما كانت صياغتها: اربط ذكاءً اصطناعيًا مجانيًا (اختياري)'), aiConnectCard(() => { drawAI(); })) : (state.caps?.ai_missing ? h('span', { class: 'muted' }, state.caps.ai_missing) : null)));
    else aiBox.replaceChildren();
    btn.disabled = noEngine();
  }

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    if (!chosen.size) { err.replaceChildren(h('div', { class: 'alert bad' }, 'اختر ملفًا واحدًا على الأقل.')); return; }
    if (noEngine()) { drawAI(); aiBox.scrollIntoView({ block: 'center' }); return; }
    const sources = [...chosen].map(([document_id, pages]) => ({ document_id, pages: pages.trim() || null }));
    btn.disabled = true; btn.textContent = 'جارٍ البدء…';
    let q = null;
    try {
      q = await api('POST', '/api/quizzes', { title: title.value.trim() || null, sources, settings: { ...S, ...(rulesOK() ? { generator: aiOff() ? 'rules' : S.generator } : {}), timer_minutes: S.timer_minutes || null } });
      await api('POST', `/api/quizzes/${q.id}/analyze`, { auto_generate: true });   // analysis -> plan -> generation, no confirmation step
      location.hash = `#/quiz/${q.id}`;
    } catch (ex) {
      if (q) { try { await api('DELETE', `/api/quizzes/${q.id}`); } catch (_) { /* nothing to clean */ } }   // never leave an empty draft behind
      if (ex.code === 'llm_not_configured') { state.caps = { ...state.caps, claude_ok: false }; drawAI(); }
      err.replaceChildren(errorBox(ex)); btn.disabled = false; btn.textContent = 'إنشاء الكويز ←';
    }
  } });
  const title = h('input', { type: 'text', maxlength: 120, placeholder: 'اختياري — يُؤخذ من اسم الملف' });
  const customCount = h('input', { type: 'number', min: 5, max: 60, dir: 'ltr', placeholder: 'عدد آخر', style: 'max-width:120px', oninput: (e) => { if (e.target.value) { S.count = +e.target.value; countBox.replaceWith((countBox = chipGroup('count', [10, 20, 30]))); } } });
  let countBox = chipGroup('count', [10, 20, 30]);
  const btn = h('button', { class: 'btn primary', type: 'submit', id: 'create-quiz' }, 'إنشاء الكويز ←');
  form.append(
    h('h1', {}, 'كويز جديد'),
    aiBox,
    h('div', { class: 'card' }, h('h2', {}, '١. المصدر'), docBox),
    h('div', { class: 'card' }, h('h2', {}, '٢. الإعدادات'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'field' }, h('label', {}, 'عدد الأسئلة المطلوب'), h('div', { class: 'row' }, countBox, customCount), h('div', { class: 'hint' }, 'هذا سقف مطلوب: إن لم يكفِ المحتوى لعدد صحيح وغير مكرر نُسلّمك العدد الممكن بدل الحشو، ونخبرك بذلك.')),
        h('div', { class: 'field' }, h('label', {}, 'الصعوبة'), chipGroup('difficulty', ['easy', 'medium', 'hard', 'mixed'], (v) => opts.difficulty[v])),
        h('div', { class: 'field' }, h('label', {}, 'لغة الأسئلة'), chipGroup('language', ['source', 'ar', 'en'], (v) => ({ source: 'لغة المصدر', ar: 'العربية', en: 'English' })[v]))),
      h('details', {}, h('summary', {}, 'خيارات إضافية'),
        h('div', { class: 'field', style: 'margin-top:.6rem' }, h('label', {}, 'عنوان الكويز'), title),
        rulesOK() && !aiOff() && h('label', { class: 'row', id: 'gen-choice', style: 'cursor:pointer;margin-top:.4rem' }, h('input', { type: 'checkbox', id: 'use-local', style: 'width:20px;height:20px', onchange: (e) => { S.generator = e.target.checked ? 'rules' : 'claude'; } }),
          h('span', {}, 'أنشئه محليًا بدون ذكاء اصطناعي ', h('span', { class: 'muted small' }, '(مجاني وفوري ولا يستهلك أي استخدام، وأسئلته أبسط: تعريفات وإكمال فراغات وأسباب وأرقام وقوائم)'))),
        h('div', { class: 'field' }, h('label', {}, 'مصدر المعلومات'), chipGroup('external_mode', ['source_only', 'supplement'], (v) => (v === 'source_only' ? 'المصدر فقط (الافتراضي)' : 'المصدر + معلومات خارجية موسومة')))),
      h('p', { class: 'hint' }, 'تُختار أنواع الأسئلة تلقائيًا بحسب ما يدعمه ملفك فعلًا. وضع الحل (تدريب/اختبار) والمؤقت تختارهما عند بدء الحل.')),
    err, h('div', { class: 'row' }, btn, h('a', { class: 'btn', href: '#/files' }, 'إلغاء')));
  drawAI();
  return form;
}

const STAGES = { queued: 'في الانتظار', reading_source: 'قراءة المصدر', analyzing_lecture: 'فهم اللكتشر واستخراج أهدافه', planned: 'تجهيز الأسئلة', drafting: 'صياغة الأسئلة والتحقق منها', retrying: 'إعادة صياغة الأسئلة المرفوضة', finalizing: 'اعتماد النسخة النهائية', done: 'اكتمل' };

export async function quizPage(id) {
  const root = h('div', {});
  let timer = null, autoStarted = false;
  onLeave(() => clearTimeout(timer));
  async function draw() {
    const q = await api('GET', `/api/quizzes/${id}`);
    fill(root, h('div', { class: 'row between' }, h('div', {}, h('h1', { class: 'bidi' }, q.title), q.generator === 'test-generator' && h('span', { class: 'badge test' }, 'محتوى اختباري — مولّد تجريبي وليس مولّد الإنتاج')),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/quizzes' }, 'كل الكويزات'), h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف الكويز؟', 'ستُحذف أسئلته ومحاولاته.', 'حذف', true)) { await api('DELETE', `/api/quizzes/${id}`); location.hash = '#/quizzes'; } } }, 'حذف'))), view(q));
    if (['analyzing', 'generating'].includes(q.status)) timer = setTimeout(() => draw().catch(() => {}), 1500);
  }
  function view(q) {
    if (q.status === 'draft') return draftView(q);
    if (['analyzing', 'generating'].includes(q.status)) return progressView(q);
    if (q.status === 'planned') {
      // A plan nobody has to confirm: carry on to generation (a smaller count is accepted; the shortfall is reported, never padded).
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
  const rulesOK = () => !!state.caps?.rules_mode;
  const isLocal = (q) => q.settings && q.settings.generator === 'rules';
  // "try again without the AI": switch this quiz to the local generator (it goes back to a draft) and run it
  async function useLocal() { try { await api('PATCH', `/api/quizzes/${id}`, { settings: { generator: 'rules' } }); await start('analyze', { auto_generate: true }); } catch (e) { root.prepend(errorBox(e)); } }

  function draftView(q) {
    return h('div', { class: 'card' }, h('h2', {}, 'لم يبدأ توليد هذا الكويز'),
      noAI() && !isLocal(q) ? h('div', { class: 'alert info' }, 'الذكاء الاصطناعي غير مربوط الآن، فيمكن إنشاء هذا الكويز محليًا بلا ذكاء اصطناعي (فوري ومجاني، أسئلته أبسط).') : h('p', { class: 'muted' }, 'اضغط ابدأ ليقرأ «كويزي» الملف ويبني الأسئلة ويتحقق منها.'),
      noAI() && !isLocal(q) && state.caps?.byok ? h('details', { class: 'card' }, h('summary', {}, 'أو اربط ذكاءً اصطناعيًا (اختياري)'), aiConnectCard(() => draw())) : null,
      h('div', { class: 'row' }, noAI() && !isLocal(q) ? (rulesOK() ? h('button', { class: 'btn primary', id: 'start-local', onclick: useLocal }, 'أنشئه الآن بلا ذكاء اصطناعي') : null) : h('button', { class: 'btn primary', onclick: () => start('analyze', { auto_generate: true }) }, 'ابدأ التوليد'), h('a', { class: 'btn', href: '#/new' }, 'كويز جديد')));
  }
  function progressView(q) {
    const browserRun = !!state.caps?.edition;      // browser editions run the job inside this page; the server edition keeps going on its own
    return h('div', { class: 'card' }, h('h2', {}, q.status === 'analyzing' ? 'جارٍ فهم اللكتشر…' : 'جارٍ توليد الأسئلة والتحقق منها…'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': q.progress.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${q.progress.pct}%` })),
      h('p', { class: 'muted', id: 'stage' }, STAGES[q.progress.stage] || q.progress.stage || ''),
      h('p', { class: 'small muted' }, browserRun ? 'تستغرق عادةً من دقيقة إلى بضع دقائق. أبقِ هذه الصفحة مفتوحة حتى تنتهي.' : 'يمكنك مغادرة الصفحة؛ المعالجة تستمر على الخادم وستجدها في «كويزاتي».'));
  }
  function failureView(q) {
    const msg = q.error || (q.plan && !q.plan.feasible_count ? 'المحتوى في هذا النطاق لا يكفي لأي سؤال موثّق بالمصدر.' : 'سبب غير معروف');
    const tips = (q.plan && q.plan.shortfall && q.plan.shortfall.suggestions) || [];
    const src = q.settings && q.settings.sources && q.settings.sources[0];
    return h('div', {}, h('div', { class: 'alert ' + (q.status === 'insufficient' || q.status === 'planned' ? 'warn' : 'bad') }, h('strong', {}, q.status === 'insufficient' || q.status === 'planned' ? 'المصدر لا يكفي: ' : 'فشلت المعالجة: '), msg),
      tips.length ? h('div', { class: 'alert info' }, tips.join(' ')) : null,
      q.report && reportCard(q.report),
      h('div', { class: 'card' }, h('h3', {}, 'ماذا تفعل الآن؟'), h('ul', {},
        h('li', {}, 'أعد المحاولة — قد يكون السبب مؤقتًا (ازدحام أو حدّ استخدام عند مزوّد الذكاء الاصطناعي). ', h('button', { class: 'btn small primary', id: 'retry', disabled: noAI() && !isLocal(q), onclick: () => retry(q) }, 'إعادة المحاولة')),
        !isLocal(q) && rulesOK() ? h('li', {}, 'أو أنشئه الآن بلا ذكاء اصطناعي: فوري ومجاني بلا حدود، وأسئلته أبسط (تعريفات وإكمال فراغات وأسباب وأرقام وقوائم). ', h('button', { class: 'btn small', id: 'use-local', onclick: useLocal }, 'أنشئه بلا ذكاء اصطناعي')) : null,
        isLocal(q) && state.caps?.byok && noAI() ? h('li', {}, 'لأسئلة تفهم الشرائح مهما كانت صياغتها اربط ذكاءً اصطناعيًا مجانيًا. ', h('a', { class: 'btn small', href: '#/settings' }, 'ربط الذكاء الاصطناعي')) : null,
        h('li', {}, 'وسّع نطاق الصفحات أو أضف ملفًا آخر. ', h('a', { class: 'btn small', href: src ? `#/new?doc=${src.document_id}` : '#/new' }, 'تعديل الطلب')),
        h('li', {}, 'تأكد أن الملف يحوي نصًا حقيقيًا (لا صور ممسوحة): افتح الملف من «ملفاتي» وراجع نص الصفحات.'))));
  }
  function reportCard(r) {
    const defs = (c) => `${num(c.numerator)} من ${num(c.denominator)} (${pct(c.numerator, c.denominator)})`;
    const lost = (r.dropped || []).filter((d) => !d.replaced); const why = [...new Set((r.dropped || []).flatMap((d) => d.reasons || []))].slice(0, 8);
    return h('div', { class: 'card' }, h('h2', {}, 'تقرير الجودة'),
      h('div', { class: 'grid g2' },
        h('div', {}, h('div', { class: 'stat' }, `${num(r.delivered)} / ${num(r.requested)}`), h('div', { class: 'stat-l' }, 'أسئلة سُلّمت / مطلوبة')),
        h('div', {}, h('div', { class: 'stat' }, pct(r.objective_coverage.numerator, r.objective_coverage.denominator)), h('div', { class: 'stat-l', title: r.objective_coverage.definition }, `تغطية أهداف المصدر: ${defs(r.objective_coverage)}`))),
      h('p', { class: 'small muted' }, `صيغ ${num(r.stats.drafted)} مرشحًا؛ رُفض ${num(r.stats.rejected_validation)} بفحص الدليل والبنية، ${num(r.stats.rejected_verifier)} بالحل المستقل، ${num(r.stats.rejected_duplicate)} للتكرار، ${num(r.stats.rejected_leak)} لتسريب إجابة. ${r.flagged ? `${num(r.flagged)} سؤالًا عليه ملاحظات بسيطة. ` : ''}${r.extra ? `${num(r.extra)} سؤالًا بزوايا إضافية لنفس المحاضرة. ` : ''}${r.local_filled ? `أكمل المولّد المحلي ${num(r.local_filled)} سؤالًا من سطور المحاضرة نفسها.` : ''}`),
      why.length ? h('details', {}, h('summary', {}, lost.length ? `أسئلة لم تُملأ (${num(lost.length)})` : `خانات تعذّر إنتاجها فعُوِّضت بأسئلة أخرى (${num(r.dropped.length)})`), h('ul', {}, why.map((t) => h('li', { class: 'small' }, t)))) : null,
      h('p', { class: 'small muted' }, `المولّد: ${r.generator} · نسخة التعليمات ${r.prompt_version}. التحقق آلي؛ لا يعني «راجعه مختص».`));
  }
  function readyView(q) {
    const st = q.settings, r = q.report;
    const dl = h('a', { class: 'btn', href: `/api/quizzes/${q.id}/pdf?answer_key=true`, download: '' }, '⬇ PDF مع مفتاح الإجابة');
    const tips = (r.shortfall && r.shortfall.suggestions) || [];
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'جاهز للحل'), r.shortfall && h('div', { class: 'alert warn', id: 'shortfall-note' }, `لم يتسع نص هذا النطاق إلا لـ ${arQ(r.delivered)} من ${num(r.requested)} المطلوبة حتى بصياغات وزوايا إضافية، لأنه قصير جدًا. `, tips.join(' ')),
        !r.shortfall && r.extra > 0 && h('p', { class: 'small muted', id: 'extra-note' }, `سُلّم العدد الذي طلبته (${num(r.requested)}). منها ${arQ(r.extra)} بزاوية أو صياغة إضافية لمعلومات سبق السؤال عنها، لأن المحاضرة أقل من العدد المطلوب من الموضوعات المستقلة.`),
        q.fallback && h('div', { class: 'alert warn', id: 'fallback-note' }, 'تعذّر الاتصال بالذكاء الاصطناعي الآن، فأُنشئ هذا الكويز محليًا بدلًا منه. يمكنك إنشاء كويز جديد لاحقًا بالذكاء الاصطناعي. ', state.caps?.operator ? h('span', { class: 'small muted', dir: 'ltr' }, q.fallback.reason) : null),
        isLocal(q) && h('div', { class: 'alert info', id: 'local-ready-note' }, 'وُلّد هذا الكويز محليًا بلا ذكاء اصطناعي: أسئلته إكمال فراغات وتعريفات وأسباب وأرقام وقوائم وترتيب خطوات من نص ملفك مباشرة، وكل سؤال معه الاقتباس الذي بُني عليه. الأسئلة الأعمق التي تفهم الشرائح مهما كانت صياغتها تحتاج ذكاءً اصطناعيًا.'),
        h('p', { class: 'muted' }, q.scoring.text),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'start-solve', onclick: () => startDialog(q) }, 'ابدأ الحل'), dl,
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
      qs.map((x) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'badge' }, REVIEW_AR[x.review_status]), h('span', { class: 'muted small' }, `ص ${x.source_pages.join('، ')}`)),
        h('div', { class: 'stem bidi' }, x.stem), x.options.map((o) => h('div', { class: 'bidi', style: o.id === x.correct_option_id ? 'color:var(--ok);font-weight:700' : '' }, (o.id === x.correct_option_id ? '✓ ' : '• ') + o.text)),
        h('div', { class: 'explain bidi' }, x.explanation, x.evidence[0] && h('blockquote', {}, `«${x.evidence[0].quote}» — ${x.evidence[0].doc_title || ''} ص${x.evidence[0].page}`)),
        h('p', { class: 'small muted' }, `الغرض: ${x.purpose} · فحوص: ${x.validation?.issues?.length ? x.validation.issues.map((i) => i.message).join('، ') : 'لا ملاحظات'}`)))), { wide: true });
  }
  await draw();
  return root;
}
