import { h, api, state, fill, toast, saveRemote, emptyState, num, arC, spinner, errorBox, confirmDialog } from './core.js?v=c8b7957638';
import { onLeave } from './main.js?v=c8b7957638';
import { reportDialog } from './pages_solve.js?v=c8b7957638';
import { aiConnectCard } from './pages_settings.js?v=c8b7957638';

const ST = { new: ['جديدة', 'info'], known: ['أعرفها', 'ok'], review: ['تحتاج مراجعة', 'warn'] };

export async function cardsPage() {
  const [docs, stats] = await Promise.all([api('GET', '/api/documents'), api('GET', '/api/cards/stats')]);
  const ready = docs.filter((d) => d.status === 'ready');
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('doc');
  const root = h('div', {}, h('h1', {}, 'بطاقات المراجعة'),
    h('p', { class: 'muted' }, 'بطاقات من ملفاتك أنت: سؤال/مفهوم في الوجه الأمامي وإجابة في الخلفي، مع المصدر والصفحة. حالتها محفوظة على حسابك.'));
  const aiOff = state.caps?.claude_ok === false, local = aiOff && !!state.caps?.rules_mode, canGen = state.caps?.llm !== false || !!state.caps?.rules_mode;
  if (local) root.append(h('div', { class: 'alert info', id: 'local-cards-note' }, h('strong', {}, 'تُبنى على جهازك فورًا. '), 'من تعريفات ملفك وأسبابه وقوائمه، مع الاقتباس والصفحة. ',
    state.caps?.byok ? h('details', { style: 'margin-top:.5rem' }, h('summary', {}, 'بطاقات أذكى: اربط ذكاءً اصطناعيًا مجانيًا (اختياري)'), aiConnectCard(() => { location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange')); })) : null));
  else if (aiOff) root.append(aiConnectCard(() => { location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange')); }));
  if (!ready.length) { root.append(h('div', { class: 'card' }, emptyState('🗂', 'لا توجد ملفات', 'ارفع ملفًا لتوليد بطاقات منه.', h('a', { class: 'btn primary', href: '#/files' }, 'رفع ملف')))); return root; }
  const byDoc = Object.fromEntries(stats.map((s) => [s.id, s]));
  ready.forEach((d) => {
    const s = byDoc[d.id];
    const status = h('div', {});
    const o = { pages: '', count: 20 };
    root.append(h('div', { class: 'card', style: preset === d.id ? 'border-color:var(--accent)' : '' },
      h('div', { class: 'row between' }, h('div', {}, h('h3', { class: 'bidi' }, d.title), s ? h('div', { class: 'small muted' }, `${arC(s.total)} · ${num(s.known)} أعرفها · ${num(s.review)} تحتاج مراجعة · ${num(s.new)} جديدة · ${num(s.due)} مستحقة الآن`) : h('div', { class: 'small muted' }, 'لا بطاقات بعد')),
        s ? h('div', { class: 'row' }, h('a', { class: 'btn primary small', href: `#/cards/study?doc=${d.id}` }, 'ادرس'), s.due ? h('a', { class: 'btn small', href: `#/cards/study?doc=${d.id}&due=1` }, `المستحقة الآن (${num(s.due)})`) : null,
          h('a', { class: 'btn small', href: `#/cards/study?doc=${d.id}&mode=list` }, 'القائمة')) : null),
      h('div', { class: 'row', style: 'margin-top:.7rem;align-items:flex-end' },
        h('div', { style: 'flex:1;min-width:150px' }, h('label', { for: 'cpages-' + d.id }, 'الصفحات'), h('input', { id: 'cpages-' + d.id, type: 'text', dir: 'ltr', placeholder: 'الكل', oninput: (e) => { o.pages = e.target.value; } })),
        h('div', { style: 'width:110px' }, h('label', { for: 'ccount-' + d.id }, 'العدد'), h('input', { id: 'ccount-' + d.id, type: 'number', min: 3, max: 60, value: 20, dir: 'ltr', oninput: (e) => { o.count = +e.target.value || 20; } })),
        h('button', { class: 'btn', disabled: !canGen || (aiOff && !local), onclick: async (e) => {
          e.target.disabled = true; const sp = spinner('جارٍ توليد البطاقات والتحقق من اقتباساتها…'); status.replaceChildren(sp);
          const onP = (ev) => { const d = ev.detail || {}; if (d.stage === 'cards' && d.total) { const t = sp.querySelector('span:last-child') || sp; t.textContent = `جارٍ توليد البطاقات… ${num(d.done)} من ${num(d.total)} أجزاء من المحاضرة`; } }; window.addEventListener('qz-progress', onP);
          try { const r = await api('POST', `/api/documents/${d.id}/cards/generate`, { pages: o.pages.trim() || null, count: o.count });
            toast(`أُنشئت ${arC(r.created)}`, 'ok'); location.hash = `#/cards/study?doc=${d.id}&mode=list`; if (location.hash.includes('/cards') && !r.created) status.replaceChildren(h('div', { class: 'alert warn' }, `لم تُنشأ بطاقات جديدة (مكررة أو بلا اقتباس صالح: ${JSON.stringify(r.rejected)}).`)); }
          catch (ex) { status.replaceChildren(errorBox(ex)); e.target.disabled = false; } finally { window.removeEventListener('qz-progress', onP); } } }, 'توليد بطاقات')),
      !canGen && h('div', { class: 'hint' }, 'التوليد غير مفعّل على الخادم (يحتاج ANTHROPIC_API_KEY).'), status));
  });
  return root;
}

export async function studyPage() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const doc = q.get('doc'), stateF = q.get('state'), mode = q.get('mode'), due = q.get('due');
  let cards = await api('GET', '/api/cards?' + new URLSearchParams({ ...(doc ? { document_id: doc } : {}), ...(stateF ? { state: stateF } : {}), ...(due ? { due: 'true' } : {}) }));
  const root = h('div', {});
  if (!cards.length) return h('div', { class: 'card' }, emptyState('🗂', due ? 'لا بطاقات مستحقة الآن — أحسنت!' : (stateF === 'review' ? 'لا توجد بطاقات تحتاج مراجعة' : 'لا توجد بطاقات'), 'ولّد بطاقات من ملفاتك أولًا.', h('a', { class: 'btn primary', href: '#/cards' }, 'البطاقات')));
  if (mode === 'list') {
    return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, `البطاقات (${num(cards.length)})`), h('a', { class: 'btn primary', href: `#/cards/study?doc=${doc}` }, 'ابدأ الدراسة')),
      h('div', { class: 'tablewrap card' }, h('table', {}, h('thead', {}, h('tr', {}, ['الأمام', 'الخلف', 'ص', 'الحالة', ''].map((t) => h('th', {}, t)))), h('tbody', {}, cards.map((c) => h('tr', {}, h('td', { class: 'bidi' }, c.front), h('td', { class: 'bidi' }, c.back), h('td', {}, c.source_page), h('td', {}, h('span', { class: 'badge ' + ST[c.state][1] }, ST[c.state][0])),
        h('td', {}, h('button', { class: 'btn small ghost', onclick: () => reportDialog('flashcard', c.id) }, 'إبلاغ'), h('button', { class: 'btn small ghost danger', onclick: async (e) => { if (await confirmDialog('حذف البطاقة؟', '', 'حذف', true)) { await api('DELETE', `/api/cards/${c.id}`); e.target.closest('tr').remove(); } } }, 'حذف'))))))));
  }
  let i = 0, back = false, done = 0;
  const onKey = (e) => { if (e.target.matches('input,textarea')) return; if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } else if (e.key === '1') mark('known'); else if (e.key === '2') mark('review'); };
  document.addEventListener('keydown', onKey);
  onLeave(() => document.removeEventListener('keydown', onKey));
  function flip() { back = !back; draw(); }
  async function mark(s) {
    const c = cards[i];
    try { await saveRemote(`card:${c.id}`, () => api('PUT', `/api/cards/${c.id}/state`, { state: s })); c.state = s; done++; back = false; i++; draw(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  function draw() {
    if (i >= cards.length) {
      const k = cards.filter((c) => c.state === 'known').length, r = cards.filter((c) => c.state === 'review').length;
      root.replaceChildren(h('div', { class: 'card center' }, h('h2', {}, 'انتهت الجلسة'), h('p', {}, `أعرف ${num(k)} · تحتاج مراجعة ${num(r)}`),
        h('div', { class: 'row', style: 'justify-content:center' }, r ? h('a', { class: 'btn primary', href: `#/cards/study?${doc ? `doc=${doc}&` : ''}state=review` }, 'راجع المحتاجة') : null, h('button', { class: 'btn', onclick: () => { i = 0; back = false; draw(); } }, 'أعد الجلسة'), h('a', { class: 'btn', href: '#/cards' }, 'عودة'))));
      return;
    }
    const c = cards[i];
    fill(root, h('div', { class: 'row between' }, h('h1', {}, stateF === 'review' ? 'مراجعة المحتاجة' : 'دراسة البطاقات'), h('span', { class: 'badge info' }, `${num(i + 1)} / ${num(cards.length)}`)),
      h('div', { class: 'progress' }, h('div', { style: `width:${(100 * i) / cards.length}%` })),
      h('div', { class: 'flip' + (back ? ' back' : '') }, h('div', { class: 'flipin', tabindex: 0, role: 'button', 'aria-label': back ? 'الوجه الخلفي — اضغط للقلب' : 'الوجه الأمامي — اضغط للقلب', onclick: flip },
        h('div', { class: 'face bidi', dir: 'auto', 'aria-hidden': String(back) }, c.front, h('small', { 'data-ui': '' }, 'اضغط للقلب (مسافة)')),
        h('div', { class: 'face bk bidi', dir: 'auto', 'aria-hidden': String(!back) }, c.back, h('small', { 'data-ui': '' }, `المصدر: ${c.document_title || ''} · ص${num(c.source_page)}`)))),
      back && c.evidence ? h('details', { class: 'card' }, h('summary', {}, 'اقتباس المصدر'), h('blockquote', { class: 'bidi', translate: 'no', style: 'margin:.5rem 0 0' }, `«${c.evidence}»`)) : null,
      h('div', { class: 'row', style: 'justify-content:center' }, !back ? h('button', { class: 'btn primary', onclick: flip }, 'اقلب البطاقة') : [
        h('button', { class: 'btn primary', onclick: () => mark('known') }, '✓ أعرفها (1)'), h('button', { class: 'btn', onclick: () => mark('review') }, '↻ أحتاج مراجعتها (2)')]),
      h('div', { class: 'center' }, h('button', { class: 'btn small ghost', onclick: () => reportDialog('flashcard', c.id) }, '⚠ أبلغ عن مشكلة في البطاقة')));
  }
  draw();
  return root;
}
