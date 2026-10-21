/** Local-only synchronous SQLite moderation. Never expose these functions through HTTP. */
const STATES = Object.freeze(['pending', 'accepted', 'rejected', 'hidden']);
const ACTIONS = Object.freeze(['accept', 'reject', 'hide', 'restore']);
const HEX = /^[a-f0-9]{64}$/;
const INVALID_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const REQUIRED = Object.freeze({
  workshop_posts: { seq: 'INTEGER', id: 'TEXT', kind: 'TEXT', nickname: 'TEXT', body: 'TEXT', reply_to: 'TEXT', created_at: 'INTEGER', payload_bytes: 'INTEGER', review_state: 'TEXT', review_version: 'INTEGER' },
  workshop_reports: { seq: 'INTEGER', id: 'TEXT', post_id: 'TEXT', reason: 'TEXT', created_at: 'INTEGER', payload_bytes: 'INTEGER' },
  workshop_audit: { seq: 'INTEGER', post_id: 'TEXT', review_version: 'INTEGER', from_state: 'TEXT', to_state: 'TEXT', action: 'TEXT', note: 'TEXT', created_at: 'INTEGER' },
});
export class ModerationError extends Error {
  constructor(code) { super(code); this.name = 'ModerationError'; this.code = code; }
}
const fail = (code) => { throw new ModerationError(code); };
const validId = (id) => typeof id === 'string' && HEX.test(id);
function checkId(id) { if (!validId(id)) fail('invalid_post_id'); }
function checkLimit(limit, maximum = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) fail('invalid_limit');
  return limit;
}
function hasUnique(sqlite, table, columns) {
  // Table names are fixed constants; index names remain bound values.
  const indexes = sqlite.prepare(`PRAGMA index_list('${table}')`).all();
  return indexes.some((index) => index.unique === 1 && (() => {
    const entries = sqlite.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name);
    return entries.length === columns.length && entries.every((entry, n) => entry.name === columns[n]);
  })());
}
/** Inspect only. An older/unsupported DB is never migrated, seeded, or changed. */
export function assertWorkshopSchema(sqlite) {
  try {
    if (!sqlite || typeof sqlite.prepare !== 'function' || typeof sqlite.exec !== 'function') fail('unsupported_workshop_schema');
    for (const [table, fields] of Object.entries(REQUIRED)) {
      const columns = sqlite.prepare(`PRAGMA table_info('${table}')`).all();
      if (!columns.length || Object.entries(fields).some(([name, type]) => !columns.some((column) => column.name === name && column.type.toUpperCase() === type))) fail('unsupported_workshop_schema');
      if (!columns.some((column) => column.name === 'seq' && column.pk === 1)) fail('unsupported_workshop_schema');
    }
    if (!hasUnique(sqlite, 'workshop_posts', ['id']) || !hasUnique(sqlite, 'workshop_reports', ['id']) || !hasUnique(sqlite, 'workshop_audit', ['post_id', 'review_version'])) fail('unsupported_workshop_schema');
    return true;
  } catch { fail('unsupported_workshop_schema'); }
}
const post = (row) => ({ seq: row.seq, id: row.id, kind: row.kind, nickname: row.nickname, body: row.body, replyTo: row.reply_to, createdAt: row.created_at, payloadBytes: row.payload_bytes, reviewState: row.review_state, reviewVersion: row.review_version });
const report = (row) => ({ seq: row.seq, id: row.id, postId: row.post_id, reason: row.reason, createdAt: row.created_at, payloadBytes: row.payload_bytes });
const audit = (row) => ({ seq: row.seq, postId: row.post_id, reviewVersion: row.review_version, fromState: row.from_state, toState: row.to_state, action: row.action, note: row.note, createdAt: row.created_at });
function read(sqlite, query, values, convert) {
  try { return sqlite.prepare(query).all(...values).map(convert); }
  catch { fail('moderation_read_failed'); }
}
/** Pending review uses oldest-first order so older submissions are not starved. */
export function listPosts(sqlite, { state = 'pending', limit = 20 } = {}) {
  if (state !== 'all' && !STATES.includes(state)) fail('invalid_review_state');
  checkLimit(limit); assertWorkshopSchema(sqlite);
  if (state === 'all') return read(sqlite, 'SELECT seq, id, kind, nickname, body, reply_to, created_at, payload_bytes, review_state, review_version FROM workshop_posts ORDER BY seq ASC LIMIT ?', [limit], post);
  return read(sqlite, 'SELECT seq, id, kind, nickname, body, reply_to, created_at, payload_bytes, review_state, review_version FROM workshop_posts WHERE review_state = ? ORDER BY seq ASC LIMIT ?', [state, limit], post);
}
export function listReports(sqlite, { limit = 20 } = {}) {
  checkLimit(limit, 200); assertWorkshopSchema(sqlite);
  return read(sqlite, 'SELECT seq, id, post_id, reason, created_at, payload_bytes FROM workshop_reports ORDER BY seq ASC LIMIT ?', [limit], report);
}
export function listAudit(sqlite, { id, limit = 100 } = {}) {
  checkId(id); checkLimit(limit); assertWorkshopSchema(sqlite);
  return read(sqlite, 'SELECT seq, post_id, review_version, from_state, to_state, action, note, created_at FROM workshop_audit WHERE post_id = ? ORDER BY review_version DESC LIMIT ?', [id, limit], audit);
}
function checkNote(note) {
  if (typeof note !== 'string' || [...note].length > 300 || INVALID_CONTROLS.test(note) || (typeof note.isWellFormed === 'function' && !note.isWellFormed())) fail('invalid_moderation_note');
}
function destination(action, current, latest) {
  if (action === 'accept') {
    if (current.review_state === 'pending') return 'accepted';
    if (current.review_state === 'accepted') return null;
  } else if (action === 'reject') {
    if (current.review_state === 'pending') return 'rejected';
    if (current.review_state === 'rejected') return null;
  } else if (action === 'hide') {
    if (current.review_state === 'accepted') return 'hidden';
    if (current.review_state === 'hidden') return null;
  } else if (action === 'restore') {
    if (current.review_state === 'hidden') return 'accepted';
    if (current.review_state === 'rejected') return 'pending';
    if (latest && latest.action === 'restore' && latest.review_version === current.review_version && latest.to_state === current.review_state) return null;
  }
  fail('invalid_review_transition');
}
/** Atomic local decision: original content is never assigned, replaced, or deleted. */
export function transitionPost(sqlite, { id, action, note = '', expectedVersion, clock = Date.now } = {}) {
  checkId(id);
  if (!ACTIONS.includes(action)) fail('invalid_review_action');
  checkNote(note);
  if (typeof clock !== 'function') fail('invalid_moderation_clock');
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) fail('invalid_expected_version');
  assertWorkshopSchema(sqlite);
  if (sqlite.isTransaction === true) fail('moderation_transaction_active');
  let began = false;
  try {
    sqlite.exec('BEGIN IMMEDIATE'); began = true;
    const current = sqlite.prepare('SELECT id, review_state, review_version FROM workshop_posts WHERE id = ? LIMIT 1').get(id);
    if (!current) fail('post_not_found');
    if (!STATES.includes(current.review_state) || !Number.isSafeInteger(current.review_version) || current.review_version < 1) fail('invalid_persisted_review_state');
    if (expectedVersion !== undefined && expectedVersion !== current.review_version) fail('stale_review_version');
    const latest = action === 'restore' ? sqlite.prepare('SELECT action, review_version, to_state FROM workshop_audit WHERE post_id = ? ORDER BY review_version DESC LIMIT 1').get(id) : null;
    const next = destination(action, current, latest);
    if (next === null) {
      sqlite.exec('COMMIT'); began = false;
      return { id, reviewState: current.review_state, reviewVersion: current.review_version, changed: false };
    }
    if (current.review_version >= Number.MAX_SAFE_INTEGER) fail('review_version_exhausted');
    const at = clock(); if (!Number.isSafeInteger(at) || at < 0) fail('invalid_moderation_clock');
    const version = current.review_version + 1;
    const update = sqlite.prepare('UPDATE workshop_posts SET review_state = ?, review_version = ? WHERE id = ? AND review_version = ? AND review_state = ?').run(next, version, id, current.review_version, current.review_state);
    if (Number(update.changes) !== 1) fail('stale_review_version');
    sqlite.prepare('INSERT INTO workshop_audit (post_id, review_version, from_state, to_state, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, version, current.review_state, next, action, note, at);
    sqlite.exec('COMMIT'); began = false;
    return { id, reviewState: next, reviewVersion: version, changed: true };
  } catch (cause) {
    if (began) { try { sqlite.exec('ROLLBACK'); } catch { fail('moderation_transaction_failed'); } }
    if (cause instanceof ModerationError) throw cause;
    fail('moderation_transaction_failed');
  }
}
