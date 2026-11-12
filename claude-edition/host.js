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
  const [db, user, sample, perms] = await Promise.all([use('db'), use('user'), use('sample'), use('permissions')]);      // permissions: built in (never declared)
  let uid = null; try { uid = user && user.id ? await user.id() : null; } catch { /* ignore */ }
  let owner = false; try { owner = !!(user && user.isOwner && (await user.isOwner())); } catch { /* not told: not the owner */ }      // the development track is the owner's page
  // WHO MAY SAVE HERE: on claude.ai a visitor who opens the shared link holds the `view` level - they read and write nothing, their own space included (every
  // save of theirs was refused: a student could not even upload a file). Their files and quizzes stay on their own device; the owner, an editor and a Contributor
  // save in the claude.ai store as before. Decided from what the platform says up front; a write it still refuses moves that visitor to the device (store()).
  let canWrite = null, editor = false; try { canWrite = user && user.can ? await user.can('data.write') : null; } catch { canWrite = null; }
  try { editor = !!(user && user.canEdit && (await user.canEdit())); } catch { /* not told */ }
  const signedIn = !!(db && uid && (owner || editor || canWrite === true));
  // A VISITOR OF SOMEONE ELSE'S PAGE HAS NO CLAUDE HERE: claude.ai runs the parts of a shared page that use Claude for its owner (and the owner's organization)
  // only - «the parts that use Claude don't work for them». A student can still have all of Quizzy: their own copy of the page (the copy is theirs, so Claude
  // works in it and their files are kept in their account). Known up front (no Claude offered, or its permission «unavailable»), and said plainly with the steps.
  let ps = null; try { ps = perms && sample && perms.state ? await perms.state('sample') : null; } catch { ps = null; }
  // (also a viewer the page has no identity for: claude.ai gives one only to the owner's organization and invited guests - a link visitor from outside it
  //  «sees the page without its live sections», Claude included)
  const needCopy = !owner && (!sample || ps === 'unavailable' || !uid);
  // the development track is the page author's, not every copy owner's: the author's page carries the mark (meta/dev in its own shared store; a copy starts without it)
  let devMark = false; if (owner && db) { try { const m = await db.doc('meta/dev').get(); devMark = !!(m && !(m.exists === false || (typeof m.exists === 'function' && !m.exists()))); } catch { devMark = false; } }
  PL = { db: signedIn ? db : null, shared: db || null, uid, sample, perms, signedIn, owner, needCopy, devOwner: owner && devMark, aiAvailable: !!sample && !needCopy,
    user: signedIn ? { id: uid, email: '', name: 'حسابي في Claude', role: 'student' } : { id: 'local', email: '', name: 'زائر (بياناتك على هذا الجهاز)', role: 'student' } };
  return PL;
}
// this browser gave the page no storage that lasts (it refused it, or never answered): the files and quizzes of this visit are kept in memory - and the student is told
// at once, on the banner, instead of finding everything gone after a reload
let VOLATILE = false;
const VOLATILE_TEXT = 'تنبيه: متصفحك لم يسمح لهذه الصفحة بالحفظ على جهازك الآن، فما ترفعه وتنشئه في هذه الزيارة لا يبقى بعد إغلاقها. حدّث الصفحة لتعود مساحة الحفظ، أو افتح الرابط في متصفح آخر.';
function volatile() { VOLATILE = true; const show = (n = 0) => { const b = document.getElementById('ce-banner'); if (!b) { if (n < 100) setTimeout(() => show(n + 1), 50); return; } b.textContent = VOLATILE_TEXT; b.style.display = ''; b.classList.add('warn'); }; show(); }
async function store() {
  if (STORE) return STORE;
  const p = await platform();
  if (!p.db) { try { STORE = await idbStore(); } catch { STORE = new Mem(); volatile(); } return STORE; }   // not signed in: this device only
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
  const cloud = {
    get: (k) => call(() => one.get(k)), set: (k, v) => call(() => one.set(k, v)), del: (k) => call(() => one.del(k)),
    async list(kind) { const s = await call(() => col.where('kind', '==', kind).get()); const docs = s && s.docs ? s.docs : Array.isArray(s) ? s : []; return docs.map((d) => data(d)).filter(Boolean); },
    async getMany(keys) { const out = {}; await each(keys, async (k) => { const v = await one.get(k); if (v) out[k] = v; }); return out; },
    async setMany(entries) { await each(entries, ([k, v]) => one.set(k, v)); },
    async delMany(keys) { await each(keys, (k) => one.del(k)); },
  };
  // a save the claude.ai store refuses for this viewer (their level writes nothing): from then on their data stays on this device, and that save is made there
  let local = null; const refused = (e) => !!e && (e.code === 'invalid_argument' || e.code === 'permission_denied' || e.code === 'not_granted');
  const toLocal = async () => { if (!local) { let x; try { x = await idbStore(); } catch { x = new Mem(); volatile(); } local = { ...x, get: x.get.bind(x), set: x.set.bind(x), del: x.del.bind(x), list: x.list.bind(x),
    getMany: async (keys) => { const out = {}; for (const k of keys) { const v = await x.get(k); if (v) out[k] = v; } return out; }, setMany: async (es) => { for (const [k, v] of es) await x.set(k, v); }, delMany: async (ks) => { for (const k of ks) await x.del(k); } };
    p.signedIn = false; p.db = null; p.user = { id: 'local', email: '', name: 'زائر (بياناتك على هذا الجهاز)', role: 'student' }; } return local; };
  const guard = (name, write) => async (...a) => { if (local) return local[name](...a); try { return await cloud[name](...a); } catch (e) { if (write && refused(e)) return (await toLocal())[name](...a); throw e; } };
  STORE = { get: guard('get'), set: guard('set', true), del: guard('del', true), list: guard('list'), getMany: guard('getMany'), setMany: guard('setMany', true), delMany: guard('delMany', true) };
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
/* THE VIEWER'S PERMISSION FOR CLAUDE: claude.ai asks it at the first request of a view, and that request WAITS while the viewer decides - a student who did not see
 * the dialog (a phone, another tab) saw a quiz that never moved. It is read without asking (`permissions`, built in): while a request waits on that dialog the
 * progress screen says «press Allow», and a student who declined is shown the way back (the Permissions panel) instead of a quiz that fails. */
let permState = null, answered = 0, asking = 0, lastAnswer = 0, offline = false, firstAsk = 0;      // firstAsk: when this view first asked Claude
async function claudePermission() { const p = await platform(); if (!p.perms || !p.sample) return null; try { permState = await p.perms.state('sample'); } catch { permState = null; } return permState; }
async function managePermission() { const p = await platform(); if (!p.perms || !p.perms.manage) throw Object.assign(new Error('افتح قائمة الأذونات (Permissions) لهذه الصفحة في claude.ai وفعّل Claude.'), { code: 'unavailable' });
  try { await p.perms.manage(); } catch (e) { throw Object.assign(new Error('تعذّر فتح لوحة الأذونات من هنا: افتح قائمة الأذونات (Permissions) لهذه الصفحة في claude.ai وفعّل Claude.'), { code: 'unavailable' }); } return claudePermission(); }
// NO CONNECTION (a phone between two networks): a request is not spent on it - the quiz waits for the connection to come back (the screen says so), then goes on
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const backOnline = (ms) => new Promise((r) => { if (isOnline()) { r(true); return; } offline = true; const done = (v) => { clearTimeout(t); window.removeEventListener('online', on); offline = false; r(v); }; const on = () => done(true); const t = setTimeout(() => done(false), ms); window.addEventListener('online', on); });
/* What claude.ai answers when Claude cannot be used at all in this view: said at once, in Arabic, and not asked again (asking again only meets the same answer).
 * The other failures keep their code; their message, which can reach the student, is Arabic too (claude.ai's own message is developer English). */
const FINAL = { session_expired: 'انتهت جلستك في claude.ai: سجّل الدخول من جديد، ثم أعد المحاولة.', sampling_disabled: 'Claude غير متاح لحسابك (أو لمؤسستك) الآن، فلا يمكن أن يكتب الأسئلة هنا.',
  not_declared: 'استخدام Claude غير متاح في هذه الصفحة الآن: حدّث الصفحة.', capability_disabled: 'استخدام Claude غير متاح في هذا العرض: افتح الرابط من تطبيق Claude أو من المتصفح وأنت مسجّل الدخول.',
  capability_removed: 'إصدار تطبيق Claude عندك لا يدعم ما تحتاجه هذه الصفحة: حدّث التطبيق، أو افتح الرابط في المتصفح.', invalid_request: 'طلب غير صالح إلى Claude.', transform_error: 'طلب غير صالح إلى Claude.', queue_overflow: 'طلبات كثيرة جدًا دفعة واحدة إلى Claude: حدّث الصفحة.' };
const AR_FAIL = { refused: 'امتنع Claude عن كتابة هذا الجزء.', empty_completion: 'لم يُرجع Claude نصًا.', invalid_json: 'جاء ردّ Claude بصيغة غير صالحة.', upstream_error: 'انقطع الاتصال بـClaude لحظةً.' };
const arFail = (e) => Object.assign(new Error((e && (AR_FAIL[e.code] || (e.code === 'cancelled' ? 'أُلغي الطلب.' : ''))) || (isOnline() ? 'تعذّر الوصول إلى Claude الآن.' : 'لا يوجد اتصال بالإنترنت.')), { code: (e && e.code) || 'llm_error', cause: e });
const SITE = 'https://sasfas18-eng.github.io/quizzy/';
const COPY_MSG = 'claude.ai لا يشغّل Claude داخل صفحة مشتركة إلا لصاحبها، وكويزي يكتب أسئلته بـClaude. الحل مرة واحدة: سجّل الدخول في claude.ai، ثم انسخ هذه الصفحة إلى حسابك (خيار النسخ في أعلى الصفحة)، وافتح نسختك: فيها تنشئ كويزاتك وتُحفظ ملفاتك في حسابك.';
const SIGNIN_MSG = 'كويزي هنا يكتب أسئلته بـClaude: افتح هذه الصفحة من داخل claude.ai (تطبيق Claude) وأنت مسجّل الدخول، ووافق على استخدام Claude عند الطلب.';
const COPY_BANNER = 'هذه صفحة للعرض: Claude يعمل في نسختك أنت. سجّل الدخول في claude.ai وانسخ كويزي إلى حسابك (مرة واحدة) لتنشئ كويزاتك.';
function copyBanner() { if (VOLATILE) return; const b = typeof document !== 'undefined' && document.getElementById('ce-banner'); if (b) { b.textContent = COPY_BANNER; b.style.display = ''; } }      // found at the first refusal: the banner says it at once
const needCopyErr = (cause) => Object.assign(new Error(COPY_MSG), { code: 'need_copy', cause });
const acquire = () => (gate.busy < gate.cap ? (gate.busy++, Promise.resolve()) : new Promise((r) => gate.q.push(r)));
const release = () => { gate.busy--; while (gate.busy < gate.cap && gate.q.length) { gate.busy++; gate.q.shift()(); } };
const llm = {
  async json(task, system, prompt) {
    const p = await platform(); if (p.needCopy) throw needCopyErr(); if (!p.sample) { const e = new Error('خدمة Claude غير متاحة: سجّل الدخول إلى claude.ai ووافق على الاستخدام.'); e.code = 'llm_not_configured'; throw e; }
    let last;
    if (quotaAt && Date.now() - quotaAt < 60000) throw quotaError();      // the quota was just reached by another request: do not queue behind it
    if (!answered && permState !== 'granted') claudePermission();      // (read again until a first answer: the screen says «press Allow» only while it is asked)
    let away = 0;      // waits for a lost connection (a request is not spent on them)
    for (let a = 0; a < 7; a++) {
      if (!isOnline() && away < 3) { away++; await backOnline(120000); }
      await acquire(); let limited = false; stats.calls++;
      const tc = Date.now(); asking++; if (!firstAsk) firstAsk = tc;
      try { const r = await p.sample.json(system + '\n\n' + prompt + '\n\nReturn ONLY one valid JSON value, no prose.', { modelTier: 'default', cache: false }); answered++; lastAnswer = Date.now(); permState = 'granted'; stats.log.push([task, Math.round(tc / 100) / 10, Math.round((Date.now() - tc) / 100) / 10]); if (stats.log.length > 400) stats.log.splice(0, 100); gate.before = null; ++gate.ok; if (gate.busy >= gate.cap && gate.cap < LANES && gate.ok >= (gate.cap < DEF_LANES ? 6 : 25)) { gate.cap++; learned = gate.cap; gate.ok = 0; remember(); } return r; }      // back to the measured limit after a few answers; beyond it, one more only after a long calm run
      catch (e) { last = e;
        // a visitor of someone else's page whom claude.ai gives no Claude (not a permission they declined - that one has its own way back): their own copy is the way
        if (e && !p.owner && ['capability_disabled', 'sampling_disabled', 'not_declared'].includes(e.code)) { p.needCopy = true; p.aiAvailable = false; copyBanner(); throw needCopyErr(e); }
        if (e && e.code === 'not_granted' && !p.owner && (await claudePermission()) !== 'denied') { p.needCopy = true; p.aiAvailable = false; copyBanner(); throw needCopyErr(e); }      // refused without the visitor declining anything: not theirs to allow here
        if (e && e.code === 'not_granted') { permState = 'denied'; throw e; }
        if (e && FINAL[e.code]) throw Object.assign(new Error(FINAL[e.code]), { code: e.code, cause: e });
        if (e && e.code === 'prompt_too_large') throw Object.assign(new Error('الطلب أطول مما يقرؤه Claude مرة واحدة.'), { code: 'too_large', cause: e });      // the engine writes it again in two halves
        if (e && (e.code === 'refused' || e.code === 'empty_completion')) throw arFail(e);      // the same request would get the same answer
        if (e && (e.code === 'quota' || QUOTA_RX.test(String(e.code || '') + ' ' + String(e.message || '')))) throw quotaError(e);
        if (e && e.code === 'rate_limited') { if (a >= 3) throw quotaError(e); limited = true; gate.ok = 0; if (gate.before == null) gate.before = gate.cap;
          if (gate.busy >= MIN_LANES) { gate.cap = Math.max(MIN_LANES, Math.min(gate.cap, gate.busy - 1)); learned = gate.cap; remember(); } }      // with fewer running, a refusal is a passing burst or the quota: wait, but learn nothing
        else if (!isOnline() && away < 3) { a--; continue; }      // the connection went: not an attempt - wait for it at the top of the loop
        else if (a >= 2) break; }
      finally { asking--; release(); }
      const ms = limited ? [2000, 5000, 12000][Math.min(a, 2)] : 1500;      // a refusal for too many at once passes quickly once fewer run: 2 s, 5 s, 12 s - then it is the quota (about 20 s in all)
      if (limited) { stats.waits++; stats.wait_ms += ms; waitNote = { until: Date.now() + ms }; }
      await sleep(ms); if (limited) waitNote = null;
    }
    throw arFail(last);
  },
};
/* THE SHARED FORMS PROFILE (the development track): one document in the artifact's shared store, written by the owner («حدّث للجميع» on #/dev) and read by every
 * viewer's quiz - so what the owner's quizzes taught the forms reaches every student at once, without a new version of the page. */
const SHARED_FORMS = 'forms/shared';
async function sharedGet(path) { const p = await platform(); if (!p.shared) return null; try { const s = await p.shared.doc(path).get(); const ok = s && !(s.exists === false || (typeof s.exists === 'function' && !s.exists())); return ok ? (typeof s.data === 'function' ? s.data() : s) : null; } catch { return null; } }
async function sharedSet(path, v) { const p = await platform(); if (!p.shared || !p.owner) throw Object.assign(new Error('للمالك فقط.'), { code: 'forbidden' }); await p.shared.doc(path).set(JSON.parse(JSON.stringify(v))); }
window.QZ_HOST = {
  sharedForms: { get: () => sharedGet(SHARED_FORMS), set: (v) => sharedSet(SHARED_FORMS, v) },
  waitState: () => (offline ? { kind: 'offline' } : waitNote && waitNote.until > Date.now() ? { kind: 'busy', seconds: Math.ceil((waitNote.until - Date.now()) / 1000) } : !answered && asking > 0 && (permState === 'prompt' || (permState == null && firstAsk && Date.now() - firstAsk > 15000)) ? { kind: 'consent', sure: permState === 'prompt' } : null),      // (a viewer that cannot tell: after 15 s without a first answer, said as a possibility)
  lastAnswerAt: () => lastAnswer, claudePermission, managePermission, isVolatile: () => VOLATILE,
  quotaSince: (t) => quotaAt >= t, llmStats: () => ({ ...stats, log: stats.log.slice() }),
  aiOnly: true,      /* every question, plan and analysis is Claude's: the local generator is not part of this edition */
  platform, store, llm, requireAuth: false, get concurrency() { return learned; }, analysisChunkChars: 2500,      /* the lecture analysed in parts of ~2500 characters side by side: the planner waits for the slowest part, not for one long answer */ generatorLabel: 'claude (sample)',
  get aiMissingMessage() { return PL && PL.needCopy ? COPY_MSG : SIGNIN_MSG; },
  devTrack: true,      // #/dev: the owner runs the corpus of study files (dist/corpus) through Claude until the forms have learned what they can (shared/api-core.js)
  printPdf: true,      // the quiz as paper (the owner's template): printed, or saved as a PDF file through claude.ai's `downloads` capability
  async capabilities(pl) { return { local: !pl.signedIn, edition: 'claude', claude_ok: !!pl.aiAvailable, need_copy: !!pl.needCopy, site_url: SITE, ai_missing: pl.needCopy ? COPY_MSG : SIGNIN_MSG, claude_permission: pl.sample && !pl.needCopy ? await claudePermission() : null }; },      // granted | prompt | denied (read without asking)
  // «السماح لـClaude»: the Permissions panel of claude.ai, the way back for a student who declined (asked only from that button)
  async handle(method, path) { if (path !== '/api/claude/permission' || method !== 'POST') return null;
    try { return { body: { state: await managePermission() } }; } catch (e) { return { status: 409, body: { code: e.code || 'unavailable', message: e.message } }; } },
  bannerText: (p) => (VOLATILE ? VOLATILE_TEXT : p.needCopy ? COPY_BANNER : p.signedIn ? 'نسخة Claude: يحلل Claude محاضرتك ويكتب أسئلتها ويفحصها بحسابك، وبياناتك محفوظة على حسابك. أبقِ الصفحة مفتوحة أثناء الإنشاء. الإدارة غير متاحة هنا.'
    : p.uid && p.aiAvailable ? 'نسخة Claude: يحلل Claude محاضرتك ويكتب أسئلتها ويفحصها بحسابك، وملفاتك وكويزاتك محفوظة على هذا الجهاز. أبقِ الصفحة مفتوحة أثناء الإنشاء.'      /* a visitor of the shared link: they save on their own device */
    : 'لم تسجّل الدخول في claude.ai: افتح الرابط من تطبيق Claude وأنت مسجّل الدخول، فـClaude هو من يكتب الأسئلة هنا. ملفاتك تبقى على هذا الجهاز حتى تسجّل الدخول.'),
};
})();
