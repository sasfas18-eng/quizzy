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
const llm = {
  async json(task, system, prompt) {
    const p = await platform(); if (!p.sample) { const e = new Error('خدمة Claude غير متاحة: سجّل الدخول إلى claude.ai ووافق على الاستخدام.'); e.code = 'llm_not_configured'; throw e; }
    let last;
    for (let a = 0; a < 7; a++) {
      try { return await p.sample.json(system + '\n\n' + prompt + '\n\nReturn ONLY one valid JSON value, no prose.', { modelTier: 'default', cache: false }); }
      catch (e) { last = e; if (e && e.code === 'not_granted') throw e;
        if (e && e.code === 'rate_limited') { await sleep(Math.min(90, 8 * 2 ** a) * 1000); continue; }   // wait, never hammer
        if (a >= 2) break; await sleep(1500); }
    }
    throw new Error((last && last.message) || 'فشل استدعاء Claude');
  },
};
// an artifact cannot serve .gz files: the OCR language data ships as .js (base64) and reaches the OCR worker through a bridge (shared/reader.js)
window.QZ_OCR = { langJs: { eng: 'vendor/tesseract/lang/eng.js', ara: 'vendor/tesseract/lang/ara.js' } };
window.QZ_HOST = {
  platform, store, llm, requireAuth: false, concurrency: 3, generatorLabel: 'claude (sample)',
  aiMissingMessage: 'التوليد يحتاج Claude: افتح هذه الصفحة من داخل claude.ai (تطبيق Claude) وأنت مسجّل الدخول، ووافق على استخدام Claude عند الطلب.',
  pdfMessage: 'تنزيل PDF غير متاح في نسخة Claude؛ يتوفر في النسخة ذات الخادم.',
  async capabilities(pl) { return { local: !pl.signedIn, edition: 'claude' }; },
  bannerText: (p) => (p.signedIn ? 'نسخة Claude: يعمل التوليد عبر Claude بحسابك، وبياناتك محفوظة على حسابك. أبقِ الصفحة مفتوحة أثناء التوليد. تنزيل PDF والإدارة غير متاحين هنا.'
    : 'لم تسجّل الدخول في claude.ai، فالتوليد غير متاح الآن وتُحفظ بياناتك على هذا الجهاز فقط. افتح الرابط من تطبيق Claude وأنت مسجّل الدخول.'),
};
})();
