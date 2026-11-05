import { h, api, state, fill, toast, confirmDialog, modal, emptyState, num, arQ, arP, pct, fmtDate, spinner, errorBox } from './core.js?v=4f74e3bbef';
import { onLeave, quizTable } from './main.js?v=4f74e3bbef';
import { uploadAndWait, readingProgress } from './pages_files.js?v=4f74e3bbef';
import { aiConnectCard } from './pages_settings.js?v=4f74e3bbef';

const PAGE = 50;
export async function quizzesPage() {
  let list = await api('GET', '/api/quizzes');
  const dead = list.filter((q) => ['failed', 'draft', 'insufficient'].includes(q.status));      // never finished (or the source was not enough): they pile up while the AI is being set up
  // tidying up: tick quizzes (or «select all») and delete them in one go; nothing is deleted without a confirmation, and files are never touched
  const sel = new Set(); const body = h('div', {}); let shown = PAGE; let clear = null;
  const bar = h('div', { class: 'row selbar', id: 'sel-bar', role: 'region', 'aria-label': 'حذف الكويزات المحددة' });
  const removeIds = async (ids, label) => {
    if (!ids.length || !(await confirmDialog(label, `سيُحذف ${num(ids.length)} ${ids.length === 1 ? 'كويز' : 'كويزًا'} مع محاولاته. ملفاتك وبطاقاتك لا تُمسّ.`, 'احذف', true))) return;
    bar.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try { let r; try { r = await api('POST', '/api/quizzes/batch-delete', { ids }); } catch (e) { if (e.status !== 404 && e.status !== 405) throw e; r = { deleted: 0 }; for (const id of ids) { await api('DELETE', `/api/quizzes/${id}`); r.deleted++; } }      // a server without the batch call: one by one
      toast(`حُذف ${num(r.deleted)} ${r.deleted === 1 ? 'كويز' : 'كويزًا'}`, 'ok'); const gone = new Set(ids); list = list.filter((q) => !gone.has(q.id)); ids.forEach((id) => sel.delete(id)); draw();
      if (clear) { const left = list.filter((q) => ['failed', 'draft', 'insufficient'].includes(q.status)).length; if (left) clear.textContent = `حذف غير المكتملة (${num(left)})`; else clear.remove(); } }
    catch (e) { toast(e.message || 'تعذّر الحذف', 'bad'); drawBar(); } };
  const drawBar = () => fill(bar, sel.size ? [h('span', { class: 'muted', id: 'sel-count' }, `حُدِّد ${num(sel.size)}`), h('button', { class: 'btn small danger', id: 'delete-selected', onclick: () => removeIds([...sel], 'حذف الكويزات المحددة؟') }, `حذف المحدد (${num(sel.size)})`), h('button', { class: 'btn small ghost', onclick: () => { sel.clear(); draw(); } }, 'إلغاء التحديد')]
    : h('span', { class: 'muted small' }, 'حدّد كويزات من القائمة لحذفها، أو «تحديد الكل».'));
  const selection = { set: sel, all: [], onChange: (redraw) => (redraw ? draw() : (drawBar(), body.querySelectorAll('tbody tr').forEach((tr) => { const c = tr.querySelector('.qsel'); tr.classList.toggle('selected', !!(c && c.checked)); }), syncAll())) };
  const syncAll = () => { const a = body.querySelector('#sel-all'); if (a) a.checked = list.length > 0 && list.every((q) => sel.has(q.id)); };
  const draw = () => { selection.all = list.map((q) => q.id); drawBar();
    if (!list.length) { fill(body, emptyState('📝', 'لا توجد كويزات', 'ارفع ملفًا ثم أنشئ أول كويز.', h('a', { class: 'btn primary', href: '#/new' }, 'كويز جديد'))); return; }
    fill(body, list.length > 1 ? h('div', { class: 'row between', style: 'margin-bottom:.6rem' }, h('label', { class: 'row', style: 'margin:0;cursor:pointer;gap:.5rem' }, h('input', { type: 'checkbox', id: 'select-all-top', checked: list.every((q) => sel.has(q.id)), onchange: (e) => { list.forEach((q) => (e.target.checked ? sel.add(q.id) : sel.delete(q.id))); draw(); } }), `تحديد الكل (${num(list.length)})`), null) : null,
      quizTable(list.slice(0, shown), selection), list.length > shown ? h('div', { class: 'center', style: 'margin-top:.8rem' }, h('button', { class: 'btn', id: 'more', onclick: () => { shown += PAGE; draw(); } }, `عرض المزيد (${num(list.length - shown)} كويزًا آخر)`)) : null); };
  draw();
  clear = dead.length ? h('button', { class: 'btn small danger', id: 'clear-dead', onclick: () => removeIds(list.filter((q) => ['failed', 'draft', 'insufficient'].includes(q.status)).map((q) => q.id), 'حذف الكويزات غير المكتملة؟') }, `حذف غير المكتملة (${num(dead.length)})`) : null;
  return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'كويزاتي'), h('div', { class: 'row' }, clear, h('a', { class: 'btn primary', href: '#/new' }, '＋ كويز جديد'))),
    h('div', { class: 'card' }, list.length ? bar : null, body));
}

