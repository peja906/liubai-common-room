/** Local-only append-only shared workshop. Never import this server module in client assets. */
export const REQUEST_BYTES = 8192;
export const BODY_READ_TIMEOUT_MS = 5000;
export const BODY_CODEPOINTS = 1500;
export const NICKNAME_CODEPOINTS = 24;
export const DEFAULT_LIMITS = Object.freeze({ perMinute: 6, perHour: 30, perDay: 100, totalPosts: 200, totalPayloadBytes: 1048576 });
const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const HEX = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const COLUMNS = 'seq, id, kind, nickname, body, reply_to, created_at, payload_bytes, review_state, review_version';
const FIND = `SELECT ${COLUMNS} FROM workshop_posts WHERE id = ? LIMIT 1`;
const POST_RECEIPT = 'SELECT id, review_state, review_version FROM workshop_posts WHERE id = ? LIMIT 1';
const FEED = `SELECT ${COLUMNS} FROM workshop_posts WHERE review_state = 'accepted' AND seq < ? ORDER BY seq DESC LIMIT 21`;
const VISIBLE = "SELECT id, review_version FROM workshop_posts WHERE review_state = 'accepted' ORDER BY seq DESC LIMIT 201";
const REPORT_COLUMNS = 'seq, id, post_id, reason, created_at, payload_bytes';
const FIND_REPORT = `SELECT ${REPORT_COLUMNS} FROM workshop_reports WHERE id = ? LIMIT 1`;
const REPORT_RECEIPT = 'SELECT id FROM workshop_reports WHERE id = ? LIMIT 1';
const EVENTS = '(SELECT created_at, payload_bytes FROM workshop_posts UNION ALL SELECT created_at, payload_bytes FROM workshop_reports)';
// Both independent append statements charge the same combined ledger. Their
// aggregate authority checks and accepted-target check are part of that INSERT.
const QUOTA_WHERE = `WHERE (SELECT COUNT(*) FROM ${EVENTS}) < ?
  AND (SELECT COALESCE(SUM(payload_bytes), 0) FROM ${EVENTS}) + ? <= ?
  AND (SELECT COUNT(*) FROM ${EVENTS} WHERE created_at > ?) < ?
  AND (SELECT COUNT(*) FROM ${EVENTS} WHERE created_at > ?) < ?
  AND (SELECT COUNT(*) FROM ${EVENTS} WHERE created_at > ?) < ?`;
