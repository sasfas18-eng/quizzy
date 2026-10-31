import { h, api, state, toast, confirmDialog, emptyState, num, fmtDate, spinner, errorBox } from './core.js?v=0ac193621c';

const STATUS = { ok: ['مقروءة', 'ok'], low_text: ['نص قليل', 'warn'], image_only: ['صورة بلا نص', 'bad'], empty: ['فارغة', 'bad'], garbled: ['نص تالف', 'bad'] };
const DOC = { processing: ['قيد المعالجة…', 'info'], ready: ['جاهز', 'ok'], failed: ['فشل', 'bad'], unreadable: ['غير مقروء', 'bad'] };

export function qualityNote(q) {
  const bad = [...q.image_only, ...q.empty, ...q.garbled];
  const parts = [];
  if (bad.length) parts.push(h('div', { class: 'alert bad' }, h('strong', {}, `${num(bad.length)} صفحة غير مقروءة: `), bad.join('، '), ' — هذه الصفحات لن تُستخدم ولن نخمّن محتواها. تحتاج معالجة OCR غير مفعّلة حاليًا.'));
  if (q.low_text.length) parts.push(h('div', { class: 'alert warn' }, `صفحات بنص قليل جدًا: ${q.low_text.join('، ')} (قد تكون عناوين أو فواصل).`));
  if (q.figures_unread.length) parts.push(h('div', { class: 'alert info' }, `صفحات فيها صور/أشكال لم تُقرأ (النص فقط يُستخدم): ${q.figures_unread.join('، ')}.`));
  return parts;
}

export async function filesPage() {
  const root = h('div', {});
  const list = h('div', {});
  const input = h('input', { type: 'file', accept: '.pdf,.pptx', id: 'file', style: 'display:none', onchange: () => upload(input.files[0]) });
  const progress = h('div', {});
  async function upload(file) {
    if (!file) return;
    progress.replaceChildren(spinner(`جارٍ رفع ومعالجة «${file.name}»…`));
    const fd = new FormData(); fd.append('file', file);
    try {
      const d = await api('POST', '/api/documents', fd);
      await poll(d.id);
      progress.replaceChildren(); toast('تمت معالجة الملف', 'ok'); await load();
    } catch (e) { progress.replaceChildren(errorBox(e)); }
  }
  async function poll(id) {
    for (let i = 0; i < 300; i++) {
      const d = await api('GET', `/api/documents/${id}`);
      if (d.status !== 'processing') return d;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  async function load() {
    const docs = await api('GET', '/api/documents');
    if (!docs.length) { list.replaceChildren(emptyState('📄', 'لا توجد ملفات بعد', 'ارفع PDF أو PPTX للبدء.', h('button', { class: 'btn primary', onclick: () => input.click() }, 'اختر ملفًا'))); return; }
    list.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['الملف', 'النوع', 'الصفحات', 'الحالة', 'رُفع', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, docs.map((d) => {
        const badp = d.quality.image_only.length + d.quality.empty.length + d.quality.garbled.length;
        return h('tr', {}, h('td', { class: 'bidi' }, h('a', { href: `#/files/${d.id}` }, d.title)), h('td', {}, d.kind.toUpperCase()),
          h('td', {}, num(d.page_count), badp ? h('span', { class: 'badge bad', style: 'margin-inline-start:.4rem' }, `${num(badp)} غير مقروءة`) : null),
          h('td', {}, h('span', { class: 'badge ' + DOC[d.status][1] }, DOC[d.status][0])), h('td', { class: 'muted small' }, fmtDate(d.created_at)),
          h('td', { class: 'row' }, d.status === 'ready' && h('a', { class: 'btn small primary', href: `#/new?doc=${d.id}` }, 'كويز'), h('a', { class: 'btn small', href: `#/files/${d.id}` }, 'التفاصيل')));
      })))));
  }
  root.append(h('div', { class: 'row between' }, h('h1', {}, 'ملفاتي'), h('button', { class: 'btn primary', onclick: () => input.click() }, '⬆ رفع ملف'), input),
    h('p', { class: 'muted' }, 'المدعوم: PDF وPPTX (حتى 40MB). نستخرج النص القابل للقراءة فقط، ونُعلمك بأي صفحة تحتاج معالجة إضافية.'), progress, list);
  await load();
  return root;
}

export async function fileDetail(id) {
  const d = await api('GET', `/api/documents/${id}`);
  const viewer = h('div', {});
  async function show(no) {
    const p = await api('GET', `/api/documents/${id}/pages/${no}`);
    viewer.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, `نص الصفحة ${num(no)}`), h('span', { class: 'badge ' + STATUS[p.status][1] }, STATUS[p.status][0])),
      p.notes && h('p', { class: 'muted small' }, p.notes), h('pre', { dir: 'auto', style: 'white-space:pre-wrap;font:inherit;background:#f7f9fa;padding:.8rem;border-radius:10px;max-height:420px;overflow:auto' }, p.text || '(لا يوجد نص مستخرج)')));
  }
  return h('div', {},
    h('div', { class: 'row between' }, h('div', {}, h('h1', { class: 'bidi' }, d.title), h('div', { class: 'muted small' }, `${d.kind.toUpperCase()} · ${num(d.page_count)} صفحة · ${d.filename}`)),
      h('div', { class: 'row' }, d.status === 'ready' && h('a', { class: 'btn primary', href: `#/new?doc=${d.id}` }, 'إنشاء كويز'),
        d.status === 'ready' && h('a', { class: 'btn', href: `#/cards?doc=${d.id}` }, 'بطاقات المراجعة'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('حذف الملف؟', 'سيُحذف الملف ونصه. الكويزات المبنية عليه تحتفظ بأسئلتها.', 'حذف', true)) { await api('DELETE', `/api/documents/${id}`); location.hash = '#/files'; } } }, 'حذف'))),
    d.error && h('div', { class: 'alert bad' }, d.error), qualityNote(d.quality),
    h('div', { class: 'card' }, h('h3', {}, 'جودة الاستخراج لكل صفحة'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'الحالة', 'الأحرف', 'مقتطف', 'ملاحظة', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, (d.pages || []).map((p) => h('tr', {}, h('td', {}, num(p.page_no)), h('td', {}, h('span', { class: 'badge ' + STATUS[p.status][1] }, STATUS[p.status][0])), h('td', {}, num(p.char_count)),
        h('td', { dir: 'auto', class: 'small muted' }, (p.snippet || '').replace(/\n/g, ' · ').slice(0, 90)), h('td', { class: 'small' }, p.notes),
        h('td', {}, h('button', { class: 'btn small', onclick: () => show(p.page_no) }, 'عرض')))))))), viewer);
}
