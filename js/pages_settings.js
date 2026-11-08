import { h, api, fill, toast, confirmDialog, spinner, errorBox, emptyState, state, TYPE_AR } from './core.js?v=a51b1c9411';

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
/** the composer's OPEN model on this device - every browser (Safari, Firefox, Chrome, phones): state, download, «try it now», and what it did in the last quiz */
function semanticCard() {
  const box = h('div', { class: 'card', id: 'semantic-ai' }, spinner('جارٍ فحص النموذج المفتوح على هذا الجهاز…'));
  const secs = (ms) => (ms / 1000).toLocaleString('ar', { maximumFractionDigits: 1 }) + ' ث';
  const draw = async () => {
    let st; try { st = await api('GET', '/api/semantic'); } catch (ex) { box.replaceChildren(h('h2', {}, 'ذكاء وكيل الصياغة على هذا الجهاز'), errorBox(ex)); return; }
    const intro = h('p', { class: 'muted' }, 'مجاني بالكامل: نموذج مفتوح صغير (all-MiniLM-L6-v2) يعمل داخل المتصفح نفسه — Safari وFirefox وChrome والجوال — بلا مفتاح ولا خادم ولا تكلفة، ولا يخرج شيء من الجهاز. يقرأ المعنى لا الحروف: يكتشف سؤالين يسألان المعلومة نفسها بكلمات مختلفة (حشو مخفي)، وخيارًا خاطئًا يحمل معنى الإجابة الصحيحة (إجابتان صحيحتان)، فيعيد وكيل الصياغة كتابتهما من جزء آخر من اللكتشر. يُنزَّل مرة واحدة (نحو ٤٥ ميغابايت) مع أول كويز ثم يبقى في المتصفح. يقرأ الأسئلة الإنجليزية (لغة اللكتشرات)، ويترك الأسئلة العربية كما هي.');
    const STATE = { available: ['ok', `يعمل على هذا الجهاز ✓${st.load_ms ? ` (جاهز خلال ${secs(st.load_ms)})` : ''}`], ready: ['ok', 'منزّل على هذا الجهاز ✓ — يعمل مع كل كويز.'],
      downloadable: ['info', 'لم يُنزَّل على هذا الجهاز بعد: يُنزَّل تلقائيًا مع أول كويز، أو الآن بالزر.'], downloading: ['info', `جارٍ التنزيل… ${st.progress || 0}%`], missing: ['warn', 'ملفات النموذج غير منشورة على هذا الموقع بعد.'] };
    const [kind, text] = STATE[st.state] || STATE.missing; const out = h('div', { role: 'status', id: 'semantic-out' });
    const L = st.last; const last = L && L.state === 'available' ? h('p', { class: 'small', id: 'semantic-last' }, `آخر كويز: فُحص ${L.checked} سؤالًا في ${secs(L.ms)}، وأُعيدت كتابة ${L.dropped} (المعلومة نفسها مرتين: ${L.same_fact}، إجابتان صحيحتان: ${L.two_right}).`) : null;
    const dl = !['available', 'missing'].includes(st.state) ? h('button', { class: 'btn', id: 'semantic-download', onclick: async (ev) => { ev.target.disabled = true; out.replaceChildren(spinner('جارٍ تنزيل النموذج وتشغيله…'));
      try { await api('POST', '/api/semantic/prepare'); draw(); } catch (ex) { out.replaceChildren(errorBox(ex)); ev.target.disabled = false; } } }, 'نزّله الآن') : null;
    const WHY = { same_fact: 'المعلومة نفسها بكلمات أخرى', two_right: 'خيار خاطئ بمعنى الإجابة الصحيحة' };
    const tryBtn = st.state !== 'missing' ? h('button', { class: 'btn primary', id: 'semantic-try', onclick: async (ev) => { ev.target.disabled = true; out.replaceChildren(spinner('يعمل النموذج على هذا الجهاز الآن…'));
      try { const r = await api('POST', '/api/semantic/try');
        out.replaceChildren(h('div', { class: 'alert ok', id: 'semantic-try-result', 'data-dropped': String(r.dropped) }, `نجح على هذا الجهاز ✓ — جاهز خلال ${secs(r.load_ms)}، وفحص ${r.checked} أسئلة في ${secs(r.ms)}.`),
          h('ul', { class: 'small', id: 'semantic-try-list' }, r.examples.map((x) => h('li', { 'data-why': x.why }, h('strong', {}, WHY[x.why] + ` (تشابه ${x.sim}): `), h('span', { dir: 'ltr' }, x.stem), ' ← ', h('span', { dir: 'ltr', class: 'muted' }, x.with))),
            r.kept.map((k) => h('li', { 'data-why': 'kept' }, h('strong', {}, 'سليم ويبقى: '), h('span', { dir: 'ltr' }, k)))),
          r.sims ? h('p', { class: 'small muted', id: 'semantic-try-sims' }, `أرقام النموذج (من 0 إلى 1): المعلومة نفسها بكلمات أخرى ${r.sims.same_fact} · خيار بمعنى الإجابة ${r.sims.twin_option} · عكس مقصود ${r.sims.opposite_option} (لا يُعدّ تكرارًا) · سؤالان مختلفان ${r.sims.unrelated}.`) : null);
        ev.target.disabled = false; } catch (ex) { out.replaceChildren(errorBox(ex)); ev.target.disabled = false; } } }, 'جرّب الآن على هذا الجهاز') : null;
    box.replaceChildren(...[h('h2', {}, 'ذكاء وكيل الصياغة على هذا الجهاز (كل المتصفحات)'), intro, h('div', { class: 'alert ' + kind, id: 'semantic-state', 'data-state': st.state }, text), last, h('div', { class: 'row' }, ...[tryBtn, dl].filter(Boolean)), out].filter(Boolean));
  };
  draw(); return box;
}

