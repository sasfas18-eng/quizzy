// TEST ONLY: emulates claude.use('db'|'user'|'sample') locally. Never shipped in dist.
(() => {
  const LS = 'qz_shim_db'; const load = () => JSON.parse(localStorage.getItem(LS) || '{}'); const save = (o) => localStorage.setItem(LS, JSON.stringify(o));
  // a NETWORK store, as claude.ai's is (when a test asks for it): every call takes window.__dbLat ms, a list also its size at window.__dbBps bytes/s, and more than
  // window.__dbMaxW writes at once are refused with «resource_exhausted» (the real store's «too many concurrent writes»); window.__dbCalls counts the calls
  const lat = (extra = 0) => (window.__dbLat ? new Promise((r) => setTimeout(r, window.__dbLat + extra)) : null); let wIn = 0;
  const viewer = location.search.includes('viewer');      // ?viewer: a visitor of the shared link (the `view` level) - reads, and writes nothing, their own space included
  const write = async (fn) => { window.__dbCalls = (window.__dbCalls || 0) + 1; if (viewer) { const e = new Error('Write not permitted at this sharing level.'); e.code = 'invalid_argument'; throw e; } if (window.__dbMaxW && wIn >= window.__dbMaxW) { const e = new Error('too many concurrent writes'); e.code = 'resource_exhausted'; throw e; }
    wIn++; try { await lat(); fn(); } finally { wIn--; } };
  const db = { collection(path) { const snap = (d) => ({ exists: true, data: () => d });
    return { doc(k) { return { async get() { window.__dbCalls = (window.__dbCalls || 0) + 1; await lat(); const d = load()[path + '/' + k]; return d ? snap(d) : { exists: false, data: () => undefined }; },
      async set(v) { if (window.__dbDelay && /^att_/.test(k)) await new Promise((r) => setTimeout(r, window.__dbDelay)); await write(() => { const o = load(); o[path + '/' + k] = JSON.parse(JSON.stringify(v)); save(o); }); },
      async delete() { await write(() => { const o = load(); delete o[path + '/' + k]; save(o); }); } }; },
      where(f, op, v) { return { async get() { window.__dbCalls = (window.__dbCalls || 0) + 1; const o = load(); const docs = Object.entries(o).filter(([p, d]) => p.startsWith(path + '/') && d[f] === v).map(([, d]) => d);
        await lat(window.__dbBps ? (JSON.stringify(docs).length / window.__dbBps) * 1000 : 0); return { docs: docs.map(snap) }; } }; } }; },
    doc(path) { const i = path.lastIndexOf('/'); return db.collection(path.slice(0, i)).doc(path.slice(i + 1)); } };      // a shared document by its full path (forms/shared)
  const user = { async id() { return viewer ? 'u2' : 'u1'; }, async isOwner() { return !location.search.includes('notowner') && !viewer; },      // the viewer is the artifact's owner (?notowner: a Contributor student; ?viewer: a link visitor)
    async canEdit() { return !location.search.includes('notowner') && !viewer; }, async can(n) { return viewer ? null : n === 'data.write'; } };
  const sents = (t) => t.split(/(?<=[.!?؟])\s+|\n+/).map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter((s) => s.split(/\s+/).length >= 6 && s.split(/\s+/).length <= 40);
  const terms = (s) => s.split(/\s+/).map((w) => w.replace(/[.,;:()،]/g, '')).filter((w) => w.length >= 5 && !/^\d+$/.test(w));
  const between = (s, a, b) => { const i = s.indexOf(a) + a.length; const j = b ? s.indexOf(b, i) : s.length; return s.slice(i, j); };
  const used = {};
  const fake = {
    analyze(p) { const pages = JSON.parse(between(p, 'PAGES:\n')); return { lecture_character: 'تحليل اختباري (shim).', discipline_guess: null, gaps: [], objectives: pages.filter((x) => x.text.length >= 80).map((x, i) => ({ id: 'o' + i, statement: x.text.split('\n')[0], pages: [x.ref], key_terms: [], capacity: 2, supports: { basic_recall: { pages: [x.ref] }, understanding: { pages: [x.ref] } } })) }; },
    generate(p) { const slots = JSON.parse(between(p, 'SLOTS:\n', '\nPAGES:\n')); const pages = JSON.parse(between(p, '\nPAGES:\n', '\nReturn JSON'));
      if (location.search.includes('quotemeta')) { const pg = JSON.parse(between(p, '\nPAGES:\n', '\nReturn JSON')); return { questions: slots.map((s) => { const t = pg[s.pages[0]] || ''; const line = t.split('\n')[0]; return { slot: s.slot, unwritable_reason: null, stem: 'Who is the lecturer of this lecture?', options: ['Dr. Ahmed', 'Dr. Omar', 'Dr. Sara', 'Dr. Lina'], correct_index: 0, explanation: 'الإجابة من الصفحة: «' + line + '». الخيارات الأخرى لا تظهر.', purpose: 'meta ' + s.slot, reasoning_pattern: 'x', evidence: [{ page: s.pages[0], quote: line }], uses_external: false }; }) }; }
      if (location.search.includes('badquotes')) return { questions: slots.map((s) => ({ slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ____ is the answer here', options: ['alpha', 'beta', 'gamma', 'delta'], correct_index: 0, explanation: 'This explanation is long enough to pass the length check but cites nothing real.', purpose: 'p', reasoning_pattern: 'r', evidence: [{ page: s.pages[0], quote: 'THIS QUOTE IS NOT IN THE SOURCE PAGE' }], uses_external: false })) };
      const refuse = location.search.includes('refusehalf'); window.__refused = window.__refused || new Set();
      return { questions: slots.map((s) => { if (refuse && s.slot % 2 === 0 && !window.__refused.has(s.slot)) { window.__refused.add(s.slot); return { slot: s.slot, unwritable_reason: 'The cited page contains no abbreviation to expand.' }; }
        const ref = s.pages[0], text = pages[ref] || ''; const ss = sents(text); if (!ss.length) return { slot: s.slot, unwritable_reason: 'لا جمل كافية' };
        const i = (used[ref] = (used[ref] || 0) + 1) - 1, sent = ss[i % ss.length], term = terms(sent).sort((a, b) => b.length - a.length)[0]; if (!term) return { slot: s.slot, unwritable_reason: 'لا مصطلح' };
        const pool = [...new Set(ss.flatMap(terms))].filter((w) => w !== term && w.length >= 4); if (pool.length < 3) return { slot: s.slot, unwritable_reason: 'لا مشتتات' };
        const opts = pool.slice(0, 3).concat([term]); return { slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ' + sent.replace(term, '_____'), options: opts, correct_index: 3,
          explanation: 'الإجابة الصحيحة مبنية على نص المحاضرة: «' + sent + '». الخيارات الأخرى لا تظهر في هذا السياق.', purpose: s.type + ' / ' + sent.slice(0, 40), reasoning_pattern: s.type, evidence: [{ page: ref, quote: sent }], uses_external: false }; }) }; },
    verify(p) { const blob = between(p, 'SOURCE PAGES:\n', '\nQUESTIONS:\n'); const qs = JSON.parse(between(p, '\nQUESTIONS:\n', '\nReturn JSON')); const norm = (x) => x.toLowerCase().replace(/\s+/g, ' '); const text = norm(blob);
      return { results: qs.map((q) => { const cloze = q.stem.split(': ').slice(1).join(': '); const hit = q.options.map((o, i) => (text.includes(norm(cloze.replace('_____', o))) ? i : -1)).filter((i) => i >= 0);
        return { id: q.id, chosen_index: hit.length === 1 ? hit[0] : null, answerable_from_source: hit.length === 1, single_best_answer: hit.length === 1, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none',
          weak_options: location.search.includes('refusehalf') && hit.length === 1 ? [{ index: (hit[0] + 1) % 4, why: 'about_question' }, { index: (hit[0] + 2) % 4, why: 'not_parallel' }] : [] }; }) }; },
    explain(p) { const items = JSON.parse(between(p, '\nITEMS:\n', '\nReturn JSON')); return { results: items.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) }; },
    cards(p) { const pages = JSON.parse(between(p, 'PAGES:\n')); const out = []; Object.entries(pages).forEach(([ref, t]) => sents(t).slice(0, 3).forEach((s) => { const w = terms(s).sort((a, b) => b.length - a.length)[0]; if (w) out.push({ front: 'Complete: ' + s.replace(w, '_____'), back: w, page: ref, quote: s }); })); return { cards: out }; },
  };
  // ?perm=prompt|denied: claude.ai's permission for `sample` (read by the built-in `permissions`). «prompt»: every request WAITS until the test allows it
  // (window.__allow()), as a request waits on the consent dialog; «denied»: every request is refused (not_granted) until the Permissions panel turns it on (manage)
  let perm = (location.search.match(/perm=(prompt|denied)/) || [])[1] || 'granted'; const held = [];
  window.__allow = () => { perm = 'granted'; held.splice(0).forEach((r) => r()); };
  const permissions = { async state(n) { return n === 'sample' ? perm : 'unavailable'; }, async manage() { window.__managed = (window.__managed || 0) + 1; if (perm === 'denied') perm = 'granted'; } };
  const sample = async () => ({ text: '' });
  let sampleCalls = 0;
  sample.json = async (input) => { if (location.search.includes('denysample')) { const e = new Error('denied'); e.code = 'not_granted'; throw e; }
    if (perm === 'denied') throw { code: 'not_granted', message: 'The viewer has not allowed this artifact to use Claude.' };
    if (perm === 'prompt') await new Promise((r) => held.push(r));
    if (navigator.onLine === false) { await new Promise((r) => setTimeout(r, 30)); throw { code: 'upstream_error', message: 'network error' }; }      // no connection: claude.ai cannot reach Claude
    if (location.search.includes('refuseall')) { await new Promise((r) => setTimeout(r, 20)); const e = new Error('Too many requests'); e.code = 'rate_limited'; throw e; }      // a used-up quota that answers like «too many at once»
    { const m = location.search.match(/quotaafter=(\d+)/); sampleCalls++; if (m && sampleCalls > +m[1]) { const e = new Error('Usage limit reached for your plan. Try again later.'); e.code = 'rate_limited'; throw e; } } input = input.replace(/\n\nReturn ONLY one valid JSON value, no prose\.$/, ''); await new Promise((r) => setTimeout(r, +((location.search.match(/[?&]lat=(\d+)/) || [])[1] || 5)));      /* ?lat=ms: a slower Claude */ if (input.includes('You profile lecture material')) { const refs = Object.keys(JSON.parse(between(input, 'PAGES:\n'))); const on = ['basic_recall', 'understanding', 'mechanisms']; return { types: Object.fromEntries(['basic_recall', 'understanding', 'mechanisms', 'application', 'critical_thinking', 'scenarios', 'compare_contrast', 'best_answer', 'not_except', 'sequence'].map((c) => [c, on.includes(c) ? { capacity: refs.length * 2, pages: refs } : { capacity: 0, pages: [] }])) }; }
    if (input.includes('You analyse lecture material')) return fake.analyze(input); if (input.includes('Write one question per slot')) return fake.generate(input);
    if (input.includes('strict, independent exam reviewer')) { window.__calls = (window.__calls || 0) + 1; return fake.verify(input); } if (input.includes('check whether each explanation')) { window.__calls = (window.__calls || 0) + 1; return fake.explain(input); } if (input.includes('spaced-repetition flashcards')) return fake.cards(input);
    if (input.includes('Classify only the supplied uncertain lecture fragments')) { window.__reading = (window.__reading || 0) + 1; const units = JSON.parse(input.slice(input.lastIndexOf('\n[{') + 1)); const heading = (t) => { const x = t.trim(); if (/^[•■▪◦–—-]/.test(x)) return false; const w = x.split(/\s+/).filter((y) => /^\p{L}/u.test(y) && !/^(?:of|the|and|in|on|for|to|with|a|an|by|or|at)$/i.test(y)); return w.length > 0 && w.filter((y) => /^\p{Lu}/u.test(y)).length / w.length >= 0.75; };      // a Title Case line on its own: a heading
      return { decisions: units.map((u) => ({ unit_id: u.unit_id, decision: u.text.trim().split(/\s+/).length >= 5 && !heading(u.text) ? 'include' : 'context', reason: 'shim: a taught line of five words or more; a heading or a label is context' })) }; }
    throw new Error('unknown prompt'); };
  const downloads = { async save({ filename, data }) { window.__saved = { filename, size: data && (data.size || data.byteLength || data.length), type: data && data.type }; return { status: 'saved' }; } };
  window.claude = { use: async (n) => ({ db, user, permissions, sample: location.search.includes('nosample') ? null : sample, downloads: location.search.includes('nodownloads') ? null : downloads }[n] || null) };
})();
