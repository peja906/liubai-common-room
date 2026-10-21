/** Local-only append-only shared workshop. Never import this server module in client assets. */
export const REQUEST_BYTES = 8192;
export const BODY_READ_TIMEOUT_MS = 5000;
export const BODY_CODEPOINTS = 1500;
export const NICKNAME_CODEPOINTS = 24;
export const DEFAULT_LIMITS = Object.freeze({ perMinute: 6, perHour: 30, perDay: 100, totalPosts: 200, totalPayloadBytes: 1048576 });
const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const HEX = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const COLUMNS = 'seq, id, kind, nickname, body, reply_to, created_at, payload_bytes';
const FIND = `SELECT ${COLUMNS} FROM workshop_posts WHERE id = ? LIMIT 1`;
const FEED = `SELECT ${COLUMNS} FROM workshop_posts WHERE seq < ? ORDER BY seq DESC LIMIT 21`;
// SQLite/D1 evaluates every authority check in the same statement as the append.
// A preflight SELECT is only an idempotency optimization, never quota authority.
const APPEND = `INSERT INTO workshop_posts (id, kind, nickname, body, reply_to, created_at, payload_bytes)
SELECT ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM workshop_posts) < ?
  AND (SELECT COALESCE(SUM(payload_bytes), 0) FROM workshop_posts) + ? <= ?
  AND (SELECT COUNT(*) FROM workshop_posts WHERE created_at > ?) < ?
  AND (SELECT COUNT(*) FROM workshop_posts WHERE created_at > ?) < ?
  AND (SELECT COUNT(*) FROM workshop_posts WHERE created_at > ?) < ?
  AND (? IS NULL OR EXISTS (SELECT 1 FROM workshop_posts WHERE id = ?))
ON CONFLICT(id) DO NOTHING`;
const STATS = `SELECT COUNT(*) AS totalPosts, COALESCE(SUM(payload_bytes), 0) AS totalBytes,
  COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS minuteCount,
  MIN(CASE WHEN created_at > ? THEN created_at END) AS minuteOldest,
  COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS hourCount,
  MIN(CASE WHEN created_at > ? THEN created_at END) AS hourOldest,
  COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS dayCount,
  MIN(CASE WHEN created_at > ? THEN created_at END) AS dayOldest
FROM workshop_posts`;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const INVISIBLE_NAME = /[\u200b-\u200f\ufeff]/u;
const RESERVED_NAME = /openai|chatgpt|codex|gemini|muse|claude|官方|已驗證|已验证|管理員|管理员|拾微|小葵|阿光|verified|administrator|moderator/iu;
class InputError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function json(value, status = 200, additional = {}) {
  // JSON MIME + nosniff, and escape HTML delimiter characters even in a raw JSON view.
  const body = JSON.stringify(value).replace(/[<>&]/g, (character) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[character]));
  return new Response(body, { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin', ...additional,
  } });
}
const error = (code, status = 400, headers) => json({ error: code }, status, headers);
const length = (value) => [...value].length;
const wellFormed = (value) => typeof value.isWellFormed === 'function' ? value.isWellFormed() : !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);

