import { h, api, state, toast, confirmDialog, emptyState, num, fmtDate, spinner, errorBox, ico, fill } from './core.js';
import { qualityNote, uploadAndRead, progressText, progressPct } from './docs.js';

export { qualityNote } from './docs.js';

const STATUS = { ok: ['مقروءة', 'ok'], low_text: ['نص قليل', 'warn'], image_only: ['صورة بلا نص', 'bad'], empty: ['فارغة', 'bad'], garbled: ['نص تالف', 'bad'] };
const DOC = { processing: ['قيد القراءة…', 'info'], ready: ['جاهز', 'ok'], failed: ['فشل', 'bad'], unreadable: ['غير مقروء', 'bad'] };

export async function filesPage() {
  const root = h('div', {}), list = h('div', {}), progress = h('div', {});
  const input = h('input', { type: 'file', accept: '.pdf,.pptx', id: 'file', style: 'display:none', onchange: () => upload(input.files[0]) });
  let poller = null;
  async function upload(file) {
    if (!file) return;
    const paint = (d) => fill(progress, h('div', { class: 'readcard', role: 'status' }, h('div', { class: 'fileline' }, h('span', { class: 'ficon' }, ico('file')), h('div', { class: 'meta' }, h('strong', { class: 'fname' }, file.name), h('span', { class: 'muted small' }, progressText(d)))),
      h('div', { class: 'progress', style: 'margin-top:.9rem' }, h('div', { style: `width:${progressPct(d)}%` }))));
    paint(null);
    try { const d = await uploadAndRead(file, paint); fill(progress); if (d.status === 'ready') toast('تمت قراءة الملف', 'ok'); else fill(progress, h('div', { class: 'alert bad' }, d.error || 'تعذّرت قراءة الملف.')); await load(); }
    catch (e) { fill(progress, errorBox(e)); }
  }
  async function load() {
    clearTimeout(poller);
    const docs = await api('GET', '/api/documents');
    if (!docs.length) { fill(list, h('div', { class: 'card' }, emptyState('📄', 'لا توجد ملفات بعد', 'ارفع PDF أو PowerPoint لتبدأ.', h('button', { class: 'btn primary', onclick: () => input.click() }, 'اختر ملفًا')))); return; }
    fill(list, docs.map((d) => {
      const badp = (d.quality.image_only || []).length + (d.quality.empty || []).length + (d.quality.garbled || []).length;
      return h('div', { class: 'card', style: 'padding:1rem 1.2rem' }, h('div', { class: 'fileline' }, h('span', { class: 'ficon' }, ico('file')),
        h('div', { class: 'meta' }, h('a', { href: `#/files/${d.id}`, class: 'bidi', style: 'font-weight:700;font-size:1.05rem;text-decoration:none' }, d.title),
          h('div', { class: 'row', style: 'gap:.45rem;margin-top:.2rem' }, h('span', { class: 'badge' }, d.kind.toUpperCase()), d.status === 'processing' ? h('span', { class: 'muted small' }, progressText(d)) : h('span', { class: 'muted small' }, `${num(d.page_count)} صفحة`),
            h('span', { class: 'badge ' + DOC[d.status][1] }, DOC[d.status][0]), badp ? h('span', { class: 'badge bad' }, `${num(badp)} غير مقروءة`) : null,
            (d.quality.ocr_pages || []).length ? h('span', { class: 'badge info' }, 'قراءة ضوئية') : null, (d.quality.table_pages || []).length ? h('span', { class: 'badge info' }, 'جداول') : null, h('span', { class: 'muted small' }, fmtDate(d.created_at)))),
        h('div', { class: 'row' }, d.status === 'ready' && h('a', { class: 'btn small primary', href: `#/new?doc=${d.id}` }, 'كويز'), h('a', { class: 'btn small', href: `#/files/${d.id}` }, 'التفاصيل'))));
    }));
    if (docs.some((d) => d.status === 'processing')) poller = setTimeout(() => load().catch(() => {}), 1500);
  }
  root.append(h('div', { class: 'pagehead' }, h('div', {}, h('h1', {}, 'ملفاتي'), h('div', { class: 'muted' }, 'اللكتشرات التي رفعتها. نقرأ النص والجداول والصور (بالقراءة الضوئية عند الحاجة).')), h('button', { class: 'btn primary', id: 'upload-btn', onclick: () => input.click() }, ico('upload'), 'رفع ملف'), input), progress, list);
  await load();
  return root;
}

export async function fileDetail(id) {
  const d = await api('GET', `/api/documents/${id}`);
  const viewer = h('div', {});
  async function show(no) {
    const p = await api('GET', `/api/documents/${id}/pages/${no}`);
    fill(viewer, h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, `نص الصفحة ${num(no)}`), h('span', { class: 'badge ' + STATUS[p.status][1] }, STATUS[p.status][0])),
      p.notes && h('p', { class: 'muted small' }, p.notes), h('pre', { dir: 'auto', style: 'white-space:pre-wrap;font:inherit;background:#f7f5ef;padding:.9rem;border-radius:14px;max-height:420px;overflow:auto' }, p.text || '(لا يوجد نص مستخرج)')));
  }
  return h('div', {},
    h('div', { class: 'pagehead' }, h('div', {}, h('h1', { class: 'bidi' }, d.title), h('div', { class: 'muted small' }, `${d.kind.toUpperCase()} · ${num(d.page_count)} صفحة · ${d.filename}`)),
      h('div', { class: 'row' }, d.status === 'ready' && h('a', { class: 'btn primary', href: `#/new?doc=${d.id}` }, 'إنشاء كويز'),
        d.status === 'ready' && h('a', { class: 'btn', href: `#/cards?doc=${d.id}` }, 'بطاقات المراجعة'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('حذف الملف؟', 'سيُحذف الملف ونصه. الكويزات المبنية عليه تحتفظ بأسئلتها.', 'حذف', true)) { await api('DELETE', `/api/documents/${id}`); location.hash = '#/files'; } } }, 'حذف'))),
    d.error && h('div', { class: 'alert bad' }, d.error), qualityNote(d.quality),
    h('div', { class: 'card' }, h('h3', {}, 'جودة الاستخراج لكل صفحة'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'الحالة', 'الأحرف', 'مقتطف', 'ملاحظة', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, (d.pages || []).map((p) => h('tr', {}, h('td', {}, num(p.page_no)), h('td', {}, h('span', { class: 'badge ' + STATUS[p.status][1] }, STATUS[p.status][0]), p.ocr ? h('span', { class: 'badge info', style: 'margin-inline-start:.3rem' }, 'OCR') : null, p.tables ? h('span', { class: 'badge info', style: 'margin-inline-start:.3rem' }, 'جدول') : null), h('td', {}, num(p.char_count)),
        h('td', { dir: 'auto', class: 'small muted' }, (p.snippet || '').replace(/\n/g, ' · ').slice(0, 90)), h('td', { class: 'small' }, p.notes),
        h('td', {}, h('button', { class: 'btn small', onclick: () => show(p.page_no) }, 'عرض')))))))), viewer);
}