const APPEND = `INSERT INTO workshop_posts (id, kind, nickname, body, reply_to, created_at, payload_bytes)
SELECT ?, ?, ?, ?, ?, ?, ?
${QUOTA_WHERE}
  AND (? IS NULL OR EXISTS (SELECT 1 FROM workshop_posts WHERE id = ? AND review_state = 'accepted'))
ON CONFLICT(id) DO NOTHING`;
const APPEND_REPORT = `INSERT INTO workshop_reports (id, post_id, reason, created_at, payload_bytes)
SELECT ?, ?, ?, ?, ?
${QUOTA_WHERE}
  AND EXISTS (SELECT 1 FROM workshop_posts WHERE id = ? AND review_state = 'accepted')
ON CONFLICT(id) DO NOTHING`;
const STATS = `SELECT COUNT(*) AS totalPosts, COALESCE(SUM(payload_bytes), 0) AS totalBytes,
  COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS minuteCount,
  MIN(CASE WHEN created_at > ? THEN created_at END) AS minuteOldest,
  COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS hourCount,
  MIN(CASE WHEN created_at > ? THEN created_at END) AS hourOldest,
  COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS dayCount,
  MIN(CASE WHEN created_at > ? THEN created_at END) AS dayOldest
FROM ${EVENTS}`;
const REVIEW_STATES = ['pending', 'accepted', 'rejected', 'hidden'];
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
const digest = async (canonical) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(canonical)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
export function normalizeReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('invalid_report');
  if (Object.keys(input).some((key) => !['postId', 'reason', 'reportId'].includes(key))) throw new InputError('unexpected_field');
  if (typeof input.postId !== 'string' || !HEX.test(input.postId)) throw new InputError('invalid_report_target');
  if (typeof input.reason !== 'string') throw new InputError('invalid_text');
  const reason = input.reason.trim();
  if (!wellFormed(reason) || DISALLOWED_CONTROLS.test(reason)) throw new InputError('invalid_text');
  if (!reason || length(reason) > 300) throw new InputError('reason_length');
  if (input.reportId !== undefined && (typeof input.reportId !== 'string' || !HEX.test(input.reportId))) throw new InputError('invalid_report_id');
  return { postId: input.postId, reason };
}
export const computeReportId = async (input) => digest(normalizeReport(input));
function reviewMetadata(row) {
  if (!row || !HEX.test(row.id) || !REVIEW_STATES.includes(row.review_state) || !Number.isSafeInteger(row.review_version) || row.review_version < 1) throw new Error('Invalid persisted review metadata');
  return { status: 'received', submissionId: row.id, reviewState: row.review_state, reviewVersion: row.review_version };
}
async function validatedPost(row, expected) {
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 1 || !HEX.test(row.id) || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error('Invalid persisted workshop row');
  reviewMetadata(row);
  const payload = normalizeSubmission({ kind: row.kind, nickname: row.nickname, body: row.body, replyTo: row.reply_to });
  if (payload.nickname !== row.nickname || payload.body !== row.body || row.payload_bytes !== encoder.encode(JSON.stringify(payload)).byteLength || await computeSubmissionId(payload) !== row.id) throw new Error('Invalid persisted workshop payload');
  if (expected && JSON.stringify(payload) !== JSON.stringify(expected)) throw new Error('Persisted payload mismatch');
  return { id: row.id, seq: row.seq, ...payload, identity: 'unverified-visitor', createdAt: row.created_at, verification: 'unverified', publication: 'public-proposal', reviewState: row.review_state, reviewVersion: row.review_version };
}
async function validatedReport(row, expected) {
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 1 || !HEX.test(row.id) || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error('Invalid persisted report row');
  const payload = normalizeReport({ postId: row.post_id, reason: row.reason });
  if (payload.reason !== row.reason || row.payload_bytes !== encoder.encode(JSON.stringify(payload)).byteLength || await computeReportId(payload) !== row.id || expected && JSON.stringify(payload) !== JSON.stringify(expected)) throw new Error('Invalid persisted report payload');
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

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (url.pathname.length > 200 || url.search.length > 80) return error('request_target_too_long', 414);
      const isFeed = url.pathname === '/api/workshop/posts';
      const isReports = url.pathname === '/api/workshop/reports';
      const receipt = /^\/api\/workshop\/receipt\/([a-f0-9]{64})$/.exec(url.pathname);
      const reportReceipt = /^\/api\/workshop\/report-receipt\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!isFeed && !isReports && !receipt && !reportReceipt) return error('not_found', 404);
      if (!isBoardVisible()) return hidden(request.method);
      if (!['GET', 'POST'].includes(request.method) || ((receipt || reportReceipt) && request.method !== 'GET') || (isReports && request.method !== 'POST')) return error('method_not_allowed', 405, { Allow: isFeed ? 'GET, POST' : isReports ? 'POST' : 'GET' });
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
          if (receipt || reportReceipt) {
            if (url.search) return error('query_not_supported');
            const isReport = !!reportReceipt, id = (receipt || reportReceipt)[1];
            const row = await database.prepare(isReport ? FIND_REPORT : FIND).bind(id).first();
            if (!isBoardVisible()) return hidden(request.method);
            if (!row) return json({ status: 'not_found' }, 404);
            if (isReport) await validatedReport(row); else await validatedPost(row);
            if (!isBoardVisible()) return hidden(request.method);
            // A second body-free read follows hash validation, so a review change
            // during that await is reflected in the receipt rather than old state.
            const latest = await database.prepare(isReport ? REPORT_RECEIPT : POST_RECEIPT).bind(id).first();
            if (!isBoardVisible()) return hidden(request.method);
            if (!latest || latest.id !== id) throw new Error('Receipt disappeared');
            return publicJson(request.method, isReport ? { status: 'received', reportId: latest.id } : reviewMetadata(latest));
          }
          if ([...url.searchParams.keys()].some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) return error('query_not_supported');
          const cursorText = url.searchParams.get('cursor');
          if (cursorText !== null && (!/^\d{1,10}$/.test(cursorText) || Number(cursorText) < 1 || Number(cursorText) > 2147483647)) return error('invalid_cursor');
          const rows = await database.prepare(FEED).bind(cursorText === null ? 2147483647 : Number(cursorText)).all();
          if (!isBoardVisible()) return hidden(request.method);
          if (!Array.isArray(rows?.results) || rows.results.length > 21) throw new Error('Invalid database read');
          const page = rows.results.slice(0, 20);
          const candidates = await Promise.all(page.map((row) => validatedPost(row)));
          if (!isBoardVisible()) return hidden(request.method);
          // This bounded final DB visibility snapshot is the individual-hide
          // boundary. No hash/read await occurs between it and Response creation.
          const current = await database.prepare(VISIBLE).bind().all();
          if (!isBoardVisible()) return hidden(request.method);
          if (!Array.isArray(current?.results) || current.results.length > 200) throw new Error('Invalid visibility snapshot');
          const versions = new Map();
          for (const row of current.results) {
            if (!HEX.test(row.id) || !Number.isSafeInteger(row.review_version) || row.review_version < 1 || versions.has(row.id)) throw new Error('Invalid visibility metadata');
            versions.set(row.id, row.review_version);
          }
          const posts = candidates.filter((post) => post.reviewState === 'accepted' && versions.get(post.id) === post.reviewVersion)
            .map((post) => ({ ...post, replyAvailability: post.replyTo !== null && versions.has(post.replyTo) ? 'accepted' : 'unavailable' }));
          return publicJson(request.method, { schema: 'liubai-workshop', schemaVersion: 2, posts, visibleIds: [...versions.keys()], nextCursor: rows.results.length > 20 ? page.at(-1).seq : null, writes: enabled ? 'enabled' : 'disabled' });
        }
        const input = await readJson(request, bodyReadTimeoutMs);
        if (!isBoardVisible()) return hidden(request.method);
        const payload = isReports ? normalizeReport(input) : normalizeSubmission(input);
        const requestedId = isReports ? input.reportId : input.submissionId;
        if (!requestedId) return error(isReports ? 'report_id_required' : 'submission_id_required');
        const id = await (isReports ? computeReportId(payload) : computeSubmissionId(payload));
        if (!isBoardVisible()) return hidden(request.method);
        if (id !== requestedId) return error(isReports ? 'report_id_mismatch' : 'submission_id_mismatch');
        const bytes = encoder.encode(JSON.stringify(payload)).byteLength;
        const findCurrent = () => database.prepare(isReports ? FIND_REPORT : FIND).bind(id).first();
        const received = async (row, duplicate) => {
          if (isReports) await validatedReport(row, payload); else await validatedPost(row, payload);
          if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
          const latest = await database.prepare(isReports ? REPORT_RECEIPT : POST_RECEIPT).bind(id).first();
          if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
          if (!latest || latest.id !== id) throw new Error('Receipt disappeared');
          const value = isReports ? { status: 'received', reportId: latest.id } : { ...reviewMetadata(latest), duplicate };
          return publicJson(request.method, value, duplicate ? 200 : 201);
        };
        const previous = await findCurrent();
        if (!isBoardVisible()) return hidden(request.method);
        if (previous) return await received(previous, true);
        const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid server clock');
        let writeError = false, inserted = false;
        try {
          // This check prevents an append not yet handed to the database. Once
          // run() has begun, hiding cannot retroactively cancel or undo its SQL.
          if (!isBoardVisible()) return hidden(request.method);
          writeMayHaveStarted = true;
          const quotaValues = [quota.totalPosts, bytes, quota.totalPayloadBytes, now - MINUTE, quota.perMinute, now - HOUR, quota.perHour, now - DAY, quota.perDay];
          const values = isReports
            ? [id, payload.postId, payload.reason, now, bytes, ...quotaValues, payload.postId]
            : [id, payload.kind, payload.nickname, payload.body, payload.replyTo, now, bytes, ...quotaValues, payload.replyTo, payload.replyTo];
          const result = await database.prepare(isReports ? APPEND_REPORT : APPEND).bind(...values).run();
          inserted = Number(result?.meta?.changes ?? result?.changes) === 1;
        } catch { writeError = true; }
        if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
        // A timed-out write may still commit. Confirm only by reading its immutable row.
        const row = await findCurrent();
        if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
        if (row) return await received(row, !inserted);
        if (writeError) return error('submission_result_unknown', 503);
        const targetId = isReports ? payload.postId : payload.replyTo;
        if (targetId !== null) {
          const parent = await find(database, targetId);
          if (!isBoardVisible()) return hidden(request.method, writeMayHaveStarted);
          if (!parent || parent.review_state !== 'accepted') return error(isReports ? 'target_not_accepted' : 'reply_not_accepted');
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
