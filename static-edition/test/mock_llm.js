// TEST ONLY: an OpenAI-compatible /v1/chat/completions server (with CORS) whose "model" builds cloze questions from the pages
// in the prompt. Lets the browser pipeline be exercised end to end with a real HTTP provider. Control: POST /__control {rate429: n, fail401: bool}
const http = require('http');
const sents = (t) => t.split(/(?<=[.!?؟])\s+|\n+/).map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter((s) => s.split(/\s+/).length >= 6 && s.split(/\s+/).length <= 40);
const terms = (s) => s.split(/\s+/).map((w) => w.replace(/[.,;:()،]/g, '')).filter((w) => w.length >= 5 && !/^\d+$/.test(w));
const between = (s, a, b) => { const i = s.indexOf(a) + a.length; const j = b ? s.indexOf(b, i) : s.length; return s.slice(i, j); };
function start(port = 0) {
  const st = { calls: {}, total: 0, rate429: 0, fail401: false, used: {}, lastAuth: null, models: [] };
  const fake = {
    analyze(p) { const pages = JSON.parse(between(p, 'PAGES:\n')); if (st.sloppy === 'empty') return { note: 'no objectives found' };
      const r = { lecture_character: 'تحليل اختباري.', discipline_guess: null, gaps: [], objectives: pages.filter((x) => x.text.length >= 80).map((x, i) => ({ id: 'o' + i, statement: x.text.split('\n')[0], pages: [x.ref], key_terms: [], capacity: 2, supports: { basic_recall: { pages: [x.ref] }, understanding: { pages: [x.ref] } } })) };
      if (st.sloppy === 'refs') r.objectives.forEach((o) => { o.pages = o.pages.map((x) => x.replace('d1p', 'page ')); o.supports = ['Recall', 'Understanding']; });
      return r; },
    generate(p) { const slots = JSON.parse(between(p, 'SLOTS:\n', '\nPAGES:\n')); const pages = JSON.parse(between(p, '\nPAGES:\n', '\nReturn JSON'));
      return { questions: slots.map((s) => { const ref = s.pages[0], text = pages[ref] || ''; const ss = sents(text); if (!ss.length) return { slot: s.slot, unwritable_reason: 'لا جمل كافية' };
        const i = (st.used[ref] = (st.used[ref] || 0) + 1) - 1, sent = ss[i % ss.length], term = terms(sent).sort((a, b) => b.length - a.length)[0]; if (!term) return { slot: s.slot, unwritable_reason: 'لا مصطلح' };
        const pool = [...new Set(ss.flatMap(terms))].filter((w) => w !== term && w.length >= 4); if (pool.length < 3) return { slot: s.slot, unwritable_reason: 'لا مشتتات' };
        return { slot: s.slot, unwritable_reason: null, stem: 'Complete according to the lecture: ' + sent.replace(term, '_____'), options: pool.slice(0, 3).concat([term]), correct_index: 3, explanation: 'الإجابة الصحيحة مبنية على نص المحاضرة: «' + sent + '». الخيارات الأخرى لا تظهر في هذا السياق.',
          purpose: s.type + ' / ' + sent.slice(0, 40), reasoning_pattern: s.type, evidence: [{ page: ref, quote: sent }], uses_external: false }; }) }; },
    verify(p) { const blob = between(p, 'SOURCE PAGES:\n', '\nQUESTIONS:\n'); const qs = JSON.parse(between(p, '\nQUESTIONS:\n', '\nReturn JSON')); const norm = (x) => x.toLowerCase().replace(/\s+/g, ' '); const text = norm(blob);
      return { results: qs.map((q) => { const cloze = q.stem.split(': ').slice(1).join(': '); const hit = q.options.map((o, i) => (text.includes(norm(cloze.replace('_____', o))) ? i : -1)).filter((i) => i >= 0);
        return { id: q.id, chosen_index: hit.length === 1 ? hit[0] : null, answerable_from_source: hit.length === 1, single_best_answer: hit.length === 1, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none' }; }) }; },
    explain(p) { const items = JSON.parse(between(p, '\nITEMS:\n', '\nReturn JSON')); return { results: items.map((x) => ({ id: x.id, explanation_supported: true, contradicts_source: false, notes: '' })) }; },
    cards(p) { const pages = JSON.parse(between(p, 'PAGES:\n')); const out = []; Object.entries(pages).forEach(([ref, t]) => sents(t).slice(0, 3).forEach((s) => { const w = terms(s).sort((a, b) => b.length - a.length)[0]; if (w) out.push({ front: 'Complete: ' + s.replace(w, '_____'), back: w, page: ref, quote: s }); })); return { cards: out }; },
    test() { return { ok: true }; },
  };
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' }; if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
      if (req.url === '/__control') { Object.assign(st, JSON.parse(raw || '{}')); res.writeHead(200, cors); return res.end('{}'); }
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404, cors); return res.end('{}'); }
      st.total++; st.lastAuth = req.headers.authorization; const body = JSON.parse(raw); st.models.push(body.model); const sys = body.messages[0].content, prompt = body.messages[1].content; const all = sys + '\n' + prompt;
      if (st.fail401) { res.writeHead(401, { ...cors, 'content-type': 'application/json' }); return res.end('{"error":"bad key"}'); }
      if (st.rate429 > 0) { st.rate429--; res.writeHead(429, { ...cors, 'retry-after': '1', 'content-type': 'application/json' }); return res.end('{"error":"rate"}'); }
      let kind = 'test'; if (all.includes('You analyse lecture material')) kind = 'analyze'; else if (all.includes('Write one question per slot')) kind = 'generate'; else if (all.includes('strict, independent exam reviewer')) kind = 'verify'; else if (all.includes('check whether each explanation')) kind = 'explain'; else if (all.includes('spaced-repetition flashcards')) kind = 'cards';
      st.calls[kind] = (st.calls[kind] || 0) + 1; const out = fake[kind](prompt);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }] })); });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, stats: st, close: () => new Promise((r) => server.close(r)) })));
}
module.exports = { start };