function badPages(doc) { return [...doc.quality.image_only, ...doc.quality.empty, ...doc.quality.garbled]; }
export async function newQuizPage() {
  try { state.caps = await api('GET', '/api/auth/capabilities', undefined, { noRedirect: true }); } catch (_) { /* keep old caps */ }
  let chatgptConnection = null;
  if (state.caps?.chatgpt_connect_available && !state.caps?.edition) {
    try { chatgptConnection = await api('GET', '/api/chatgpt/status'); } catch (_) { /* show the normal server state */ }
  }
  const docs = (await api('GET', '/api/documents')).filter((d) => d.status === 'ready');
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('doc');
  const opts = await api('GET', '/api/quizzes/options');
  // The question types are NOT a student choice: the analysis decides which of them the lecture supports and the planner adds them.
  const S = { count: 20, difficulty: 'mixed', language: 'source', focus: 'balanced', mode: 'practice', shuffle_options: true, timer_minutes: null, delivery: 'online', pdf_include_key: true, external_mode: 'source_only' };
  if (state.caps?.rules_mode) S.generator = 'claude';      // browser editions can also build quizzes locally, without any AI
  else S.generator = chatgptConnection?.plan_usage ? 'chatgpt_plan' : 'site';
  const chosen = new Map(); // docId -> pages string
  if (preset && docs.some((d) => d.id === preset)) chosen.set(preset, '');
  const err = h('div', { role: 'alert' });

  const chipGroup = (key, items, fmt = (x) => x) => {
    const box = h('div', { class: 'chips', role: 'group' });
    const draw = () => box.replaceChildren(...items.map((v) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(S[key] === v), onclick: () => { S[key] = v; draw(); } }, fmt(v))));
    draw(); return box;
  };

  // The SOURCE is automatic: the file you came from (?doc=), else the newest ready one; a file uploaded here is added to it. No list to tick, no page ranges (unreadable pages are
  // left out by themselves), no title (it is the file's name): the student only says how many questions.
  let autoPick = !chosen.size; if (!chosen.size && docs.length) chosen.set(docs[0].id, '');      // a file uploaded here replaces the automatic pick (the student gave it ON PURPOSE); several at once all stay
  const docBox = h('div', {});
  function drawDocs() {
    if (!docs.length) { docBox.replaceChildren(h('p', { class: 'muted', id: 'no-files' }, 'ارفع ملفك (PDF أو PowerPoint) بالزر، ثم أنشئ منه الكويز هنا مباشرة.')); return; }
    docBox.replaceChildren(...docs.filter((d) => chosen.has(d.id)).map((d) => h('div', { class: 'row', id: 'chosen-file', style: 'margin:.2rem 0' }, h('span', { 'aria-hidden': 'true' }, '📄'), h('strong', { class: 'bidi' }, d.title), h('span', { class: 'muted small' }, ` · ${arP(d.page_count)}`),
      badPages(d).length ? h('span', { class: 'muted small' }, ` — ${arP(badPages(d).length)} غير مقروءة تُستبعد تلقائيًا`) : null)));
  }
  drawDocs();

  // A NEW file can be added right here (button, drag and drop, one or several files): it is read, listed first and ticked, so the quiz is made from it without leaving the page.
  const upBox = h('div', { role: 'status', 'aria-live': 'polite' });
  const picker = h('input', { type: 'file', id: 'new-file', accept: '.pdf,.pptx,.ppt', multiple: true, style: 'display:none', 'aria-label': 'رفع ملف جديد', onchange: () => { const fs = [...picker.files]; picker.value = ''; addFiles(fs); } });
  async function addFiles(files) {
    for (const file of files) {
      if (!/\.(pdf|pptx|ppt)$/i.test(file.name || '')) { upBox.append(h('div', { class: 'alert bad' }, `«${file.name}» غير مدعوم: المدعوم PDF وPowerPoint (PPTX وPPT).`)); continue; }
      const row = h('div', {}, spinner(`جارٍ رفع ومعالجة «${file.name}»…`)); upBox.append(row); const stop = readingProgress(file, row);
      try {
        const d = await uploadAndWait(file).finally(stop);
        if (d.status === 'ready') { if (autoPick) { chosen.clear(); autoPick = false; } docs.unshift(d); chosen.set(d.id, ''); drawDocs(); row.replaceChildren(h('div', { class: 'alert ok' }, `تمت معالجة «${d.title}» وهو محدَّد الآن للكويز.`)); setTimeout(() => row.remove(), 7000); }
        else row.replaceChildren(h('div', { class: 'alert bad' }, `تعذّر استخراج نص قابل للقراءة من «${file.name}»${d.error ? ': ' + d.error : '.'}`));
      } catch (e) { row.replaceChildren(errorBox(e)); }
    }
  }
  const srcCard = h('div', { class: 'card', id: 'source-card',
    ondragover: (e) => { e.preventDefault(); srcCard.classList.add('drop'); }, ondragleave: () => srcCard.classList.remove('drop'),
    ondrop: (e) => { e.preventDefault(); srcCard.classList.remove('drop'); addFiles([...(e.dataTransfer?.files || [])]); } },
    docBox, upBox,
    h('div', { class: 'row', style: 'margin-top:.4rem' }, h('button', { type: 'button', class: 'btn', id: 'new-file-btn', onclick: () => picker.click() }, docs.length ? '⬆ ارفع ملفًا آخر' : '⬆ ارفع ملفًا'), picker,
      h('span', { class: 'muted small' }, 'PDF أو PowerPoint (حتى 40MB) — أو اسحب الملف وأفلته هنا.')));

  // No key, no problem: with no AI connected the quiz is built by the local generator (straight from the file's text, on this device).
  // The AI is an optional upgrade, never a gate. Only the server edition without any generator at all still has to say so.
  const rulesOK = () => !!state.caps?.rules_mode;
  const aiOff = () => state.caps?.claude_ok === false;
  const noEngine = () => state.caps?.llm === false && !rulesOK() && S.generator !== 'chatgpt_plan';
  const aiBox = h('div', {});
  function drawAI() {
    if (noEngine()) fill(aiBox, h('div', { class: 'alert warn' }, h('strong', {}, 'التوليد غير مفعّل على هذا الخادم. '),
      state.caps?.chatgpt_connect_available ? ['اربط حساب ChatGPT المؤهل من ', h('a', { href: '#/account' }, 'حسابي'), ' ثم عُد لإنشاء الكويز.'] : 'يحتاج مفتاح خدمة الذكاء الاصطناعي (ANTHROPIC_API_KEY).'));
    else if (S.generator === 'chatgpt_plan') fill(aiBox, h('div', { class: 'alert info', id: 'chatgpt-ready-note' }, 'سيُنشأ هذا الكويز تلقائيًا من صفحات ملفك باستخدام حصة حساب ChatGPT المرتبط، ويخضع لفحص المصدر والمفتاح قبل الحفظ.'));
    else if (aiOff() && rulesOK()) fill(aiBox, h('div', { class: 'alert info', id: 'local-note' }, h('strong', {}, 'يُنشأ على جهازك فورًا. '),
      state.caps?.chat_bridge ? 'التوليد المحلي تلقائي ومجاني، لكنه ينتج أسئلة أبسط. يمكن استخدام ChatGPT أو Claude يدويًا بنسخ الطلب وإعادة الرد؛ لا يوجد اتصال تلقائي بحساب المحادثة في هذه النسخة.' : 'من نص ملفك مباشرةً — مجانًا وبلا حدود.'));
    else aiBox.replaceChildren();
    btn.disabled = noEngine(); if (chatBtn) chatBtn.disabled = noEngine();
  }

  let creationMode = 'local';
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    if (!chosen.size) { err.replaceChildren(h('div', { class: 'alert bad' }, 'ارفع ملفك أولًا بالزر أعلاه.')); return; }
    if (noEngine()) { drawAI(); aiBox.scrollIntoView({ block: 'center' }); return; }
    const sources = [...chosen].map(([document_id, pages]) => ({ document_id, pages: pages.trim() || null }));
    btn.disabled = true; if (chatBtn) chatBtn.disabled = true; const active = creationMode === 'chat' && chatBtn ? chatBtn : btn; active.textContent = 'جارٍ البدء…';
    let q = null;
    try {
      q = await api('POST', '/api/quizzes', { title: null, sources, settings: { ...S, ...(rulesOK() ? { generator: aiOff() ? 'rules' : S.generator } : {}), timer_minutes: S.timer_minutes || null } });
      if (creationMode === 'chat' && state.caps?.chat_bridge) { location.hash = `#/quiz/${q.id}`; return; }
      await api('POST', `/api/quizzes/${q.id}/analyze`, { auto_generate: true });   // analysis -> plan -> generation, no confirmation step
      location.hash = `#/quiz/${q.id}`;
    } catch (ex) {
      if (q) { try { await api('DELETE', `/api/quizzes/${q.id}`); } catch (_) { /* nothing to clean */ } }   // never leave an empty draft behind
      if (ex.code === 'llm_not_configured') { state.caps = { ...state.caps, claude_ok: false }; drawAI(); }
      err.replaceChildren(errorBox(ex)); btn.disabled = false; btn.textContent = state.caps?.chat_bridge ? 'إنشاء تلقائي محلي ←' : S.generator === 'chatgpt_plan' ? 'إنشاء عبر ChatGPT ←' : 'إنشاء الكويز ←'; if (chatBtn) { chatBtn.disabled = false; chatBtn.textContent = 'نسخ الطلب إلى ChatGPT أو Claude يدويًا'; }
    }
  } });
  const customCount = h('input', { type: 'number', min: 5, max: 100, dir: 'ltr', placeholder: 'عدد آخر', style: 'max-width:120px', oninput: (e) => { if (e.target.value) { S.count = +e.target.value; countBox.replaceWith((countBox = chipGroup('count', [10, 20, 30, 50, 75, 100]))); } } });
  let countBox = chipGroup('count', [10, 20, 30, 50, 75, 100]);
  const btn = h('button', { class: 'btn primary', type: 'submit', id: 'create-quiz', onclick: () => { creationMode = 'local'; } }, state.caps?.chat_bridge ? 'إنشاء تلقائي محلي ←' : S.generator === 'chatgpt_plan' ? 'إنشاء عبر ChatGPT ←' : 'إنشاء الكويز ←');
  const chatBtn = state.caps?.chat_bridge ? h('button', { class: 'btn', type: 'button', id: 'create-chat-quiz', onclick: () => { creationMode = 'chat'; form.requestSubmit(); } }, 'نسخ الطلب إلى ChatGPT أو Claude يدويًا') : null;
  form.append(
    h('h1', {}, 'كويز جديد'),
    aiBox,
    srcCard,
    h('div', { class: 'card' }, h('h2', {}, 'الإعدادات'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'field' }, h('label', {}, 'عدد الأسئلة المطلوب'), h('div', { class: 'row' }, countBox, customCount), h('div', { class: 'hint' }, 'هذا سقف مطلوب: إن لم يكفِ المحتوى لعدد صحيح وغير مكرر نُسلّمك العدد الممكن بدل الحشو، ونخبرك بذلك.')),
        h('div', { class: 'field' }, h('label', {}, 'الصعوبة'), chipGroup('difficulty', ['easy', 'medium', 'hard', 'mixed'], (v) => opts.difficulty[v])),
        h('div', { class: 'field' }, h('label', {}, 'لغة الأسئلة'), chipGroup('language', ['source', 'ar', 'en'], (v) => ({ source: 'لغة المصدر', ar: 'العربية', en: 'English' })[v]))),
      !aiOff() && h('details', {}, h('summary', {}, 'خيارات إضافية'),
        h('div', { class: 'field', style: 'margin-top:.6rem' }, h('label', {}, 'مصدر المعلومات'), chipGroup('external_mode', ['source_only', 'supplement'], (v) => (v === 'source_only' ? 'المصدر فقط (الافتراضي)' : 'المصدر + معلومات خارجية موسومة')))),
      h('p', { class: 'hint' }, 'تُختار أنواع الأسئلة تلقائيًا بحسب ما يدعمه ملفك فعلًا. وضع الحل (تدريب/اختبار) والمؤقت تختارهما عند بدء الحل.')),
    err, h('div', { class: 'row' }, btn, chatBtn, h('a', { class: 'btn', href: '#/files' }, 'إلغاء')));
  drawAI();
  return form;
}

