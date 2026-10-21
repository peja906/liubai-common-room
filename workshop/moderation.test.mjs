import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertWorkshopSchema, listPosts, listReports, listAudit, transitionPost } from './moderation.mjs';
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fresh = (source = schema) => { const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON'); sqlite.exec(source); return sqlite; };
function addPost(sqlite, body = '合成待審原稿，尚未核實。') {
  const payload = { kind: 'discussion', nickname: '未驗證同行者', body, replyTo: null };
  const canonical = JSON.stringify(payload), id = hash(canonical);
  sqlite.prepare('INSERT INTO workshop_posts (id,kind,nickname,body,reply_to,created_at,payload_bytes) VALUES (?,?,?,?,?,?,?)').run(id, payload.kind, payload.nickname, body, null, 1000, Buffer.byteLength(canonical));
  return id;
}
const row = (sqlite, id) => sqlite.prepare('SELECT * FROM workshop_posts WHERE id = ?').get(id);
const immutable = ({ review_state, review_version, ...fields }) => fields;
const clock = () => 2000;
function hasCode(code) { return (error) => error.code === code && error.message === code; }
function snapshot(sqlite) {
  return JSON.stringify({ schema: sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(), posts: sqlite.prepare('SELECT * FROM workshop_posts ORDER BY seq').all() });
}

test('schema inspection accepts the new three-table shape without seeding or changing it', () => {
  const sqlite = fresh(); const before = snapshot(sqlite);
  assert.equal(assertWorkshopSchema(sqlite), true); assert.equal(snapshot(sqlite), before);
  assert.deepEqual(listPosts(sqlite), []); assert.deepEqual(listReports(sqlite), []);
  assert.equal(sqlite.isTransaction, false);
});

test('old schema is explicitly unsupported and every entry point leaves original schema and rows intact', () => {
  const sqlite = fresh(`CREATE TABLE workshop_posts (seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,nickname TEXT NOT NULL,body TEXT NOT NULL,reply_to TEXT,created_at INTEGER NOT NULL,payload_bytes INTEGER NOT NULL);`);
  const id = addPost(sqlite, '舊版合成私稿，不得遷移或覆寫。'); const before = snapshot(sqlite);
  for (const invoke of [() => assertWorkshopSchema(sqlite), () => listPosts(sqlite), () => listReports(sqlite), () => listAudit(sqlite, { id }), () => transitionPost(sqlite, { id, action: 'accept', clock })]) assert.throws(invoke, hasCode('unsupported_workshop_schema'));
  assert.equal(snapshot(sqlite), before); assert.equal(sqlite.isTransaction, false);
});

test('audit uniqueness is required; a partial schema is not silently accepted', () => {
  const sqlite = fresh(schema.replace('UNIQUE (post_id, review_version)', 'CHECK (review_version >= 2)'));
  assert.throws(() => assertWorkshopSchema(sqlite), hasCode('unsupported_workshop_schema'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workshop_posts').get().n, 0);
});

test('accept, hide and restore append audit versions while all original payload fields remain exact', () => {
  const sqlite = fresh(), id = addPost(sqlite, '<script>只是原文</script> https://example.invalid 不抓取。'); const original = immutable(row(sqlite, id));
  assert.equal(row(sqlite, id).review_state, 'pending'); assert.equal(row(sqlite, id).review_version, 1);
  assert.deepEqual(transitionPost(sqlite, { id, action: 'accept', note: '只允許展示，未核實。', expectedVersion: 1, clock }), { id, reviewState: 'accepted', reviewVersion: 2, changed: true });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'hide', note: '合成隱藏理由', expectedVersion: 2, clock }), { id, reviewState: 'hidden', reviewVersion: 3, changed: true });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'restore', expectedVersion: 3, clock }), { id, reviewState: 'accepted', reviewVersion: 4, changed: true });
  assert.deepEqual(immutable(row(sqlite, id)), original);
  const events = listAudit(sqlite, { id }); assert.deepEqual(events.map((event) => event.reviewVersion), [4, 3, 2]);
  assert.deepEqual(events.map(({ fromState, toState, action }) => [fromState, toState, action]), [['hidden', 'accepted', 'restore'], ['accepted', 'hidden', 'hide'], ['pending', 'accepted', 'accept']]);
  assert.ok(events.every((event) => event.createdAt === 2000)); assert.equal(sqlite.isTransaction, false);
});