/** Canonical input is the entire explicitly public payload, never any chat/draft state. */
export function normalizeSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('invalid_submission');
  if (Object.keys(input).some((key) => !['kind', 'nickname', 'body', 'replyTo', 'submissionId'].includes(key))) throw new InputError('unexpected_field');
  if (!['discussion', 'proposal'].includes(input.kind)) throw new InputError('invalid_kind');
  if (typeof input.body !== 'string' || (input.nickname !== undefined && typeof input.nickname !== 'string')) throw new InputError('invalid_text');
  const nickname = (input.nickname ?? '').normalize('NFKC').trim() || '訪客';
  const body = input.body.trim();
  const replyTo = input.replyTo ?? null;
  if (!wellFormed(nickname) || !wellFormed(body) || DISALLOWED_CONTROLS.test(nickname) || DISALLOWED_CONTROLS.test(body) || INVISIBLE_NAME.test(nickname)) throw new InputError('invalid_text');
  if (length(nickname) > NICKNAME_CODEPOINTS) throw new InputError('nickname_too_long');
  const foldedName = nickname.replace(/[\s\p{P}\p{S}]/gu, '');
  if (RESERVED_NAME.test(foldedName)) throw new InputError('reserved_nickname');
  if (!body || length(body) > BODY_CODEPOINTS) throw new InputError('body_length');
  if (replyTo !== null && (typeof replyTo !== 'string' || !HEX.test(replyTo))) throw new InputError('invalid_reply');
  if (input.submissionId !== undefined && (typeof input.submissionId !== 'string' || !HEX.test(input.submissionId))) throw new InputError('invalid_submission_id');
  return { kind: input.kind, nickname, body, replyTo };
}
export async function computeSubmissionId(input) {
  const canonical = JSON.stringify(normalizeSubmission(input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function publicPost(row) {
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 1 || !HEX.test(row.id) || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error('Invalid persisted workshop row');
  const payload = normalizeSubmission({ kind: row.kind, nickname: row.nickname, body: row.body, replyTo: row.reply_to });
  if (payload.nickname !== row.nickname || payload.body !== row.body || row.payload_bytes !== encoder.encode(JSON.stringify(payload)).byteLength || await computeSubmissionId(payload) !== row.id) throw new Error('Invalid persisted workshop payload');
  return { id: row.id, seq: row.seq, ...payload, identity: 'unverified-visitor', createdAt: row.created_at, verification: 'unverified', publication: 'public-proposal' };
}
async function readJson(request, timeoutMs) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new InputError('invalid_request');
  if (declared !== null && Number(declared) > REQUEST_BYTES) throw new InputError('request_too_large', 413);
  if (!request.body) throw new InputError('invalid_json');
  const reader = request.body.getReader(); const chunks = []; let size = 0, expired = false;
  // One deadline covers the entire body, rather than restarting on every chunk.
  // Cancellation itself may stall in an underlying stream, so never await it.
  const cancelReader = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new InputError('request_read_timeout', 408));
      cancelReader();
    }, timeoutMs);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (expired) throw new InputError('request_read_timeout', 408);
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_BYTES) { cancelReader(); throw new InputError('request_too_large', 413); }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof InputError) throw cause;
    throw new InputError('request_incomplete');
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InputError('invalid_json'); }
}
function validOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try { const parsed = new URL(origin); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin; }
  catch { return false; }
}
function postOriginAllowed(request, origin) {
  return request.headers.get('origin') === origin
    && request.headers.get('sec-fetch-site') === 'same-origin'
    && ['cors', 'same-origin'].includes(request.headers.get('sec-fetch-mode'))
    && request.headers.get('sec-fetch-dest') === 'empty';
}
function validatedLimits(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw new TypeError('Invalid server workshop limits');
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_LIMITS)) if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > DEFAULT_LIMITS[key]) throw new TypeError('Server limits may only lower the fixed maximum');
  return Object.freeze(result);
}