const STAGES = { polishing: 'فحص الأسئلة وتحسين صياغتها', queued: 'في الانتظار', reading_source: 'قراءة المصدر', analyzing_lecture: 'فهم اللكتشر واستخراج أهدافه', planned: 'تجهيز الأسئلة', drafting: 'صياغة الأسئلة والتحقق منها', retrying: 'إعادة صياغة الأسئلة المرفوضة', finalizing: 'اعتماد النسخة النهائية', done: 'اكتمل' };

export async function quizPage(id) {
  const root = h('div', {});
  let timer = null, autoStarted = false, busy = false;
  const onDone = (ev) => { const d = ev.detail || {}; if (d.stage === 'quiz' && d.id === id && busy) { clearTimeout(timer); timer = null; draw().catch(() => {}); } };      // the job finished in this tab: redraw now
  window.addEventListener('qz-progress', onDone);
  onLeave(() => { clearTimeout(timer); window.removeEventListener('qz-progress', onDone); });
  async function draw() {
    const q = await api('GET', `/api/quizzes/${id}`);
    fill(root, h('div', { class: 'row between' }, h('div', {}, h('h1', { class: 'bidi' }, q.title), q.generator === 'test-generator' && h('span', { class: 'badge test' }, 'محتوى اختباري — مولّد تجريبي وليس مولّد الإنتاج')),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/quizzes' }, 'كل الكويزات'), h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('حذف الكويز؟', 'ستُحذف أسئلته ومحاولاته.', 'حذف', true)) { await api('DELETE', `/api/quizzes/${id}`); location.hash = '#/quizzes'; } } }, 'حذف'))), view(q));
    busy = ['analyzing', 'generating'].includes(q.status); clearTimeout(timer); timer = busy ? setTimeout(() => draw().catch(() => {}), 1500) : null;
  }
  function view(q) {
    if (q.status === 'draft') return draftView(q);
    if (['analyzing', 'generating'].includes(q.status)) return progressView(q);
    if (q.status === 'planned') {
      // A plan nobody has to confirm: carry on to generation (the requested count is always delivered; only a source with nothing to ask from is reported).
      if (q.plan && q.plan.feasible_count > 0) { if (!autoStarted) { autoStarted = true; start('generate', { accept_reduced: true }); } return progressView({ ...q, progress: { stage: 'drafting', pct: 5 } }); }
      return failureView(q);
    }
    if (q.status === 'ready') return readyView(q);
    return failureView(q);
  }
  async function start(what, body) {
    try { await api('POST', `/api/quizzes/${id}/${what}`, body || {}); await draw(); }
    catch (e) {
      if (e.code === 'llm_not_configured') { state.caps = { ...state.caps, claude_ok: false }; await draw(); return; }
      root.prepend(errorBox(e));
    }
  }
  const retry = (q) => (q.plan && q.plan.feasible_count > 0 ? start('generate', { accept_reduced: true }) : start('analyze', { auto_generate: true }));
  const noAI = () => state.caps?.claude_ok === false;
  const rulesOK = () => !!state.caps?.rules_mode;
  const isLocal = (q) => q.settings && q.settings.generator === 'rules';
  // "try again without the AI": switch this quiz to the local generator (it goes back to a draft) and run it
  async function useLocal() { try { await api('PATCH', `/api/quizzes/${id}`, { settings: { generator: 'rules' } }); await start('analyze', { auto_generate: true }); } catch (e) { root.prepend(errorBox(e)); } }

  function openChatBridge(q, preferred = 'chatgpt') {
    const box = h('div', {}, h('h2', {}, 'نقل يدوي إلى ChatGPT أو Claude'), spinner('جارٍ تجهيز طلب موثّق من صفحات الكويز…'));
    const close = modal(box, { wide: true }); let selected = preferred;
    api('GET', `/api/quizzes/${q.id}/chat-bridge`).then((data) => {
      const prompt = h('textarea', { readonly: true, dir: 'ltr', rows: 8, 'aria-label': 'الطلب الجاهز للمحادثة', style: 'font-size:.78rem' }, data.prompt);
      const response = h('textarea', { dir: 'ltr', rows: 10, placeholder: 'الصق هنا رد JSON كاملًا من ChatGPT أو Claude…', 'aria-label': 'رد المحادثة بصيغة JSON' });
      const status = h('div', { role: 'status', 'aria-live': 'polite' }); const chosen = h('strong', {}, preferred === 'claude' ? 'Claude' : 'ChatGPT');
      const copyOpen = async (provider) => {
        selected = provider; chosen.textContent = provider === 'claude' ? 'Claude' : 'ChatGPT';
        window.open(data.provider_urls[provider], '_blank', 'noopener,noreferrer');
        try { await navigator.clipboard.writeText(data.prompt); status.replaceChildren(h('div', { class: 'alert ok' }, 'نُسخ الطلب. الصقه في المحادثة، ثم أعد رد JSON إلى الحقل أدناه.')); }
        catch (_) { prompt.focus(); prompt.select(); status.replaceChildren(h('div', { class: 'alert warn' }, 'تعذّر النسخ التلقائي. انسخ النص المحدد يدويًا ثم الصقه في المحادثة.')); }
      };
      const importBtn = h('button', { class: 'btn primary', onclick: async () => {
        if (!response.value.trim()) { status.replaceChildren(h('div', { class: 'alert warn' }, 'الصق رد المحادثة أولًا.')); return; }
        importBtn.disabled = true; status.replaceChildren(spinner('جارٍ التحقق من الدليل والمفتاح والتكرار قبل الحفظ…'));
        try { const r = await api('POST', `/api/quizzes/${q.id}/chat-bridge`, { provider: selected, response: response.value }); close(); toast(`اعتمد كويزي ${num(r.delivered)} سؤالًا من ${chosen.textContent}`, 'ok'); await draw(); }
        catch (ex) { status.replaceChildren(errorBox(ex)); importBtn.disabled = false; }
      } }, 'استيراد الأسئلة والتحقق منها');
      const step = (n, title, ...content) => h('section', { class: 'chat-step' }, h('div', { class: 'chat-step-head' }, h('span', { class: 'chat-step-num', 'aria-hidden': 'true' }, num(n)), h('h3', {}, title)), ...content);
      box.replaceChildren(h('h2', {}, 'نقل يدوي إلى ChatGPT أو Claude'),
        h('div', { class: 'alert info' }, h('strong', {}, 'هذه الخطوات يدوية وليست ربط حساب. '), 'يجهز كويزي الطلب، وأنت تنقله إلى حسابك ثم تعيد النتيجة. كويزي لا يرسل ملفك تلقائيًا.'),
        h('p', { class: 'muted' }, 'يلزم تسجيل الدخول في ChatGPT أو Claude الذي تختاره. استخدم حسابك المجاني أو اشتراكك الحالي؛ لا يحتاج الطالب التسجيل في الخدمتين معًا.'),
        h('div', { class: 'chat-flow' },
          step(1, 'انسخ الطلب وافتح المحادثة', h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => copyOpen('chatgpt') }, 'انسخ وافتح ChatGPT'), h('button', { class: 'btn', onclick: () => copyOpen('claude') }, 'انسخ وافتح Claude')),
            data.omitted_pages.length ? h('div', { class: 'alert warn small' }, `الطلب طويل؛ لم تُرسل ${num(data.omitted_pages.length)} صفحة غير مستعملة في أسئلة الكويز المحلي. الاستيراد لن يقبل دليلًا من خارج الصفحات المرفقة.`) : h('p', { class: 'small muted' }, `الطلب يشمل ${arP(data.pages)} من المصدر (${num(data.prompt_chars)} حرفًا).`), prompt),
          step(2, 'الصق الطلب في المحادثة', h('p', { class: 'small muted' }, 'انتظر حتى تعيد كائن JSON كاملًا. إذا أضافت شرحًا خارج JSON، الصق الرد كاملًا وسيحاول كويزي استخراج الكائن.')),
          step(3, 'أعد النتيجة إلى كويزي', h('p', { class: 'small muted' }, 'المصدر المختار: ', chosen, '. لن يستبدل كويزي أسئلتك الحالية إلا إذا اجتاز عدد كافٍ فحص المصدر والخيارات والمفتاح والتكرار.'), response,
            h('div', { class: 'row' }, importBtn, h('button', { class: 'btn', onclick: close }, 'إلغاء')))), status);
    }).catch((ex) => box.replaceChildren(h('h2', {}, 'تعذّر تجهيز طلب المحادثة'), errorBox(ex), h('button', { class: 'btn', onclick: close }, 'إغلاق')));
  }

  function draftView(q) {
    if (state.caps?.chat_bridge) return h('div', { class: 'card' }, h('h2', {}, 'اختر طريقة إنشاء الأسئلة'),
      h('p', { class: 'muted' }, 'الإنشاء المحلي تلقائي وأسئلته أبسط. استخدام حساب ChatGPT أو Claude هنا يدوي: انسخ الطلب، ألصقه في المحادثة، ثم أعد الإجابة إلى كويزي للتحقق. لا يوجد ربط تلقائي بالحساب.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'start-local', onclick: useLocal }, 'إنشاء تلقائي محلي'), h('button', { class: 'btn', id: 'draft-chatgpt', onclick: () => openChatBridge(q, 'chatgpt') }, 'نسخ إلى ChatGPT يدويًا'), h('button', { class: 'btn', id: 'draft-claude', onclick: () => openChatBridge(q, 'claude') }, 'نسخ إلى Claude يدويًا')));
    return h('div', { class: 'card' }, h('h2', {}, 'لم يبدأ توليد هذا الكويز'),
      noAI() && !isLocal(q) ? h('div', { class: 'alert info' }, 'الذكاء الاصطناعي غير مربوط الآن، فيمكن إنشاء هذا الكويز محليًا بلا ذكاء اصطناعي (فوري ومجاني، أسئلته أبسط).') : h('p', { class: 'muted' }, 'اضغط ابدأ ليقرأ «كويزي» الملف ويبني الأسئلة ويتحقق منها.'),
      noAI() && !isLocal(q) && state.caps?.byok ? h('details', { class: 'card' }, h('summary', {}, 'أو اربط ذكاءً اصطناعيًا (اختياري)'), aiConnectCard(() => draw())) : null,
      h('div', { class: 'row' }, noAI() && !isLocal(q) ? (rulesOK() ? h('button', { class: 'btn primary', id: 'start-local', onclick: useLocal }, 'أنشئه الآن بلا ذكاء اصطناعي') : null) : h('button', { class: 'btn primary', onclick: () => start('analyze', { auto_generate: true }) }, 'ابدأ التوليد'), h('a', { class: 'btn', href: '#/new' }, 'كويز جديد')));
  }
  function progressView(q) {
    const browserRun = !!state.caps?.edition;      // browser editions run the job inside this page; the server edition keeps going on its own
    return h('div', { class: 'card' }, h('h2', {}, q.status === 'analyzing' ? 'جارٍ فهم اللكتشر…' : 'جارٍ توليد الأسئلة والتحقق منها…'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': q.progress.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${q.progress.pct}%` })),
      h('p', { class: 'muted', id: 'stage' }, STAGES[q.progress.stage] || q.progress.stage || ''),
      h('p', { class: 'small muted' }, browserRun ? 'تستغرق عادةً من دقيقة إلى بضع دقائق. أبقِ هذه الصفحة مفتوحة حتى تنتهي.' : 'يمكنك مغادرة الصفحة؛ المعالجة تستمر على الخادم وستجدها في «كويزاتي».'));
  }
  function failureView(q) {
    const msg = q.error || (q.plan && !q.plan.feasible_count ? 'المحتوى في هذا النطاق لا يكفي لأي سؤال موثّق بالمصدر.' : 'سبب غير معروف');
    const tips = (q.plan && q.plan.shortfall && q.plan.shortfall.suggestions) || [];
    const src = q.settings && q.settings.sources && q.settings.sources[0];
    return h('div', {}, h('div', { class: 'alert ' + (q.status === 'insufficient' || q.status === 'planned' ? 'warn' : 'bad') }, h('strong', {}, q.status === 'insufficient' || q.status === 'planned' ? 'المصدر لا يكفي: ' : 'فشلت المعالجة: '), msg),
      tips.length ? h('div', { class: 'alert info' }, tips.join(' ')) : null,
      h('div', { class: 'card' }, h('h3', {}, 'ماذا تفعل الآن؟'), h('ul', {},
        h('li', {}, 'أعد المحاولة — قد يكون السبب مؤقتًا (ازدحام أو حدّ استخدام عند مزوّد الذكاء الاصطناعي). ', h('button', { class: 'btn small primary', id: 'retry', disabled: noAI() && !isLocal(q), onclick: () => retry(q) }, 'إعادة المحاولة')),
        !isLocal(q) && rulesOK() ? h('li', {}, 'أو أنشئه الآن بلا ذكاء اصطناعي: فوري ومجاني بلا حدود، وأسئلته أبسط (تعريفات وإكمال فراغات وأسباب وأرقام وقوائم). ', h('button', { class: 'btn small', id: 'use-local', onclick: useLocal }, 'أنشئه بلا ذكاء اصطناعي')) : null,
        isLocal(q) && state.caps?.byok && noAI() ? h('li', {}, 'لأسئلة تفهم الشرائح مهما كانت صياغتها اربط ذكاءً اصطناعيًا مجانيًا. ', h('a', { class: 'btn small', href: '#/settings' }, 'ربط الذكاء الاصطناعي')) : null,
        state.caps?.chat_bridge ? h('li', {}, 'أو انسخ الطلب يدويًا إلى ChatGPT أو Claude ثم أعد الرد ليتحقق منه كويزي. ', h('button', { class: 'btn small', onclick: () => openChatBridge(q) }, 'نسخ يدوي إلى المحادثة')) : null,
        h('li', {}, 'وسّع نطاق الصفحات أو أضف ملفًا آخر. ', h('a', { class: 'btn small', href: src ? `#/new?doc=${src.document_id}` : '#/new' }, 'تعديل الطلب')),
        h('li', {}, 'تأكد أن الملف يحوي نصًا حقيقيًا (لا صور ممسوحة): افتح الملف من «ملفاتي» وراجع نص الصفحات.'))));
  }
  function readyView(q) {
    const st = q.settings, r = q.report;
    const dl = h('a', { class: 'btn', href: `/api/quizzes/${q.id}/pdf?answer_key=true`, download: '' }, '⬇ PDF مع مفتاح الإجابة');
    const tips = (r.shortfall && r.shortfall.suggestions) || [];
    // an unfinished attempt comes first: a student who left half-way should not start over by mistake
    const startBtn = h('button', { class: 'btn primary', id: 'start-solve', onclick: () => startDialog(q) }, 'ابدأ الحل'), resume = h('span', { style: 'display:contents' });
    const onUnfinished = (a) => { fill(resume, h('a', { class: 'btn primary', id: 'resume-attempt', href: `#/attempt/${a.id}` }, `تابع محاولتك (${num(a.answered)}/${num(a.total)})`)); startBtn.className = 'btn'; startBtn.textContent = 'ابدأ الحل من جديد'; };
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'جاهز للحل'), r.shortfall && h('div', { class: 'alert warn', id: 'shortfall-note' }, `نص هذا النطاق لا يكفي إلا لـ ${arQ(r.delivered)} من ${num(r.requested)} المطلوبة، لأنه قصير. `, tips.join(' ')),
        q.fallback && h('div', { class: 'alert warn', id: 'fallback-note' }, 'تعذّر الاتصال بالذكاء الاصطناعي الآن، فأُنشئ هذا الكويز محليًا بدلًا منه. يمكنك إنشاء كويز جديد لاحقًا بالذكاء الاصطناعي. ', state.caps?.operator ? h('span', { class: 'small muted', dir: 'ltr' }, q.fallback.reason) : null),
        isLocal(q) && h('div', { class: 'alert info', id: 'local-ready-note' }, 'وُلّد هذا الكويز على جهازك من نص ملفك مباشرة، وكل سؤال معه الاقتباس الذي بُني عليه.'),
        h('p', { class: 'muted' }, q.scoring.text),
        h('div', { class: 'row' }, resume, startBtn, isLocal(q) && state.caps?.chat_bridge ? h('button', { class: 'btn', id: 'chat-bridge', onclick: () => openChatBridge(q) }, 'نسخ يدوي إلى ChatGPT أو Claude') : null, dl,
          h('a', { class: 'btn', href: `/api/quizzes/${q.id}/pdf?answer_key=false`, download: '' }, '⬇ PDF بدون مفتاح'),
          h('a', { class: 'btn', href: `#/cards?doc=${st.sources[0].document_id}` }, 'بطاقات المراجعة'), h('button', { class: 'btn', onclick: () => bank(q) }, 'بنك الأسئلة'))),
      attemptsCard(q.id, onUnfinished));
  }
  function attemptsCard(qid, onUnfinished) {
    const box = h('div', { class: 'card' }, h('h2', {}, 'محاولاتك السابقة'), spinner());
    api('GET', `/api/attempts?quiz_id=${qid}`).then((list) => {
      const open = list.find((a) => a.status !== 'submitted'); if (open && onUnfinished) onUnfinished(open);
      box.replaceChildren(h('h2', {}, 'محاولاتك السابقة'), list.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, list.map((a) => h('tr', {}, h('td', {}, fmtDate(a.updated_at)), h('td', {}, a.mode === 'exam' ? 'اختبار' : 'تدريب'),
        h('td', {}, a.status === 'submitted' ? `${num(a.score)} / ${num(a.max_score)} (${pct(a.score, a.max_score)})` : `غير مكتملة — ${num(a.answered)}/${num(a.total)}`),
        h('td', {}, h('a', { class: 'btn small', href: a.status === 'submitted' ? `#/attempt/${a.id}/result` : `#/attempt/${a.id}` }, a.status === 'submitted' ? 'المراجعة' : 'متابعة'))))))) : h('p', { class: 'muted' }, 'لا توجد محاولات بعد.'));
    });
    return box;
  }
  function startDialog(q) {
    const st = q.settings; const o = { mode: st.mode, timer: st.timer_minutes || '', shuffle: st.shuffle_options, shuffleQ: false };
    modal((close) => h('div', {}, h('h2', {}, 'بدء المحاولة'),
      h('div', { class: 'field' }, h('label', {}, 'الوضع'), h('div', { class: 'chips' }, ['practice', 'exam'].map((m) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(o.mode === m), onclick: (e) => { o.mode = m; [...e.target.parentNode.children].forEach((c) => c.setAttribute('aria-pressed', String(c === e.target))); } }, m === 'practice' ? 'تدريب' : 'اختبار')))),
      h('div', { class: 'field' }, h('label', {}, 'مؤقت (دقائق، اختياري)'), h('input', { type: 'number', min: 1, value: o.timer, dir: 'ltr', oninput: (e) => { o.timer = e.target.value; } })),
      h('label', { class: 'row', style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: o.shuffle, style: 'width:20px;height:20px', onchange: (e) => { o.shuffle = e.target.checked; } }), 'ترتيب الخيارات عشوائيًا'),
      h('label', { class: 'row', style: 'cursor:pointer' }, h('input', { type: 'checkbox', style: 'width:20px;height:20px', onchange: (e) => { o.shuffleQ = e.target.checked; } }), 'ترتيب الأسئلة عشوائيًا'),
      h('div', { class: 'alert info' }, q.scoring.text), h('p', { class: 'small muted' }, `في التدريب يظهر التفسير بعد كل إجابة وتُقفل. في الاختبار لا يظهر شيء حتى التسليم، ${state.caps?.edition ? 'وحين ينتهي المؤقت تُسلَّم المحاولة تلقائيًا.' : 'والمؤقت يُطبَّق على الخادم.'}`),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const a = await api('POST', `/api/quizzes/${q.id}/attempts`, { mode: o.mode, timer_minutes: o.timer ? +o.timer : null, shuffle_options: o.shuffle, shuffle_questions: o.shuffleQ }); close(); location.hash = `#/attempt/${a.id}`; } catch (e) { toast(e.message, 'bad'); } } }, 'ابدأ'), h('button', { class: 'btn', onclick: close }, 'إلغاء'))));
  }
  async function bank(q) {
    const qs = await api('GET', `/api/quizzes/${q.id}/questions`);
    modal(h('div', {}, h('h2', {}, `بنك الأسئلة (${num(qs.length)})`), h('p', { class: 'muted small' }, 'عرض كامل مع المفتاح والدليل — للمراجعة بعد الاختبار فقط.'),
      qs.map((x) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'muted small' }, `ص ${x.source_pages.join('، ')}`)),
        h('div', { class: 'stem bidi' }, x.stem), x.options.map((o) => h('div', { class: 'bidi', style: o.id === x.correct_option_id ? 'color:var(--ok);font-weight:700' : '' }, (o.id === x.correct_option_id ? '✓ ' : '• ') + o.text)),
        h('div', { class: 'explain bidi' }, x.explanation, x.evidence[0] && h('blockquote', {}, `«${x.evidence[0].quote}» — ${x.evidence[0].doc_title || ''} ص${x.evidence[0].page}`)),
        ))), { wide: true });
  }
  await draw();
  return root;
}