function chromeAiCard() {
  const box = h('div', { class: 'card', id: 'chrome-ai' }, spinner('جارٍ فحص نموذج Chrome المدمج…'));
  const draw = async () => {
    let st; try { st = await api('GET', '/api/chrome-ai'); } catch (ex) { box.replaceChildren(h('h2', {}, 'ذكاء Chrome المدمج لوكيل الصياغة'), errorBox(ex)); return; }
    const intro = h('p', { class: 'muted' }, 'مجاني بالكامل: نموذج مدمج في متصفح Chrome نفسه، يعمل على الجهاز بلا مفتاح ولا خادم ولا تكلفة. إن وُجد على جهاز الطالب، يفحص وكيل الصياغة كل سؤال «بلا إجابة» ويحسّن صياغة الأسئلة الإنجليزية خلال ١٠ ثوانٍ، وكل ما يقترحه يُتحقق منه مقابل نص المحاضرة. إن لم يوجد، يعمل كل شيء كما هو.');
    const last = st.last && st.last.state === 'available' ? h('p', { class: 'small', id: 'chrome-ai-last' }, `آخر كويز: فُحص ${st.last.checked} سؤالًا، حُسّنت صياغة ${st.last.polished}، واستُبدل ${st.last.dropped} لم يؤكد النموذج إجابته (${Math.round(st.last.ms / 100) / 10} ث).`) : null;
    const STATE = { available: ['ok', 'يعمل على هذا الجهاز ✓'], downloadable: ['info', 'متاح للتنزيل على هذا الجهاز (مرة واحدة، حجمه كبير).'], downloading: ['info', 'جارٍ تنزيل النموذج…'], unavailable: ['warn', 'هذا الجهاز لا يستوفي متطلبات النموذج (Chrome 148 أو أحدث لسطح المكتب، مساحة فارغة ٢٢GB، ومعالج رسوميات بأكثر من ٤GB أو ذاكرة ١٦GB).'],
      unsupported: ['info', 'هذا المتصفح لا يوفّر نموذج Chrome المدمج (يلزم Chrome 148 أو أحدث على الحاسوب). لا بأس: النموذج المفتوح أعلاه يعمل هنا ويساند وكيل الصياغة.'] };
    const [kind, text] = STATE[st.state] || STATE.unavailable; const out = h('div', { role: 'status' });
    const dl = st.state === 'downloadable' ? h('button', { class: 'btn', id: 'chrome-ai-download', onclick: async (ev) => { ev.target.disabled = true; out.replaceChildren(spinner('جارٍ التنزيل… قد يستغرق دقائق.'));
      try { await api('POST', '/api/chrome-ai/prepare'); draw(); } catch (ex) { out.replaceChildren(errorBox(ex)); ev.target.disabled = false; } } }, 'نزّل النموذج على هذا الجهاز') : null;
    // since Chrome 148 (May 2026) the Prompt API is stable on websites: no origin-trial token; what decides is the browser and the device
    const token = st.state !== 'available' ? h('p', { class: 'small muted', id: 'chrome-ai-req' }, 'لا يحتاج أي رمز: يعمل على المواقع مباشرة منذ Chrome 148، على الحاسوب فقط (ويندوز وماك ولينكس) بشرط مساحة فارغة ٢٢GB، ومعالج رسوميات بذاكرة أكثر من ٤GB أو ذاكرة ١٦GB وأربع أنوية. الجوال غير مدعوم بعد.') : null;
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
// ---- AI for every visitor: a free Gemini key kept on the site's relay (a Cloudflare Worker), never in the site. Shows whether it is set up, and the steps if not.
function aiRelayCard() {
  const box = h('div', { class: 'card', id: 'ai-relay' }, spinner('جارٍ قراءة حالة وسيط الذكاء الاصطناعي…'));
  const draw = async () => {
    let st; try { st = await api('GET', '/api/llm/relay-status'); } catch (ex) { box.replaceChildren(h('h2', {}, 'الذكاء الاصطناعي لكل الزوار'), errorBox(ex)); return; }
    const head = h('h2', {}, 'الذكاء الاصطناعي لكل الزوار');
    const intro = h('p', { class: 'muted' }, 'كتابة الأسئلة بنموذج Gemini مجاني، لكل زائر، بلا تسجيل منه وبلا مفتاح في الموقع: المفتاح يبقى على وسيط (Cloudflare Worker) تنشئه مرة واحدة. عند نفاد الحصة اليومية المجانية أو تعذّر الوسيط، يُبنى الكويز محليًا تلقائيًا، فلا يتوقف أحد.');
    if (!st.configured) {
      box.replaceChildren(head, intro, h('div', { class: 'alert info', id: 'relay-state', 'data-state': 'off' }, 'غير مفعّل الآن: كل كويز يُبنى محليًا على جهاز الطالب (مجانًا). لتفعيله:'),
        h('ol', { class: 'steps plain', id: 'relay-steps' },
          h('li', {}, h('div', {}, 'أنشئ مفتاح Gemini مجاني من ', h('code', { dir: 'ltr' }, 'aistudio.google.com/apikey'), ' (بلا بطاقة دفع).')),
          h('li', {}, h('div', {}, 'في Cloudflare: Workers & Pages ← Create ← Worker ← الصق محتوى ', h('code', { dir: 'ltr' }, 'relay/cloudflare-worker.mjs'), ' ← Deploy، ثم Settings ← Variables: ', h('code', { dir: 'ltr' }, 'GEMINI_API_KEY'), ' (Secret) و', h('code', { dir: 'ltr' }, 'ALLOWED_ORIGIN'), ' (عنوان موقعك).')),
          h('li', {}, h('div', {}, 'في GitHub: Settings ← Secrets and variables ← Actions ← Variables: أضف ', h('code', { dir: 'ltr' }, 'QZ_RELAY'), ' = عنوان الـWorker، ثم أعد تشغيل آخر Workflow.')),
          h('li', {}, h('div', {}, 'الدليل الكامل خطوة بخطوة: ', h('code', { dir: 'ltr' }, 'docs/SETUP-AI.md'), '.'))));
      return; }
    if (!st.reachable) { box.replaceChildren(head, intro, h('div', { class: 'alert warn', id: 'relay-state', 'data-state': 'unreachable' }, 'الوسيط مضبوط في الموقع لكنه لا يستجيب: تأكد أن الـWorker منشور وأن العنوان صحيح', st.address ? [' (', h('code', { dir: 'ltr' }, st.address), ')'] : null, '.')); return; }
    const checks = [[st.key_set, 'مفتاح Gemini مضبوط على الوسيط'], [st.origin_set, 'عنوان الموقع مضبوط على الوسيط (ALLOWED_ORIGIN)'], [st.origin_ok, 'عنوان هذا الموقع مقبول لدى الوسيط']];
    const allOk = checks.every((c) => c[0]);
    box.replaceChildren(head, intro,
      h('div', { class: 'alert ' + (allOk ? 'ok' : 'warn'), id: 'relay-state', 'data-state': allOk ? 'on' : 'half' }, allOk ? 'مفعّل ✓ — يكتب الأسئلة بنموذج ' + (st.model || 'Gemini') + '، ويعود إلى المولّد المحلي عند أي تعذّر.' : 'الوسيط يستجيب لكن إعداده ناقص:'),
      h('ul', { class: 'checks' }, checks.map((c) => h('li', { class: c[0] ? 'ok' : 'bad' }, (c[0] ? '✓ ' : '✗ ') + c[1]))));
  };
  draw(); return box;
}

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
  fill(root, h('h1', {}, 'وضع المشغل'), h('p', { class: 'muted' }, state.caps?.relay ? 'الأسئلة تُكتب بالذكاء الاصطناعي (Gemini) عبر وسيط الموقع، وتعود إلى المولّد المحلي المجاني عند أي تعذّر.' : 'كل الكويزات تُنشأ على جهاز الطالب بالمولّد المحلي، بلا أي خدمة ذكاء اصطناعي وبلا تكلفة.'),
    accBox, aiRelayCard(), semanticCard(), chromeAiCard(), reportsCard(),
    h('div', { class: 'card' }, h('button', { class: 'btn danger', id: 'op-off', onclick: () => toggle(false) }, 'إيقاف وضع المشغل على هذا الجهاز')));
  drawAccounts();
  return root;
}
