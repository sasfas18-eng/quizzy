// node static-edition/test/stores.test.js — the device stores (shared/stores.js) against a minimal fake IndexedDB:
//  1) list(kind) reads ONLY the rows of that kind (a key range), never the whole database — with many quizzes the Files page used to pull every quiz and every page into memory;
//  2) a write the browser refuses because the site's storage is full (thrown at once, or reported when the transaction ends) becomes a clear error with code 'storage_full';
//  3) the in-memory store lists exactly the same rows;
//  5) THE CONNECTION THE BROWSER CLOSED (students saw «Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing» until they reloaded):
//     closed with its `close` event, closed without it, or a transaction aborted by the closing - the store opens a new connection and the call succeeds; a
//     database that never opens is reported (storage_unavailable) instead of waited for.
const assert = require('assert');

function fakeIndexedDB() {
  const data = new Map(); const log = { getAll: [], opens: 0 }; const mode = { fail: null, hang: false, abortNext: 0 }; const conns = [];
  const quota = () => Object.assign(new Error('The current transaction exceeded its quota limitations.'), { name: 'QuotaExceededError', code: 22 });
  const closing = () => Object.assign(new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."), { name: 'InvalidStateError' });
  const connect = () => { const db = { closed: false, onclose: null, onversionchange: null, objectStoreNames: { contains: () => true }, createObjectStore() {}, close() { db.closed = true; }, transaction(_name, kind) {
    if (db.closed) throw closing();
    const t = { error: null, oncomplete: null, onerror: null, onabort: null };
    if (mode.abortNext > 0) { mode.abortNext--; t.failed = true; setTimeout(() => { t.error = Object.assign(new Error('The transaction was aborted, so the request cannot be fulfilled.'), { name: 'AbortError' }); t.onabort && t.onabort(); }, 0); }
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
  } }; conns.push(db); return db; };
  const indexedDB = { open() { log.opens++; const rq = { result: null }; if (mode.hang) return rq; setTimeout(() => { rq.result = connect(); rq.onupgradeneeded && rq.onupgradeneeded(); rq.onsuccess && rq.onsuccess(); }, 0); return rq; } };
  // what a phone does to a page in the background: every open connection is closed - with its `close` event (`event`), or without it
  const closeAll = (event) => conns.forEach((c) => { if (!c.closed) { c.closed = true; if (event && c.onclose) c.onclose(); } });
  return { indexedDB, data, log, mode, closeAll };
}

(async () => {
  const fake = fakeIndexedDB();
  global.window = { indexedDB: fake.indexedDB, QZ_CONFIG: { idbOpenMs: 300 } }; global.indexedDB = fake.indexedDB; global.IDBKeyRange = { bound: (lo, hi) => ({ lo, hi }) };
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

  // ---- 5) the connection the browser closed
  const s5 = await idbStore('t5'); await s5.set('quiz_a', { kind: 'quiz', id: 'a' }); const o0 = fake.log.opens;
  fake.closeAll(false);      // closed without a word: the next call meets «The database connection is closing»
  await s5.set('quiz_b', { kind: 'quiz', id: 'b' }); assert.strictEqual((await s5.get('quiz_a')).id, 'a', 'read after the connection was closed');
  assert.deepStrictEqual((await s5.list('quiz')).map((d) => d.id).sort(), ['a', 'b'], 'the write made after the close is there'); assert.strictEqual(fake.log.opens, o0 + 1, 'one new connection, not one per call');
  fake.closeAll(true); const o1 = fake.log.opens;      // closed with its `close` event: the next call opens a new one at once
  assert.strictEqual((await s5.get('quiz_b')).id, 'b'); assert.strictEqual(fake.log.opens, o1 + 1);
  fake.mode.abortNext = 1; await s5.set('quiz_c', { kind: 'quiz', id: 'c' }); assert.strictEqual((await s5.get('quiz_c')).id, 'c', 'a transaction aborted by the closing is made again');
  fake.mode.abortNext = 5; await assert.rejects(() => s5.set('quiz_d', { kind: 'quiz', id: 'd' }), (e) => e.name === 'AbortError', 'a store that keeps failing says so (three tries), it never loops'); fake.mode.abortNext = 0;
  fake.mode.fail = 'throw'; await assert.rejects(() => s5.set('quiz_e', { kind: 'quiz', id: 'e' }), (e) => e.code === 'storage_full', 'a full storage is still reported at once, not retried'); fake.mode.fail = null;
  fake.mode.hang = true; const t0 = Date.now(); await assert.rejects(() => idbStore('never'), (e) => e.code === 'storage_unavailable'); assert(Date.now() - t0 < 1000, 'a database that never opens is reported, not waited for');
  fake.closeAll(true); await assert.rejects(() => s5.get('quiz_a'), (e) => e.code === 'storage_unavailable', 'the same for a reconnection that never answers'); fake.mode.hang = false;
  assert.strictEqual((await s5.get('quiz_a')).id, 'a', 'and once the browser answers again, the store works');
  assert(window.QZ_STORES.isStorageLost({ name: 'InvalidStateError' }) && !window.QZ_STORES.isStorageLost({ name: 'QuotaExceededError' }) && !window.QZ_STORES.isStorageLost(new Error('boom')));
  console.log('ok   5) a connection the browser closed (with or without its event, or mid-transaction) is opened again and the call succeeds; never-opening -> storage_unavailable');
  console.log('stores tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
