// The ONE place where a quiz is started: drop a lecture file -> we read it -> one big button. Everything else is optional and folded away.
import { h, api, state, fill, num, errorBox, ico } from './core.js';
import { qualityNote, uploadAndRead, progressText, progressPct } from './docs.js';
import { aiConnectCard } from './pages_settings.js';

const COUNT_LABEL = (v) => (v === 'auto' ? 'تلقائي' : String(v));

export function startCard({ preset = null } = {}) {
  // The ten question types are an internal matter: the analysis decides which ones the lecture supports. The student never sees them.
  const S = { count: 'auto', difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only' };
  let view = 'idle', doc = null, range = '', reading = null, existing = [], opts = null;
  const box = h('div', { class: 'startcard' }), err = h('div', { role: 'alert' });
  const input = h('input', { type: 'file', accept: '.pdf,.pptx', id: 'file', style: 'display:none', onchange: () => { if (input.files[0]) pick(input.files[0]); } });
  const aiOff = () => state.caps?.claude_ok === false || state.caps?.llm === false;

  const chipGroup = (key, items, fmt = (x) => x) => {
    const g = h('div', { class: 'chips', role: 'group' });
    const paint = () => g.replaceChildren(...items.map((v) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(S[key] === v), onclick: () => { S[key] = v; paint(); } }, fmt(v))));
    paint(); return g;
  };

  function idleView() {
    const dz = h('button', { type: 'button', class: 'drop', id: 'dropzone', onclick: () => input.click(),
      ondragover: (e) => { e.preventDefault(); dz.classList.add('over'); }, ondragleave: () => dz.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); dz.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) pick(f); } },
    h('span', { class: 'dicon' }, ico('upload')), h('span', { class: 'big' }, 'اسحب ملف اللكتشر هنا أو اضغط للاختيار'), h('span', { class: 'sub' }, 'PDF أو PowerPoint — نقرأ النص والجداول والصور'));
    return [dz, input, existing.length ? h('div', { class: 'row', style: 'margin-top:1rem;justify-content:center' }, h('span', { class: 'muted small' }, 'أو اختر ملفًا سبق رفعه:'),
      ...existing.slice(0, 4).map((d) => h('button', { type: 'button', class: 'chip-btn', onclick: () => { doc = d; range = ''; view = 'ready'; draw(); } }, d.title))) : null, err];
  }
  function readingView() {
    const d = reading && reading.d;
    return h('div', { class: 'readcard', role: 'status' }, h('div', { class: 'fileline' }, h('span', { class: 'ficon' }, ico('file')), h('div', { class: 'meta' }, h('strong', { class: 'fname' }, reading ? reading.name : ''), h('span', { class: 'muted small', id: 'read-text' }, progressText(d)))),
      h('div', { class: 'progress', style: 'margin-top:1rem', role: 'progressbar', 'aria-valuenow': progressPct(d) }, h('div', { style: `width:${progressPct(d)}%` })),
      h('p', { class: 'muted small', style: 'margin:.8rem 0 0' }, 'الملفات الممسوحة ضوئيًا تستغرق وقتًا أطول لأننا نقرأ صورها. أبقِ الصفحة مفتوحة.'));
  }
  function readyView() {
    const q = doc.quality || {}; const bits = [`${num(doc.page_count)} صفحة`];
    if ((q.table_pages || []).length) bits.push(`جداول في ${num(q.table_pages.length)} صفحة`); if ((q.ocr_pages || []).length) bits.push(`قراءة ضوئية لـ ${num(q.ocr_pages.length)} صفحة`);
    const rng = h('input', { type: 'text', dir: 'ltr', placeholder: `الكل (1-${doc.page_count})`, 'aria-label': 'نطاق الصفحات', value: range, oninput: (e) => { range = e.target.value; } });
    const btn = h('button', { class: 'btn primary big', type: 'submit', id: 'create-quiz' }, 'أنشئ الكويز ←');
    const aiBox = h('div', {});
    const drawAI = () => { if (state.caps?.llm === false) fill(aiBox, h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير مفعّل على هذا الخادم. '), 'يحتاج مفتاح خدمة الذكاء الاصطناعي (ANTHROPIC_API_KEY).')); else if (state.caps?.claude_ok === false) fill(aiBox, aiConnectCard(() => drawAI())); else aiBox.replaceChildren(); btn.disabled = state.caps?.llm === false; };
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.replaceChildren(); if (aiOff()) { drawAI(); aiBox.scrollIntoView({ block: 'center' }); return; }
      btn.disabled = true; btn.textContent = 'جارٍ البدء…'; let qz = null;
      try {
        qz = await api('POST', '/api/quizzes', { title: null, sources: [{ document_id: doc.id, pages: range.trim() || null }], settings: { ...S } });
        await api('POST', `/api/quizzes/${qz.id}/analyze`, { auto_generate: true });   // analysis -> plan -> generation, no confirmation step
        location.hash = `#/quiz/${qz.id}`;
      } catch (ex) {
        if (qz) { try { await api('DELETE', `/api/quizzes/${qz.id}`); } catch (_) { /* nothing to clean */ } }   // never leave an empty draft behind
        if (ex.code === 'llm_not_configured') { state.caps = { ...state.caps, claude_ok: false }; drawAI(); }
        err.replaceChildren(errorBox(ex)); btn.disabled = false; btn.textContent = 'أنشئ الكويز ←';
      }
    } },
    h('details', { class: 'opts-panel' }, h('summary', {}, 'خيارات (اختيارية)'),
      h('div', { class: 'rowsplit', style: 'margin-top:1rem' },
        h('div', { class: 'field' }, h('label', {}, 'عدد الأسئلة'), chipGroup('count', ['auto', 10, 20, 30, 40], COUNT_LABEL), h('div', { class: 'hint' }, '«تلقائي» يغطي كل المحاضرة؛ وإن كان المحتوى أقل من المطلوب نُكمل العدد بصياغات مختلفة لنفس الأفكار.')),
        h('div', { class: 'field' }, h('label', {}, 'الصعوبة'), chipGroup('difficulty', ['mixed', 'easy', 'medium', 'hard'], (v) => ((opts && opts.difficulty) || { mixed: 'متنوعة', easy: 'سهلة', medium: 'متوسطة', hard: 'متقدمة' })[v])),
        h('div', { class: 'field' }, h('label', {}, 'لغة الأسئلة'), chipGroup('language', ['source', 'ar', 'en'], (v) => ({ source: 'لغة الملف', ar: 'العربية', en: 'English' })[v])),
        doc.page_count > 1 ? h('div', { class: 'field' }, h('label', {}, 'صفحات معيّنة فقط'), rng, h('div', { class: 'hint' }, 'مثال: 1-12, 15, 20-30. اتركه فارغًا لكل الملف.')) : null)),
    aiBox, err, h('div', { class: 'actions' }, btn));
    drawAI();
    return h('div', { class: 'readcard' }, h('div', { class: 'fileline' }, h('span', { class: 'ficon' }, ico('file')), h('div', { class: 'meta' }, h('strong', { class: 'fname' }, doc.title), h('span', { class: 'muted small' }, bits.join(' · '))),
      h('button', { class: 'btn small ghost', type: 'button', id: 'change-file', onclick: () => { view = 'idle'; doc = null; draw(); } }, 'تغيير الملف')), qualityNote(q), form);
  }
  function draw() { fill(box, view === 'reading' ? readingView() : view === 'ready' ? readyView() : idleView()); }
  function drawReading() { if (view === 'reading') draw(); }

  async function pick(file) {
    err.replaceChildren(); view = 'reading'; reading = { name: file.name, d: null }; draw();
    try {
      const d = await uploadAndRead(file, (x) => { reading.d = x; drawReading(); });
      if (d.status === 'ready') { doc = d; range = ''; view = 'ready'; } else { view = 'idle'; err.replaceChildren(h('div', { class: 'alert bad' }, d.error || 'تعذّرت قراءة الملف.')); }
    } catch (e) { view = 'idle'; err.replaceChildren(errorBox(e)); }
    draw();
  }
  (async () => {
    try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }
    try { opts = await api('GET', '/api/quizzes/options'); } catch (_) { /* defaults */ }
    try { existing = (await api('GET', '/api/documents')).filter((d) => d.status === 'ready'); } catch (_) { existing = []; }
    if (preset) { const d = existing.find((x) => x.id === preset); if (d) { doc = d; view = 'ready'; } }
    draw();
  })();
  draw();
  return box;
}
