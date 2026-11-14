// THE LECTURE EXPLAINED, SLIDE BY SLIDE (#/explain/<file>): the slide on one side, its explanation on the other - the big idea, the points in teaching order
// (each lights up the line of the slide it explains), the slide's terms, what to remember for the exam, and one quick question to check oneself. Three levels
// (simple / deep / for the exam), any phrase of the slide selected and explained, a question about the slide answered from it, «فهمتها» to mark a slide and go
// on. Where the student is, and what they marked, is kept; the next slide is prepared while they read this one; every explanation is kept once made.
import { h, api, fill, toast, num, dirOf, typeset, errorBox, emptyState } from './core.js';
import { onLeave } from './main.js';

const LEVELS = [['simple', 'ببساطة'], ['deep', 'بعمق'], ['exam', 'للاختبار']];
// Arabic written around English terms: each English run kept whole, left to right, inside the Arabic sentence (its punctuation no longer scattered)
const LATIN = /([A-Za-z][A-Za-z0-9 ()'’.,:;+\/%=-]*[A-Za-z0-9)%])/g;
const runs = (t) => String(t || '').split(LATIN).map((part, i) => (i % 2 ? h('bdi', { dir: 'ltr' }, part) : part));
// a quotation «…» of the slide is one unit, in its own direction (its bullet left out); the rest, run by run
const mixed = (t) => String(t || '').split(/(«[^»]*»)/).map((part) => { const q = part.match(/^«([^»]*)»$/); if (!q) return runs(part);
  const inner = q[1].replace(/^\s*[•▪◦●‣\-–*]\s*/, '').trim(); return /[A-Za-z]/.test(inner) ? ['«', h('bdi', { dir: dirOf(inner) }, inner), '»'] : part; });
const flat = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export async function explainPage(id) {
  const data = await api('GET', `/api/explain/${id}`);
  const slides = data.slides || [];
  if (!slides.length) return emptyState('📄', 'لا توجد شرائح مقروءة في هذا الملف', 'جرّب ملفًا آخر، أو ارفع الملف الأصلي (PowerPoint أو PDF صُدِّر منه).', h('a', { class: 'btn', href: `#/files/${id}` }, 'صفحة الملف'));
  const prog = data.progress || {}; let level = LEVELS.some(([k]) => k === prog.level) ? prog.level : 'simple';
  let idx = Math.min(Math.max(0, prog.current || 0), slides.length - 1); const understood = new Set(prog.understood || []);
  const made = new Map(), asks = new Map(), answered = new Map(); let left = false;
  let ready = new Set(data.ready || []);      // the slides whose explanation is ready at this level (the whole lecture is prepared in the background)
  const prepare = () => { if (!data.ai) return; const lv = level; api('POST', `/api/explain/${id}/prepare`, { level: lv, from: idx }, { noRedirect: true }).then((r) => { if (lv !== level || left) return; (r.ready || []).forEach((p) => ready.add(p)); drawHead(); }).catch(() => { /* each slide is asked when reached */ }); };
  const onReady = (e) => { const d = e.detail || {}; if (d.doc !== id || d.level !== level || left) return; ready.add(d.page); drawHead(); };
  window.addEventListener('qz-explain-ready', onReady);
  const keyOf = (i, lv = level) => slides[i].page_no + '|' + lv;
  const root = h('div', { class: 'xpl' });
  const save = (extra) => api('PUT', `/api/explain/${id}/progress`, { current: idx, level, ...(extra || {}) }).catch(() => { /* kept next time */ });

  // an explanation, asked once (the prefetch and the student share one request); refresh: another way of explaining it
  const want = (i, lv = level, refresh = false) => { const k = keyOf(i, lv); if (!refresh && made.has(k)) return made.get(k);
    const p = api('POST', `/api/explain/${id}/slide`, { page: slides[i].page_no, level: lv, refresh }, { noRedirect: true }); made.set(k, p); p.catch(() => made.delete(k)); return p; };
  const prefetch = (i) => { if (data.ai && i >= 0 && i < slides.length && !made.has(keyOf(i))) want(i).catch(() => { /* asked again when opened */ }); };

  const slideBox = h('div', { class: 'xslide card', 'aria-live': 'polite' }), expBox = h('div', { class: 'xexp card' }), strip = h('div', { class: 'xstrip', role: 'tablist', 'aria-label': 'الشرائح' });
  const head = h('div', { class: 'xhead' }), nav = h('div', { class: 'xnav row between' }), pop = h('button', { class: 'btn small primary xpop', type: 'button', hidden: true }, '✨ اشرح هذا');

  function drawHead() {
    const done = slides.filter((s) => understood.has(s.page_no)).length;
    fill(head, h('div', { class: 'row between' },
      h('div', {}, h('a', { class: 'small muted', href: `#/files/${id}` }, '→ صفحة الملف'), h('h1', { style: 'margin:.2rem 0 0' }, 'شرح المحاضرة'), h('div', { class: 'muted bidi' }, data.title)),
      h('div', { class: 'xlevels', role: 'radiogroup', 'aria-label': 'مستوى الشرح' }, LEVELS.map(([k, label]) => h('button', { type: 'button', role: 'radio', class: 'chip-btn', 'aria-checked': String(level === k), 'aria-pressed': String(level === k),
        onclick: () => { if (level === k) return; level = k; ready = new Set(); save(); draw(); prepare(); } }, label)))),
    h('div', { class: 'xprogress' }, h('div', { class: 'row between small muted' }, h('span', {}, `الشريحة ${num(idx + 1)} من ${num(slides.length)} · فهمت ${num(done)}`),
      data.ai ? h('span', { class: 'xready' + (ready.size >= slides.length ? ' all' : '') }, ready.size >= slides.length ? '✓ الشرح جاهز كاملًا' : [h('span', { class: 'spin' }), ` جهّزنا الشرح لـ${num(ready.size)} من ${num(slides.length)}`]) : null),
      h('div', { class: 'progress' }, h('div', { style: `width:${Math.round((100 * done) / slides.length)}%` }))));
    fill(strip, slides.map((s, i) => h('button', { type: 'button', role: 'tab', class: 'xdot' + (i === idx ? ' cur' : '') + (understood.has(s.page_no) ? ' ok' : '') + (ready.has(s.page_no) ? ' rd' : ''), 'aria-selected': String(i === idx), 'aria-label': `الشريحة ${s.page_no}`, onclick: () => go(i) }, num(s.page_no))));
    const cur = strip.children[idx]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function drawSlide() {
    const s = slides[idx]; const lines = String(s.text || '').split('\n').map((x) => x.trim()).filter((x) => x && !/^\d{1,3}$/.test(x));      // (a bare page number is not the slide's)
    // the slide as it looks (kept on this device when its file was read): its picture first, then its text - the text is what the explanation quotes and lights up
    const pic = s.img ? h('figure', { class: 'ximg' }, h('img', { alt: `الشريحة ${s.page_no}`, loading: 'lazy' })) : null;
    if (pic) imgFor(s.page_no).then((url) => { const im = pic.querySelector('img'); if (url && im) { im.onerror = () => fill(pic, h('div', { class: 'ximg-lost small muted' }, 'صورة هذه الشريحة لم تعد محفوظة على هذا الجهاز — ارفع الملف مرة أخرى لتعود.')); im.src = url; } else fill(pic, h('div', { class: 'ximg-lost small muted' }, 'صورة هذه الشريحة لم تعد محفوظة على هذا الجهاز — ارفع الملف مرة أخرى لتعود.')); });
    fill(slideBox, h('div', { class: 'xslabel small muted' }, `الشريحة ${num(s.page_no)}`), pic,
      lines.length ? [h('h3', { class: 'xtitle', dir: dirOf(lines[0]), 'data-line': flat(lines[0]) }, lines[0]),
        h('div', { class: 'xlines' }, lines.slice(1).map((l) => h('p', { dir: dirOf(l), 'data-line': flat(l), class: /^[•▪◦●‣\-–*]|^\d{1,2}[.)]/.test(l) ? 'xbul' : '' }, l)))]
        : h('p', { class: 'muted' }, 'لا نص في هذه الشريحة.'),
      h('p', { class: 'xhint small muted', 'data-ui': '' }, data.ai ? 'ظلّل أي كلمة أو جملة في الشريحة لتُشرح لك.' : ''));
  }
  const urls = new Map();      // the slides' pictures as object URLs (made once, released when the page is left)
  const imgFor = (page) => { if (!urls.has(page)) urls.set(page, api('GET', `/api/explain/${id}/image/${page}`, undefined, { raw: true }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null)); return urls.get(page); };
  // the line of the slide a point explains lights up
  const light = (quote, on) => { const q = flat(quote); if (!q) return; slideBox.querySelectorAll('[data-line]').forEach((el) => { const l = el.dataset.line; if (l && (l.includes(q) || (q.includes(l) && l.length > 6))) el.classList.toggle('lit', on); }); };

  async function drawExplain() {
    const i = idx, lv = level;
    if (!data.ai) { fill(expBox, h('div', { class: 'alert info' }, 'الشرح يكتبه Claude: افتح كويزي من داخل claude.ai وأنت مسجّل الدخول، ووافق على استخدامه.')); return; }
    fill(expBox, h('div', { class: 'xskel', role: 'status', 'aria-label': 'جارٍ تحضير الشرح' }, h('span', { class: 'spin' }), h('span', { class: 'muted' }, 'يحضّر الشرح…'), h('i'), h('i'), h('i')));
    // AS IT IS WRITTEN: the idea, then each point the moment it is complete and checked, while the rest is still coming
    const page = slides[i].page_no; let got = false;
    const showPart = (part) => { if (got || left || i !== idx || lv !== level || !part || !(part.idea || (part.points || []).length)) return;
      fill(expBox, part.idea ? h('div', { class: 'xidea' }, h('span', { class: 'xtag' }, 'الفكرة'), h('p', {}, mixed(part.idea))) : null,
        (part.points || []).length ? h('ol', { class: 'xpoints' }, part.points.map((p, n) => h('li', { class: 'xin' }, h('span', { class: 'xn' }, num(n + 1)), h('span', { class: 'xar' }, mixed(p.ar), p.pic ? h('span', { class: 'xpic' }, '🖼 من صورة الشريحة') : null)))) : null,
        h('div', { class: 'row xmore', role: 'status' }, h('span', { class: 'spin' }), h('span', { class: 'small muted' }, 'يكمل الشرح…'))); };
    const onPart = (e) => { const d = e.detail || {}; if (d.doc === id && d.page === page && d.level === lv) showPart(d.part); };
    window.addEventListener('qz-explain', onPart);
    api('GET', `/api/explain/${id}/partial/${page}?level=${lv}`, undefined, { noRedirect: true }).then(showPart).catch(() => { /* nothing written yet */ });      // a slide prepared ahead may be half written already
    let x; try { x = await want(i, lv); } catch (e) { window.removeEventListener('qz-explain', onPart); if (left || i !== idx || lv !== level) return; fill(expBox, errorBox(e, () => drawExplain())); return; }
    got = true; window.removeEventListener('qz-explain', onPart);
    if (left || i !== idx || lv !== level) return;      // the student moved on meanwhile
    const s = slides[i];
    const points = h('ol', { class: 'xpoints' }, (x.points || []).map((p, n) => h('li', { tabindex: 0, onmouseenter: () => light(p.quote, true), onmouseleave: () => light(p.quote, false), onfocus: () => light(p.quote, true), onblur: () => light(p.quote, false) },
      h('span', { class: 'xn' }, num(n + 1)), h('span', { class: 'xar' }, mixed(p.ar), p.pic ? h('span', { class: 'xpic' }, '🖼 من صورة الشريحة') : null))));
    const qs = x.questions || (x.check ? [x.check] : []); const check = qs.length ? questionsBox(qs, s.page_no) : null;      /* (an explanation kept before the slide's questions: its one question) */
    fill(expBox,
      h('div', { class: 'xidea' }, h('span', { class: 'xtag' }, 'الفكرة'), h('p', {}, mixed(x.idea))),
      (x.points || []).length ? points : null,
      (x.terms || []).length ? h('div', { class: 'xterms' }, h('div', { class: 'xtag' }, 'مصطلحات الشريحة'), h('div', { class: 'row', style: 'flex-wrap:wrap;gap:.4rem' }, x.terms.map((t) => h('span', { class: 'xterm' }, h('b', { dir: 'ltr', translate: 'no' }, t.en), h('span', {}, mixed(t.ar)))))) : null,
      (x.remember || []).length ? h('div', { class: 'xremember' }, h('div', { class: 'xtag' }, '⭐ تذكّر للاختبار'), x.remember.map((r) => h('p', {}, mixed(r)))) : null,
      check,
      h('div', { class: 'row xactions' }, h('button', { class: 'btn primary', id: 'x-understood', onclick: () => { understood.add(s.page_no); save({ understood: s.page_no }); if (idx < slides.length - 1) go(idx + 1); else { drawHead(); drawEnd(); } } }, idx < slides.length - 1 ? 'فهمتها، التالي ←' : 'فهمتها ✓'),
        h('button', { class: 'btn small ghost', onclick: async () => { made.delete(keyOf(i)); want(i, level, true); drawExplain(); } }, '↻ اشرحها بطريقة أخرى')),
      askBox(s));
    typeset(expBox);
    prefetch(i + 1); prefetch(i + 2);      // the next two slides are ready when the student gets there
  }

  // THE SLIDE'S QUESTIONS: each answered on the spot (right / wrong, why, the line of the slide), and the score once all are answered
  function questionsBox(qs, page) {
    const box = h('div', { class: 'xcheck' }); const ans = answered.get(page) || {}; answered.set(page, ans);
    const draw = () => { const done = qs.filter((_, j) => ans[j] != null).length, right = qs.filter((k, j) => ans[j] === k.correct_index).length;
      fill(box, h('div', { class: 'row between' }, h('div', { class: 'xtag' }, `📝 أسئلة الشريحة (${num(qs.length)})`), done === qs.length ? h('span', { class: 'xscore ' + (right === qs.length ? 'ok' : '') }, `أصبت ${num(right)} من ${num(qs.length)}`) : null),
        qs.map((k, j) => { const a = ans[j]; return h('div', { class: 'xq' }, h('div', { class: 'xstem', dir: dirOf(k.stem) }, h('span', { class: 'xqn' }, num(j + 1) + '. '), k.stem),
          h('div', { class: 'xopts' }, k.options.map((o, n) => h('button', { type: 'button', dir: dirOf(o), disabled: a != null, class: 'xopt' + (a != null ? (n === k.correct_index ? ' right' : n === a ? ' wrong' : '') : ''),
            onclick: () => { ans[j] = n; draw(); } }, o))),
          a != null ? h('div', { class: 'xwhy ' + (a === k.correct_index ? 'ok' : 'bad') }, h('strong', {}, a === k.correct_index ? '✓ صح' : '✗ ليس هذا'), k.why ? [' ', mixed(k.why)] : '', k.quote ? h('blockquote', { dir: dirOf(k.quote) }, '«', k.quote, '»') : null) : null); })); };
    draw(); return box;
  }

  function askBox(s) {
    const log = h('div', { class: 'xlog' }), input = h('input', { class: 'tin', type: 'text', maxlength: 300, placeholder: 'اسأل عن هذه الشريحة…' }), err = h('div', { class: 'small', style: 'color:var(--bad)' });
    const turns = asks.get(s.page_no) || []; asks.set(s.page_no, turns);
    const drawLog = () => fill(log, turns.map((t) => [h('div', { class: 'tb me' }, t.sel ? h('span', { class: 'small muted' }, '«' + t.sel + '» ') : null, t.q), h('div', { class: 'tb ai' + (t.a ? '' : ' wait') }, t.a ? mixed(t.a) : '…')]));
    const ask = async (q, sel) => { err.textContent = ''; const t = { q: q || 'اشرح لي هذا', sel: sel || '', a: '' }; turns.push(t); drawLog();
      try { const r = await api('POST', `/api/explain/${id}/ask`, { page: s.page_no, q: t.q, selection: t.sel, history: turns.slice(0, -1).filter((x) => x.a).map((x) => ({ q: x.q, a: x.a })) }, { noRedirect: true });
        if (r && r.ar) t.a = r.ar; else { turns.pop(); err.textContent = 'لم يتيسّر جواب سليم من الشريحة على هذا. جرّب صياغة أخرى.'; } }
      catch (e) { turns.pop(); err.textContent = e.message || String(e); }
      if (!left && slides[idx].page_no === s.page_no) drawLog(); };
    askBox.ask = ask;      // (the «explain this» button of a selection asks here)
    drawLog();
    return h('div', { class: 'xask tutor' }, h('div', { class: 'thead' }, h('span', { class: 'lbl' }, 'اسأل عن الشريحة'), h('span', { class: 'small muted' }, 'من محاضرتك فقط')), log, err,
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (!q) return; input.value = ''; ask(q); } }, input, h('button', { class: 'btn small primary', type: 'submit' }, 'اسأل')));
  }

  function drawEnd() {
    fill(expBox, h('div', { class: 'xend' }, h('div', { style: 'font-size:2.2rem' }, '🎉'), h('h2', {}, 'أنهيت شرح المحاضرة'),
      h('p', { class: 'muted' }, `فهمت ${num(slides.filter((s) => understood.has(s.page_no)).length)} من ${num(slides.length)} شريحة. الآن ثبّت ما فهمته: الاختبار بعد الشرح هو ما يرسّخه.`),
      h('div', { class: 'row', style: 'justify-content:center' }, h('a', { class: 'btn primary', href: `#/new?doc=${id}` }, 'اختبر نفسك على المحاضرة'), h('a', { class: 'btn', href: `#/cards?doc=${id}` }, 'بطاقات المراجعة'),
        h('button', { class: 'btn ghost', onclick: () => go(0) }, 'من البداية'))));
  }

  function drawNav() {
    fill(nav, h('button', { class: 'btn', disabled: idx === 0, onclick: () => go(idx - 1) }, '→ السابقة'), h('span', { class: 'small muted' }, `${num(idx + 1)} / ${num(slides.length)}`),
      h('button', { class: 'btn', disabled: idx === slides.length - 1, onclick: () => go(idx + 1) }, 'التالية ←'));
  }
  function draw() { drawHead(); drawSlide(); drawNav(); drawExplain(); }
  function go(i) { if (i < 0 || i >= slides.length || i === idx) { if (i === idx) draw(); return; } idx = i; pop.hidden = true; save(); draw(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

  // a phrase selected on the slide: «اشرح هذا» next to it
  let popY = 0; const onSel = () => { setTimeout(() => { const sel = window.getSelection(); const t = sel ? sel.toString().trim() : ''; if (!data.ai || t.length < 2 || t.length > 300 || !sel.rangeCount || !slideBox.contains(sel.anchorNode)) { pop.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect(); pop.hidden = false; popY = window.scrollY; pop.style.top = Math.max(8, r.top - 44) + 'px'; pop.style.left = Math.min(window.innerWidth - 130, Math.max(8, r.left + r.width / 2 - 60)) + 'px'; pop.dataset.sel = t; }, 0); };
  pop.onclick = () => { const t = pop.dataset.sel; pop.hidden = true; window.getSelection().removeAllRanges(); if (askBox.ask) { askBox.ask('اشرح لي هذا', t); const a = expBox.querySelector('.xask'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } };
  slideBox.addEventListener('mouseup', onSel); slideBox.addEventListener('touchend', onSel);
  const hideSel = () => { if (Math.abs(window.scrollY - popY) > 40) pop.hidden = true; };      // a real scroll, not the page shifting a little as the counter above updates window.addEventListener('scroll', hideSel, { passive: true });
  const keyh = (e) => { if (e.target.matches('input,textarea,select') || document.querySelector('.modal')) return; if (e.key === 'ArrowLeft') go(idx + 1); else if (e.key === 'ArrowRight') go(idx - 1); };
  document.addEventListener('keydown', keyh);
  onLeave(() => { left = true; window.removeEventListener('qz-explain-ready', onReady); urls.forEach((u) => u.then((x) => x && URL.revokeObjectURL(x))); document.removeEventListener('keydown', keyh); window.removeEventListener('scroll', hideSel); pop.remove(); });

  fill(root, head, strip, h('div', { class: 'xgrid' }, slideBox, expBox), nav);
  document.body.append(pop);
  draw(); prepare();      // the whole lecture prepared while the student reads the first slide
  return root;
}
