import { h, api, fill, toast, confirmDialog, spinner, errorBox, emptyState, state, TYPE_AR } from './core.js?v=932a8d1e48';

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

/** the operator's view of the students' reports and what the composer (rules.js COMPOSER) did with them on this device */
const KIND_AR = { wrong_key: 'الإجابة خطأ', not_in_source: 'غير موجود في المصدر', unclear: 'غير واضح', bad_distractor: 'خيارات ضعيفة', duplicate: 'مكرر', language: 'لغوي', other: 'أخرى' };
function reportsCard() {
  const box = h('div', { class: 'card', id: 'reports-box' }, spinner('جارٍ قراءة البلاغات…'));
  const draw = async (st) => {
    try { st = st || await api('GET', '/api/composer/reports'); } catch (ex) { box.replaceChildren(h('h2', {}, 'بلاغات الطلاب'), errorBox(ex)); return; }
    const head = st.total ? h('div', { class: 'alert ok', id: 'reports-state', 'data-total': String(st.total) }, h('strong', {}, `${st.total} بلاغ عولج ✓ `),
      `${st.blocked_questions} سؤالًا لن يُكتب مرة أخرى${st.blocked_facts ? `، و${st.blocked_facts} معلومة لن تُسأل بالصياغة نفسها` : ''}.`)
      : h('div', { class: 'alert info', id: 'reports-state', 'data-total': '0' }, 'لا بلاغات على هذا الجهاز بعد.');
    const kinds = Object.entries(st.kinds || {}); const resetBtn = h('button', { class: 'btn small danger', id: 'reports-reset', onclick: async () => { if (!(await confirmDialog('مسح البلاغات؟', 'يعود وكيل الصياغة إلى تقييمه الأساسي للصياغات على هذا الجهاز.', 'امسح', true))) return; draw(await api('POST', '/api/composer/reports/reset')); toast('مُسحت البلاغات', 'ok'); } }, 'مسح البلاغات');
    box.replaceChildren(...[h('h2', {}, 'بلاغات الطلاب'),
      h('p', { class: 'muted' }, 'يعالج وكيل الصياغة كل بلاغ عن سؤال كتبه: لا يكتب السؤال نفسه مرة أخرى، وإن كان البلاغ «الإجابة خطأ» أو «غير موجود في المصدر» أو «خيارات ضعيفة» لا يعود إلى تلك المعلومة بالصياغة نفسها، ويُضعف الصياغة المُبلّغ عنها في الكويزات القادمة على هذا الجهاز.'),
      head,
      kinds.length ? h('p', { class: 'small' }, kinds.map(([k, n]) => `${KIND_AR[k] || k}: ${n}`).join(' · ')) : null,
      st.forms.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'reports-forms' }, h('thead', {}, h('tr', {}, ['الصياغة', 'النوع', 'بلاغات', 'إضعافها'].map((t) => h('th', {}, t)))),
        h('tbody', {}, st.forms.slice(0, 12).map((f) => h('tr', { 'data-form': f.form }, h('td', {}, FORM_AR[f.form] || f.form), h('td', { class: 'small muted' }, TYPE_AR[f.qtype] || f.qtype || ''), h('td', {}, f.reports), h('td', {}, pct(f.penalty / 0.3)))))))
        : null,
      st.total ? h('div', { class: 'row' }, resetBtn) : null].filter(Boolean));      // replaceChildren would print a null
  };
  draw(); return box;
}

/** Unlisted page (#/operator): switches OPERATOR mode on for this device and shows the accounts check, the students' reports (handled by the composer) and the state of
 *  Chrome's built-in model (the composer's zero-cost AI) on this device. Quizzes are made locally; there is no AI key anywhere in the site. */
export async function operatorPage() {
  if (state.caps?.edition !== 'web') return h('div', { class: 'card' }, emptyState('⚙', 'غير متاح هنا', 'وضع المشغل خاص بموقع GitHub Pages.'));
  const root = h('div', { style: 'max-width:760px;margin:auto' });
  const toggle = async (on) => { await api('POST', '/api/operator', { on }); await refreshCaps(); location.hash = on ? '#/operator?on=' + Date.now() : '#/'; };      // no account yet: stay here (that is where the accounts check is)
  await refreshCaps();
  if (!state.caps?.operator) {
    fill(root, h('h1', {}, 'وضع المشغل'), h('div', { class: 'card' },
      h('p', {}, 'هذه الصفحة لصاحب الموقع فقط: فحص الحسابات، وبلاغات الطلاب وما فعله بها وكيل الصياغة، وحالة ذكاء Chrome المدمج لوكيل الصياغة على هذا الجهاز. الزوار لا يرونها.'),
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
    accBox, chromeAiCard(), reportsCard(),
    h('div', { class: 'card' }, h('button', { class: 'btn danger', id: 'op-off', onclick: () => toggle(false) }, 'إيقاف وضع المشغل على هذا الجهاز')));
  drawAccounts();
  return root;
}