export function createWorkshopAPI({ enabled = false, visible = true, allowedOrigin = null, clock = Date.now, limits = {}, bodyReadTimeoutMs = BODY_READ_TIMEOUT_MS } = {}) {
  if (typeof enabled !== 'boolean' || !['boolean', 'function'].includes(typeof visible) || typeof clock !== 'function') throw new TypeError('Server-only workshop configuration required');
  if ((enabled || allowedOrigin !== null) && !validOrigin(allowedOrigin)) throw new TypeError('Exact configured workshop origin required');
  if (!Number.isSafeInteger(bodyReadTimeoutMs) || bodyReadTimeoutMs < 1 || bodyReadTimeoutMs > BODY_READ_TIMEOUT_MS) throw new TypeError('Server body deadline may only lower the fixed maximum');
  const quota = validatedLimits(limits);
  const isBoardVisible = () => {
    try { return (typeof visible === 'function' ? visible() : visible) === true; }
    catch { return false; }
  };
  const hidden = (method, writeMayHaveStarted = false) => error(method === 'POST' && writeMayHaveStarted ? 'submission_result_unknown' : 'workshop_unavailable', 503);
  // Every public-content response is constructed only after its asynchronous
  // reads/validation finish, with a final synchronous fail-closed visibility gate.
  const publicJson = (method, value, status = 200) => isBoardVisible() ? json(value, status) : hidden(method, method === 'POST');
  const find = (database, id) => database.prepare(FIND).bind(id).first();
  const confirmedPost = async (row, expected) => {
    const post = await publicPost(row);
    if (expected && JSON.stringify({ kind: post.kind, nickname: post.nickname, body: post.body, replyTo: post.replyTo }) !== JSON.stringify(expected)) throw new Error('Persisted payload mismatch');
    return post;
  };

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (url.pathname.length > 200 || url.search.length > 80) return error('request_target_too_long', 414);
      const isFeed = url.pathname === '/api/workshop/posts';
      const receipt = /^\/api\/workshop\/receipt\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!isFeed && !receipt) return error('not_found', 404);
      if (!isBoardVisible()) return hidden(request.method);
      if (!['GET', 'POST'].includes(request.method) || (receipt && request.method !== 'GET')) return error('method_not_allowed', 405, { Allow: isFeed ? 'GET, POST' : 'GET' });
      if (request.method === 'POST') {
        if (!enabled) return error('public_submissions_disabled', 503);
        if (url.search) return error('query_not_supported');
        if (url.origin !== allowedOrigin || !postOriginAllowed(request, allowedOrigin)) return error('same_origin_required', 403);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return error('json_required', 415);
      }
      if (!env.DB || typeof env.DB.prepare !== 'function') return error('workshop_unavailable', 503);
      const database = env.DB;
      let writeMayHaveStarted = false;
      try {
        if (request.method === 'GET') {
          if (receipt) {
            if (url.search) return error('query_not_supported');
            const row = await find(database, receipt[1]);
            if (!isBoardVisible()) return hidden(request.method);
            if (!row) return json({ status: 'not_found' }, 404);
            const post = await publicPost(row);
            return publicJson(request.method, { status: 'confirmed', post });
          }
          if ([...url.searchParams.keys()].some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) return error('query_not_supported');
          const cursorText = url.searchParams.get('cursor');
          if (cursorText !== null && (!/^\d{1,10}$/.test(cursorText) || Number(cursorText) < 1 || Number(cursorText) > 2147483647)) return error('invalid_cursor');
          const rows = await database.prepare(FEED).bind(cursorText === null ? 2147483647 : Number(cursorText)).all();
          if (!isBoardVisible()) return hidden(request.method);
          if (!Array.isArray(rows?.results) || rows.results.length > 21) throw new Error('Invalid database read');
          const page = rows.results.slice(0, 20);
          const posts = await Promise.all(page.map(publicPost));
          return publicJson(request.method, { schema: 'liubai-workshop', schemaVersion: 1, posts, nextCursor: rows.results.length > 20 ? page.at(-1).seq : null, writes: enabled ? 'enabled' : 'disabled' });
        }
        const input = await readJson(request, bodyReadTimeoutMs);
        if (!isBoardVisible()) return hidden(request.method);
        const payload = normalizeSubmission(input);
        if (!input.submissionId) return error('submission_id_required');
        const id = await computeSubmissionId(payload);
        if (!isBoardVisible()) return hidden(request.method);
        if (id !== input.submissionId) return error('submission_id_mismatch');
        const bytes = encoder.encode(JSON.stringify(payload)).byteLength;
        const previous = await find(database, id);
        if (!isBoardVisible()) return hidden(request.method);
        if (previous) {
          const post = await confirmedPost(previous, payload);
          return publicJson(request.method, { status: 'confirmed', duplicate: true, post });
        }
        const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid server clock');
        let writeError = false, inserted = false;
        try {
          // This check prevents an append not yet handed to the database. Once
          // run() has begun, hiding cannot retroactively cancel or undo its SQL.
          if (!isBoardVisible()) return hidden(request.method);
          writeMayHaveStarted = true;
          const result = await database.prepare(APPEND).bind(id, payload.kind, payload.nickname, payload.body, payload.replyTo, now, bytes,
            quota.totalPosts, bytes, quota.totalPayloadBytes,
            now - MINUTE, quota.perMinute, now - HOUR, quota.perHour, now - DAY, quota.perDay,
            payload.replyTo, payload.replyTo).run();
          inserted = Number(result?.meta?.changes ?? result?.changes) === 1;
        } catch { writeError = true; }
        if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
        // A timed-out write may still commit. Confirm only by reading its immutable row.
        const row = await find(database, id);
        if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
        if (row) {
          const post = await confirmedPost(row, payload);
          return publicJson(request.method, { status: 'confirmed', duplicate: !inserted, post }, inserted ? 201 : 200);
        }
        if (writeError) return error('submission_result_unknown', 503);
        if (payload.replyTo !== null) {
          const parent = await find(database, payload.replyTo);
          if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
          if (!parent) return error('reply_not_found');
        }
        const stats = await database.prepare(STATS).bind(now - MINUTE, now - MINUTE, now - HOUR, now - HOUR, now - DAY, now - DAY).first();
        if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
        if (!stats) throw new Error('Quota unavailable');
        if (stats.totalPosts >= quota.totalPosts || stats.totalBytes + bytes > quota.totalPayloadBytes) return error('workshop_capacity_reached', 507);
        const blocked = [
          [stats.minuteCount, quota.perMinute, stats.minuteOldest, MINUTE],
          [stats.hourCount, quota.perHour, stats.hourOldest, HOUR],
          [stats.dayCount, quota.perDay, stats.dayOldest, DAY],
        ].filter(([count, maximum]) => count >= maximum);
        if (blocked.length) {
          const retryAfter = Math.max(1, ...blocked.map(([, , oldest, window]) => Math.ceil((oldest + window - now) / 1000)));
          return error('workshop_rate_limited', 429, { 'Retry-After': String(retryAfter) });
        }
        return error('submission_result_unknown', 503);
      } catch (cause) {
        if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
        if (cause instanceof InputError) return error(cause.code, cause.status);
        return error(request.method === 'POST' ? 'submission_result_unknown' : 'workshop_unavailable', 503);
      }
    },
  };
}
export default createWorkshopAPI();
