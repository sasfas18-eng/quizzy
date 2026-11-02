import { h, api, fill, toast, confirmDialog, spinner, errorBox, emptyState, state, TYPE_AR } from './core.js?v=9edf45c425';

async function refreshCaps() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }   // AI availability changed
}

/** The notice shown where an AI was needed but none is available (the Claude edition, when Claude is not granted). The web edition has no AI at all: its quizzes are made locally. */
export function aiConnectCard() {
  const caps = state.caps || {};
  return h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير متاح الآن. '), caps.ai_missing || 'لم يُجهَّز الذكاء الاصطناعي هنا.');
}

// the local generator's question shapes (claude-edition/rules.js FORMS), named for the operator's panel of the self-learning agent
const FORM_AR = { defMeaning: 'معنى المصطلح', effectRecall: 'تذكّر الأثر', pickExample: 'اختيار المثال', setOf: 'عناصر مجموعة', cloze: 'إكمال كلمة', listBelongs: 'ينتمي إلى القائمة', defCloze: 'إكمال التعريف',
  defToTerm: 'من التعريف إلى المصطلح', acroQ: 'معنى الاختصار', statement: 'العبارة الصحيحة', causeEffect: 'سبب ← نتيجة', purposeQ: 'الغرض من', effectCause: 'نتيجة ← سبب',
  famLead: 'إلى أي فئة ينتمي', exampleOf: 'مثال على', rangeQ: 'قيمة ضمن مدى', numValue: 'قيمة رقمية', numStatement: 'عبارة رقمية', listNot: 'ليس من القائمة', leastEffect: 'الأقل ارتباطًا',
  falseOf: 'العبارة الخاطئة عن', exceptPoint: 'كل ما يلي إلا', famOrder: 'ترتيب عناصر سلسلة', seqOrder: 'ترتيب الخطوات', seqNext: 'الخطوة التالية', pairing: 'مطابقة زوج', distinguish: 'ما يميّز أ عن ب',
  contrast: 'مقارنة', matchRow: 'صف من جدول', bestEffect: 'أفضل وصف للأثر', bestPoint: 'أفضل نقطة', bestDef: 'أفضل تعريف', bestOf: 'أفضل إجابة', caseEffect: 'حالة: الأثر المتوقع',
  caseExample: 'حالة: أي مثال', caseLead: 'حالة: أي فئة', scenario: 'سيناريو', accurateOf: 'الأدق عن', caution: 'تنبيه وحذر' };
const pct = (x) => Math.round(x * 100) + '%';
/** the composer's zero-cost AI on THIS device: Chrome's built-in model (no key, no server, no request leaves the device) */
function chromeAiCard() {
  const box = h('div', { class: 'card', id: 'chrome-ai' }, spinner('جارٍ فحص نموذج Chrome المدمج…'));
  const draw = async () => {
    let st; try { st = await api('GET', '/api/chrome-ai'); } catch (ex) { box.replaceChildren(h('h2', {}, 'ذكاء Chrome المدمج لوكيل الصياغة'), errorBox(ex)); return; }
    const intro = h('p', { class: 'muted' }, 'مجاني بالكامل: نموذج مدمج في متصفح Chrome نفسه، يعمل على الجهاز بلا مفتاح ولا خادم ولا تكلفة. إن وُجد على جهاز الطالب، يفحص وكيل الصياغة كل سؤال «بلا إجابة» ويحسّن صياغة الأسئلة الإنجليزية خلال ١٠ ثوانٍ، وكل ما يقترحه يُتحقق منه مقابل نص المحاضرة. إن لم يوجد، يعمل كل شيء كما هو.');
    const last = st.last && st.last.state === 'available' ? h('p', { class: 'small', id: 'chrome-ai-last' }, `آخر كويز: فُحص ${st.last.checked} سؤالًا، حُسّنت صياغة ${st.last.polished}، واستُبدل ${st.last.dropped} لم يؤكد النموذج إجابته (${Math.round(st.last.ms / 100) / 10} ث).`) : null;
    const STATE = { available: ['ok', 'يعمل على هذا الجهاز ✓'], downloadable: ['info', 'متاح للتنزيل على هذا الجهاز (مرة واحدة، حجمه كبير).'], downloading: ['info', 'جارٍ تنزيل النموذج…'], unavailable: ['warn', 'هذا الجهاز لا يستوفي متطلبات النموذج (Chrome لسطح المكتب وذاكرة ١٦GB أو معالج رسوميات جيد).'],
      unsupported: ['warn', 'متصفح هذا الجهاز لا يوفّر النموذج المدمج (يعمل في Chrome لسطح المكتب فقط، لا الجوال ولا Safari/Firefox).'] };
    const [kind, text] = STATE[st.state] || STATE.unavailable; const out = h('div', { role: 'status' });
    const dl = st.state === 'downloadable' ? h('button', { class: 'btn', id: 'chrome-ai-download', onclick: async (ev) => { ev.target.disabled = true; out.replaceChildren(spinner('جارٍ التنزيل… قد يستغرق دقائق.'));
      try { await api('POST', '/api/chrome-ai/prepare'); draw(); } catch (ex) { out.replaceChildren(errorBox(ex)); ev.target.disabled = false; } } }, 'نزّل النموذج على هذا الجهاز') : null;
    const token = !st.token && st.state !== 'available' ? h('p', { class: 'small muted', id: 'chrome-ai-token' }, 'على المواقع ما زال هذا النموذج تجريبيًا في Chrome: يلزم «رمز تجربة» مجاني لعنوان موقعك من صفحة Chrome Origin Trials (Prompt API) يوضع في config.js في الحقل ', h('code', { dir: 'ltr' }, 'chromeAiToken'), '. الرمز ليس سرًّا.') : null;
    box.replaceChildren(...[h('h2', {}, 'ذكاء Chrome المدمج لوكيل الصياغة'), intro, h('div', { class: 'alert ' + kind, id: 'chrome-ai-state', 'data-state': st.state }, text), last, token, dl, out].filter(Boolean));
  };
  draw(); return box;
}

