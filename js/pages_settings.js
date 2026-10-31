import { h, api, fill, toast, confirmDialog, spinner, errorBox, emptyState, state } from './core.js';

const PRESETS = {
  gemini: { label: 'Google Gemini (طبقة مجانية)', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', rpm: 12, link: 'https://aistudio.google.com/apikey', linkText: 'aistudio.google.com/apikey', how: 'افتح الرابط وسجّل بحساب Google ثم اضغط «Create API key» وانسخ المفتاح.' },
  groq: { label: 'Groq (طبقة مجانية بحدود)', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: '', rpm: 25, link: 'https://console.groq.com/keys', linkText: 'console.groq.com/keys', how: 'سجّل ثم اضغط «Create API Key» وانسخ المفتاح.' },
  openrouter: { label: 'OpenRouter (نماذج مجانية :free)', kind: 'openai', base: 'https://openrouter.ai/api/v1', model: '', rpm: 15, link: 'https://openrouter.ai/keys', linkText: 'openrouter.ai/keys', how: 'سجّل ثم «Create Key» وانسخ المفتاح (الحدود المجانية أضيق).' },
  anthropic: { label: 'Anthropic Claude (مدفوع)', kind: 'anthropic', base: 'https://api.anthropic.com', model: '', rpm: 40, link: 'https://console.anthropic.com/settings/keys', linkText: 'console.anthropic.com', how: 'للجودة الأعلى؛ يحتاج رصيدًا مدفوعًا.' },
  ollama: { label: 'Ollama على جهازك (بلا حد)', kind: 'openai', base: 'http://localhost:11434/v1', model: '', rpm: 120, link: '', linkText: '', how: 'شغّل Ollama بالمتغير OLLAMA_ORIGINS ليسمح بهذا الموقع.' },
  custom: { label: 'مزوّد آخر متوافق مع OpenAI', kind: 'openai', base: '', model: '', rpm: 20, link: '', linkText: '', how: '' },
};
const QUICK = ['gemini', 'groq', 'openrouter'];

async function refreshCaps() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }   // AI availability changed
}

/** Compact "connect the AI" card (new-quiz page, failure view, settings). One field: paste the key.
 *  The model is discovered from what the key can use, so nobody has to know model names. `onDone` runs once it works. */
export function aiConnectCard(onDone) {
  const caps = state.caps || {};
  if (!caps.byok) return h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير متاح الآن. '), caps.ai_missing || 'لم يُجهَّز الذكاء الاصطناعي على هذا الخادم بعد.');
  let preset = 'gemini';
  const how = h('div', { class: 'hint' });
  const drawHow = () => { const p = PRESETS[preset]; how.replaceChildren(p.how + ' ', p.link ? h('a', { href: p.link, target: '_blank', rel: 'noopener', dir: 'ltr' }, p.linkText) : ''); };
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
      status.textContent = 'جارٍ فحص المفتاح…';
      const found = await api('POST', '/api/llm/discover', { kind: p.kind, base: p.base, key: k });
      if (!found.suggested) throw new Error('لم أجد نموذجًا مناسبًا لهذا المفتاح. جرّب مزوّدًا آخر أو أضِف النموذج يدويًا من صفحة «ربط الذكاء الاصطناعي».');
      status.textContent = `جارٍ تجربة النموذج ${found.suggested}…`;
      const eps = await api('POST', '/api/llm/endpoints', { name: p.label.split(' (')[0], kind: p.kind, base: p.base, key: k, model: found.suggested, rpm: p.rpm }); added = eps[eps.length - 1];
      await api('POST', '/api/llm/test', { id: added.id });
      await refreshCaps(); key.value = ''; status.textContent = '';
      toast('تم ربط الذكاء الاصطناعي ✓', 'ok'); if (onDone) await onDone();
    } catch (ex) {
      if (added) { try { await api('DELETE', `/api/llm/endpoints/${added.id}`); } catch (_) { /* ignore */ } }
      status.textContent = ''; err.replaceChildren(h('div', { class: 'alert bad' }, ex.message || 'تعذّر الربط.'));
    } finally { btn.disabled = false; }
  } },
    h('h3', {}, 'اربط الذكاء الاصطناعي (مرة واحدة)'),
    h('p', { class: 'muted' }, 'هذا الموقع بلا خادم، فتحتاج مفتاحًا من مزوّد يقدّم طبقة مجانية. يُحفظ في متصفحك فقط ويُرسل مباشرة إلى المزوّد.'),
    h('div', { class: 'row' }, h('div', { class: 'field', style: 'flex:1;min-width:200px;margin:0' }, h('label', { for: 'quick-preset' }, 'المزوّد'), sel),
      h('div', { class: 'field', style: 'flex:2;min-width:240px;margin:0' }, h('label', { for: 'quick-key' }, 'المفتاح'), key)),
    how, status, err, h('div', { class: 'row', style: 'margin-top:.6rem' }, btn, h('a', { class: 'small', href: '#/settings' }, 'خيارات متقدمة')));
  drawHow();
  return form;
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
    listBox.replaceChildren(eps.length ? h('div', { class: 'card' }, h('h2', {}, 'المفاتيح المربوطة'), eps.map((e) => {
      const status = h('span', { class: 'small muted' });
      return h('div', { class: 'row between', style: 'padding:.6rem 0;border-top:1px solid var(--line)' },
        h('div', {}, h('strong', { class: 'bidi' }, e.name), h('div', { class: 'small muted ltr' }, `${e.base} · ${e.model} · ${e.rpm}/min · ${e.key_hint}`), status),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: async (ev) => { ev.target.disabled = true; status.textContent = ' جارٍ الاختبار…';
            try { const r = await api('POST', '/api/llm/test', { id: e.id }); status.textContent = r.ok ? ` ✓ يعمل (${Math.round(r.ms)}ms)` : ' ✗ ردّ غير متوقع'; status.style.color = r.ok ? 'var(--ok)' : 'var(--bad)'; }
            catch (ex) { status.textContent = ' ✗ ' + ex.message; status.style.color = 'var(--bad)'; } ev.target.disabled = false; } }, 'اختبار'),
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف المفتاح؟', 'يُحذف من هذا المتصفح فقط.', 'حذف', true)) { await api('DELETE', `/api/llm/endpoints/${e.id}`); drawList(); } } }, 'حذف')));
    })) : (state.caps?.shared_ai ? null : h('div', { class: 'alert warn' }, 'لم تربط الذكاء الاصطناعي بعد؛ بدونه لا تُولَّد أسئلة.')));
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
  fill(root, h('h1', {}, 'ربط الذكاء الاصطناعي'),
    shared ? h('div', { class: 'alert ok' }, 'هذا الموقع مربوط بالذكاء الاصطناعي مسبقًا، فلا تحتاج لشيء. يمكنك إضافة مفتاحك الخاص إن أردت حدودًا أوسع (اختياري).') : null,
    eps0.length ? null : quick,                                   // nothing connected yet: the one-field card comes first
    listBox,
    h('details', { class: 'card' }, h('summary', {}, eps0.length ? 'إضافة مزوّد آخر' : 'خيارات متقدمة (Anthropic، Ollama، مزوّد آخر…)'), eps0.length ? quick : null, form),
    h('div', { class: 'alert warn' }, 'تنبيه أمني: المفتاح محفوظ كنص في متصفحك. لا تستخدم مفتاحًا ذا صلاحيات واسعة أو رصيد كبير، ولا تضعه على جهاز عام.'));
  await drawList();
  return root;
}
