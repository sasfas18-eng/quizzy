/* Quizzy — shared browser stores: in-memory and IndexedDB (device-local). Interface: get(k) set(k,v) del(k) list(kind) [clear()].
 *
 * Keys carry their kind as a prefix (doc_<id>, page_<id>_<n>, quiz_<id>, att_<id>, card_<id>, report_<id>), so list(kind) reads ONLY the rows of that kind (an IndexedDB key range).
 * It used to read the whole database and filter in JavaScript: with many quizzes every list (the Files page included) pulled all of them — and every page's text — into memory,
 * several times over on the home page, which is what made a phone choke after a while.
 * A write the browser refuses because the site's storage is full fails with a clear error (code 'storage_full'), never a bare DOMException. */
(() => {
const PREFIX = { doc: 'doc_', page: 'page_', quiz: 'quiz_', attempt: 'att_', card: 'card_', report: 'report_', acache: 'acache_' };
const isFull = (e) => !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || '')));
const fullError = (e) => Object.assign(new Error('storage_full'), { code: 'storage_full', cause: e });
class Mem { constructor() { this.m = new Map(); } async get(k) { return this.m.has(k) ? JSON.parse(this.m.get(k)) : null; } async set(k, v) { this.m.set(k, JSON.stringify(v)); } async del(k) { this.m.delete(k); }
  async list(kind) { const pre = PREFIX[kind]; const out = []; for (const [k, s] of this.m) { if (pre && !k.startsWith(pre)) continue; const d = JSON.parse(s); if (d && d.kind === kind) out.push(d); } return out; } }
function idbStore(name = 'quizzy_local_v1') {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no indexedDB'));
    const rq = indexedDB.open(name, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const dbh = rq.result;
      const tx =(mode, fn) => new Promise((res, rej) => {
        let t, out; const fail = (e) => rej(isFull(e) ? fullError(e) : e);
        try { t = dbh.transaction('kv', mode); out = fn(t.objectStore('kv')); } catch (e) { return fail(e); }
        t.oncomplete = () => res(out && 'result' in out ? out.result : undefined); t.onerror = () => fail(t.error || (out && out.error)); t.onabort = () => fail(t.error || (out && out.error));
      });
      const range = (kind) => (PREFIX[kind] ? IDBKeyRange.bound(PREFIX[kind], PREFIX[kind] + '￿') : undefined);
      resolve({ get: (k) => tx('readonly', (s) => s.get(k)).then((v) => v || null), set: (k, v) => tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(v)), k)), del: (k) => tx('readwrite', (s) => s.delete(k)),
        list: (kind) => tx('readonly', (s) => s.getAll(range(kind))).then((all) => (all || []).filter((d) => d && d.kind === kind)), clear: () => tx('readwrite', (s) => s.clear()) });
    };
  });
}

Mem.prototype.clear = async function () { this.m.clear(); };
/** How much of the site's storage this browser lets it use: { usage, quota } in bytes, or null when the browser does not say. Also asks (once, quietly) that the data be kept even when the disk is nearly full. */
// Space freed in Cache Storage is given back by the browser at once, but Chrome keeps COUNTING it in estimate() until it is closed and opened
// again (measured: 22.6 MB still counted after the delete and a reload, 0.1 MB after a restart). Where the browser itemises its count
// (usageDetails), the caches it still counts beyond the caches that really exist are left out of the number shown, and `pending` says how much.
async function cachesBytes() {
  let n = 0;
  for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) { const res = await c.match(r); n += (res && +res.headers.get('content-length')) || (res ? (await res.clone().blob()).size : 0); } }
  return n;
}
async function storageInfo() {
  try { if (!navigator.storage || !navigator.storage.estimate) return null; if (navigator.storage.persist && !storageInfo.asked) { storageInfo.asked = true; navigator.storage.persist().catch(() => {}); }
    const e = await navigator.storage.estimate(); if (!e || !e.quota) return null;
    let pending = 0;
    try { const counted = e.usageDetails && e.usageDetails.caches; if (counted && window.caches) { const lag = counted - (await cachesBytes()); if (lag > 1048576) pending = Math.min(lag, e.usage || 0); } } catch { /* not itemised here */ }
    return pending ? { usage: (e.usage || 0) - pending, quota: e.quota, pending } : { usage: e.usage || 0, quota: e.quota }; } catch { return null; }
}
// The tools the site downloads ONCE and keeps for every quiz - not the student's data, so deleting files does not touch them:
// the composer's open model (transformers.js keeps it in the Cache Storage «transformers-cache») and the data for reading pages that are
// pictures (tesseract.js keeps it in the IndexedDB «keyval-store»). toolsInfo() says how big they are; clearTools() frees them - they come
// back by themselves the next time they are needed.
const TOOL_CACHE = 'transformers-cache', TOOL_DB = 'keyval-store', TOOL_STORE = 'keyval', TOOL_FLAGS = ['qz_semantic_ok_v1'];
const sizeOf = (v) => (v == null ? 0 : v.byteLength != null ? v.byteLength : v.size != null ? v.size : typeof v === 'string' ? v.length : 0);
function withToolDb(fn) {      // opened only if it exists: opening a missing database would create an empty one the reading library could not use
  return new Promise((res) => {
    if (!window.indexedDB || !indexedDB.databases) return res(null);
    indexedDB.databases().then((all) => {
      if (!all.some((d) => d.name === TOOL_DB)) return res(null);
      const rq = indexedDB.open(TOOL_DB); rq.onerror = () => res(null);
      rq.onsuccess = () => { const db = rq.result; if (!db.objectStoreNames.contains(TOOL_STORE)) { db.close(); return res(null); } fn(db, (v) => { db.close(); res(v); }); };
    }, () => res(null));
  });
}
async function toolsInfo() {
  let model = 0, reading = 0;
  try { if (window.caches && (await caches.has(TOOL_CACHE))) { const c = await caches.open(TOOL_CACHE); for (const r of await c.keys()) { const res = await c.match(r); model += (res && +res.headers.get('content-length')) || (res ? (await res.clone().blob()).size : 0); } } } catch { /* not readable here */ }
  try { reading = (await withToolDb((db, done) => { const rq = db.transaction(TOOL_STORE, 'readonly').objectStore(TOOL_STORE).getAll(); rq.onsuccess = () => done((rq.result || []).reduce((a, v) => a + sizeOf(v), 0)); rq.onerror = () => done(0); })) || 0; } catch { /* not readable here */ }
  return { model, reading };
}
async function clearTools() {
  const before = await toolsInfo();
  try { if (window.caches) await caches.delete(TOOL_CACHE); } catch { /* nothing to free */ }
  try { await withToolDb((db, done) => { const t = db.transaction(TOOL_STORE, 'readwrite'); t.objectStore(TOOL_STORE).clear(); t.oncomplete = () => done(true); t.onerror = () => done(false); }); } catch { /* nothing to free */ }
  TOOL_FLAGS.forEach((k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } });      // «downloaded on this device» is no longer true
  const bytes = before.model + before.reading;
  return bytes;
}
window.QZ_STORES = { Mem, idbStore, storageInfo, toolsInfo, clearTools, isStorageFull: isFull };
})();