/** the operator's view of the self-learning agent (rules.js LEARN): what it learned from students' answers on this device, and how it now orders the generator */
function learnerCard() {
  const box = h('div', { class: 'card', id: 'learner-box' }, spinner('جارٍ قراءة ما تعلّمه الوكيل…'));
  const draw = async (st) => {
    try { st = st || await api('GET', '/api/learner'); } catch (ex) { box.replaceChildren(h('h2', {}, 'وكيل التعلّم الذاتي'), errorBox(ex)); return; }
    const tried = st.forms.filter((f) => f.answered || f.reports);
    const head = st.ready ? h('div', { class: 'alert ok', id: 'learner-state', 'data-ready': '1' }, h('strong', {}, 'يعمل ✓ '), `تعلّم من ${st.answers} إجابة${st.reports ? ` و${st.reports} بلاغ` : ''}، ويرتّب الآن صياغات كل نوع بحسب ما تعلّمه.`)
      : h('div', { class: 'alert info', id: 'learner-state', 'data-ready': '0' }, h('strong', {}, 'يجمع الأدلة: '), `${st.answers} من ${st.min_answers} إجابة. قبل ذلك يعمل المولّد بترتيبه الأساسي المأخوذ من نماذج المعلمين، ثم يبدأ الوكيل إعادة الترتيب وحده.`);
    const exportBtn = h('button', { class: 'btn small', id: 'learner-export', onclick: async () => { const r = await api('GET', '/api/learner?export=1'); const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r.state, null, 1)], { type: 'application/json' })), download: 'quizzy-learner.json' }); document.body.append(a); a.click(); a.remove(); } }, 'تصدير ما تعلّمه');
    const resetBtn = h('button', { class: 'btn small danger', id: 'learner-reset', onclick: async () => { if (!(await confirmDialog('مسح ما تعلّمه الوكيل؟', 'يعود المولّد إلى ترتيبه الأساسي على هذا الجهاز، ويبدأ الوكيل التعلّم من جديد.', 'امسح', true))) return; draw(await api('POST', '/api/learner/reset')); toast('مُسح ما تعلّمه الوكيل', 'ok'); } }, 'مسح والبدء من جديد');
    box.replaceChildren(...[h('h2', {}, 'وكيل التعلّم الذاتي'),
      h('p', { class: 'muted' }, 'يتعلّم من كل إجابة يحلّها الطالب ومن كل بلاغ عن سؤال: أي صياغة تقيس الفهم فعلًا (صعوبة مناسبة قرب ٦٠٪ إجابات صحيحة، بلا بلاغات)، ثم يقدّم المولّد المحلي الأفضل منها تلقائيًا. يتعلّم على الجهاز الذي تُحلّ عليه الكويزات.'),
      head,
      tried.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'learner-forms' }, h('thead', {}, h('tr', {}, ['الصياغة', 'النوع', 'أُجيبت', 'صحيحة', 'بلاغات', 'التقييم'].map((t) => h('th', {}, t)))),
        h('tbody', {}, tried.slice(0, 12).map((f) => h('tr', { 'data-form': f.form }, h('td', {}, FORM_AR[f.form] || f.form), h('td', { class: 'small muted' }, TYPE_AR[f.qtype] || f.qtype), h('td', {}, f.answered), h('td', {}, f.answered ? pct(f.correct / f.answered) : '—'), h('td', {}, f.reports), h('td', {}, pct(f.score)))))))
        : h('p', { class: 'small muted' }, 'لم تُحلّ أسئلة من المولّد المحلي على هذا الجهاز بعد.'),
      h('div', { class: 'row' }, exportBtn, resetBtn)].filter(Boolean));      // replaceChildren would print a null
  };
  draw(); return box;
}

/** Unlisted page (#/operator): switches OPERATOR mode on for this device — the AI box exists only here — and shows whether Claude is available to
 *  every visitor through the relay (the safe way to share one key: the key stays on the relay, never in the site). */
