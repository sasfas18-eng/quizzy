import { h, api, fill, toast, confirmDialog, spinner, errorBox, emptyState, state, TYPE_AR } from './core.js';

const PRESETS = {
  gemini: { label: 'Google Gemini (طبقة مجانية)', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', model: '', rpm: 9, link: 'https://aistudio.google.com/apikey', linkText: 'aistudio.google.com/apikey', how: 'افتح الرابط وسجّل بحساب Google ثم اضغط «Create API key» وانسخ المفتاح.' },
  groq: { label: 'Groq (طبقة مجانية بحدود)', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: '', rpm: 25, link: 'https://console.groq.com/keys', linkText: 'console.groq.com/keys', how: 'سجّل ثم اضغط «Create API Key» وانسخ المفتاح.' },
  openrouter: { label: 'OpenRouter (نماذج مجانية :free)', kind: 'openai', base: 'https://openrouter.ai/api/v1', model: '', rpm: 15, link: 'https://openrouter.ai/keys', linkText: 'openrouter.ai/keys', how: 'سجّل ثم «Create Key» وانسخ المفتاح (الحدود المجانية أضيق).' },
  anthropic: { label: 'Anthropic Claude (برصيدك المدفوع)', kind: 'anthropic', base: 'https://api.anthropic.com', model: '', rpm: 40, link: 'https://platform.claude.com/settings/keys', linkText: 'platform.claude.com/settings/keys', how: 'لا يوجد «تفعيل» للرصيد: ما اشتريته يظهر فورًا في Billing. المطلوب مفتاح: سجّل الدخول بنفس الحساب ← «Create key» (النطاق: Default workspace، والمدة: Never) ← انسخه (يظهر مرة واحدة). يُخصم من رصيدك المدفوع؛ حدّد سقف إنفاق شهريًا من Billing لتطمئن.' },
  ollama: { label: 'Ollama على جهازك (بلا حد)', kind: 'openai', base: 'http://localhost:11434/v1', model: '', rpm: 120, link: '', linkText: '', how: 'شغّل Ollama بالمتغير OLLAMA_ORIGINS ليسمح بهذا الموقع.' },
  custom: { label: 'مزوّد آخر متوافق مع OpenAI', kind: 'openai', base: '', model: '', rpm: 20, link: '', linkText: '', how: '' },
};
const QUICK = ['anthropic', 'gemini', 'groq', 'openrouter'];
// Claude models offered on the card (the operator's own money: the choice is theirs, so it is explicit, not silent)
const CLAUDE_MODELS = [['claude-opus-5-5', 'Opus 5.5 — الأقوى والأغلى'], ['claude-sonnet-5-5', 'Sonnet 5.5 — متوازن (الأنسب لرصيد صغير)'], ['claude-haiku-5-5', 'Haiku 5.5 — الأرخص والأسرع']];
/** failures that belong to the MODEL that was tried (not to the key or the network): the connect card goes on to the next model of the provider's list */
const MODEL_PROBLEM = /بصيغة JSON|بجواب فارغ|حدّ الإخراج|لا يردّ بصيغة|HTTP 404|not_found|decommissioned|does not exist|النموذج غير متاح/i;
/** plain-Arabic reasons for the failures an operator actually meets when connecting a key */
function explainAiError(msg) {
  const m = String(msg || '');
  if (/بصيغة JSON|حدّ الإخراج|بجواب فارغ|لا يردّ بصيغة|مزدحمة مؤقتًا|عطل مؤقت عند المزوّد|حدّ الطلبات المسموح/.test(m)) return m;       // already plain Arabic naming the model and what it answered (a model that does not answer in JSON; a thinking model out of room)
  if (/not scoped to a workspace|anthropic-workspace-id|ANTHROPIC_WORKSPACE_ID/i.test(m)) return 'هذا المفتاح غير مقيّد بمساحة عمل (Workspace). الأسهل: احذفه وأنشئ مفتاحًا جديدًا من platform.claude.com/settings/keys واختر النطاق Default workspace (لا Organization). وإن كنت تستعمل الوسيط وتريد مفتاح Organization، أضف عليه المتغير ANTHROPIC_WORKSPACE_ID = معرّف مساحة العمل (يبدأ بـ wrkspc_ ويظهر في عمود ID بصفحة Workspaces).';
  if (/usage limits|usage threshold|enforced_spend_limit/i.test(m)) return 'وصل حسابك إلى سقف الإنفاق الذي حدّدته (Billing ← Spend limits). ارفع الحد من platform.claude.com/settings/billing أو انتظر بداية الشهر القادم؛ وفي هذه الأثناء يعمل الموقع بالتوليد المحلي.';
  if (/credit balance|billing|purchase credits/i.test(m)) return 'رصيد حسابك في Anthropic غير كافٍ أو لم يُفعَّل بعد: افتح platform.claude.com/settings/billing وتأكد أن الرصيد (مثل الـ5 دولار) ظاهر، ثم أعد المحاولة.';
  if (/HTTP 401|HTTP 403|auth|غير صالح/i.test(m)) return 'المفتاح غير صالح أو غير مصرّح له أو انتهت مدته. تأكد أنك نسخته كاملًا (مفاتيح API تبدأ بـ sk-ant-api)، وأنه من نفس حساب الرصيد، وأنك اخترت Expiration = Never عند إنشائه.';
  if (/HTTP 404|not_found|model/i.test(m) && /HTTP 404|not_found/i.test(m)) return 'هذا النموذج غير متاح لمفتاحك؛ اختر نموذجًا آخر من القائمة.';
  return m || 'تعذّر الربط.';
}

async function refreshCaps() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }   // AI availability changed
}

