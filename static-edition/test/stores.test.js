// node static-edition/test/stores.test.js — the device stores (shared/stores.js) against a minimal fake IndexedDB:
//  1) list(kind) reads ONLY the rows of that kind (a key range), never the whole database — with many quizzes the Files page used to pull every quiz and every page into memory;
//  2) a write the browser refuses because the site's storage is full (thrown at once, or reported when the transaction ends) becomes a clear error with code 'storage_full';
//  3) the in-memory store lists exactly the same rows.
const assert = require('assert');

function fakeIndexedDB() {
  const data = new Map(); const log = { getAll: [] }; const mode = { fail: null };
  const quota = () => Object.assign(new Error('The current transaction exceeded its quota limitations.'), { name: 'QuotaExceededError', code: 22 });
  const db = { createObjectStore() {}, transaction(_name, kind) {
    const t = { error: null, oncomplete: null, onerror: null, onabort: null };
    const done = () => setTimeout(() => { if (t.failed) return; t.oncomplete && t.oncomplete(); }, 0);
    const req = (result) => { const r = { result, error: null }; done(); return r; };
    t.objectStore = () => ({
      get: (k) => req(data.get(k)),
      put: (v, k) => { if (mode.fail === 'throw') throw quota(); if (mode.fail === 'abort') { t.failed = true; t.error = quota(); setTimeout(() => t.onabort && t.onabort(), 0); return { result: undefined, error: t.error }; } data.set(k, v); return req(k); },
      delete: (k) => { data.delete(k); return req(undefined); },
      clear: () => { data.clear(); return req(undefined); },
      getAll: (range) => { log.getAll.push(range ? { lo: range.lo, hi: range.hi } : null); return req([...data].filter(([k]) => !range || (k >= range.lo && k <= range.hi)).map(([, v]) => v)); },
    });
    return t;
  } };
  const indexedDB = { open() { const rq = { result: db }; setTimeout(() => { rq.onupgradeneeded && rq.onupgradeneeded(); rq.onsuccess && rq.onsuccess(); }, 0); return rq; } };
  return { indexedDB, data, log, mode };
}

(async () => {
  const fake = fakeIndexedDB();
  global.window = { indexedDB: fake.indexedDB }; global.indexedDB = fake.indexedDB; global.IDBKeyRange = { bound: (lo, hi) => ({ lo, hi }) };
  require('../../shared/stores.js'); const { Mem, idbStore, storageInfo, isStorageFull } = window.QZ_STORES;
  const seed = async (st) => { for (let i = 0; i < 30; i++) { await st.set('quiz_q' + i, { kind: 'quiz', id: 'q' + i }); await st.set('page_d1_' + i, { kind: 'page', doc: 'd1', page_no: i, text: 'x' }); }
    await st.set('doc_d1', { kind: 'doc', id: 'd1' }); await st.set('doc_d2', { kind: 'doc', id: 'd2' }); await st.set('att_a1', { kind: 'attempt', id: 'a1' }); await st.set('card_c1', { kind: 'card', id: 'c1' }); await st.set('report_r1', { kind: 'report', id: 'r1' }); };

  // ---- 1) key ranges
  const st = await idbStore('t'); await seed(st); fake.log.getAll.length = 0;
  const docs = await st.list('doc'); assert.deepStrictEqual(docs.map((d) => d.id).sort(), ['d1', 'd2']);
  assert.deepStrictEqual(fake.log.getAll, [{ lo: 'doc_', hi: 'doc_￿' }], 'listing the documents reads only the doc_ rows (not the 30 quizzes, not the pages)');
  fake.log.getAll.length = 0; assert.strictEqual((await st.list('quiz')).length, 30); assert.deepStrictEqual(fake.log.getAll, [{ lo: 'quiz_', hi: 'quiz_￿' }]);
  for (const [kind, n] of [['attempt', 1], ['card', 1], ['report', 1], ['page', 30]]) assert.strictEqual((await st.list(kind)).length, n, kind);
  assert.deepStrictEqual((await st.list('nothing')), [], 'an unknown kind finds nothing'); assert(fake.log.getAll.every((r) => r === null || r.lo), 'known kinds always use a range');
  assert.strictEqual((await st.get('doc_d1')).id, 'd1'); assert.strictEqual(await st.get('doc_missing'), null);
  await st.del('doc_d2'); assert.strictEqual((await st.list('doc')).length, 1); await st.clear(); assert.strictEqual((await st.list('quiz')).length, 0);
  console.log('ok   1) list(kind) = one key range per kind (doc_ -> only documents), get/del/clear unchanged');

  // ---- 2) storage full
  fake.mode.fail = 'throw';
  await assert.rejects(() => st.set('doc_x', { kind: 'doc', id: 'x' }), (e) => e.code === 'storage_full' && e.message === 'storage_full' && isStorageFull(e.cause));
  fake.mode.fail = 'abort';
  await assert.rejects(() => st.set('doc_y', { kind: 'doc', id: 'y' }), (e) => e.code === 'storage_full', 'a quota error reported when the transaction ends is the same clear error');
  fake.mode.fail = null; await st.set('doc_z', { kind: 'doc', id: 'z' }); assert.strictEqual((await st.list('doc')).length, 1, 'after the failure the store still works, and nothing half-written is left');
  assert(!isStorageFull(new Error('boom')) && isStorageFull({ name: 'QuotaExceededError' }) && isStorageFull({ message: 'Quota exceeded' }));
  console.log('ok   2) a refused write (thrown or at commit) is a clear storage_full error; the store keeps working');

  // ---- 3) the in-memory store lists the same rows
  const mem = new Mem(); await seed(mem);
  assert.deepStrictEqual((await mem.list('doc')).map((d) => d.id).sort(), ['d1', 'd2']); assert.strictEqual((await mem.list('quiz')).length, 30); assert.strictEqual((await mem.list('page')).length, 30);
  assert.deepStrictEqual(await mem.list('nothing'), []); await mem.clear(); assert.strictEqual((await mem.list('doc')).length, 0);
  console.log('ok   3) in-memory store lists the same rows');

  // ---- 4) how much room is left
  Object.defineProperty(global, 'navigator', { value: { storage: { estimate: async () => ({ usage: 5 * 1048576, quota: 100 * 1048576 }), persist: async () => true } }, configurable: true });
  assert.deepStrictEqual(await storageInfo(), { usage: 5 * 1048576, quota: 100 * 1048576 });
  Object.defineProperty(global, 'navigator', { value: {}, configurable: true }); assert.strictEqual(await storageInfo(), null, 'a browser that does not say -> null (nothing is shown)');
  console.log('ok   4) storage estimate: numbers when the browser gives them, null when not');
  console.log('stores tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
