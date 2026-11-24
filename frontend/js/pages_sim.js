// المحاكي (#/sim/<attempt>): the owner's exam on the exam app's screen (sim_core.js) over a real attempt - answers, flags and skips saved as they are made,
// the time kept by the attempt, End Exam hands it in. Then the app's «Exam Result» (#/sim/<attempt>/result), with the site's own review one tap away.
// The quiz's own design is untouched: this is a page of its own, opened only from «المحاكي» in the start dialog.
import { api, saveRemote, toast } from './core.js';
import { onLeave } from './main.js';
import { shell, mountSim, renderResult } from './sim_core.js';

const lockPage = (on) => { document.documentElement.style.overflow = on ? 'hidden' : ''; };

export async function simPage(id) {
  const a = await api('GET', `/api/attempts/${id}`);
  if (a.status === 'submitted') { location.hash = `#/sim/${id}/result`; return null; }
  if (!a.sim) { location.hash = `#/attempt/${id}`; return null; }
  const root = shell(); lockPage(true);
  const toResult = () => { location.hash = `#/sim/${id}/result`; };
  const failed = (e) => { if (e && (e.code === 'time_up' || e.code === 'already_submitted')) toResult(); else if (e && [404, 422].includes(e.status)) toast(e.message, 'bad'); };
  const remainingAtOpen = a.time.remaining;      // the attempt's own clock: the time left when the page opened
  const model = { title: a.quiz_title, student: 'Student', timeLimit: a.time.limit || null, elapsed: a.time.limit ? Math.max(0, a.time.limit - (remainingAtOpen == null ? a.time.limit : remainingAtOpen)) : (a.elapsed_seconds || 0),
    index: Math.min(a.current_index || 0, a.total - 1), marksPer: 1,
    questions: a.questions.map((q) => ({ id: q.id, stem: q.stem, options: q.options.map((o) => ({ id: o.id, text: o.text })), selected: q.selected_option_id || null, flagged: !!q.flagged, skipped: !!q.skipped })) };
  const ui = mountSim(root, model, {
    choose: (q, opt) => saveRemote(`ans:${q.id}`, () => api('PUT', `/api/attempts/${id}/answer`, { question_id: q.id, option_id: opt })).catch(failed),
    flag: (q, on) => saveRemote(`flag:${q.id}`, () => api('PUT', `/api/attempts/${id}/answer`, { question_id: q.id, flagged: on })).catch(failed),
    skip: (q, on) => saveRemote(`skip:${q.id}`, () => api('PUT', `/api/attempts/${id}/answer`, { question_id: q.id, skipped: on })).catch(failed),
    position: (i, el) => saveRemote('pos', () => api('PUT', `/api/attempts/${id}/position`, { index: i, elapsed_seconds: el })).catch(() => {}),
    finish: async (reason, el) => {
      try { await api('PUT', `/api/attempts/${id}/position`, { index: 0, elapsed_seconds: el }); } catch (_) { /* the time on the result only */ }
      try { await saveRemote('submit', () => api('POST', `/api/attempts/${id}/submit`)); } catch (e) { if (!(e && (e.code === 'already_submitted' || e.code === 'time_up'))) { toast(e.message || 'Could not submit the exam. Try again.', 'bad'); return; } }
      setTimeout(toResult, reason === 'time' ? 1200 : 0); },
  });
  onLeave(() => { ui.destroy(); lockPage(false); saveRemote('pos', () => api('PUT', `/api/attempts/${id}/position`, { index: 0, elapsed_seconds: ui.elapsed })).catch(() => {}); });
  return root;
}

export async function simResultPage(id) {
  const a = await api('GET', `/api/attempts/${id}`);
  if (a.status !== 'submitted') { location.hash = a.sim ? `#/sim/${id}` : `#/attempt/${id}`; return null; }
  const root = shell(); lockPage(true); onLeave(() => lockPage(false));
  renderResult(root, { title: a.quiz_title, course: '', total: a.total, totalMarks: a.total, obtained: a.score || 0 }, [
    { label: 'Review Answers', primary: true, id: 'qs-review', onclick: () => { location.hash = `#/attempt/${id}/result`; } },
    { label: 'Back to the quiz', id: 'qs-back', onclick: () => { location.hash = `#/quiz/${a.quiz_id}`; } },
  ], () => { location.hash = `#/quiz/${a.quiz_id}`; });
  return root;
}
