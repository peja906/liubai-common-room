/** Isolated local-only safety regressions. Fixtures are new synthetic DBs, retained in /tmp. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, symlink, link, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkshopAPI } from './api.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sequence = { value: 0 };
const fixture = (name) => `/tmp/liubai-workshop-review3-safety-${process.pid}-${Date.now()}-${sequence.value++}-${name}.sqlite`;
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const exists = async (path) => access(path).then(() => true, () => false);
async function run(file, args) {
  try { return { ...(await execute(process.execPath, [file, ...args], { cwd: root, timeout: 7000, env: { ...process.env, NODE_NO_WARNINGS: '1' } })), code: 0 }; }
  catch (cause) { return { code: cause.code, stdout: cause.stdout ?? '', stderr: cause.stderr ?? '', killed: cause.killed }; }
}
async function newDb(name, schema) {
  const path = fixture(name); const prior = process.umask(0o077);
  try { const db = new DatabaseSync(path); try { db.exec(schema); } finally { db.close(); } }
  finally { process.umask(prior); }
  return path;
}
const oldSchema = await readFile(new URL('./fixtures/review2-schema.sql', import.meta.url), 'utf8');
const currentSchema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');

test('preview refuses an existing review-2 DB before migration or writes, preserving exact bytes', async () => {
  const path = await newDb('old-preview', oldSchema), before = await hash(path);
  const result = await run('workshop/preview.mjs', ['--port', '0', '--db', path]);
  assert.equal(result.code, 1); assert.equal(result.killed, false);
  assert.match(result.stderr, /unsupported_workshop_schema/);
  assert.equal(await hash(path), before);
  assert.equal(await exists(path + '-journal'), false);
  assert.equal(await exists(path + '-wal'), false);
});

test('management refuses old schema read-only without creating audit/report tables', async () => {
  const path = await newDb('old-cli', oldSchema), before = await hash(path);
  const result = await run('workshop/moderate.mjs', ['--db', path, 'accept', '--id', 'a'.repeat(64)]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: 'unsupported_workshop_schema' });
  assert.equal(await hash(path), before);
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('workshop_reports','workshop_audit')").get().n, 0); }
  finally { db.close(); }
});

test('CLI never creates a missing DB and rejects non-QA targets without exposing paths', async () => {
  const path = fixture('missing');
  const missing = await run('workshop/moderate.mjs', ['--db', path, 'list']);
  assert.equal(missing.code, 1); assert.deepEqual(JSON.parse(missing.stderr), { error: 'database_not_found' });
  assert.equal(await exists(path), false);
  const outside = await run('workshop/moderate.mjs', ['--db', '/etc/hosts', 'list']);
  assert.equal(outside.code, 1); assert.deepEqual(JSON.parse(outside.stderr), { error: 'unsafe_local_database' });
  assert.equal(outside.stderr.includes('/etc'), false);
});

test('CLI rejects symbolic and hard-linked DB targets without changing original data', async () => {
  const target = await newDb('target', currentSchema), before = await hash(target);
  const symbolic = fixture('symlink'); await symlink(target, symbolic);
  const hard = fixture('hardlink'); await link(target, hard);
  for (const path of [symbolic, hard]) {
    const result = await run('workshop/moderate.mjs', ['--db', path, 'list']);
    assert.equal(result.code, 1); assert.deepEqual(JSON.parse(result.stderr), { error: 'unsafe_local_database' });
  }
  assert.equal(await hash(target), before);
});

test('CLI is read-only for list/audit and rejects stale management decisions with no original overwrite', async () => {
  const path = await newDb('manage', currentSchema);
  const db = new DatabaseSync(path);
  try { db.prepare('INSERT INTO workshop_posts (id,kind,nickname,body,reply_to,created_at,payload_bytes) VALUES (?,?,?,?,?,?,?)').run('b'.repeat(64), 'discussion', '合成訪客', 'CLI synthetic retained original', null, 1, 1); }
  finally { db.close(); }
  const before = await hash(path);
  const listed = await run('workshop/moderate.mjs', ['--db', path, 'list']);
  assert.equal(listed.code, 0); assert.equal(JSON.parse(listed.stdout).posts[0].reviewState, 'pending');
  assert.equal(await hash(path), before);
  const accepted = await run('workshop/moderate.mjs', ['--db', path, 'accept', '--id', 'b'.repeat(64), '--expected-version', '1', '--note', '合成審閱']);
  assert.equal(accepted.code, 0); assert.equal(JSON.parse(accepted.stdout).result.reviewVersion, 2);
  const stable = await hash(path);
  const stale = await run('workshop/moderate.mjs', ['--db', path, 'hide', '--id', 'b'.repeat(64), '--expected-version', '1']);
  assert.equal(stale.code, 1); assert.deepEqual(JSON.parse(stale.stderr), { error: 'stale_review_version' });
  assert.equal(await hash(path), stable);
  const audited = await run('workshop/moderate.mjs', ['--db', path, 'audit', '--id', 'b'.repeat(64)]);
  assert.equal(audited.code, 0); assert.equal(JSON.parse(audited.stdout).events.length, 1);
  assert.equal(await hash(path), stable);
  const readback = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(readback.prepare('SELECT body FROM workshop_posts').get().body, 'CLI synthetic retained original'); }
  finally { readback.close(); }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('CLI can retrieve report 101 within the retained 200-row ledger and rejects an excessive list limit', async () => {
  const path = await newDb('reports-tail', currentSchema);
  const payload = { kind: 'discussion', nickname: '合成訪客', body: 'Retained report target', replyTo: null };
  const canonical = JSON.stringify(payload);
  const postId = createHash('sha256').update(canonical).digest('hex');
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO workshop_posts (id,kind,nickname,body,reply_to,created_at,payload_bytes) VALUES (?,?,?,?,?,?,?)').run(postId, payload.kind, payload.nickname, payload.body, null, 1, Buffer.byteLength(canonical));
    const insert = db.prepare('INSERT INTO workshop_reports (id,post_id,reason,created_at,payload_bytes) VALUES (?,?,?,?,?)');
    for (let n = 1; n <= 101; n++) {
      const report = { postId, reason: `synthetic-reason-${n}` }, text = JSON.stringify(report);
      insert.run(createHash('sha256').update(text).digest('hex'), postId, report.reason, n * 86400000, Buffer.byteLength(text));
    }
  } finally { db.close(); }
  const before = await hash(path);
  const listed = await run('workshop/moderate.mjs', ['--db', path, 'reports', 'list', '--limit', '200']);
  assert.equal(listed.code, 0);
  const reports = JSON.parse(listed.stdout).reports;
  assert.equal(reports.length, 101); assert.equal(reports.at(-1).reason, 'synthetic-reason-101');
  const excessive = await run('workshop/moderate.mjs', ['--db', path, 'reports', '--limit', '201']);
  assert.equal(excessive.code, 1); assert.deepEqual(JSON.parse(excessive.stderr), { error: 'invalid_arguments' });
  assert.equal(await hash(path), before);
});

test('no network moderation, original draft, report listing or audit endpoints exist', async () => {
  let queries = 0;
  const DB = { prepare() { queries++; throw new Error('must not access DB'); } };
  const api = createWorkshopAPI({ enabled: true, allowedOrigin: 'https://workshop.example.invalid' });
  for (const path of ['/api/workshop/admin', '/api/workshop/accept', '/api/workshop/hide', '/api/workshop/restore', '/api/workshop/moderation', '/api/workshop/audit', '/api/workshop/drafts', '/api/workshop/reports/all']) {
    for (const method of ['GET', 'POST']) {
      const response = await api.fetch(new Request('https://workshop.example.invalid' + path, { method }), { DB });
      assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
    }
  }
  assert.equal(queries, 0);
});
