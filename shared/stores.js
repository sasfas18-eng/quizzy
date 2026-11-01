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
async function storageInfo() {
  try { if (!navigator.storage || !navigator.storage.estimate) return null; if (navigator.storage.persist && !storageInfo.asked) { storageInfo.asked = true; navigator.storage.persist().catch(() => {}); }
    const e = await navigator.storage.estimate(); return e && e.quota ? { usage: e.usage || 0, quota: e.quota } : null; } catch { return null; }
}
window.QZ_STORES = { Mem, idbStore, storageInfo, isStorageFull: isFull };
})();
