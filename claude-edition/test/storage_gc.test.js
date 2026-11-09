// node claude-edition/test/storage_gc.test.js — pages left without their file are cleaned up (a real account held 34 pages of a file that was gone):
//  1) the pages of a file that no longer exists are removed, once a session, in the background, when the list of files is opened
//  2) never the pages of a file that exists, nor of an upload written in the last hour (another tab may still be writing its file record)
//  3) a store that answers with no files at all removes nothing
const assert = require('assert');
global.window = global; global.location = { href: 'http://x/' }; global.document = { addEventListener() {}, getElementById() { return null; } };
window.fetch = async () => ({}); require('../engine.js'); require('../../shared/owner_rules.js');
const data = new Map(); let lists = 0;
const mem = { async get(k) { return data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null; }, async set(k, v) { data.set(k, JSON.parse(JSON.stringify(v))); }, async del(k) { data.delete(k); },
  async list(kind) { lists++; return [...data.values()].filter((d) => d.kind === kind).map((d) => JSON.parse(JSON.stringify(d))); } };
window.QZ_HOST = { aiOnly: true, platform: async () => ({ signedIn: true, user: { id: 'u1', email: 'a@b.c', display_name: 'A' }, aiAvailable: true }), bannerText: () => '', store: async () => mem, llm: {} };
require('../../shared/api-core.js');
const now = Date.now() / 1000;
const page = (doc, n, at) => data.set(`page_${doc}_${n}`, { kind: 'page', doc, page_no: n, text: 'text ' + n, ...(at ? { at } : {}) });
(async () => {
  // 3) no files listed: nothing is touched (a short or failed list must never cost a page)
  page('gone', 1); page('gone', 2);
  let r = await window.QZ_API.handle('GET', '/api/documents', new URLSearchParams(), {}); assert.strictEqual(r.status, 200);
  await new Promise((res) => setTimeout(res, 20)); assert(data.has('page_gone_1') && data.has('page_gone_2'), '3) with no files listed nothing is removed');
  // a new session (the clean-up runs once a session), with files this time
  delete require.cache[require.resolve('../../shared/api-core.js')]; require('../../shared/api-core.js');
  data.set('doc_kept', { kind: 'doc', id: 'kept', title: 'Kept', pages: [{ page_no: 1, status: 'ok' }], created_at: now, page_count: 1, status: 'ready' }); page('kept', 1, now - 7200);
  for (let n = 1; n <= 34; n++) page('gone', n);      // the real case: a whole file's pages, its record gone
  page('fresh', 1, now - 60); page('fresh', 2, now - 60);      // written a minute ago: maybe an upload still running in another tab
  r = await window.QZ_API.handle('GET', '/api/documents', new URLSearchParams(), {}); const list = await r.json(); assert.strictEqual(list.length, 1, 'the files list is answered at once');
  for (let i = 0; i < 50 && [...data.keys()].some((k) => k.startsWith('page_gone_')); i++) await new Promise((res) => setTimeout(res, 10));
  assert(![...data.keys()].some((k) => k.startsWith('page_gone_')), '1) the 34 pages of the file that is gone are removed');
  assert(data.has('page_kept_1'), '2) the pages of a file that exists stay'); assert(data.has('page_fresh_1') && data.has('page_fresh_2'), '2) pages written in the last hour stay');
  const before = lists; await window.QZ_API.handle('GET', '/api/documents', new URLSearchParams(), {}); await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(lists - before, 1, '1) once a session: opening the list again lists the files only (no second scan of the pages)');
  console.log('storage clean-up ok: 34 pages of a deleted file removed in the background; files that exist and fresh uploads untouched; nothing removed when no file is listed');
})().catch((e) => { console.error(e); process.exit(1); });