/** Compact "connect the AI" card (new-quiz page, failure view, settings). One field: paste the key.
 *  The model is discovered from what the key can use, so nobody has to know model names. `onDone` runs once it works. */
export function aiConnectCard(onDone) {
  const caps = state.caps || {};
  if (!caps.byok) return h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير متاح الآن. '), caps.ai_missing || 'لم يُجهَّز الذكاء الاصطناعي على هذا الخادم بعد.');
  let preset = 'anthropic';
  const how = h('div', { class: 'hint' });
  const model = h('select', { id: 'quick-model', 'aria-label': 'نموذج Claude' }, CLAUDE_MODELS.map(([v, l]) => h('option', { value: v }, l)));
  model.value = 'claude-sonnet-5-5';                                   // pre-selected for a small prepaid balance; all three stay visible and the choice is the operator's
  const modelRow = h('div', { class: 'field', id: 'quick-model-row', style: 'margin:.5rem 0 0' }, h('label', { for: 'quick-model' }, 'نموذج Claude'), model,
    h('div', { class: 'hint' }, 'تقدير تقريبي لتكلفة كويز من ٢٠ سؤالًا: Opus ≈ ١–٢ دولار · Sonnet ≈ نصف دولار إلى دولار · Haiku ≈ بضعة سنتات. اختر حسب رصيدك.'));
  const drawHow = () => { const p = PRESETS[preset]; how.replaceChildren(p.how + ' ', p.link ? h('a', { href: p.link, target: '_blank', rel: 'noopener', dir: 'ltr' }, p.linkText) : ''); modelRow.style.display = preset === 'anthropic' ? '' : 'none'; };
  const sel = h('select', { id: 'quick-preset', 'aria-label': 'المزوّد', onchange: (e) => { preset = e.target.value; drawHow(); } }, QUICK.map((k) => h('option', { value: k }, PRESETS[k].label)));
  const key = h('input', { id: 'quick-key', type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: 'الصق المفتاح هنا', 'aria-label': 'المفتاح' });
  const status = h('div', { class: 'hint', role: 'status' });
  const err = h('div', { role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit', id: 'quick-go' }, 'ربط وتجربة');
  const form = h('form', { class: 'card', id: 'connect-ai', onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren(); status.textContent = '';
    const k = key.value.trim(); if (!k) { err.replaceChildren(h('div', { class: 'alert bad' }, 'الصق المفتاح أولًا.')); return; }
    const p = PRESETS[preset]; btn.disabled = true; let added = null;
    try {
      let list = [model.value];                                              // Claude: the operator picked the model above
      if (preset !== 'anthropic') {
        status.textContent = 'جارٍ فحص المفتاح…';
        const found = await api('POST', '/api/llm/discover', { kind: p.kind, base: p.base, key: k });
        list = (found.candidates && found.candidates.length ? found.candidates : [found.suggested]).filter(Boolean);
        if (!list.length) throw new Error('لم أجد نموذجًا مناسبًا لهذا المفتاح. جرّب مزوّدًا آخر أو أضِف النموذج يدويًا من صفحة «ربط الذكاء الاصطناعي».');
      }
      let chosen = '', lastEx = null, busyNote = '';
      for (const [i, m] of list.entries()) {                                                 // a problem of THIS model (it never answers in JSON, it is not available to the key) -> the next model of the list; a problem of the key stops here
        status.textContent = `جارٍ تجربة النموذج ${m}…`;
        const eps = await api('POST', '/api/llm/endpoints', { name: p.label.split(' (')[0], kind: p.kind, base: p.base, key: k, model: m, rpm: p.rpm, ...(preset === 'openrouter' ? { alts: list.slice(i + 1, i + 3) } : {}) }); added = eps[eps.length - 1];
        try { const r = await api('POST', '/api/llm/test', { id: added.id }); if (r && r.busy) busyNote = r.message || ''; chosen = m; lastEx = null; break; }       // busy = the provider answered AFTER checking the key: it is fine
        catch (ex) { lastEx = ex; try { await api('DELETE', `/api/llm/endpoints/${added.id}`); } catch (_) { /* ignore */ } added = null; if (!MODEL_PROBLEM.test(String(ex.message || ''))) throw ex; }
      }
      if (lastEx) throw lastEx;
      await refreshCaps(); key.value = ''; status.textContent = '';
      if (busyNote) { err.replaceChildren(h('div', { class: 'alert warn', id: 'busy-note' }, h('strong', {}, 'تم ربط المفتاح ✓ '), busyNote, ' ', h('button', { class: 'btn small', type: 'button', id: 'busy-continue', onclick: () => { if (onDone) onDone(); } }, 'متابعة'))); return; }
      toast(`تم ربط الذكاء الاصطناعي ✓ (${chosen})`, 'ok'); if (onDone) await onDone();
    } catch (ex) {
      if (added) { try { await api('DELETE', `/api/llm/endpoints/${added.id}`); } catch (_) { /* ignore */ } }
      status.textContent = ''; err.replaceChildren(h('div', { class: 'alert bad' }, explainAiError(ex.message)));
    } finally { btn.disabled = false; }
  } },
    h('h3', {}, 'اربط الذكاء الاصطناعي على هذا الجهاز (للمشغل)'),
    h('p', { class: 'muted' }, 'المفتاح يُحفظ في هذا المتصفح فقط ويُرسل مباشرة إلى المزوّد، ولا يراه أي زائر ولا يعمل لغيرك. لتعميم Claude على كل الزوار بأمان استخدم الوسيط (صفحة وضع المشغل).'),
    h('div', { class: 'row' }, h('div', { class: 'field', style: 'flex:1;min-width:200px;margin:0' }, h('label', { for: 'quick-preset' }, 'المزوّد'), sel),
      h('div', { class: 'field', style: 'flex:2;min-width:240px;margin:0' }, h('label', { for: 'quick-key' }, 'المفتاح'), key)),
    modelRow, how, status, err, h('div', { class: 'row', style: 'margin-top:.6rem' }, btn, h('a', { class: 'small', href: '#/settings' }, 'خيارات متقدمة')));
  drawHow();
  return form;
}

// the local generator's question shapes (claude-edition/rules.js FORMS), named for the operator's panel of the self-learning agent
const FORM_AR = { defMeaning: 'معنى المصطلح', effectRecall: 'تذكّر الأثر', pickExample: 'اختيار المثال', setOf: 'عناصر مجموعة', cloze: 'إكمال كلمة', listBelongs: 'ينتمي إلى القائمة', defCloze: 'إكمال التعريف',
  defToTerm: 'من التعريف إلى المصطلح', acroQ: 'معنى الاختصار', statement: 'العبارة الصحيحة', causeEffect: 'سبب ← نتيجة', purposeQ: 'الغرض من', effectCause: 'نتيجة ← سبب',
  famLead: 'إلى أي فئة ينتمي', exampleOf: 'مثال على', rangeQ: 'قيمة ضمن مدى', numValue: 'قيمة رقمية', numStatement: 'عبارة رقمية', listNot: 'ليس من القائمة', leastEffect: 'الأقل ارتباطًا',
  falseOf: 'العبارة الخاطئة عن', exceptPoint: 'كل ما يلي إلا', famOrder: 'ترتيب عناصر سلسلة', seqOrder: 'ترتيب الخطوات', seqNext: 'الخطوة التالية', pairing: 'مطابقة زوج', distinguish: 'ما يميّز أ عن ب',
  contrast: 'مقارنة', matchRow: 'صف من جدول', bestEffect: 'أفضل وصف للأثر', bestPoint: 'أفضل نقطة', bestDef: 'أفضل تعريف', bestOf: 'أفضل إجابة', caseEffect: 'حالة: الأثر المتوقع',
  caseExample: 'حالة: أي مثال', caseLead: 'حالة: أي فئة', scenario: 'سيناريو', accurateOf: 'الأدق عن', caution: 'تنبيه وحذر' };
const MUT_AR = { flip: 'عكس الاتجاه (يزيد ↔ ينقص)', swap: 'تبديل طرفين', negate: 'نفي العبارة', overclaim: 'مبالغة (دائمًا / فقط)', altered: 'تعديل جزئي للعبارة الصحيحة', sibling: 'خيار من نفس العائلة' };
const pct = (x) => Math.round(x * 100) + '%';
/** the operator's view of the self-learning agent (rules.js LEARN): what it learned from students' answers on this device, and how it now orders the generator */
function learnerCard() {
  const box = h('div', { class: 'card', id: 'learner-box' }, spinner('جارٍ قراءة ما تعلّمه الوكيل…'));
  const draw = async (st) => {
    try { st = st || await api('GET', '/api/learner'); } catch (ex) { box.replaceChildren(h('h2', {}, 'وكيل التعلّم الذاتي'), errorBox(ex)); return; }
    const tried = st.forms.filter((f) => f.answered), muts = st.muts.filter((m) => m.shown);
    const head = st.ready ? h('div', { class: 'alert ok', id: 'learner-state', 'data-ready': '1' }, h('strong', {}, 'يعمل ✓ '), `تعلّم من ${st.answers} إجابة${st.reports ? ` و${st.reports} بلاغ` : ''}، ويرتّب الآن صياغات كل نوع وخياراته الخاطئة بحسب ما تعلّمه.`)
      : h('div', { class: 'alert info', id: 'learner-state', 'data-ready': '0' }, h('strong', {}, 'يجمع الأدلة: '), `${st.answers} من ${st.min_answers} إجابة. قبل ذلك يعمل المولّد بترتيبه الأساسي المأخوذ من نماذج المعلمين، ثم يبدأ الوكيل إعادة الترتيب وحده.`);
    const exportBtn = h('button', { class: 'btn small', id: 'learner-export', onclick: async () => { const r = await api('GET', '/api/learner?export=1'); const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r.state, null, 1)], { type: 'application/json' })), download: 'quizzy-learner.json' }); document.body.append(a); a.click(); a.remove(); } }, 'تصدير ما تعلّمه');
    const resetBtn = h('button', { class: 'btn small danger', id: 'learner-reset', onclick: async () => { if (!(await confirmDialog('مسح ما تعلّمه الوكيل؟', 'يعود المولّد إلى ترتيبه الأساسي على هذا الجهاز، ويبدأ الوكيل التعلّم من جديد.', 'امسح', true))) return; draw(await api('POST', '/api/learner/reset')); toast('مُسح ما تعلّمه الوكيل', 'ok'); } }, 'مسح والبدء من جديد');
    box.replaceChildren(...[h('h2', {}, 'وكيل التعلّم الذاتي'),
      h('p', { class: 'muted' }, 'يتعلّم من كل إجابة يحلّها الطالب ومن كل بلاغ عن سؤال: أي صياغة تقيس الفهم فعلًا (صعوبة مناسبة قرب ٦٠٪ إجابات صحيحة، بلا بلاغات)، وهل يجيبها الطلاب الأقوى أكثر من الأضعف (التمييز)، وأي نوع من الخيارات الخاطئة يُقنع الطلاب فعلًا. ثم يقدّم المولّد المحلي الأفضل منها تلقائيًا. يتعلّم على الجهاز الذي تُحلّ عليه الكويزات.'),
      head,
      tried.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'learner-forms' }, h('thead', {}, h('tr', {}, ['الصياغة', 'النوع', 'أُجيبت', 'صحيحة', 'التمييز', 'بلاغات', 'التقييم'].map((t) => h('th', {}, t)))),
        h('tbody', {}, tried.slice(0, 12).map((f) => h('tr', { 'data-form': f.form }, h('td', {}, FORM_AR[f.form] || f.form), h('td', { class: 'small muted' }, TYPE_AR[f.qtype] || f.qtype), h('td', {}, f.answered), h('td', {}, pct(f.correct / f.answered)), h('td', { dir: 'ltr' }, f.disc == null ? '—' : (f.disc > 0 ? '+' : '') + f.disc.toFixed(2)), h('td', {}, f.reports), h('td', {}, pct(f.score)))))))
        : h('p', { class: 'small muted' }, 'لم تُحلّ أسئلة من المولّد المحلي على هذا الجهاز بعد.'),
      muts.length ? h('div', {}, h('h3', {}, 'الخيارات الخاطئة الأكثر إقناعًا'), h('ul', { id: 'learner-muts' }, muts.map((m) => h('li', { 'data-kind': m.kind }, `${MUT_AR[m.kind] || m.kind}: اختاره الطلاب ${m.picked} من ${m.shown} مرة`)))) : null,
      h('div', { class: 'row' }, exportBtn, resetBtn)].filter(Boolean));      // replaceChildren would print a null
  };
  draw(); return box;
}

