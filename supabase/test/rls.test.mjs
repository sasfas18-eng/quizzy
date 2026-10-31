// Real PostgreSQL test of supabase/schema.sql (RLS + erasure). Needs `embedded-postgres` and `pg` (npm) and must not run as root:
//   QZ_NODE_MODULES=/path/to/node_modules node supabase/test/rls.test.mjs
// Emulates Supabase's `auth` schema and roles, then checks isolation with the same primitives PostgREST uses
// (SET ROLE + request.jwt.claim.sub).
import { pathToFileURL, fileURLToPath } from 'node:url'; import { readFileSync, mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import path from 'node:path'; import assert from 'node:assert';
const NM = process.env.QZ_NODE_MODULES || path.resolve('node_modules');
const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(NM, 'embedded-postgres/dist/index.js')).href);
const pg = (await import(pathToFileURL(path.join(NM, 'pg/lib/index.js')).href)).default;
const schema = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../schema.sql'), 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'qz-pg-')); const port = 54000 + Math.floor(Math.random() * 900);
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
let admin;
try {
  await server.initialise(); await server.start(); await server.createDatabase('quizzy');
  admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: 'quizzy' }); await admin.connect();
  await admin.query(`
    create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(current_setting('request.jwt.claim.sub', true), ''), '')::uuid $$;
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;`);
  await admin.query(schema); await admin.query(schema);   // idempotent: running it twice must not fail
  await admin.query('grant select, insert, update, delete on public.kv to anon, authenticated;');   // what Supabase's default privileges do; RLS must still restrict
  const A = (await admin.query("insert into auth.users(email) values ('a@x.com') returning id")).rows[0].id, B = (await admin.query("insert into auth.users(email) values ('b@x.com') returning id")).rows[0].id;
  const as = async (role, uid, fn) => { await admin.query('begin'); try { await admin.query(`set local role ${role}`); await admin.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || '']); const r = await fn((q, a) => admin.query(q, a)); await admin.query('commit'); return r; } catch (e) { await admin.query('rollback'); throw e; } };

  // owner can write (user_id comes from the default auth.uid()), upsert, read back
  await as('authenticated', A, (q) => q("insert into public.kv(k, kind, data) values ('quiz_1','quiz','{\"title\":\"A\"}')"));
  await as('authenticated', A, (q) => q("insert into public.kv(user_id,k,kind,data) values ($1,'quiz_1','quiz','{\"title\":\"A2\"}') on conflict (user_id,k) do update set data = excluded.data", [A]));
  let rows = (await as('authenticated', A, (q) => q("select k, data from public.kv"))).rows; assert.deepStrictEqual(rows.map((r) => [r.k, r.data.title]), [['quiz_1', 'A2']]);
  const t1 = (await as('authenticated', A, (q) => q("select updated_at from public.kv"))).rows[0].updated_at;
  await as('authenticated', A, (q) => q("update public.kv set data = '{\"title\":\"A3\"}' where k='quiz_1'")); const t2 = (await as('authenticated', A, (q) => q("select updated_at from public.kv"))).rows[0].updated_at; assert(t2 >= t1);
  await as('authenticated', B, (q) => q("insert into public.kv(k, kind, data) values ('quiz_1','quiz','{\"title\":\"B\"}')"));   // same key, different owner: independent row

  // isolation
  rows = (await as('authenticated', B, (q) => q("select data from public.kv where k='quiz_1'"))).rows; assert.deepStrictEqual(rows.map((r) => r.data.title), ['B'], 'B sees only B');
  assert.strictEqual((await as('authenticated', B, (q) => q("update public.kv set data='{\"hack\":1}' where user_id=$1", [A]))).rowCount, 0, "B cannot update A's rows");
  assert.strictEqual((await as('authenticated', B, (q) => q("delete from public.kv where user_id=$1", [A]))).rowCount, 0, "B cannot delete A's rows");
  await assert.rejects(() => as('authenticated', B, (q) => q("insert into public.kv(user_id,k,kind,data) values ($1,'planted','quiz','{}')", [A])), /row-level security/i);   // cannot plant rows into A
  await assert.rejects(() => as('authenticated', B, (q) => q("update public.kv set user_id=$1 where k='quiz_1'", [A])), /row-level security/i);                 // cannot hand rows to A
  assert.strictEqual((await as('anon', null, (q) => q('select * from public.kv'))).rowCount, 0, 'anon key alone sees nothing');
  await assert.rejects(() => as('anon', null, (q) => q("insert into public.kv(user_id,k,kind,data) values ($1,'x','quiz','{}')", [A])), /row-level security/i);
  assert.strictEqual((await as('authenticated', A, (q) => q("select * from public.kv"))).rowCount, 1, "A's data intact after B's attempts");

  // erasure
  await assert.rejects(() => as('anon', null, (q) => q('select public.delete_my_account()')), /permission denied/i);
  await assert.rejects(() => as('authenticated', null, (q) => q('select public.delete_my_account()')), /not authenticated/i);
  await as('authenticated', A, (q) => q('select public.delete_my_account()'));
  assert.strictEqual((await admin.query('select count(*)::int c from auth.users where id=$1', [A])).rows[0].c, 0, 'account removed');
  assert.strictEqual((await admin.query('select count(*)::int c from public.kv where user_id=$1', [A])).rows[0].c, 0, 'its documents cascaded');
  assert.strictEqual((await admin.query('select count(*)::int c from public.kv where user_id=$1', [B])).rows[0].c, 1, "B's data untouched");
  console.log('supabase RLS tests ok (real PostgreSQL)');
} finally { try { await admin?.end(); } catch {} try { await server.stop(); } catch {} rmSync(dir, { recursive: true, force: true }); }
