// Static-demo "server": answers the app's /api/* calls in the browser (localStorage), using REAL data exported from a
// local run of Quizzy. No uploads, no generation, no accounts. Everything here is labelled demo in the UI banner.
(() => {
  const realFetch = window.fetch.bind(window);
  const KEY = 'quizzy_demo_v1';
  let D = null;
  const st = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  st.attempts ||= {}; st.cards ||= {}; st.in ||= false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const E = (status, code, message) => J({ code, message }, status);
  const NA = () => E(503, 'demo_mode', 'هذه نسخة عرض تجريبية: الرفع والتوليد والحسابات الحقيقية غير متاحة هنا. شغّل المشروع على خادم لتجربتها.');
  const user = { id: 'demo', email: 'demo@quizzy.example', name: 'زائر تجريبي', role: 'student' };
  const now = () => Date.now() / 1000;
  const body = (init) => { try { return init && init.body ? JSON.parse(init.body) : {}; } catch { return {}; } };

  function attState(a) {
    const q = D.quiz, byId = Object.fromEntries(D.questions.map((x) => [x.id, x]));
    const sub = a.status === 'submitted', practice = a.mode === 'practice';
    const items = a.order.map((qid, i) => {
      const x = byId[qid], ans = a.answers[qid] || {};
      const oo = a.optOrder[qid].map((id) => x.options.find((o) => o.id === id));
      const it = { id: qid, position: i + 1, qtype: x.qtype, type_label: x.type_label, stem: x.stem, options: oo, selected_option_id: ans.sel || null,
        flagged: !!ans.flag, answered: !!ans.sel, source_pages: x.source_pages };
      if (sub || (practice && ans.revealed)) Object.assign(it, { correct_option_id: x.correct_option_id, explanation: x.explanation, is_correct: ans.sel === x.correct_option_id, evidence: x.evidence });
      return it;
    });
    const score = items.filter((i) => i.is_correct).length;
    return { id: a.id, quiz_id: q.id, quiz_title: q.title, mode: a.mode, status: a.status, current_index: a.idx, elapsed_seconds: a.elapsed || 0,
      time: { limit: a.timer, remaining: a.timer ? Math.max(0, a.timer - Math.floor(now() - a.started)) : null }, score: sub ? score : null, max_score: sub ? items.length : null,
      questions: items, scoring: q.scoring, answered: items.filter((i) => i.answered).length, total: items.length, generator: q.generator, is_demo: true, started_at: a.started, submitted_at: a.submittedAt };
  }
  const attRow = (a) => { const s = attState(a); return { id: a.id, quiz_id: s.quiz_id, quiz_title: s.quiz_title, mode: a.mode, status: a.status, answered: s.answered, total: s.total,
    score: s.score, max_score: s.max_score, started_at: a.started, updated_at: a.updated, submitted_at: a.submittedAt }; };
  const card = (c) => ({ ...c, ...(st.cards[c.id] || {}), document_title: D.doc.title });

  async function handle(method, path, qs, init) {
    if (!D) D = await (await realFetch('./data.json')).json();
    const b = body(init); let m;
    if (path === '/api/auth/capabilities') return J({ password_reset: false, llm: false, llm_is_test: false });
    if (path === '/api/auth/me') return st.in ? J(user) : E(401, 'unauthenticated', 'سجّل الدخول للمتابعة.');
    if (path === '/api/auth/login' || path === '/api/auth/register') { st.in = true; save(); return J(user); }
    if (path === '/api/auth/logout') { st.in = false; save(); return J({ ok: true }); }
    if (path.startsWith('/api/auth/')) return NA();
    if (!st.in) return E(401, 'unauthenticated', 'سجّل الدخول للمتابعة.');
    if (path === '/api/events' || path === '/api/reports') return J({ ok: true });
    if (path === '/api/documents' && method === 'GET') return J([D.doc]);
    if (path === '/api/documents') return NA();
    if ((m = path.match(/^\/api\/documents\/(\w+)\/pages\/(\d+)$/))) return J(D.pages[m[2]]);
    if ((m = path.match(/^\/api\/documents\/(\w+)\/cards\/generate$/))) return NA();
    if ((m = path.match(/^\/api\/documents\/(\w+)$/))) return method === 'GET' ? J(D.doc) : NA();
    if (path === '/api/quizzes/options') return J(D.options);
    if (path === '/api/quizzes' && method === 'GET') return J([D.quiz]);
    if (path === '/api/quizzes') return NA();
    if ((m = path.match(/^\/api\/quizzes\/(\w+)$/))) return method === 'GET' ? J(D.quiz) : NA();
    if ((m = path.match(/^\/api\/quizzes\/(\w+)\/questions$/))) return J(D.questions);
    if ((m = path.match(/^\/api\/quizzes\/(\w+)\/attempts$/))) {
      const id = 'a' + Math.random().toString(36).slice(2, 10); let order = D.questions.map((x) => x.id);
      if (b.only_question_ids) order = order.filter((x) => b.only_question_ids.includes(x));
      if (b.shuffle_questions) order.sort(() => Math.random() - 0.5);
      const optOrder = {}; D.questions.forEach((x) => { const ids = x.options.map((o) => o.id); if (b.shuffle_options !== false) ids.sort(() => Math.random() - 0.5); optOrder[x.id] = ids; });
      st.attempts[id] = { id, mode: b.mode || 'practice', order, optOrder, answers: {}, idx: 0, elapsed: 0, status: 'in_progress', started: now(), updated: now(), timer: b.timer_minutes ? b.timer_minutes * 60 : null };
      save(); return J(attState(st.attempts[id]));
    }
    if (path === '/api/attempts' && method === 'GET') {
      let l = Object.values(st.attempts); if (qs.get('status')) l = l.filter((a) => a.status === qs.get('status'));
      return J(l.sort((a, b2) => b2.updated - a.updated).map(attRow));
    }
    if ((m = path.match(/^\/api\/attempts\/(\w+)(\/\w+)?$/))) {
      const a = st.attempts[m[1]]; if (!a) return E(404, 'not_found', 'المحاولة غير موجودة.');
      const act = m[2];
      if (!act && method === 'GET') return J(attState(a));
      if (!act && method === 'DELETE') { delete st.attempts[a.id]; save(); return J({ ok: true }); }
      if (act === '/answer') {
        if (a.status === 'submitted') return E(409, 'already_submitted', 'المحاولة مسلَّمة.');
        const x = D.questions.find((q) => q.id === b.question_id), ans = (a.answers[x.id] ||= {}); const r = { saved: true, saved_at: now() };
        if (b.option_id != null) {
          if (a.mode === 'practice' && ans.revealed) return E(409, 'locked', 'تم عرض التفسير؛ لا يمكن تغيير الإجابة.');
          ans.sel = b.option_id; if (a.mode === 'practice') { ans.revealed = true; Object.assign(r, { is_correct: ans.sel === x.correct_option_id, correct_option_id: x.correct_option_id, explanation: x.explanation, evidence: x.evidence, source_pages: x.source_pages }); }
        }
        if (b.flagged != null) ans.flag = b.flagged;
        a.updated = now(); save(); return J(r);
      }
      if (act === '/position') { a.idx = b.index; a.elapsed = Math.max(a.elapsed, b.elapsed_seconds); a.updated = now(); save(); return J({ saved: true, saved_at: now() }); }
      if (act === '/submit') { a.status = 'submitted'; a.submittedAt = now(); a.updated = now(); save(); return J(attState(a)); }
    }
    if (path === '/api/cards/stats') {
      const cs = D.cards.map(card);
      return J([{ id: D.doc.id, title: D.doc.title, total: cs.length, known: cs.filter((c) => c.state === 'known').length, review: cs.filter((c) => c.state === 'review').length,
        new: cs.filter((c) => c.state === 'new').length, due: cs.filter((c) => !c.due_at || c.due_at <= now()).length }]);
    }
    if (path === '/api/cards' && method === 'GET') {
      let cs = D.cards.map(card); if (qs.get('state')) cs = cs.filter((c) => c.state === qs.get('state')); if (qs.get('due')) cs = cs.filter((c) => !c.due_at || c.due_at <= now());
      return J(cs);
    }
    if ((m = path.match(/^\/api\/cards\/(\w+)\/state$/))) {
      const c = st.cards[m[1]] || { interval_days: 0 }; const prev = c.interval_days || 0;
      if (b.state === 'known') { c.interval_days = prev < 1 ? 1 : Math.min(180, Math.round(prev * 22) / 10); c.due_at = now() + c.interval_days * 86400; }
      else if (b.state === 'review') { c.interval_days = 0; c.due_at = now() + 600; } else { c.interval_days = 0; c.due_at = null; }
      c.state = b.state; st.cards[m[1]] = c; save(); return J({ saved: true, state: b.state, saved_at: now() });
    }
    if (path.startsWith('/api/admin')) return E(403, 'forbidden', 'الإدارة غير متاحة في العرض التجريبي.');
    return E(404, 'not_found', 'غير متاح في العرض التجريبي.');
  }

  window.fetch = (url, init = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url, location.href);
    if (!u.pathname.includes('/api/')) return realFetch(url, init);
    const path = u.pathname.slice(u.pathname.indexOf('/api/'));
    return handle((init.method || 'GET').toUpperCase(), path, u.searchParams, init);
  };
  // PDF links point at the pre-built sample file
  document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href*="/pdf"]'); if (a) a.href = './quiz-demo.pdf'; }, true);
  // visible demo banner
  window.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'عرض تجريبي ثابت: بيانات حقيقية من تشغيل محلي بمولّد اختباري (ليست جودة النموذج الحقيقي). الرفع والتوليد والحسابات الحقيقية غير متاحة هنا.';
    b.style.cssText = 'background:#fff1cc;color:#6b4200;padding:.45rem 1rem;text-align:center;font:600 .85rem system-ui;border-bottom:1px solid #d9a441';
    document.body.prepend(b);
  });
})();