test('reject and restore return to pending; repeated same decisions do not add versions or audit', () => {
  const sqlite = fresh(), id = addPost(sqlite);
  assert.throws(() => transitionPost(sqlite, { id, action: 'restore', clock }), hasCode('invalid_review_transition'));
  const rejected = transitionPost(sqlite, { id, action: 'reject', clock }); assert.equal(rejected.reviewState, 'rejected'); assert.equal(rejected.reviewVersion, 2);
  assert.deepEqual(transitionPost(sqlite, { id, action: 'reject', note: '重複決定不改已有備註', expectedVersion: 2, clock }), { id, reviewState: 'rejected', reviewVersion: 2, changed: false });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'restore', clock }), { id, reviewState: 'pending', reviewVersion: 3, changed: true });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'restore', clock }), { id, reviewState: 'pending', reviewVersion: 3, changed: false });
  assert.equal(listAudit(sqlite, { id }).length, 2); assert.equal(listPosts(sqlite, { state: 'accepted' }).length, 0);
  transitionPost(sqlite, { id, action: 'accept', clock });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'accept', clock }), { id, reviewState: 'accepted', reviewVersion: 4, changed: false });
  transitionPost(sqlite, { id, action: 'hide', clock });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'hide', clock }), { id, reviewState: 'hidden', reviewVersion: 5, changed: false });
  transitionPost(sqlite, { id, action: 'restore', clock });
  assert.deepEqual(transitionPost(sqlite, { id, action: 'restore', clock }), { id, reviewState: 'accepted', reviewVersion: 6, changed: false });
  assert.equal(listAudit(sqlite, { id }).length, 5);
});

test('illegal transitions and missing posts fail without version, audit, or original-content changes', () => {
  const sqlite = fresh(), id = addPost(sqlite);
  const unchanged = () => ({ post: row(sqlite, id), audit: listAudit(sqlite, { id }) });
  const before = unchanged(); assert.throws(() => transitionPost(sqlite, { id, action: 'hide', clock }), hasCode('invalid_review_transition')); assert.deepEqual(unchanged(), before);
  transitionPost(sqlite, { id, action: 'accept', clock }); const accepted = unchanged();
  for (const action of ['reject', 'restore']) assert.throws(() => transitionPost(sqlite, { id, action, clock }), hasCode('invalid_review_transition'));
  assert.deepEqual(unchanged(), accepted);
  assert.throws(() => transitionPost(sqlite, { id: 'a'.repeat(64), action: 'accept', clock }), hasCode('post_not_found'));
  assert.equal(sqlite.isTransaction, false);
});

