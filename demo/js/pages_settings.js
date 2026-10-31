import { h, api, toast, confirmDialog, spinner, errorBox, emptyState, state } from './core.js';

const PRESETS = {
  groq: { label: 'Groq (طبقة مجانية بحدود)', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: '', rpm: 25, link: 'https://console.groq.com/keys', hint: 'انسخ اسم نموذج من لوحة Groq.' },
  gemini: { label: 'Google Gemini (طبقة مجانية)', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', rpm: 12, link: 'https://aistudio.google.com/apikey', hint: 'اسم النموذج من Google AI Studio.' },
  openrouter: { label: 'OpenRouter (نماذج مجانية :free)', kind: 'openai', base: 'https://openrouter.ai/api/v1', model: '', rpm: 15, link: 'https://openrouter.ai/keys', hint: 'اختر نموذجًا ينتهي بـ :free.' },
  anthropic: { label: 'Anthropic Claude (مدفوع)', kind: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', rpm: 40, link: 'https://console.anthropic.com/settings/keys', hint: 'للجودة الأعلى. claude-haiku-5-5 أرخص.' },
  ollama: { label: 'Ollama على جهازك (بلا حد)', kind: 'openai', base: 'http://localhost:11434/v1', model: '', rpm: 120, link: '', hint: 'شغّل Ollama بالمتغير OLLAMA_ORIGINS ليسمح بهذا الموقع.' },
  custom: { label: 'مزوّد آخر متوافق مع OpenAI', kind: 'openai', base: '', model: '', rpm: 20, link: '', hint: '' },
};

export async function settingsPage() {
  if (!state.caps?.byok) return h('div', { class: 'card' }, emptyState('⚙', 'لا توجد إعدادات هنا', 'مفاتيح التوليد تُضبط على الخادم في هذه النسخة.'));
  const root = h('div', { style: 'max-width:760px;margin:auto' });
  const listBox = h('div', {});
  const f = { preset: 'groq', name: '', base: PRESETS.groq.base, kind: 'openai', key: '', model: '', rpm: 25 };
  const inputs = {};
  const fld = (id, label, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), el, hint && h('div', { class: 'hint' }, hint));

  async function drawList() {
    const eps = await api('GET', '/api/llm/endpoints');
    try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }   // AI availability changed
    listBox.replaceChildren(eps.length ? h('div', { class: 'card' }, h('h2', {}, 'مفاتيحك'), eps.map((e) => {
      const status = h('span', { class: 'small muted' });
      return h('div', { class: 'row between', style: 'padding:.6rem 0;border-top:1px solid var(--line)' },
        h('div', {}, h('strong', { class: 'bidi' }, e.name), h('div', { class: 'small muted ltr' }, `${e.base} · ${e.model} · ${e.rpm}/min · ${e.key_hint}`), status),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: async (ev) => { ev.target.disabled = true; status.textContent = ' جارٍ الاختبار…';
            try { const r = await api('POST', '/api/llm/test', { id: e.id }); status.textContent = r.ok ? ` ✓ يعمل (${Math.round(r.ms)}ms)` : ' ✗ ردّ غير متوقع'; status.style.color = r.ok ? 'var(--ok)' : 'var(--bad)'; }
            catch (ex) { status.textContent = ' ✗ ' + ex.message; status.style.color = 'var(--bad)'; } ev.target.disabled = false; } }, 'اختبار'),
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف المفتاح؟', 'يُحذف من هذا المتصفح فقط.', 'حذف', true)) { await api('DELETE', `/api/llm/endpoints/${e.id}`); drawList(); } } }, 'حذف')));
    })) : h('div', { class: 'alert warn' }, 'لم تضف مفتاحًا بعد. بدونه يعمل وضع «بدون توكن» فقط (أبسط وأنواعه أقل).'));
  }

  const presetSel = h('select', { id: 'preset', onchange: (e) => { const p = PRESETS[e.target.value]; f.preset = e.target.value; Object.assign(f, { kind: p.kind, base: p.base, rpm: p.rpm });
    inputs.base.value = p.base; inputs.rpm.value = p.rpm; if (p.model || e.target.value === 'anthropic') inputs.model.value = p.model; hint.replaceChildren(p.hint || '', p.link ? h('span', {}, ' ', h('a', { href: p.link, target: '_blank', rel: 'noopener' }, 'احصل على مفتاح')) : null); } },
    Object.entries(PRESETS).map(([k, p]) => h('option', { value: k }, p.label)));
  const hint = h('div', { class: 'hint' }, PRESETS.groq.hint, h('span', {}, ' ', h('a', { href: PRESETS.groq.link, target: '_blank', rel: 'noopener' }, 'احصل على مفتاح')));
  inputs.base = h('input', { id: 'base', type: 'text', dir: 'ltr', value: f.base, oninput: (e) => { f.base = e.target.value; } });
  inputs.model = h('input', { id: 'model', type: 'text', dir: 'ltr', placeholder: 'اسم النموذج كما في لوحة المزوّد', oninput: (e) => { f.model = e.target.value; } });
  inputs.key = h('input', { id: 'key', type: 'password', dir: 'ltr', autocomplete: 'off', oninput: (e) => { f.key = e.target.value; } });
  inputs.rpm = h('input', { id: 'rpm', type: 'number', min: 1, max: 600, dir: 'ltr', value: f.rpm, oninput: (e) => { f.rpm = +e.target.value; } });
  const err = h('div', { role: 'alert' });
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    try { await api('POST', '/api/llm/endpoints', { name: PRESETS[f.preset].label.split(' (')[0], kind: f.kind, base: f.base, key: f.key, model: f.model, rpm: f.rpm }); inputs.key.value = ''; f.key = ''; toast('أُضيف المفتاح', 'ok'); drawList(); }
    catch (ex) { err.replaceChildren(h('div', { class: 'alert bad' }, ex.message)); } } },
    h('h2', {}, 'إضافة مفتاح توليد'),
    fld('preset', 'المزوّد', presetSel, null), hint,
    fld('base', 'عنوان الواجهة (API)', inputs.base), fld('model', 'النموذج', inputs.model), fld('key', 'المفتاح', inputs.key, 'يُحفظ في هذا المتصفح فقط ويُرسل مباشرة إلى المزوّد.'),
    fld('rpm', 'الحد الأقصى للطلبات في الدقيقة', inputs.rpm, 'يبطّئ الموقع نفسه تحت هذا الحد كي لا يوقفك المزوّد. يمكنك إضافة أكثر من مفتاح/مزوّد: تتوزع الطلبات بينها ويُنتقل لغيره عند بلوغ حدّ أحدها.'),
    err, h('button', { class: 'btn primary', type: 'submit' }, 'إضافة'));
  root.append(h('h1', {}, 'الإعدادات'),
    h('div', { class: 'alert info' }, h('strong', {}, 'كيف يعمل التوليد هنا؟ '), 'الموقع بلا خادم، فيستدعي مزوّد الذكاء الاصطناعي الذي تختاره مباشرة من متصفحك بمفتاحك أنت. كثير من المزوّدين يقدّمون طبقة مجانية. على المزوّد أن يسمح بطلبات المتصفح (CORS)؛ زر «اختبار» يكشف ذلك.'),
    listBox, form,
    h('div', { class: 'alert warn' }, 'تنبيه أمني: المفتاح محفوظ كنص في متصفحك. لا تستخدم مفتاحًا ذا صلاحيات واسعة أو رصيد كبير، ولا تضعه على جهاز عام.'));
  await drawList();
  return root;
}
