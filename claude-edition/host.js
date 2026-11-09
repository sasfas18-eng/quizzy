/* Quizzy · Claude edition host: claude.ai `db` (per-person), `sample` (the viewer's Claude), `user`. Falls back to device-local mode. */
(() => {
const { Mem, idbStore } = window.QZ_STORES; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PL = null, STORE = null;
// at most POOL store calls at once over the whole page (the store refuses «too many concurrent writes»); the rest wait their turn, in order
const POOL = 6; let busy = 0; const waiting = [];
const lane = async (f) => { if (busy >= POOL) await new Promise((r) => waiting.push(r)); busy++; try { return await f(); } finally { busy--; const n = waiting.shift(); if (n) n(); } };
async function platform() {
  if (PL) return PL;
  const c = window.claude; const use = async (n) => { try { return c && c.use ? await c.use(n) : null; } catch { return null; } };
  const [db, user, sample] = await Promise.all([use('db'), use('user'), use('sample')]);
  let uid = null; try { uid = user && user.id ? await user.id() : null; } catch { /* ignore */ }
  let owner = false; try { owner = !!(user && user.isOwner && (await user.isOwner())); } catch { /* not told: not the owner */ }      // the development track is the owner's page
  const signedIn = !!(db && uid);
  PL = { db: signedIn ? db : null, uid, sample, signedIn, owner, aiAvailable: !!sample,
    user: signedIn ? { id: uid, email: '', name: 'حسابي في Claude', role: 'student' } : { id: 'local', email: '', name: 'زائر (بياناتك على هذا الجهاز)', role: 'student' } };
  return PL;
}
async function store() {
  if (STORE) return STORE;
  const p = await platform();
  if (!p.db) { try { STORE = await idbStore(); } catch { STORE = new Mem(); } return STORE; }   // not signed in: this device only
  const col = p.db.collection('data/users/' + p.uid), data = (s) => (s && typeof s.data === 'function' ? s.data() : s) || null;
  // The claude.ai store answers every call over the network. Many documents (a lecture's pages, a quiz and its attempts) are read, written and deleted SIDE BY
  // SIDE - at most POOL calls at once over the whole page, as it refuses «too many concurrent writes» - and a call refused for that, or by a passing hiccup, is
  // tried again after a short pause. (A 40-slide file was 41 calls one after the other: 9 s to upload, 9 s to delete.)
  const one = {
    async get(k) { const s = await col.doc(k).get(); return s && (s.exists === false || (typeof s.exists === 'function' && !s.exists())) ? null : data(s); },
    async set(k, v) { try { await col.doc(k).set(JSON.parse(JSON.stringify(v))); } catch (e) { if (e && e.code === 'quota_exceeded') { const f = new Error('storage full'); f.code = 'storage_full'; throw f; } throw e; } },
    async del(k) { await col.doc(k).delete(); },
  };
  const call = (f) => lane(async () => { for (let a = 0; ; a++) { try { return await f(); } catch (e) { if (a >= 4 || !(e && (e.code === 'resource_exhausted' || e.code === 'unavailable'))) throw e; await sleep(250 * 2 ** a + Math.random() * 250); } } });
  const each = (items, f) => Promise.all(items.map((x) => call(() => f(x))));
  STORE = {
    get: (k) => call(() => one.get(k)), set: (k, v) => call(() => one.set(k, v)), del: (k) => call(() => one.del(k)),
    async list(kind) { const s = await call(() => col.where('kind', '==', kind).get()); const docs = s && s.docs ? s.docs : Array.isArray(s) ? s : []; return docs.map((d) => data(d)).filter(Boolean); },
    async getMany(keys) { const out = {}; await each(keys, async (k) => { const v = await one.get(k); if (v) out[k] = v; }); return out; },
    async setMany(entries) { await each(entries, ([k, v]) => one.set(k, v)); },
    async delMany(keys) { await each(keys, (k) => one.del(k)); },
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
/* ...but a refusal is a LIMIT ONLY when several were running. When the account's quota runs out, Claude refuses even a single request - and the gate used to "learn"
 * from that that the account takes one request at a time, kept it on the device, and every later quiz ran its 50 requests one after another (a real 30-question quiz:
 * 331 s, each request 4-11 s). So: a refusal teaches a limit only with MIN_LANES or more running, the gate never goes below MIN_LANES, it climbs back to the measured
 * limit after a few answers, refusals that turn out to be the quota leave the limit as it was, and a number kept by the earlier gate below MIN_LANES is forgotten. */
const LANES_KEY = 'qz_claude_lanes_v3', DEF_LANES = 7, MIN_LANES = 3;      // DEF_LANES: the limit measured on a real account (7 at once)
let learned = (() => { try { const v = +localStorage.getItem(LANES_KEY); if (v >= MIN_LANES && v <= LANES) return v; const old = +localStorage.getItem('qz_claude_lanes_v2'); return old >= MIN_LANES && old <= LANES ? old : DEF_LANES; } catch { return DEF_LANES; } })();
const remember = () => { try { localStorage.setItem(LANES_KEY, String(learned)); } catch { /* private mode */ } };
const gate = { cap: learned, busy: 0, ok: 0, q: [], before: null };      // before: the limit when the current run of refusals began (given back if they were the quota)
/* The viewer's Claude USAGE LIMIT. claude.ai answers "too many" both for a short burst and when the account's quota is used up. A burst passes in seconds; a used-up quota
 * does not - waiting minutes for it (7 retries, up to 90 s each) only looked like a lecture that never finished. So: a reply that names the quota/limit, or a THIRD "too many"
 * in a row for the same request (about 25 s of waiting), is treated as the quota: every request stops at once (the other lanes too, for a minute), the student is told
 * plainly, and the quiz is completed from the lecture's own text. The short waits before that are shown on the progress screen. */
const QUOTA_RX = /quota|usage[_ ]?limit|limit[_ ]?(reached|exceeded)|exceeded|exhausted|out of (credits|messages|usage)|insufficient|billing/i;
let quotaAt = 0, waitNote = null; const stats = { calls: 0, waits: 0, wait_ms: 0, log: [] };      // log: [task, start s, seconds] of every answered request (the quiz's own report keeps its part)
function quotaError(cause) { quotaAt = Date.now(); if (gate.before != null) { gate.cap = learned = Math.max(gate.before, MIN_LANES); gate.before = null; remember(); }      // those refusals were the quota, not a limit
  const e = new Error('نفدت حصة Claude في حسابك الآن (أو بلغت حد الاستخدام المؤقت).'); e.code = 'quota'; e.cause = cause; return e; }
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
      try { const r = await p.sample.json(system + '\n\n' + prompt + '\n\nReturn ONLY one valid JSON value, no prose.', { modelTier: 'default', cache: false }); stats.log.push([task, Math.round(tc / 100) / 10, Math.round((Date.now() - tc) / 100) / 10]); if (stats.log.length > 400) stats.log.splice(0, 100); gate.before = null; ++gate.ok; if (gate.busy >= gate.cap && gate.cap < LANES && gate.ok >= (gate.cap < DEF_LANES ? 6 : 25)) { gate.cap++; learned = gate.cap; gate.ok = 0; remember(); } return r; }      // back to the measured limit after a few answers; beyond it, one more only after a long calm run
      catch (e) { last = e; if (e && e.code === 'not_granted') throw e;
        if (e && (e.code === 'quota' || QUOTA_RX.test(String(e.code || '') + ' ' + String(e.message || '')))) throw quotaError(e);
        if (e && e.code === 'rate_limited') { if (a >= 3) throw quotaError(e); limited = true; gate.ok = 0; if (gate.before == null) gate.before = gate.cap;
          if (gate.busy >= MIN_LANES) { gate.cap = Math.max(MIN_LANES, Math.min(gate.cap, gate.busy - 1)); learned = gate.cap; remember(); } }      // with fewer running, a refusal is a passing burst or the quota: wait, but learn nothing
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
  devTrack: true,      // #/dev: the owner runs the corpus of study files (dist/corpus) through Claude until the forms have learned what they can (shared/api-core.js)
  printPdf: true,      // the quiz as paper (the owner's template): printed, or saved as a PDF file through claude.ai's `downloads` capability
  async capabilities(pl) { return { local: !pl.signedIn, edition: 'claude' }; },
  bannerText: (p) => (p.signedIn ? 'نسخة Claude: يحلل Claude محاضرتك ويكتب أسئلتها ويفحصها بحسابك، وبياناتك محفوظة على حسابك. أبقِ الصفحة مفتوحة أثناء الإنشاء. الإدارة غير متاحة هنا.'
    : 'لم تسجّل الدخول في claude.ai: افتح الرابط من تطبيق Claude وأنت مسجّل الدخول، فـClaude هو من يكتب الأسئلة هنا. ملفاتك تبقى على هذا الجهاز حتى تسجّل الدخول.'),
};
})();