test('expectedVersion prevents stale changes and stale duplicate decisions before any no-op', () => {
  const sqlite = fresh(), id = addPost(sqlite);
  transitionPost(sqlite, { id, action: 'accept', expectedVersion: 1, clock }); const before = snapshot(sqlite), auditBefore = listAudit(sqlite, { id });
  for (const action of ['accept', 'hide']) assert.throws(() => transitionPost(sqlite, { id, action, expectedVersion: 1, clock }), hasCode('stale_review_version'));
  for (const value of [0, -1, 1.5, null, '2', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => transitionPost(sqlite, { id, action: 'hide', expectedVersion: value, clock }), hasCode('invalid_expected_version'));
  assert.equal(snapshot(sqlite), before); assert.deepEqual(listAudit(sqlite, { id }), auditBefore); assert.equal(sqlite.isTransaction, false);
  assert.equal(transitionPost(sqlite, { id, action: 'hide', expectedVersion: 2, clock }).reviewVersion, 3);
});

test('an audit insert failure rolls back state/version and exposes only a generic stable code', () => {
  const sqlite = fresh(), id = addPost(sqlite); const before = row(sqlite, id);
  sqlite.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON workshop_audit BEGIN SELECT RAISE(ABORT, 'SECRET SQL /private/path'); END;");
  assert.throws(() => transitionPost(sqlite, { id, action: 'accept', note: '合成管理意見', clock }), hasCode('moderation_transaction_failed'));
  assert.deepEqual(row(sqlite, id), before); assert.deepEqual(listAudit(sqlite, { id }), []); assert.equal(sqlite.isTransaction, false);
});

test('UPDATE changes must be one; an ignored update cannot append a misleading audit event', () => {
  const sqlite = fresh(), id = addPost(sqlite); const before = row(sqlite, id);
  sqlite.exec('CREATE TRIGGER synthetic_update_ignore BEFORE UPDATE ON workshop_posts BEGIN SELECT RAISE(IGNORE); END;');
  assert.throws(() => transitionPost(sqlite, { id, action: 'accept', expectedVersion: 1, clock }), hasCode('stale_review_version'));
  assert.deepEqual(row(sqlite, id), before); assert.deepEqual(listAudit(sqlite, { id }), []); assert.equal(sqlite.isTransaction, false);
});

test('notes are bound as literal safe text and validated by codepoints and controls', () => {
  const sqlite = fresh(), id = addPost(sqlite); const note = `'; DROP TABLE workshop_posts;-- <script>只是管理原文</script>`;
  transitionPost(sqlite, { id, action: 'accept', note, clock }); assert.equal(listAudit(sqlite, { id })[0].note, note);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workshop_posts').get().n, 1);
  for (const bad of [null, 1, '字'.repeat(301), '\u001b[31m', '\u202e覆寫方向', '\ud800']) assert.throws(() => transitionPost(sqlite, { id, action: 'hide', note: bad, clock }), hasCode('invalid_moderation_note'));
  assert.equal(row(sqlite, id).reviewVersion, undefined); assert.equal(row(sqlite, id).review_version, 2);
  transitionPost(sqlite, { id, action: 'hide', note: '🙂'.repeat(300), clock }); assert.equal([...listAudit(sqlite, { id })[0].note].length, 300);
});

test('lists are read-only, state-scoped, bounded, and expose audit/reports only through local functions', () => {
  const sqlite = fresh(); const ids = Array.from({ length: 5 }, (_, n) => addPost(sqlite, `第${n}份合成原稿`));
  transitionPost(sqlite, { id: ids[1], action: 'accept', clock }); transitionPost(sqlite, { id: ids[2], action: 'reject', clock });
  transitionPost(sqlite, { id: ids[3], action: 'accept', clock }); transitionPost(sqlite, { id: ids[3], action: 'hide', clock });
  for (let n = 0; n < 2; n += 1) { const reason = `合成理由${n}，不公開`; const canonical = JSON.stringify({ postId: ids[1], reason }); sqlite.prepare('INSERT INTO workshop_reports (id,post_id,reason,created_at,payload_bytes) VALUES (?,?,?,?,?)').run(hash(canonical), ids[1], reason, 3000 + n, Buffer.byteLength(canonical)); }
  const before = snapshot(sqlite);
  assert.deepEqual(listPosts(sqlite).map((entry) => entry.id), [ids[0], ids[4]]);
  assert.deepEqual(listPosts(sqlite, { state: 'all', limit: 3 }).map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(listPosts(sqlite, { state: 'accepted' })[0].reviewState, 'accepted');
  assert.equal(listPosts(sqlite, { state: 'rejected' })[0].reviewState, 'rejected');
  assert.equal(listPosts(sqlite, { state: 'hidden' })[0].reviewState, 'hidden');
  assert.deepEqual(listReports(sqlite, { limit: 1 }).map(({ reason, postId }) => [reason, postId]), [['合成理由0，不公開', ids[1]]]);
  assert.equal(listAudit(sqlite, { id: ids[3], limit: 1 })[0].action, 'hide'); assert.deepEqual(listAudit(sqlite, { id: 'f'.repeat(64) }), []);
  for (const limit of [0, -1, 101, 0.5, '20', NaN]) {
    assert.throws(() => listPosts(sqlite, { limit }), hasCode('invalid_limit')); if (limit !== 101) assert.throws(() => listReports(sqlite, { limit }), hasCode('invalid_limit')); assert.throws(() => listAudit(sqlite, { id: ids[1], limit }), hasCode('invalid_limit'));
  }
  assert.throws(() => listPosts(sqlite, { state: "pending' OR 1=1 --" }), hasCode('invalid_review_state')); assert.equal(snapshot(sqlite), before);
});

test('all 101 reports remain reachable within the combined cap; reports accept limit 200, reject 201, and preserve originals', () => {
  const sqlite = fresh(), id = addPost(sqlite); transitionPost(sqlite, { id, action: 'accept', clock });
  const insert = sqlite.prepare('INSERT INTO workshop_reports (id,post_id,reason,created_at,payload_bytes) VALUES (?,?,?,?,?)');
  for (let n = 1; n <= 101; n += 1) {
    const reason = `第${n}筆合成回報原文，不得改寫。`, canonical = JSON.stringify({ postId: id, reason });
    insert.run(hash(canonical), id, reason, 3000 + n, Buffer.byteLength(canonical));
  }
  const originals = sqlite.prepare('SELECT * FROM workshop_reports ORDER BY seq').all(), originalPost = row(sqlite, id);
  const values = listReports(sqlite, { limit: 200 }); assert.equal(values.length, 101);
  assert.equal(values[100].seq, 101); assert.equal(values[100].id, originals[100].id); assert.equal(values[100].reason, originals[100].reason);
  assert.equal(listReports(sqlite, { limit: 101 }).at(-1).seq, 101);
  assert.throws(() => listReports(sqlite, { limit: 201 }), hasCode('invalid_limit'));
  assert.throws(() => listPosts(sqlite, { limit: 101 }), hasCode('invalid_limit'));
  assert.throws(() => listAudit(sqlite, { id, limit: 101 }), hasCode('invalid_limit'));
  assert.deepEqual(sqlite.prepare('SELECT * FROM workshop_reports ORDER BY seq').all(), originals); assert.deepEqual(row(sqlite, id), originalPost);
});

test('an outer caller transaction is never committed or rolled back by a moderation call', () => {
  const sqlite = fresh(), id = addPost(sqlite); sqlite.exec('BEGIN');
  assert.throws(() => transitionPost(sqlite, { id, action: 'accept', clock }), hasCode('moderation_transaction_active'));
  assert.equal(sqlite.isTransaction, true); sqlite.exec('ROLLBACK'); assert.equal(row(sqlite, id).review_version, 1);
});

test('invalid/throwing clocks and exhausted review versions preserve state and leave no open transaction', () => {
  const sqlite = fresh(), id = addPost(sqlite); const before = row(sqlite, id);
  assert.throws(() => transitionPost(sqlite, { id, action: 'accept', clock: () => -1 }), hasCode('invalid_moderation_clock'));
  assert.throws(() => transitionPost(sqlite, { id, action: 'accept', clock: () => { throw new Error('SECRET clock'); } }), hasCode('moderation_transaction_failed'));
  assert.deepEqual(row(sqlite, id), before); assert.equal(sqlite.isTransaction, false); assert.deepEqual(listAudit(sqlite, { id }), []);
  sqlite.prepare('UPDATE workshop_posts SET review_version = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, id);
  assert.throws(() => transitionPost(sqlite, { id, action: 'accept', clock }), hasCode('review_version_exhausted'));
  assert.equal(row(sqlite, id).review_version, Number.MAX_SAFE_INTEGER); assert.equal(sqlite.isTransaction, false);
});
