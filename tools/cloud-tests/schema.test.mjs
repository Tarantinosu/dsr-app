import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const owner = '00000000-0000-4000-8000-000000000001';
const editor = '00000000-0000-4000-8000-000000000002';
const stranger = '00000000-0000-4000-8000-000000000003';
const request = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (name = 'Test', records) => ({
  format: 'DSR_OFFLINE_BACKUP', version: 2,
  records: records || [{ __backendId: 'p1', record_type: 'project', name }],
  config: { company_name: name }
});
async function asUser(id, fn) {
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function save(id, version, data) {
  return (await db.query('select public.dsr_save($1, $2, $3) as result', [request(id), version, data])).rows[0].result;
}
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  await db.query('insert into auth.users values ($1), ($2), ($3)', [owner, editor, stranger]);
  await db.exec(await readFile(new URL('../../supabase/01_setup.sql', import.meta.url), 'utf8'));
  await db.query("insert into public.dsr_members(user_id,role) values ($1,'owner'),($2,'editor')", [owner, editor]);
});
after(async () => { await db?.close(); });

test('anonymous cannot call RPC or read business tables', async () => {
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query('select public.dsr_read()'), /permission denied/);
    await assert.rejects(db.query('select * from public.dsr_document'), /permission denied/);
  } finally { await db.exec('reset role'); }
});
test('authenticated non-member cannot read, write, or grant themselves membership', async () => {
  await asUser(stranger, async () => {
    await assert.rejects(db.query('select public.dsr_read()'), /DSR_ACCESS_DENIED/);
    await assert.rejects(save(1, 0, payload()), /DSR_ACCESS_DENIED/);
    await assert.rejects(db.query("insert into public.dsr_members values ($1,'owner',now())", [stranger]), /permission denied/);
  });
});
test('editor cannot initialize the shared dataset', async () => {
  await asUser(editor, () => assert.rejects(save(2, 0, payload()), /DSR_OWNER_REQUIRED_FOR_IMPORT/));
});
test('owner imports preserving IDs and company settings', async () => {
  await asUser(owner, async () => {
    assert.deepEqual(await save(3, 0, payload()), { version: 1, replayed: false });
    const { rows } = await db.query('select public.dsr_read() as result');
    assert.deepEqual(rows[0].result.payload, payload());
    assert.equal(rows[0].result.role, 'owner');
  });
});
test('same save intent retries once, even after another machine has saved', async () => {
  await asUser(editor, async () => {
    assert.deepEqual(await save(4, 1, payload('second')), { version: 2, replayed: false });
  });
  await asUser(owner, async () => {
    assert.deepEqual(await save(3, 0, payload()), { version: 1, replayed: true });
    const result = (await db.query('select public.dsr_read() as result')).rows[0].result;
    assert.equal(result.version, 2);
    assert.equal(result.payload.config.company_name, 'second');
  });
});
test('stale machine cannot overwrite newer data', async () => {
  await asUser(owner, () => assert.rejects(save(5, 1, payload('stale')), /DSR_VERSION_CONFLICT/));
});
test('request UUID cannot be reused with different data or another account', async () => {
  await asUser(owner, () => assert.rejects(save(3, 0, payload('changed')), /DSR_REQUEST_ID_REUSED/));
  await asUser(editor, () => assert.rejects(save(3, 0, payload()), /DSR_REQUEST_ID_REUSED/));
});
test('reject missing ID, duplicate ID, missing record type, and invalid config atomically', async () => {
  const invalid = [
    payload('bad', [{ record_type: 'project' }]),
    payload('bad', [{ __backendId: 'p1', record_type: 'project' }, { __backendId: 'p1', record_type: 'project' }]),
    payload('bad', [{ __backendId: 'p1' }]),
    { ...payload(), config: [] },
    { ...payload(), version: 99 }
  ];
  await asUser(owner, async () => {
    for (const p of invalid) await assert.rejects(save(6, 2, p), /DSR_INVALID/);
    assert.equal((await db.query('select public.dsr_read() as result')).rows[0].result.version, 2);
  });
});
test('reject replacing existing business data with empty records', async () => {
  await asUser(owner, () => assert.rejects(save(7, 2, payload('empty', [])), /DSR_REFUSE_EMPTY_REPLACEMENT/));
});
test('unchanged revision returns metadata without resending JSON', async () => {
  await asUser(editor, async () => {
    const result = (await db.query('select public.dsr_read(2) as result')).rows[0].result;
    assert.equal(result.unchanged, true);
    assert.equal(result.payload, null);
  });
});
test('migration can be rerun without resetting existing records or memberships', async () => {
  await db.exec(await readFile(new URL('../../supabase/01_setup.sql', import.meta.url), 'utf8'));
  const result = await db.query('select version from public.dsr_document');
  assert.equal(result.rows[0].version, 2);
  assert.equal((await db.query('select count(*) as n from public.dsr_members')).rows[0].n, 2);
});