export async function operatorPage() {
  if (state.caps?.edition !== 'web') return h('div', { class: 'card' }, emptyState('⚙', 'غير متاح هنا', 'وضع المشغل خاص بموقع GitHub Pages.'));
  const root = h('div', { style: 'max-width:760px;margin:auto' });
  const toggle = async (on) => { await api('POST', '/api/operator', { on }); await refreshCaps(); location.hash = on ? '#/operator?on=' + Date.now() : '#/'; };      // no account yet: stay here (that is where the accounts check is)
  await refreshCaps();
  if (!state.caps?.operator) {
    fill(root, h('h1', {}, 'وضع المشغل'), h('div', { class: 'card' },
      h('p', {}, 'هذه الصفحة لصاحب الموقع فقط: فحص الحسابات، ولوحة وكيل التعلّم، وحالة ذكاء Chrome المدمج لوكيل الصياغة على هذا الجهاز. الزوار لا يرونها.'),
      h('button', { class: 'btn primary', id: 'op-on', onclick: () => toggle(true) }, 'تفعيل وضع المشغل على هذا الجهاز')));
    return root;
  }
  // ---- accounts: are the cloud accounts (e-mail + password) on, and is the project really ready?
  const accBox = h('div', { class: 'card', id: 'accounts-status' }, spinner('جارٍ قراءة حالة الحسابات…'));
  const drawAccounts = async () => {
    let st; try { st = await api('GET', '/api/accounts/status'); } catch (ex) { accBox.replaceChildren(h('h2', {}, 'الحسابات السحابية'), h('div', { class: 'alert bad' }, ex.message)); return; }
    if (st.secret_key) { accBox.replaceChildren(h('h2', {}, 'الحسابات السحابية: أُوقفت لخطر أمني'), h('div', { class: 'alert bad', id: 'accounts-secret' }, 'المفتاح الموضوع في إعدادات الموقع مفتاح سرّي (service_role)، ولو عمل لأعطى كل زائر قاعدة بياناتك. أُوقفت الحسابات. ضع مفتاح anon العام بدلًا منه، وأبطل السرّي من Project Settings > API في Supabase لأنه صار علنيًا.')); return; }
    if (!st.configured) {
      accBox.replaceChildren(h('h2', {}, 'الحسابات السحابية: غير مفعّلة'),
        h('p', { class: 'muted' }, st.half ? 'الإعداد ناقص: يلزم عنوان المشروع ومفتاحه العام معًا.' : 'الموقع يعمل الآن بحسابات على هذا الجهاز: بريد وكلمة مرور يُحفظان في متصفح صاحبهما فقط (لا انتقال بين الأجهزة، ولا استعادة لكلمة المرور). لحسابات سحابية حقيقية:'),
        h('ol', { class: 'steps plain', id: 'accounts-steps' },
          h('li', {}, h('div', {}, 'أنشئ مشروعًا مجانيًا في ', h('code', { dir: 'ltr' }, 'supabase.com'), '، ثم SQL Editor ← New query ← الصق محتوى ', h('code', { dir: 'ltr' }, 'supabase/schema.sql'), ' ← Run.')),
          h('li', {}, h('div', {}, 'Authentication ← URL Configuration: اجعل Site URL عنوان موقعك هذا.')),
          h('li', {}, h('div', {}, 'Project Settings ← API: انسخ ', h('strong', {}, 'Project URL'), ' و', h('strong', {}, 'anon public key'), ' (لا تنسخ service_role أبدًا).')),
          h('li', {}, h('div', {}, 'في GitHub: Settings ← Secrets and variables ← Actions ← Variables: أضف ', h('code', { dir: 'ltr' }, 'QZ_SUPABASE_URL'), ' و', h('code', { dir: 'ltr' }, 'QZ_SUPABASE_ANON_KEY'), '، ثم أعد تشغيل آخر Workflow. ثم عُد إلى هذه البطاقة واضغط «افحص الحسابات».'))));
      return; }
    const out = h('div', { id: 'accounts-result' });
    accBox.replaceChildren(h('h2', {}, 'الحسابات السحابية: مفعّلة ✓'), h('p', { class: 'muted' }, 'التسجيل والدخول بالبريد وكلمة المرور، وبيانات كل طالب معزولة عن غيره في ', h('code', { dir: 'ltr' }, st.host || 'Supabase'), '.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', id: 'accounts-check', onclick: async (ev) => { ev.target.disabled = true; out.replaceChildren(spinner('جارٍ الفحص…'));
        try { const r = await api('POST', '/api/accounts/check'); out.replaceChildren(h('ul', { class: 'checks' }, r.steps.map((x) => h('li', { class: x.ok ? 'ok' : 'bad' }, (x.ok ? '✓ ' : '✗ ') + x.text)))); } catch (ex) { out.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); } ev.target.disabled = false; } }, 'افحص الحسابات')), out);
  };
  fill(root, h('h1', {}, 'وضع المشغل'), h('p', { class: 'muted' }, 'كل الكويزات تُنشأ على جهاز الطالب بالمولّد المحلي، بلا أي خدمة ذكاء اصطناعي وبلا تكلفة.'),
    accBox, chromeAiCard(), learnerCard(),
    h('div', { class: 'card' }, h('button', { class: 'btn danger', id: 'op-off', onclick: () => toggle(false) }, 'إيقاف وضع المشغل على هذا الجهاز')));
  drawAccounts();
  return root;
}