/** Unlisted page (#/operator): switches OPERATOR mode on for this device — the AI box exists only here — and shows whether Claude is available to
 *  every visitor through the relay (the safe way to share one key: the key stays on the relay, never in the site). */
export async function operatorPage() {
  if (state.caps?.edition !== 'web') return h('div', { class: 'card' }, emptyState('⚙', 'غير متاح هنا', 'وضع المشغل خاص بموقع GitHub Pages.'));
  const root = h('div', { style: 'max-width:760px;margin:auto' });
  const toggle = async (on) => { await api('POST', '/api/operator', { on }); await refreshCaps(); location.hash = on ? (state.user ? '#/settings' : '#/operator?on=' + Date.now()) : '#/'; };      // no account yet: stay here (that is where the accounts check is)
  await refreshCaps();
  if (!state.caps?.operator) {
    fill(root, h('h1', {}, 'وضع المشغل'), h('div', { class: 'card' },
      h('p', {}, 'هذه الصفحة لصاحب الموقع فقط. تفعيلها يُظهر خانة ربط الذكاء الاصطناعي على هذا الجهاز وحده؛ الزوار لا يرونها ولا يستطيعون ربط مفاتيحهم.'),
      h('button', { class: 'btn primary', id: 'op-on', onclick: () => toggle(true) }, 'تفعيل وضع المشغل على هذا الجهاز')));
    return root;
  }
  const box = h('div', { class: 'card', id: 'relay-status' }, spinner('جارٍ فحص الوسيط…'));
  // ---- the automatic generation path: preset order, each provider's state, a real check. Nobody chooses the order; providers back each other up.
  const chainBox = h('div', { class: 'card', id: 'chain-box' }, spinner('جارٍ قراءة المسار…'));
  const STATE_TXT = { ready: '✓ جاهز', cooling: '⏳ يستريح قليلًا (حدّ الطلبات)', out: '⏸ متوقف مؤقتًا', dead: '✗ يحتاج إصلاحًا' };
  const arN = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}`);
  const wait = (s) => (s >= 90 ? arN(Math.round(s / 60), 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة') : arN(Math.max(1, s), 'ثانية', 'ثانيتين', 'ثوانٍ', 'ثانية'));
  const reqs = (n) => arN(n, 'طلب واحد', 'طلبان', 'طلبات', 'طلبًا');
  const drawChain = async (results) => {
    let st; try { st = await api('GET', '/api/llm/chain'); } catch (ex) { chainBox.replaceChildren(errorBox(ex)); return; }
    if (results && results.chain) st = { chain: results.chain };
    const list = st.chain || [];
    const out = h('div', { id: 'chain-check', role: 'status', style: 'margin-top:.6rem' });
    if (results && results.results) out.replaceChildren(...results.results.map((r) => h('div', { class: 'small', 'data-ok': r.ok ? '1' : '0', 'data-busy': r.busy ? '1' : '0', style: 'color:' + (r.ok ? 'var(--ok)' : r.busy ? 'inherit' : 'var(--bad)') },
      `${r.ok ? '✓' : r.busy ? '⏳' : '✗'} ${r.name} (${r.model}): ${r.ok ? `يعمل (${r.ms}ms)` : r.busy ? r.message : explainAiError(r.message)}`)));
    const go = h('button', { class: 'btn', id: 'chain-go', onclick: async (ev) => { ev.target.disabled = true; out.replaceChildren(spinner('جارٍ فحص كل مزوّد بطلب حقيقي صغير…'));
      try { const r = await api('POST', '/api/llm/check', {}); await refreshCaps(); await drawChain(r); } catch (ex) { out.replaceChildren(errorBox(ex)); ev.target.disabled = false; } } }, 'افحص المسار الآن');
    chainBox.replaceChildren(h('h2', {}, 'مسار التوليد التلقائي'),
      list.length
        ? h('div', {}, h('p', { class: 'muted' }, 'مرتّب مسبقًا ولا تحتاج أن تختاره. يجرّب الموقع الأول، فإن تعذّر لأي سبب (رصيد، سقف إنفاق، مفتاح، حدّ طلبات) أكمل الثاني من حيث توقّف، وهكذا. وإن تعذّروا جميعًا يُنشأ الكويز محليًا بلا ذكاء اصطناعي.'),
          h('ol', { id: 'chain-list' }, list.map((x) => h('li', { 'data-state': x.state, 'data-name': x.name, 'data-alt': x.alt ? '1' : '0', style: x.alt ? 'margin-inline-start:1.4rem;list-style:circle' : '' },
            h('strong', { class: 'bidi' }, x.name), ' ', h('code', { dir: 'ltr' }, x.model), x.alt ? h('span', { class: 'small muted' }, ' (نموذج بديل لنفس المفتاح)') : null, ' — ', h('span', { style: x.state === 'ready' ? 'color:var(--ok)' : x.state === 'dead' ? 'color:var(--bad)' : '' }, STATE_TXT[x.state] || x.state),
            x.state === 'out' ? h('span', { class: 'small muted' }, ` (${x.reason}؛ يُعاد تجريبه تلقائيًا بعد ${wait(x.retry_in)})`) : x.state === 'dead' ? h('span', { class: 'small muted' }, /JSON/.test(x.reason || '') ? ` (${x.reason}؛ أعد إضافة المزوّد من «ذكاء المشغل» لتجرّب نموذجًا آخر ثم افحص)` : ` (${x.reason}؛ أعد ربط مفتاح صحيح ثم افحص)`) : null,
            x.used ? h('span', { class: 'small muted' }, ` · ${reqs(x.used)} في هذه الجلسة`) : null)),
            h('li', { 'data-name': 'local' }, h('strong', {}, 'التوليد المحلي'), ' — احتياطي أخير دائمًا متاح (أسئلة أبسط، بلا ذكاء اصطناعي)')),
          h('div', { class: 'row' }, go), out)
        : h('div', {}, h('p', { class: 'muted' }, 'لا يوجد ذكاء اصطناعي مربوط الآن، فيعمل الموقع بالتوليد المحلي (أسئلة أبسط، بلا مفتاح). اربط مفتاحًا من «ذكاء المشغل» أو فعّل الوسيط، وسيظهر المسار هنا.'),
          h('ol', { id: 'chain-list' }, h('li', { 'data-name': 'local' }, h('strong', {}, 'التوليد المحلي'), ' — دائمًا متاح'))));
  };
  const steps = () => h('div', {}, h('p', { class: 'muted' }, 'الآن يستعمل الزوار التوليد المحلي (أبسط، بلا ذكاء اصطناعي). لتشغيل Claude لكل الزوار بأمان، دون أن يظهر مفتاحك لأحد (٥ دقائق):'),
    h('ol', {},
      h('li', {}, 'تأكد أن ما اشتريته ظاهر في ', h('a', { href: 'https://platform.claude.com/settings/billing', target: '_blank', rel: 'noopener', dir: 'ltr' }, 'platform.claude.com/settings/billing'), ' (الرصيد يتفعّل فور الشراء، ولا توجد خطوة تفعيل)، ثم من ', h('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener', dir: 'ltr' }, 'platform.claude.com/settings/keys'), ' أنشئ مفتاحًا (Create key) بالنطاق Default workspace والمدة Never، وانسخه.'),
      h('li', {}, 'على ', h('a', { href: 'https://dash.cloudflare.com', target: '_blank', rel: 'noopener', dir: 'ltr' }, 'cloudflare.com'), ' (مجاني): Workers & Pages ← Create ← Worker ← الصق محتوى الملف ', h('code', { dir: 'ltr' }, 'relay/cloudflare-worker.mjs'), ' ← Deploy.'),
      h('li', {}, 'في إعدادات الوسيط (Variables and Secrets) أضف: ', h('code', { dir: 'ltr' }, 'ANTHROPIC_API_KEY'), ' (النوع Secret = مفتاحك) و', h('code', { dir: 'ltr' }, 'ALLOWED_ORIGIN'), ' = ', h('code', { dir: 'ltr' }, location.origin), ' ثم Deploy.'),
      h('li', {}, 'افتح عنوان الوسيط في المتصفح: يجب أن يظهر ', h('code', { dir: 'ltr' }, '"key_set": true'), '. ثم اكتب العنوان في ', h('code', { dir: 'ltr' }, 'config.js'), ' بجانب ', h('code', { dir: 'ltr' }, 'relay'), ' (أو أرسل العنوان فقط لمن يدير الموقع).')),
    h('div', { class: 'alert warn' }, 'لا تكتب المفتاح نفسه في أي ملف من الموقع ولا في GitHub ولا في محادثة: يصبح علنيًا ويُستنزف رصيدك. العنوان وحده آمن.'));
  const draw = async () => {
    let st; try { st = await api('GET', '/api/llm/relay-status'); } catch (ex) { box.replaceChildren(errorBox(ex)); return; }
    if (!st.configured) { box.replaceChildren(h('h2', {}, 'Claude لكل الزوار: غير مفعّل'), steps()); return; }
    if (!st.reachable) { box.replaceChildren(h('h2', {}, 'Claude لكل الزوار: الوسيط لا يستجيب'), h('div', { class: 'alert bad' }, `تعذّر الوصول إلى الوسيط${st.address ? ' (' + st.address + ')' : ''}. تأكد من العنوان في config.js، وأن ALLOWED_ORIGIN على الوسيط = ${location.origin} تمامًا (بلا / في النهاية).`)); return; }
    if (st.reachable && st.key_set && st.origin_set && st.origin_ok === false) { box.replaceChildren(h('h2', {}, 'Claude لكل الزوار: الوسيط لا يقبل هذا الموقع'), h('div', { class: 'alert warn' }, `الوسيط يعمل لكن ALLOWED_ORIGIN عليه (${(st.allowed_origins || []).join(' ، ')}) لا يطابق عنوان موقعك ${location.origin} تمامًا (بلا / في النهاية، وبنفس http/https). صحّحه من Variables and Secrets ثم Deploy.`)); return; }
    const miss = [!st.key_set && 'ANTHROPIC_API_KEY', !st.origin_set && 'ALLOWED_ORIGIN'].filter(Boolean);
    if (miss.length) { box.replaceChildren(h('h2', {}, 'Claude لكل الزوار: الوسيط ينقصه إعداد'), h('div', { class: 'alert warn' }, `لم يُضبط على الوسيط: ${miss.join(' و')}. أضفه من Variables and Secrets ثم Deploy.`)); return; }
    const res = h('span', { class: 'small muted', id: 'relay-test-result' });
    box.replaceChildren(h('h2', {}, 'Claude لكل الزوار: يعمل ✓'), h('p', {}, 'الوسيط يحمل مفتاحك بأمان، وكل زائر يولّد أسئلته بـ Claude دون أن يرى أو يدخل أي مفتاح.'),
      h('div', { class: 'small muted' }, 'النموذج المستعمل: ', h('code', { dir: 'ltr' }, st.model), ' — يُغيَّر من ', h('code', { dir: 'ltr' }, 'relayModel'), ' في config.js. المسموح: ', ...(st.models || []).flatMap((m, i) => [i ? ' · ' : '', h('code', { dir: 'ltr' }, m)]), '.'),
      h('div', { class: 'row', style: 'margin-top:.7rem' }, h('button', { class: 'btn', id: 'relay-test', onclick: async (ev) => { ev.target.disabled = true; res.textContent = ' جارٍ طلب تجريبي حقيقي…';
        try { const r = await api('POST', '/api/llm/test', { id: 'relay' }); res.textContent = r.ok ? ` ✓ نجح (${Math.round(r.ms)}ms)` : ' ✗ ردّ غير متوقع'; res.style.color = r.ok ? 'var(--ok)' : 'var(--bad)'; } catch (ex) { res.textContent = ' ✗ ' + explainAiError(ex.message); res.style.color = 'var(--bad)'; } ev.target.disabled = false; } }, 'اختبار طلب حقيقي'), res),
      h('p', { class: 'small muted' }, 'كل كويز يخصم من رصيدك في Anthropic. حدّد سقف إنفاق شهريًا من لوحة Billing، ولتوفير الرصيد استعمل Sonnet أو Haiku.'));
  };
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
  // ---- what EVERY visitor uses, and the one button that gives them the operator's providers
  const siteBox = h('div', { class: 'card', id: 'site-ai' }, spinner('جارٍ فحص ما يستعمله الزوار…'));
  const drawSite = async () => {
    let st; try { st = await api('GET', '/api/llm/site'); } catch (ex) { siteBox.replaceChildren(errorBox(ex)); return; }
    const now = st.shared.length ? h('div', { class: 'alert ok', id: 'site-ai-now' }, h('strong', {}, 'كل الزوار يولّدون الآن بـ: '), st.shared.map((e) => `${e.name} (${e.model})`).join('، '))
      : h('div', { class: 'alert warn', id: 'site-ai-now' }, h('strong', {}, 'الزوار الآن على التوليد المحلي. '), 'المفاتيح التي تربطها في «ذكاء المشغل» تعمل على هذا الجهاز وحده حتى تعمّمها من هنا.');
    const pub = st.device.filter((e) => e.publishable), paid = st.device.filter((e) => !e.publishable);
    const token = h('input', { id: 'gh-token', type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: st.token_saved ? 'محفوظ على هذا الجهاز' : 'github_pat_…' });
    const remember = h('input', { type: 'checkbox', id: 'gh-remember', checked: true, style: 'width:20px;height:20px' }); const out = h('div', { role: 'status' });
    const go = async (none) => {
      if (!none && !(await confirmDialog('تعميم على كل الزوار؟', 'سيستعمل كل زائر هذه المفاتيح، ويستطيع أي شخص قراءتها من ملف الموقع (لأن الموقع ثابت بلا خادم). لذلك تُعمَّم المفاتيح المجانية فقط، ويُستحسن تقييد مفتاح Gemini بعنوان موقعك. يظهر التغيير عند الزوار خلال دقيقة إلى عشر دقائق.', 'عمّم'))) return;
      out.replaceChildren(spinner(none ? 'جارٍ الإلغاء…' : 'جارٍ التعميم…'));
      try { const r = await api('POST', '/api/llm/publish', { token: token.value.trim(), remember: remember.checked, none: !!none }); out.replaceChildren(h('div', { class: 'alert ok', id: 'site-ai-done' }, none ? 'أُلغي التعميم: يعود الزوار إلى التوليد المحلي خلال دقائق.' : `عُمِّم على كل الزوار ✓ (${r.published.join('، ')}). يظهر عندهم خلال دقيقة إلى عشر دقائق؛ افتح الموقع من جهاز آخر وجرّب.`)); }
      catch (ex) { out.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); } };
    siteBox.replaceChildren(h('h2', {}, 'الذكاء الاصطناعي لكل الزوار'), now,
      pub.length ? h('div', {}, h('p', {}, 'مزوّداتك المجانية على هذا الجهاز (تُعمَّم كلها): ', pub.map((e) => `${e.name} (${e.model})`).join('، ')),
        h('div', { class: 'field' }, h('label', { for: 'gh-token' }, 'رمز GitHub للكتابة في الموقع'), token,
          h('div', { class: 'hint' }, 'مرة واحدة: GitHub ← Settings ← Developer settings ← Fine-grained tokens ← Generate: Repository access = ', h('code', { dir: 'ltr' }, st.repo || 'مستودع الموقع'), '، Permissions ← Contents = Read and write. يُحفظ في هذا المتصفح فقط ولا يُرسل إلا إلى GitHub.')),
        h('label', { class: 'row', style: 'cursor:pointer' }, remember, 'احفظ الرمز على هذا الجهاز'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'publish-ai', onclick: () => go(false) }, 'عمّم على كل الموقع'), st.shared.some((e) => !e.relay) ? h('button', { class: 'btn', id: 'unpublish-ai', onclick: () => go(true) }, 'ألغِ التعميم') : null))
        : h('p', { class: 'muted' }, 'لا يوجد على هذا الجهاز مزوّد مجاني لتعميمه. ', h('a', { href: '#/settings' }, 'اربط مفتاحًا مجانيًا (Gemini أو Groq) ←')),
      paid.length ? h('div', { class: 'alert info', id: 'site-ai-paid' }, `${paid.map((e) => e.name).join('، ')}: مفتاح مدفوع لا يوضع في ملف الموقع (يصبح علنيًا ويُستنزف رصيدك)؛ يُعمَّم عبر الوسيط في البطاقة التالية.`) : null, out);
  };
  fill(root, h('h1', {}, 'وضع المشغل'), siteBox, chainBox, box, accBox, learnerCard(),
    h('div', { class: 'card' }, h('h2', {}, 'على هذا الجهاز'), h('p', { class: 'muted' }, 'اربط مفتاحًا لنفسك فقط (مثلًا لتجربة Claude الآن قبل تجهيز الوسيط).'), h('a', { class: 'btn', href: '#/settings' }, 'ذكاء المشغل على هذا الجهاز')),
    h('div', { class: 'card' }, h('button', { class: 'btn danger', id: 'op-off', onclick: () => toggle(false) }, 'إيقاف وضع المشغل على هذا الجهاز')));
  draw(); drawChain(); drawAccounts(); drawSite();
  return root;
}

export async function settingsPage() {
  if (!state.caps?.byok) return h('div', { class: 'card' }, emptyState('⚙', 'لا توجد إعدادات هنا', 'الذكاء الاصطناعي يُضبط على الخادم في هذه النسخة.'));
  const root = h('div', { style: 'max-width:760px;margin:auto' });
  const listBox = h('div', {});
  const f = { preset: 'gemini', name: '', base: PRESETS.gemini.base, kind: 'openai', key: '', model: '', rpm: PRESETS.gemini.rpm };
  const inputs = {};
  const fld = (id, label, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), el, hint && h('div', { class: 'hint' }, hint));

  async function drawList() {
    const eps = await api('GET', '/api/llm/endpoints');
    await refreshCaps();
    listBox.replaceChildren(eps.length ? h('div', { class: 'card' }, h('h2', {}, 'المفاتيح المربوطة'), h('p', { class: 'small muted' }, 'الترتيب تلقائي: Claude أولًا ثم Gemini ثم Groq ثم OpenRouter ثم نموذج جهازك، وإن تعذّر أحدها (رصيد، سقف، مفتاح، حدّ طلبات) أكمل التالي، وإن تعذّرت كلها يُنشأ الكويز محليًا. تراه وتفحصه من صفحة وضع المشغل.'), eps.map((e) => {
      const status = h('span', { class: 'small muted' });
      return h('div', { class: 'row between', style: 'padding:.6rem 0;border-top:1px solid var(--line)' },
        h('div', {}, h('strong', { class: 'bidi' }, e.name), h('div', { class: 'small muted ltr' }, `${e.base} · ${e.model} · ${e.rpm}/min · ${e.key_hint}`), status),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: async (ev) => { ev.target.disabled = true; status.textContent = ' جارٍ الاختبار…';
            try { const r = await api('POST', '/api/llm/test', { id: e.id }); status.textContent = r.ok ? ` ✓ يعمل (${Math.round(r.ms)}ms)` : r.busy ? ' ⏳ ' + r.message : ' ✗ ردّ غير متوقع'; status.style.color = r.ok ? 'var(--ok)' : r.busy ? '' : 'var(--bad)'; }
            catch (ex) { status.textContent = ' ✗ ' + ex.message; status.style.color = 'var(--bad)'; } ev.target.disabled = false; } }, 'اختبار'),
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف المفتاح؟', 'يُحذف من هذا المتصفح فقط.', 'حذف', true)) { await api('DELETE', `/api/llm/endpoints/${e.id}`); drawList(); } } }, 'حذف')));
    })) : (state.caps?.shared_ai ? null : h('div', { class: 'alert info' }, 'لم تربط ذكاءً اصطناعيًا بعد: الموقع يعمل الآن بالتوليد المحلي (أسئلة أبسط، بلا مفتاح).')));
  }

  const presetSel = h('select', { id: 'preset', onchange: (e) => { const p = PRESETS[e.target.value]; f.preset = e.target.value; Object.assign(f, { kind: p.kind, base: p.base, rpm: p.rpm });
    inputs.base.value = p.base; inputs.rpm.value = p.rpm; hint.replaceChildren(p.how + ' ', p.link ? h('a', { href: p.link, target: '_blank', rel: 'noopener', dir: 'ltr' }, p.linkText) : ''); } },
    Object.entries(PRESETS).map(([k, p]) => h('option', { value: k }, p.label)));
  const hint = h('div', { class: 'hint' }, PRESETS.gemini.how + ' ', h('a', { href: PRESETS.gemini.link, target: '_blank', rel: 'noopener', dir: 'ltr' }, PRESETS.gemini.linkText));
  inputs.base = h('input', { id: 'base', type: 'text', dir: 'ltr', value: f.base, oninput: (e) => { f.base = e.target.value; } });
  inputs.model = h('input', { id: 'model', type: 'text', dir: 'ltr', placeholder: 'اتركه فارغًا ليُختار النموذج المناسب تلقائيًا', oninput: (e) => { f.model = e.target.value; } });
  inputs.key = h('input', { id: 'key', type: 'password', dir: 'ltr', autocomplete: 'off', oninput: (e) => { f.key = e.target.value; } });
  inputs.rpm = h('input', { id: 'rpm', type: 'number', min: 1, max: 600, dir: 'ltr', value: f.rpm, oninput: (e) => { f.rpm = +e.target.value; } });
  const err = h('div', { role: 'alert' });
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    try {
      let model = f.model.trim();
      if (!model) { const found = await api('POST', '/api/llm/discover', { kind: f.kind, base: f.base, key: f.key }); model = found.suggested || ''; if (!model) throw new Error('تعذّر اختيار نموذج تلقائيًا؛ اكتب اسمه كما في لوحة المزوّد.'); }
      await api('POST', '/api/llm/endpoints', { name: PRESETS[f.preset].label.split(' (')[0], kind: f.kind, base: f.base, key: f.key, model, rpm: f.rpm }); inputs.key.value = ''; f.key = ''; toast('أُضيف المفتاح', 'ok'); drawList();
    } catch (ex) { err.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); } } },
    h('h2', {}, 'إضافة مزوّد (متقدم)'),
    fld('preset', 'المزوّد', presetSel, null), hint,
    fld('base', 'عنوان الواجهة (API)', inputs.base), fld('model', 'النموذج (اختياري)', inputs.model), fld('key', 'المفتاح', inputs.key, 'يُحفظ في هذا المتصفح فقط ويُرسل مباشرة إلى المزوّد.'),
    fld('rpm', 'الحد الأقصى للطلبات في الدقيقة', inputs.rpm, 'يبطّئ الموقع نفسه تحت هذا الحد كي لا يوقفك المزوّد. يمكنك ربط أكثر من مزوّد: تتوزع الطلبات بينها ويُنتقل لغيره عند بلوغ حدّ أحدها.'),
    err, h('button', { class: 'btn primary', type: 'submit' }, 'إضافة'));
  const eps0 = await api('GET', '/api/llm/endpoints'); const shared = !!state.caps?.shared_ai;
  const quick = shared ? null : aiConnectCard(() => { location.hash = '#/new'; });
  fill(root, h('h1', {}, 'ذكاء المشغل'), h('p', { class: 'muted' }, 'هذه الصفحة لك أنت فقط (وضع المشغل على هذا الجهاز). الزوار لا يرونها ولا يمكنهم ربط مفاتيح. ', h('a', { href: '#/operator' }, 'حالة Claude لكل الزوار ←')),
    shared ? h('div', { class: 'alert ok' }, 'الموقع مربوط بالذكاء الاصطناعي لكل الزوار. مفاتيحك هنا لهذا الجهاز وحده، لتجربة نموذج آخر مثلًا.') : null,
    h('div', { class: 'alert info', id: 'publish-hint' }, h('strong', {}, 'ما تربطه هنا يعمل على هذا الجهاز فقط. '), 'لكي يستعمله كل زائر: ', h('a', { href: '#/operator' }, 'صفحة وضع المشغل ← «عمّم على كل الموقع»'), '.'),
    eps0.length ? null : quick,                                   // nothing connected yet: the one-field card comes first
    listBox,
    h('details', { class: 'card' }, h('summary', {}, eps0.length ? 'إضافة مزوّد آخر' : 'خيارات متقدمة (Ollama، مزوّد آخر…)'), eps0.length ? quick : null, form),
    h('div', { class: 'alert warn' }, 'تنبيه أمني: المفتاح محفوظ كنص في متصفحك، فلا تضعه على جهاز عام. ولا تكتب مفتاحًا مدفوعًا في أي ملف من الموقع أو من GitHub (يصبح علنيًا ويُستنزف رصيدك): لتعميم Claude على الجميع استخدم الوسيط.'));
  await drawList();
  return root;
}
