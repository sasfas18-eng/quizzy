/* Quizzy — shared browser stores: in-memory and IndexedDB (device-local). Interface: get(k) set(k,v) del(k) list(kind) [clear()]. */
(() => {
class Mem { constructor() { this.m = new Map(); } async get(k) { return this.m.has(k) ? JSON.parse(this.m.get(k)) : null; } async set(k, v) { this.m.set(k, JSON.stringify(v)); } async del(k) { this.m.delete(k); }
  async list(kind) { return [...this.m.values()].map((s) => JSON.parse(s)).filter((d) => d.kind === kind); } }
function idbStore(name = 'quizzy_local_v1') {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no indexedDB'));
    const rq = indexedDB.open(name, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const dbh = rq.result;
      const tx = (mode, fn) => new Promise((res, rej) => { const t = dbh.transaction('kv', mode); const out = fn(t.objectStore('kv')); t.oncomplete = () => res(out && 'result' in out ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      resolve({ get: (k) => tx('readonly', (s) => s.get(k)).then((v) => v || null), set: (k, v) => tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(v)), k)), del: (k) => tx('readwrite', (s) => s.delete(k)),
        list: (kind) => tx('readonly', (s) => s.getAll()).then((all) => (all || []).filter((d) => d && d.kind === kind)), clear: () => tx('readwrite', (s) => s.clear()) });
    };
  });
}

Mem.prototype.clear = async function () { this.m.clear(); };
window.QZ_STORES = { Mem, idbStore };
})();
