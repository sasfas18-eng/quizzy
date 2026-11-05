import { h, api, state, fill, toast, confirmDialog, emptyState, num, arP, arF, fmtDate, spinner, errorBox } from './core.js?v=416e29fb2f';
import { lang } from './i18n.js?v=416e29fb2f';

/** a size the way a person reads it: «12 ك.ب», «3.8 م.ب», «33 م.ب» (KB / MB in English) */
const size = (b) => { const en = lang() === 'en'; if (b < 1048576) return `${num(Math.max(1, Math.round(b / 1024)))} ${en ? 'KB' : 'ك.ب'}`; const m = b / 1048576;
  return `${num(m < 10 ? Math.round(m * 10) / 10 : Math.round(m))} ${en ? 'MB' : 'م.ب'}`; };

const STATUS = { ok: ['مقروءة', 'ok'], low_text: ['نص قليل', 'warn'], image_only: ['صورة بلا نص', 'bad'], empty: ['فارغة', 'bad'], garbled: ['نص تالف', 'bad'] };
const DOC = { processing: ['قيد المعالجة…', 'info'], ready: ['جاهز', 'ok'], failed: ['فشل', 'bad'], unreadable: ['غير مقروء', 'bad'] };
const USELESS = (d) => ['unreadable', 'failed'].includes(d.status);      // a file no quiz can be built from: it only takes room

export function qualityNote(q) {
  const bad = [...q.image_only, ...q.empty, ...q.garbled];
  const parts = [];
  if (bad.length) parts.push(h('div', { class: 'alert bad' }, h('strong', {}, `${arP(bad.length)} غير مقروءة: `), bad.join('، '), ' — صور بلا نص يمكن قراءته، فلن تُستخدم ولن نخمّن محتواها.'));
  if (q.low_text.length) parts.push(h('div', { class: 'alert warn' }, `صفحات بنص قليل جدًا: ${q.low_text.join('، ')} (قد تكون عناوين أو فواصل).`));
  if (q.read_from_images?.length) parts.push(h('div', { class: 'alert info', id: 'read-from-images' }, `قُرئت ${arP(q.read_from_images.length)} من صورها (ص ${q.read_from_images.join('، ')}): قد يكون فيها خطأ قراءة قليل، والأسئلة مبنية على ما قُرئ فعلًا مع اقتباسه.`));
  if (q.figures_unread.length) parts.push(h('div', { class: 'alert info' }, `صفحات فيها صور/أشكال لم تُقرأ (النص فقط يُستخدم): ${q.figures_unread.join('، ')}.`));
  return parts;
}

/** While a file is read: the progress of the slow part - reading the pages that are pictures - shown in `box` (a scanned lecture takes a while; the student sees it move). Returns a stop function. */
export function readingProgress(file, box) {
  const on = (e) => { const d = e.detail || {}; if (d.name !== file.name) return;
    if (d.phase === 'ocr-load') box.replaceChildren(spinner(`«${file.name}» صفحاته صور: جارٍ تجهيز قراءتها (أول مرة فقط قد تستغرق دقيقة)…`));
    else if (d.phase === 'ocr') box.replaceChildren(spinner(`جارٍ قراءة الصفحات المصوّرة في «${file.name}»… ${num(d.done)} من ${num(d.total)}`)); };
  window.addEventListener('qz-progress', on); return () => window.removeEventListener('qz-progress', on);
}
/** Upload ONE file and wait until it has been read (the browser editions read it at once; the server reads it in the background). Resolves with the finished document summary. */
export async function uploadAndWait(file) {
  const fd = new FormData(); fd.append('file', file);
  let d = await api('POST', '/api/documents', fd);
  for (let i = 0; d.status === 'processing' && i < 300; i++) { await new Promise((r) => setTimeout(r, 1000)); d = await api('GET', `/api/documents/${d.id}`); }
  if (d.status === 'processing') throw new Error('استغرقت قراءة الملف وقتًا أطول من المعتاد. افتح «ملفاتي» بعد قليل وسترى حالته.');
  return d;
}

