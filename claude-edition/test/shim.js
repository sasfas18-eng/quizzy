// TEST ONLY: emulates claude.use('db'|'user'|'sample') locally. Never shipped in dist.
(() => {
  const LS = 'qz_shim_db'; const load = () => JSON.parse(localStorage.getItem(LS) || '{}'); const save = (o) => localStorage.setItem(LS, JSON.stringify(o));
  const db = { collection(path) { const snap = (d) => ({ exists: true, data: () => d });
    return { doc(k) { return { async get() { const d = load()[path + '/' + k]; return d ? snap(d) : { exists: false, data: () => undefined }; }, async set(v) { const o = load(); o[path + '/' + k] = v; save(o); }, async delete() { const o = load(); delete o[path + '/' + k]; save(o); } }; },
      where(f, op, v) { return { async get() { const o = load(); return { docs: Object.entries(o).filter(([p, d]) => p.startsWith(path + '/') && d[f] === v).map(([, d]) => snap(d)) }; } }; } }; } };
  const user = { async id() { return 'u1'; } };
  const sents = (t) => t.split(/(?<=[.!?؟])\s+|\n+/).map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter((s) => s.split(/\s+/).length >= 6 && s.split(/\s+/).length <= 40);
  const terms = (s) => s.split(/\s+/).map((w) => w.replace(/[.,;:()،]/g, '')).filter((w) => w.length >= 5 && !/^\d+$/.test(w));
  const between = (s, a, b) => { const i = s.indexOf(a) + a.length; const j = b ? s.indexOf(b, i) : s.length; return s.slice(i, j); };
  const used = {};
  const fake = {
    analyze(p) { const pages = JSON.parse(between(p, 'PAGES:\n')); return { lecture_character: 'تحليل اختباري (shim).', discipline_guess: null, gaps: [], objectives: pages.filter((x) => x.text.length >= 80).map((x, i) => ({ id: 'o' + i, statement: x.text.split('\n')[0], pages: [x.ref], key_terms: [], capacity: 2, supports: { basic_recall: { pages: [x.ref] }, understanding: { pages: [x.ref] } } })) }; },
    generate(p) { const slots = JSON.parse(between(p, 'SLOTS:\n', '\nPAGES:\n')); const pages = JSON.parse(between(p, '\nPAGES:\n', '\nReturn JSON'));
      return { questions: slots.map((s) => { const ref = s.pages[0], text = pages[ref] || ''; const ss = sents(text); if (!ss.length) return { slot: s.slot, unwritable_reason: 'لا جمل كافية' };
        const i = (used[ref] = (used[ref] || 0) + 1) - 1, sent = ss[i % ss.length], term = terms(sent).sort((a, b) => b.length - a.length)[0]; if (!term) return { slot: s.slot, unwritable_reason: 'لا مصطلح' };
        const pool = [...new Set(ss.flatMap(terms))].filter((w) => w !== term && w.length >= 4); if (pool.length < 3) return { slot: s.slot, unwritable_reason: 'لا مشتتات' };
        const opts = pool.slice(0, 3).concat([term]); return { slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ' + sent.replace(term, '_____'), options: opts, correct_index: 3,
          explanation: 'الإجابة الصحيحة مبنية على نص المحاضرة: «' + sent + '». الخيارات الأخرى لا تظهر في هذا السياق.', purpose: s.type + ' / ' + sent.slice(0, 40), reasoning_pattern: s.type, evidence: [{ page: ref, quote: sent }], uses_external: false }; }) }; },
    verify(p) { const blob = between(p, 'SOURCE PAGES:\n', '\nQUESTIONS:\n'); const qs = JSON.parse(between(p, '\nQUESTIONS:\n', '\nReturn JSON')); const norm = (x) => x.toLowerCase().replace(/\s+/g, ' '); const text = norm(blob);
      return { results: qs.map((q) => { const cloze = q.stem.split(': ').slice(1).join(': '); const hit = q.options.map((o, i) => (text.includes(norm(cloze.replace('_____', o))) ? i : -1)).filter((i) => i >= 0);
        return { id: q.id, chosen_index: hit.length === 1 ? hit[0] : null, answerable_from_source: hit.length === 1, single_best_answer: hit.length === 1, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' }; }) }; },
    explain(p) { const items = JSON.parse(between(p, '\nITEMS:\n', '\nReturn JSON')); return { results: items.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) }; },
    cards(p) { const pages = JSON.parse(between(p, 'PAGES:\n')); const out = []; Object.entries(pages).forEach(([ref, t]) => sents(t).slice(0, 3).forEach((s) => { const w = terms(s).sort((a, b) => b.length - a.length)[0]; if (w) out.push({ front: 'Complete: ' + s.replace(w, '_____'), back: w, page: ref, quote: s }); })); return { cards: out }; },
  };
  const sample = async () => ({ text: '' });
  sample.json = async (input) => { if (location.search.includes('denysample')) { const e = new Error('denied'); e.code = 'not_granted'; throw e; } input = input.replace(/\n\nReturn ONLY one valid JSON value, no prose\.$/, ''); await new Promise((r) => setTimeout(r, 5)); if (input.includes('You analyse lecture material')) return fake.analyze(input); if (input.includes('Write one question per slot')) return fake.generate(input);
    if (input.includes('strict, independent exam reviewer')) { window.__calls = (window.__calls || 0) + 1; return fake.verify(input); } if (input.includes('check whether each explanation')) { window.__calls = (window.__calls || 0) + 1; return fake.explain(input); } if (input.includes('spaced-repetition flashcards')) return fake.cards(input); throw new Error('unknown prompt'); };
  window.claude = { use: async (n) => ({ db, user, sample: location.search.includes('nosample') ? null : sample }[n] || null) };
})();
