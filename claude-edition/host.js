/* Quizzy · Claude edition host: claude.ai `db` (per-person), `sample` (the viewer's Claude), `user`. Falls back to device-local mode. */
(() => {
const { Mem, idbStore } = window.QZ_STORES; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PL = null, STORE = null;
async function platform() {
  if (PL) return PL;
  const c = window.claude; const use = async (n) => { try { return c && c.use ? await c.use(n) : null; } catch { return null; } };
  const [db, user, sample] = await Promise.all([use('db'), use('user'), use('sample')]);
  let uid = null; try { uid = user && user.id ? await user.id() : null; } catch { /* ignore */ }
  const signedIn = !!(db && uid);
  PL = { db: signedIn ? db : null, uid, sample, signedIn, aiAvailable: !!sample,
    user: signedIn ? { id: uid, email: '', name: 'حسابي في Claude', role: 'student' } : { id: 'local', email: '', name: 'زائر (بياناتك على هذا الجهاز)', role: 'student' } };
  return PL;
}
async function store() {
  if (STORE) return STORE;
  const p = await platform();
  if (!p.db) { try { STORE = await idbStore(); } catch { STORE = new Mem(); } return STORE; }   // not signed in: this device only
  const col = p.db.collection('data/users/' + p.uid), data = (s) => (s && typeof s.data === 'function' ? s.data() : s) || null;
  STORE = {
    async get(k) { const s = await col.doc(k).get(); return s && (s.exists === false || (typeof s.exists === 'function' && !s.exists())) ? null : data(s); },
    async set(k, v) { await col.doc(k).set(JSON.parse(JSON.stringify(v))); },
    async del(k) { await col.doc(k).delete(); },
    async list(kind) { const s = await col.where('kind', '==', kind).get(); const docs = s && s.docs ? s.docs : Array.isArray(s) ? s : []; return docs.map((d) => data(d)).filter(Boolean); },
  };
  return STORE;
}
/* An ADAPTIVE gate in front of the viewer's Claude: up to LANES requests at once (the quiz is written in many small batches side by side instead of a few long ones);
 * when Claude says "too many" the gate halves itself at once and then grows back by one after a run of answers - so the viewer's account is never hammered, and a
 * quiz goes as fast as that account allows. The requests and their content are unchanged: only how many wait their turn. */
const LANES = 12;
/* The viewer's account has its OWN limit of requests at once (measured on a real account: 92 requests and 302 s for 30 questions, most of them refused and waited
 * for). So the gate LEARNS it: when Claude refuses, the number that was running minus one is what this account takes; the gate stays there (no more refusals,
 * no 8-16 s waits), and the quiz is written in fewer, larger batches to match. The learned number is kept on this device for the next quizzes; after a long
 * run of answers it tries one more, and steps back if refused. */
const LANES_KEY = 'qz_claude_lanes_v2';
// a number kept by the earlier gate (at most 8): 8 was only its ceiling (try the new one); below 8 the account really refused more, so that is kept
let learned = (() => { try { const v = +localStorage.getItem(LANES_KEY); if (v >= 1 && v <= LANES) return v; const old = +localStorage.getItem('qz_claude_lanes_v1'); return old >= 1 && old < 8 ? old : LANES; } catch { return LANES; } })();
const remember = () => { try { localStorage.setItem(LANES_KEY, String(learned)); } catch { /* private mode */ } };
const gate = { cap: learned, busy: 0, ok: 0, q: [] };
/* The viewer's Claude USAGE LIMIT. claude.ai answers "too many" both for a short burst and when the account's quota is used up. A burst passes in seconds; a used-up quota
 * does not - waiting minutes for it (7 retries, up to 90 s each) only looked like a lecture that never finished. So: a reply that names the quota/limit, or a THIRD "too many"
 * in a row for the same request (about 25 s of waiting), is treated as the quota: every request stops at once (the other lanes too, for a minute), the student is told
 * plainly, and the quiz is completed from the lecture's own text. The short waits before that are shown on the progress screen. */
const QUOTA_RX = /quota|usage[_ ]?limit|limit[_ ]?(reached|exceeded)|exceeded|exhausted|out of (credits|messages|usage)|insufficient|billing/i;
let quotaAt = 0, waitNote = null; const stats = { calls: 0, waits: 0, wait_ms: 0, log: [] };      // log: [task, start s, seconds] of every answered request (the quiz's own report keeps its part)
function quotaError(cause) { quotaAt = Date.now(); const e = new Error('نفدت حصة Claude في حسابك الآن (أو بلغت حد الاستخدام المؤقت).'); e.code = 'quota'; e.cause = cause; return e; }
const acquire = () => (gate.busy < gate.cap ? (gate.busy++, Promise.resolve()) : new Promise((r) => gate.q.push(r)));
const release = () => { gate.busy--; while (gate.busy < gate.cap && gate.q.length) { gate.busy++; gate.q.shift()(); } };
const llm = {
  async json(task, system, prompt) {
    const p = await platform(); if (!p.sample) { const e = new Error('خدمة Claude غير متاحة: سجّل الدخول إلى claude.ai ووافق على الاستخدام.'); e.code = 'llm_not_configured'; throw e; }
    let last;
    if (quotaAt && Date.now() - quotaAt < 60000) throw quotaError();      // the quota was just reached by another request: do not queue behind it
    for (let a = 0; a < 7; a++) {
      await acquire(); let limited = false; stats.calls++;
      const tc = Date.now();
      try { const r = await p.sample.json(system + '\n\n' + prompt + '\n\nReturn ONLY one valid JSON value, no prose.', { modelTier: 'default', cache: false }); stats.log.push([task, Math.round(tc / 100) / 10, Math.round((Date.now() - tc) / 100) / 10]); if (stats.log.length > 400) stats.log.splice(0, 100); if (++gate.ok >= 25 && gate.busy >= gate.cap && gate.cap < LANES) { gate.cap++; learned = gate.cap; gate.ok = 0; remember(); } return r; }      // probe one more only when the gate was full and calm for a long run
      catch (e) { last = e; if (e && e.code === 'not_granted') throw e;
        if (e && (e.code === 'quota' || QUOTA_RX.test(String(e.code || '') + ' ' + String(e.message || '')))) throw quotaError(e);
        if (e && e.code === 'rate_limited') { if (a >= 3) throw quotaError(e); limited = true; gate.ok = 0; gate.cap = Math.max(1, Math.min(gate.cap, gate.busy - 1)); learned = gate.cap; remember(); }
        else if (a >= 2) break; }
      finally { release(); }
      const ms = limited ? [2000, 5000, 12000][Math.min(a, 2)] : 1500;      // a refusal for too many at once passes quickly once fewer run: 2 s, 5 s, 12 s - then it is the quota (about 20 s in all)
      if (limited) { stats.waits++; stats.wait_ms += ms; waitNote = { until: Date.now() + ms }; }
      await sleep(ms); if (limited) waitNote = null;
    }
    throw new Error((last && last.message) || 'فشل استدعاء Claude');
  },
};
window.QZ_HOST = {
  waitState: () => (waitNote && waitNote.until > Date.now() ? { kind: 'busy', seconds: Math.ceil((waitNote.until - Date.now()) / 1000) } : null),
  quotaSince: (t) => quotaAt >= t, llmStats: () => ({ ...stats, log: stats.log.slice() }),
  aiOnly: true,      /* every question, plan and analysis is Claude's: the local generator is not part of this edition */
  platform, store, llm, requireAuth: false, get concurrency() { return learned; }, analysisChunkChars: 2500,      /* the lecture analysed in parts of ~2500 characters side by side: the planner waits for the slowest part, not for one long answer */ generatorLabel: 'claude (sample)',
  aiMissingMessage: 'كويزي هنا يكتب أسئلته بـClaude: افتح هذه الصفحة من داخل claude.ai (تطبيق Claude) وأنت مسجّل الدخول، ووافق على استخدام Claude عند الطلب.',
  printPdf: true,      // the quiz as paper (the owner's template): printed, or saved as a PDF file through claude.ai's `downloads` capability
  async capabilities(pl) { return { local: !pl.signedIn, edition: 'claude' }; },
  bannerText: (p) => (p.signedIn ? 'نسخة Claude: يحلل Claude محاضرتك ويكتب أسئلتها ويفحصها بحسابك، وبياناتك محفوظة على حسابك. أبقِ الصفحة مفتوحة أثناء الإنشاء. الإدارة غير متاحة هنا.'
    : 'لم تسجّل الدخول في claude.ai: افتح الرابط من تطبيق Claude وأنت مسجّل الدخول، فـClaude هو من يكتب الأسئلة هنا. ملفاتك تبقى على هذا الجهاز حتى تسجّل الدخول.'),
};
})();