export async function filesPage() {
  const root = h('div', {});
  const list = h('div', {});
  const input = h('input', { type: 'file', accept: '.pdf,.pptx,.ppt', id: 'file', style: 'display:none', onchange: () => { const f = input.files[0]; input.value = ''; upload(f); } });      // value reset: choosing the SAME file again must fire "change" again
  const progress = h('div', {});
  async function upload(file) {
    if (!file) return;
    progress.replaceChildren(spinner(`جارٍ رفع ومعالجة «${file.name}»…`)); if (list.querySelector('.empty')) list.replaceChildren(); const stop = readingProgress(file, progress);
    try { const d = await uploadAndWait(file).finally(stop); await load(); showRoom().catch(() => {});
      if (d.status === 'ready') { progress.replaceChildren(); toast(d.quality?.read_from_images?.length ? `قُرئ الملف، ومنه ${arP(d.quality.read_from_images.length)} من الصور` : 'تمت معالجة الملف', 'ok'); }
      else progress.replaceChildren(h('div', { class: 'alert bad', id: 'unreadable-note' }, h('strong', {}, `لا يمكن بناء كويز من «${d.title}»: `), d.error || 'لم يُستخرج منه نص يمكن قراءته.')); }
    catch (e) { progress.replaceChildren(errorBox(e)); }
  }
  // tidying up (files fill the room the browser gives the site): delete one file from its row, tick several (or «select all») and delete them
  // in one go, or clear every file no quiz can be built from. Nothing goes without a confirmation; quizzes built from a file keep their questions.
  let docs = []; const sel = new Set();
  const bar = h('div', { class: 'row selbar', id: 'files-sel-bar', role: 'region', 'aria-label': 'حذف الملفات المحددة' });
  const tools = h('span', { style: 'display:contents' });
  async function removeIds(ids, title) {
    if (!ids.length) return;
    const one = ids.length === 1 && docs.find((d) => d.id === ids[0]);
    const text = one ? 'سيُحذف الملف ونصه. الكويزات المبنية عليه تحتفظ بأسئلتها.' : `ستُحذف ${arF(ids.length)} مع نصوصها. الكويزات المبنية عليها تحتفظ بأسئلتها.`;
    if (!(await confirmDialog(title, text, 'احذف', true))) return;
    list.querySelectorAll('button, input').forEach((x) => { x.disabled = true; }); bar.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    let n = 0;
    try { for (const id of ids) { await api('DELETE', `/api/documents/${id}`); n++; sel.delete(id); } toast(`حُذف ${arF(n)}`, 'ok'); }
    catch (e) { toast(e.message || 'تعذّر الحذف', 'bad'); }
    await load(); showRoom().catch(() => {});
  }
  const drawBar = () => fill(bar, sel.size ? [h('span', { class: 'muted', id: 'files-sel-count' }, `حُدِّد ${num(sel.size)}`),
    h('button', { class: 'btn small danger', id: 'files-delete-selected', onclick: () => removeIds([...sel], 'حذف الملفات المحددة؟') }, `حذف المحدد (${num(sel.size)})`),
    h('button', { class: 'btn small', onclick: () => { sel.clear(); draw(); } }, 'إلغاء التحديد')]
    : h('span', { class: 'muted small' }, docs.length > 1 ? 'حدّد ملفات من القائمة لحذفها، أو «تحديد الكل».' : 'احذف ملفًا لا تحتاجه من زر «حذف» في صفّه.'));
  const drawTools = () => { const dead = docs.filter(USELESS);
    fill(tools, dead.length ? h('button', { class: 'btn small danger', id: 'files-clear-unreadable', onclick: () => removeIds(docs.filter(USELESS).map((d) => d.id), 'حذف الملفات غير المقروءة؟') }, `حذف غير المقروءة (${num(dead.length)})`) : null); };
  const tick = (d) => h('td', { class: 'selcell', 'data-label': 'تحديد' }, h('input', { type: 'checkbox', class: 'fsel', 'aria-label': 'تحديد «' + d.title + '»', checked: sel.has(d.id),
    onchange: (e) => { if (e.target.checked) sel.add(d.id); else sel.delete(d.id); e.target.closest('tr').classList.toggle('selected', e.target.checked); const a = list.querySelector('#files-sel-all'); if (a) a.checked = docs.every((x) => sel.has(x.id)); drawBar(); } }));
  function draw() {
    drawBar(); drawTools();
    if (!docs.length) { list.replaceChildren(emptyState('📄', 'لا توجد ملفات بعد', 'ارفع PDF أو PowerPoint للبدء.', h('button', { class: 'btn primary', onclick: () => input.click() }, 'اختر ملفًا'))); return; }
    const all = h('th', { class: 'selcell' }, h('input', { type: 'checkbox', id: 'files-sel-all', 'aria-label': 'تحديد كل الملفات', checked: docs.every((d) => sel.has(d.id)),
      onchange: (e) => { docs.forEach((d) => (e.target.checked ? sel.add(d.id) : sel.delete(d.id))); draw(); } }));
    list.replaceChildren(bar, h('div', { class: 'tablewrap' }, h('table', { class: 'stack' }, h('thead', {}, h('tr', {}, all, ['الملف', 'النوع', 'الصفحات', 'الحالة', 'رُفع', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, docs.map((d) => {
        const badp = d.quality.image_only.length + d.quality.empty.length + d.quality.garbled.length;
        return h('tr', { class: sel.has(d.id) ? 'selected' : '' }, tick(d), h('td', { class: 'bidi' }, h('a', { href: `#/files/${d.id}`, translate: 'no' }, d.title)), h('td', { 'data-label': 'النوع' }, d.kind.toUpperCase()),
          h('td', { 'data-label': 'الصفحات' }, num(d.page_count), badp ? h('span', { class: 'badge bad', style: 'margin-inline-start:.4rem' }, `${num(badp)} غير مقروءة`) : null),
          h('td', { 'data-label': 'الحالة' }, h('span', { class: 'badge ' + DOC[d.status][1] }, DOC[d.status][0])), h('td', { class: 'muted small', 'data-label': 'رُفع' }, fmtDate(d.created_at)),
          h('td', { class: 'row' }, d.status === 'ready' && h('a', { class: 'btn small primary', href: `#/new?doc=${d.id}` }, 'كويز'), h('a', { class: 'btn small', href: `#/files/${d.id}` }, 'التفاصيل'),
            h('button', { class: 'btn small danger fdel', 'aria-label': 'حذف «' + d.title + '»', onclick: () => removeIds([d.id], 'حذف الملف؟') }, 'حذف')));
      })))));
  }
  async function load() {
    docs = await api('GET', '/api/documents');
    const ids = new Set(docs.map((d) => d.id)); [...sel].forEach((id) => { if (!ids.has(id)) sel.delete(id); });      // a deleted file is no longer ticked
    draw();
  }
  const room = h('div', {});
  async function showRoom() {      // browser editions keep everything on this device: say how much room is left, and warn long before it runs out
    const info = state.caps?.accounts === 'device' && window.QZ_STORES && window.QZ_STORES.storageInfo ? await window.QZ_STORES.storageInfo() : null; if (!info) return;
    const mb = (n) => num(Math.max(1, Math.round(n / 1048576))); const ratio = info.usage / info.quota;
    const S = window.QZ_STORES; const kept = S.toolsInfo ? await S.toolsInfo() : { model: 0, reading: 0 }; const toolBytes = kept.model + kept.reading;
    // what fills the room, said plainly: the student's own data is small; the tools downloaded once are most of it, and deleting files does not touch them
    const parts = [kept.model > 0 && `نموذج وكيل الصياغة ${size(kept.model)}`, kept.reading > 0 && `قراءة الصفحات المصوّرة ${size(kept.reading)}`].filter(Boolean);
    const toolsLine = toolBytes >= 512 * 1024 ? h('p', { class: 'muted small', id: 'room-tools' }, `منها ${size(toolBytes)} أدوات تُنزَّل مرة واحدة وتُستعمل لكل كويز`, ' (',
      parts.map((x, i) => [i ? (lang() === 'en' ? ', ' : '، ') : '', h('span', {}, x)]), ')', '، وحذف الملفات لا يمسّها. ',
      h('button', { class: 'btn small', id: 'clear-tools', onclick: async () => {
        if (!(await confirmDialog('إفراغ الأدوات المحفوظة؟', `يُحرَّر ${size(toolBytes)} من جهازك. لا يضيع شيء من ملفاتك وكويزاتك وبطاقاتك؛ وتُنزَّل الأدوات من جديد تلقائيًا عند الحاجة، فيستغرق أول كويز بعدها وقتًا أطول قليلًا.`, 'أفرغها', true))) return;
        const freed = await S.clearTools(); toast(`حُرِّر ${size(freed)}`, 'ok'); showRoom().catch(() => {}); } }, 'إفراغ الأدوات المحفوظة')) : null;
    fill(room, ratio >= 0.8 ? h('div', { class: 'alert warn' }, h('strong', {}, 'المساحة التي يمنحها متصفحك لهذا الموقع شارفت على الامتلاء. '), `المستخدم ${mb(info.usage)} م.ب من ${mb(info.quota)} م.ب. احذف كويزات أو ملفات قديمة (في «كويزاتي» زر يحذف الكويزات الفاشلة دفعة واحدة)، أو نزّل نسخة من بياناتك من «حسابي».`)
      : h('p', { class: 'muted small', id: 'room' }, `المساحة المستخدمة على جهازك: ${size(info.usage)} من ${size(info.quota)}.`,
        info.pending ? [' ', h('span', { id: 'room-pending' }, `يُتمّ المتصفح إخراج ${size(info.pending)} حُرِّرت من حسابه حين تغلقه وتفتحه من جديد.`)] : null), toolsLine);
  }
  root.append(h('div', { class: 'row between' }, h('h1', {}, 'ملفاتي'), h('div', { class: 'row' }, tools, h('button', { class: 'btn primary', onclick: () => input.click() }, '⬆ رفع ملف')), input),
    h('p', { class: 'muted' }, 'المدعوم: PDF وPowerPoint ‏(PPTX وPPT، حتى 40MB). نستخرج النص القابل للقراءة فقط، ونُعلمك بأي صفحة تحتاج معالجة إضافية.'), progress, list, room);
  await load(); showRoom().catch(() => {});
  return root;
}

export async function fileDetail(id) {
  const d = await api('GET', `/api/documents/${id}`);
  const viewer = h('div', {});
  async function show(no) {
    const p = await api('GET', `/api/documents/${id}/pages/${no}`);
    viewer.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, `نص الصفحة ${num(no)}`), h('span', { class: 'badge ' + STATUS[p.status][1] }, STATUS[p.status][0])),
      p.notes && h('p', { class: 'muted small' }, p.notes), h('pre', { dir: 'auto', style: 'white-space:pre-wrap;font:inherit;background:#f7f9fa;padding:.8rem;border-radius:10px;max-height:420px;overflow:auto' }, p.text || h('span', { 'data-ui': '' }, '(لا يوجد نص مستخرج)'))));
  }
  return h('div', {},
    h('div', { class: 'row between' }, h('div', {}, h('h1', { class: 'bidi' }, d.title), h('div', { class: 'muted small' }, `${d.kind.toUpperCase()} · ${arP(d.page_count)} · ${d.filename}`)),
      h('div', { class: 'row' }, d.status === 'ready' && h('a', { class: 'btn primary', href: `#/new?doc=${d.id}` }, 'إنشاء كويز'),
        d.status === 'ready' && h('a', { class: 'btn', href: `#/cards?doc=${d.id}` }, 'بطاقات المراجعة'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('حذف الملف؟', 'سيُحذف الملف ونصه. الكويزات المبنية عليه تحتفظ بأسئلتها.', 'حذف', true)) { await api('DELETE', `/api/documents/${id}`); location.hash = '#/files'; } } }, 'حذف'))),
    d.error && h('div', { class: 'alert bad' }, d.error), qualityNote(d.quality),
    h('div', { class: 'card' }, h('h3', {}, 'جودة الاستخراج لكل صفحة'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'الحالة', 'الأحرف', 'مقتطف', 'ملاحظة', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, (d.pages || []).map((p) => h('tr', {}, h('td', {}, num(p.page_no)), h('td', {}, h('span', { class: 'badge ' + STATUS[p.status][1] }, STATUS[p.status][0])), h('td', {}, num(p.char_count)),
        h('td', { dir: 'auto', class: 'small muted' }, (p.snippet || '').replace(/\n/g, ' · ').slice(0, 90)), h('td', { class: 'small' }, p.notes),
        h('td', {}, h('button', { class: 'btn small', onclick: () => show(p.page_no) }, 'عرض')))))))), viewer);
}
