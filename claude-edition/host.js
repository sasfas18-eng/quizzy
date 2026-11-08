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
const LANES = 8; const gate = { cap: LANES, busy: 0, ok: 0, q: [] };
/* The viewer's Claude USAGE LIMIT. claude.ai answers "too many" both for a short burst and when the account's quota is used up. A burst passes in seconds; a used-up quota
 * does not - waiting minutes for it (7 retries, up to 90 s each) only looked like a lecture that never finished. So: a reply that names the quota/limit, or a THIRD "too many"
 * in a row for the same request (about 25 s of waiting), is treated as the quota: every request stops at once (the other lanes too, for a minute), the student is told
 * plainly, and the quiz is completed from the lecture's own text. The short waits before that are shown on the progress screen. */
const QUOTA_RX = /quota|usage[_ ]?limit|limit[_ ]?(reached|exceeded)|exceeded|exhausted|out of (credits|messages|usage)|insufficient|billing/i;
let quotaAt = 0, waitNote = null; const stats = { calls: 0, waits: 0, wait_ms: 0 };
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
      try { const r = await p.sample.json(system + '\n\n' + prompt + '\n\nReturn ONLY one valid JSON value, no prose.', { modelTier: 'default', cache: false }); if (++gate.ok >= 4 && gate.cap < LANES) { gate.cap++; gate.ok = 0; } return r; }
      catch (e) { last = e; if (e && e.code === 'not_granted') throw e;
        if (e && (e.code === 'quota' || QUOTA_RX.test(String(e.code || '') + ' ' + String(e.message || '')))) throw quotaError(e);
        if (e && e.code === 'rate_limited') { if (a >= 2) throw quotaError(e); limited = true; gate.ok = 0; gate.cap = Math.max(1, Math.floor(gate.cap / 2)); }
        else if (a >= 2) break; }
      finally { release(); }
      const ms = limited ? 8000 * 2 ** a : 1500;      // wait (outside the gate), never hammer: 8 s, then 16 s
      if (limited) { stats.waits++; stats.wait_ms += ms; waitNote = { until: Date.now() + ms }; }
      await sleep(ms); if (limited) waitNote = null;
    }
    throw new Error((last && last.message) || 'فشل استدعاء Claude');
  },
};
window.QZ_HOST = {
  waitState: () => (waitNote && waitNote.until > Date.now() ? { kind: 'busy', seconds: Math.ceil((waitNote.until - Date.now()) / 1000) } : null),
  quotaSince: (t) => quotaAt >= t, llmStats: () => ({ ...stats }),
  platform, store, llm, requireAuth: false, concurrency: 8, generatorLabel: 'claude (sample)',
  aiMissingMessage: 'التوليد بالذكاء الاصطناعي يحتاج Claude: افتح هذه الصفحة من داخل claude.ai (تطبيق Claude) وأنت مسجّل الدخول، ووافق على استخدام Claude عند الطلب. ويمكنك الآن الإنشاء بلا ذكاء اصطناعي.',
  pdfMessage: 'تنزيل PDF غير متاح في نسخة Claude؛ يتوفر في النسخة ذات الخادم.',
  async capabilities(pl) { return { local: !pl.signedIn, edition: 'claude' }; },
  bannerText: (p) => (p.signedIn ? 'نسخة Claude: يعمل التوليد عبر Claude بحسابك (أو محليًا بلا ذكاء اصطناعي من «خيارات إضافية»)، وبياناتك محفوظة على حسابك. أبقِ الصفحة مفتوحة أثناء التوليد. تنزيل PDF والإدارة غير متاحين هنا.'
    : 'لم تسجّل الدخول في claude.ai: يعمل الإنشاء محليًا بلا ذكاء اصطناعي وبياناتك على هذا الجهاز فقط. افتح الرابط من تطبيق Claude وأنت مسجّل الدخول لتوليد أذكى وحفظ على حسابك.'),
};
})();
