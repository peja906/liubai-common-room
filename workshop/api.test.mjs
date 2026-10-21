import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createWorkshopAPI, normalizeSubmission, computeSubmissionId, DEFAULT_LIMITS } from './api.mjs';
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const ORIGIN = 'http://127.0.0.1:4176';
const headers = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Content-Type': 'application/json' };
function database({ delayed = false } = {}) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON'); sqlite.exec(schema);
  const statements = [];
  const pause = async () => { if (delayed) await new Promise((resolve) => setImmediate(resolve)); };
  return { sqlite, statements, rows: () => sqlite.prepare('SELECT * FROM workshop_posts ORDER BY seq').all(),
    prepare(sql) { statements.push(sql); return { bind(...values) { return {
      async first() { await pause(); return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { await pause(); return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { await pause(); const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    }; } }; },
  };
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function gatedDatabase(db, gate) {
  return { prepare(sql) { const statement = db.prepare(sql); return { bind(...values) {
    const bound = statement.bind(...values);
    return Object.fromEntries(['first', 'all', 'run'].map((operation) => [operation, async () => { await gate(sql, operation); return await bound[operation](); }]));
  } }; } };
}
const enabled = (config = {}) => createWorkshopAPI({ enabled: true, allowedOrigin: ORIGIN, clock: () => 1000000000, ...config });
async function input(overrides = {}) {
  const raw = { kind: 'discussion', nickname: '同行者', body: '一則合成公開討論。', replyTo: null, ...overrides };
  return { ...raw, submissionId: await computeSubmissionId(raw) };
}
const request = (path = '/api/workshop/posts', options = {}) => new Request(ORIGIN + path, options);
const get = (api, db, path) => api.fetch(request(path), db ? { DB: db } : {});
async function send(api, db, raw, extraHeaders = {}, path = '/api/workshop/posts') {
  return api.fetch(request(path, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(raw) }), { DB: db });
}

test('default kill switch is off; no DB operation, client headers and query cannot enable it', async () => {
  const db = database(); const api = createWorkshopAPI(); const body = await input();
  for (const path of ['/api/workshop/posts', '/api/workshop/posts?enabled=true']) {
    const response = await send(api, db, body, { 'X-Workshop-Enabled': 'true' }, path);
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'public_submissions_disabled');
  }
  assert.equal(db.statements.length, 0); assert.equal(db.rows().length, 0);
});

test('normal explicit append is confirmed by readback, immutable, public-only and unverified', async () => {
  const db = database(), api = enabled(); const body = await input({ nickname: '  同行者  ', body: '  合成提案，連結 https://example.invalid 不抓取。  ' });
  const response = await send(api, db, body, { 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'SYNTHETIC-PRIVATE-UA', Cookie: 'synthetic-private-cookie=yes', 'X-Private-Draft': 'SYNTHETIC-UNSENT-DRAFT' }); assert.equal(response.status, 201);
  const value = await response.json(); assert.equal(value.status, 'confirmed'); assert.equal(value.duplicate, false);
  assert.equal(value.post.nickname, '同行者'); assert.equal(value.post.body, body.body.trim());
  assert.equal(value.post.identity, 'unverified-visitor'); assert.equal(value.post.verification, 'unverified'); assert.equal(value.post.publication, 'public-proposal');
  assert.equal(db.rows().length, 1); assert.equal(db.rows()[0].id, body.submissionId);
  assert.ok(db.statements.some((sql) => sql.startsWith('INSERT') && sql.includes('SELECT') && sql.includes('COUNT(*)') && sql.includes('ON CONFLICT(id) DO NOTHING')));
  assert.ok(!Object.keys(db.rows()[0]).some((key) => /ip|agent|cookie|private/i.test(key)));
  assert.doesNotMatch(JSON.stringify(db.rows()), /203\.0\.113\.9|SYNTHETIC-PRIVATE-UA|synthetic-private-cookie|SYNTHETIC-UNSENT-DRAFT/);
  const receipt = await get(api, db, '/api/workshop/receipt/' + body.submissionId); assert.equal(receipt.status, 200);
  assert.deepEqual((await receipt.json()).post, value.post);
});

test('exact duplicate payload and same-id retry return one confirmed row without consuming rate/capacity', async () => {
  const db = database(), api = enabled({ limits: { perMinute: 1, totalPosts: 1 } }); const body = await input();
  assert.equal((await send(api, db, body)).status, 201);
  for (let n = 0; n < 3; n += 1) { const response = await send(api, db, await input()); assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true); }
  assert.equal(db.rows().length, 1);
  const mismatch = { ...body, body: '不能沿用舊hash改寫另一段文字' };
  assert.equal((await send(api, db, mismatch)).status, 400); assert.equal(db.rows()[0].body, body.body);
});

test('parallel distinct requests cannot race past a single-statement global count cap', async () => {
  const db = database({ delayed: true }); const api = enabled({ limits: { totalPosts: 3 } });
  const bodies = await Promise.all(Array.from({ length: 12 }, (_, n) => input({ body: `並行合成 ${n}` })));
  const responses = await Promise.all(bodies.map((body) => send(api, db, body)));
  assert.equal(responses.filter((response) => response.status === 201).length, 3);
  assert.equal(responses.filter((response) => response.status === 507).length, 9);
  assert.equal(db.rows().length, 3);
});

test('parallel same-payload retries are exactly one append and all confirmed', async () => {
  const db = database({ delayed: true }), api = enabled({ limits: { totalPosts: 1, perMinute: 1 } }); const body = await input();
  const responses = await Promise.all(Array.from({ length: 8 }, () => send(api, db, body)));
  assert.ok(responses.every((response) => [200, 201].includes(response.status))); assert.equal(db.rows().length, 1);
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
});

test('global rolling minute/hour/day windows use only server time and expire at the boundary', async () => {
  for (const [key, window] of [['perMinute', 60000], ['perHour', 3600000], ['perDay', 86400000]]) {
    let now = 2000000000; const db = database(), api = enabled({ clock: () => now, limits: { [key]: 1 } });
    assert.equal((await send(api, db, await input({ body: `${key}第一則` }))).status, 201);
    const blocked = await send(api, db, await input({ body: `${key}第二則` })); assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    now += window - 1; assert.equal((await send(api, db, await input({ body: `${key}第三則` }))).status, 429);
    now += 1; assert.equal((await send(api, db, await input({ body: `${key}第四則` }))).status, 201);
    assert.equal(db.rows().length, 2);
  }
});

test('byte quota is atomic and bounded independently of post count', async () => {
  const first = await input(); const bytes = new TextEncoder().encode(JSON.stringify(normalizeSubmission(first))).byteLength;
  const db = database(), api = enabled({ limits: { totalPayloadBytes: bytes } });
  assert.equal((await send(api, db, first)).status, 201);
  assert.equal((await send(api, db, await input({ body: '額外的合成內容' }))).status, 507);
  assert.equal(db.rows().length, 1); assert.equal(db.rows()[0].payload_bytes, bytes);
});

test('cross-site, missing/null origin, navigation/form and wrong content type are denied before SQL', async () => {
  const db = database(), api = enabled(), body = await input();
  for (const extra of [{ Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': 'document' }]) {
    assert.equal((await send(api, db, body, extra)).status, 403);
  }
  const missing = { ...headers }; delete missing.Origin;
  assert.equal((await api.fetch(request(undefined, { method: 'POST', headers: missing, body: JSON.stringify(body) }), { DB: db })).status, 403);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) assert.equal((await send(api, db, body, { 'Content-Type': type })).status, 415);
  assert.equal((await send(api, db, body, { 'Content-Encoding': 'gzip' })).status, 415);
  const foreignTarget = new Request('http://other.invalid/api/workshop/posts', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await api.fetch(foreignTarget, { DB: db })).status, 403);
  assert.equal(db.statements.length, 0);
  const options = await api.fetch(request(undefined, { method: 'OPTIONS', headers: { Origin: 'https://evil.invalid' } }), { DB: db });
  assert.equal(options.status, 405); assert.equal(options.headers.get('access-control-allow-origin'), null);
});

test('unknown fields, invalid IDs, text controls, impersonation names and oversize inputs never append', async () => {
  const db = database(), api = enabled(), body = await input();
  const invalid = [
    { ...body, privateDraft: '不應上傳' }, { ...body, createdAt: 0 }, { ...body, verified: true }, { ...body, submissionId: 'x' },
    { ...body, kind: 'wiki-overwrite' }, { ...body, body: '' }, { ...body, body: '字'.repeat(1501) },
    { ...body, nickname: '名'.repeat(25) }, { ...body, nickname: 'Gemini 官方' }, { ...body, nickname: 'Ｍｕｓｅ' },
    { ...body, nickname: '管\u200b理員' }, { ...body, body: 'hi\u202eevil' }, { ...body, body: '\ud800' },
    { ...body, replyTo: 'https://example.invalid' },
  ];
  for (const candidate of invalid) assert.equal((await send(api, db, candidate)).status, 400);
  assert.equal(db.rows().length, 0);
  const over = await api.fetch(request(undefined, { method: 'POST', headers, body: JSON.stringify({ body: '字'.repeat(4000) }) }), { DB: db });
  assert.equal(over.status, 413);
  const declared = await send(api, db, body, { 'Content-Length': '9000' }); assert.equal(declared.status, 413);
  const truncated = await api.fetch(request(undefined, { method: 'POST', headers, body: '{broken' }), { DB: db }); assert.equal(truncated.status, 400);
  assert.equal(db.statements.length, 0);
});

test('streaming body cap applies without Content-Length and rejects invalid UTF8', async () => {
  const db = database(), api = enabled();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(4097)); controller.close(); } });
  const oversized = request(undefined, { method: 'POST', headers, body: stream, duplex: 'half' });
  assert.equal((await api.fetch(oversized, { DB: db })).status, 413);
  const invalid = request(undefined, { method: 'POST', headers, body: new Uint8Array([0xff, 0xfe]) });
  assert.equal((await api.fetch(invalid, { DB: db })).status, 400); assert.equal(db.statements.length, 0);
});

test('one bounded body-read deadline cancels a stalled stream before any DB access, even if cancel never settles', { timeout: 1000 }, async () => {
  const db = database(), api = enabled({ bodyReadTimeoutMs: 20 }); let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"kind":"discussion",')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const stalled = request(undefined, { method: 'POST', headers, body: stream, duplex: 'half' });
  const response = await api.fetch(stalled, { DB: db });
  assert.equal(response.status, 408); assert.equal((await response.json()).error, 'request_read_timeout');
  assert.equal(cancelled, true); assert.equal(db.statements.length, 0); assert.equal(db.rows().length, 0);
  assert.throws(() => enabled({ bodyReadTimeoutMs: 5001 }), /lower/);
  assert.throws(() => enabled({ bodyReadTimeoutMs: 0 }), /lower/);
});

test('HTML and SQL-looking text round-trip as text; no table loss or external fetch', async () => {
  const db = database(), api = enabled();
  const attack = `<script>globalThis.bad=true</script><img src="https://example.invalid/x" onerror="bad()">'; DROP TABLE workshop_posts;--`;
  const body = await input({ nickname: '<b>訪客</b>', body: attack });
  const response = await send(api, db, body); assert.equal(response.status, 201);
  const raw = await response.text(); assert.ok(!raw.includes('<script>')); assert.equal(JSON.parse(raw).post.body, attack);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get(api, db, '/api/workshop/posts')).status, 200); assert.equal(db.rows().length, 1);
  assert.ok(db.statements.every((sql) => !sql.includes(attack)));
});

test('replies only reference an existing public immutable row; no edits/deletes exist', async () => {
  const db = database(), api = enabled(); const parent = await input(); await send(api, db, parent);
  const reply = await input({ kind: 'proposal', body: '只回覆已公開內容', replyTo: parent.submissionId });
  assert.equal((await send(api, db, reply)).status, 201);
  assert.equal((await send(api, db, await input({ body: '不存在來源', replyTo: 'a'.repeat(64) }))).status, 400);
  const before = db.rows();
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await api.fetch(request(undefined, { method, headers, body: '{}' }), { DB: db })).status, 405);
  assert.deepEqual(db.rows(), before);
});

test('feed pagination is bounded, newest first, cursor-safe and receipts are public-only', async () => {
  let now = 3000000000; const db = database(), api = enabled({ clock: () => now });
  for (let n = 0; n < 25; n += 1) { now += 120000; assert.equal((await send(api, db, await input({ body: `第${n}則合成` }))).status, 201); }
  const first = await (await get(api, db, '/api/workshop/posts')).json(); assert.equal(first.posts.length, 20); assert.equal(first.nextCursor, 6);
  assert.deepEqual(first.posts.map((post) => post.seq), Array.from({ length: 20 }, (_, n) => 25 - n));
  const second = await (await get(api, db, '/api/workshop/posts?cursor=6')).json(); assert.equal(second.posts.length, 5); assert.equal(second.nextCursor, null);
  for (const path of ['/api/workshop/posts?limit=200', '/api/workshop/posts?cursor=1&cursor=2', '/api/workshop/posts?cursor=-1', '/api/workshop/posts?cursor=99999999999', '/api/workshop/receipt/' + 'a'.repeat(64) + '?private=true']) assert.equal((await get(api, db, path)).status, 400);
  assert.equal((await get(api, db, '/api/workshop/receipt/' + 'a'.repeat(64))).status, 404);
  assert.equal((await get(api, db, '/api/workshop/private-drafts')).status, 404);
});

test('server display switch hides existing posts/receipts and stops writes without deleting rows', async () => {
  let visible = true; const db = database(), api = enabled({ visible: () => visible }); const body = await input(); await send(api, db, body);
  const original = db.rows(); visible = false; const count = db.statements.length;
  for (const path of ['/api/workshop/posts', '/api/workshop/receipt/' + body.submissionId, '/api/workshop/posts?visible=true']) {
    const response = await api.fetch(request(path, { headers: { 'X-Workshop-Visible': 'true' } }), { DB: db }); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(body.body));
  }
  assert.equal((await send(api, db, await input({ body: '隱藏後不能新增' }), { 'X-Workshop-Visible': 'true' })).status, 503);
  assert.equal(db.statements.length, count); assert.deepEqual(db.rows(), original);
  visible = true; assert.equal((await get(api, db, '/api/workshop/posts')).status, 200);
});

test('in-flight feed and receipt reads fail closed after hide or a visibility callback error, without public content', async () => {
  for (const route of ['feed', 'receipt']) for (const hiddenState of [false, 'throw']) {
    let visible = true;
    const api = enabled({ visible: () => { if (visible === 'throw') throw new Error('SYNTHETIC_PRIVATE_VISIBILITY_ERROR'); return visible; } });
    const db = database(), body = await input({ body: `SYNTHETIC_INFLIGHT_${route}_TO_HIDE` }); await send(api, db, body);
    const entered = deferred(), release = deferred();
    const paused = gatedDatabase(db, async (_sql, operation) => { if (operation === (route === 'feed' ? 'all' : 'first')) { entered.resolve(); await release.promise; } });
    const responsePending = get(api, paused, route === 'feed' ? '/api/workshop/posts' : '/api/workshop/receipt/' + body.submissionId);
    await entered.promise; visible = hiddenState; release.resolve();
    const response = await responsePending; const text = await response.text();
    assert.equal(response.status, 503); assert.equal(JSON.parse(text).error, 'workshop_unavailable');
    assert.ok(!text.includes(body.body)); assert.ok(!text.includes(body.submissionId)); assert.ok(!text.includes('PRIVATE_VISIBILITY_ERROR'));
    assert.equal(db.rows().length, 1);
  }
});

test('hiding while a POST body is pending prevents any database access or append after the body completes', async () => {
  let visible = true, controller;
  const api = enabled({ visible: () => visible }), db = database(), body = await input({ body: 'SYNTHETIC_BODY_PENDING_HIDE' });
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pendingRequest = request(undefined, { method: 'POST', headers, body: stream, duplex: 'half' });
  const responsePending = api.fetch(pendingRequest, { DB: db });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(pendingRequest.body.locked, true, 'handler is awaiting the body, not merely its initial visibility gate');
  visible = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close();
  const response = await responsePending; assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(body.body));
  assert.equal(db.statements.length, 0); assert.equal(db.rows().length, 0);
});

test('hiding during preflight duplicate lookup blocks a new INSERT and also withholds an existing duplicate', async () => {
  for (const exists of [false, true]) {
    let visible = true; const api = enabled({ visible: () => visible }), db = database();
    const body = await input({ body: `SYNTHETIC_PREFLIGHT_HIDE_${exists}` }); if (exists) await send(api, db, body);
    const before = db.rows(); const baselineInserts = db.statements.filter((sql) => sql.startsWith('INSERT')).length;
    const entered = deferred(), release = deferred();
    const paused = gatedDatabase(db, async (_sql, operation) => { if (operation === 'first') { entered.resolve(); await release.promise; } });
    const responsePending = send(api, paused, body); await entered.promise; visible = false; release.resolve();
    const response = await responsePending; assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(body.body));
    assert.equal(db.statements.filter((sql) => sql.startsWith('INSERT')).length, baselineInserts); assert.deepEqual(db.rows(), before);
  }
});

test('the last visibility check immediately before handing INSERT to DB catches a hide after preflight checks', async () => {
  let visible = true; const db = database();
  const api = enabled({ visible: () => visible, clock: () => { visible = false; return 1000000000; } });
  const body = await input({ body: 'SYNTHETIC_LAST_GATE_HIDE' }); const response = await send(api, db, body);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(body.body));
  assert.ok(db.statements.some((sql) => sql.startsWith('SELECT'))); assert.ok(!db.statements.some((sql) => sql.startsWith('INSERT'))); assert.equal(db.rows().length, 0);
});

test('hiding after INSERT was handed to DB or while readback waits withholds content without pretending the write was cancelled', async () => {
  for (const pauseAt of ['run', 'readback']) {
    let visible = true, finds = 0; const db = database(), api = enabled({ visible: () => visible });
    const body = await input({ body: `SYNTHETIC_COMMIT_MAY_REMAIN_${pauseAt}` });
    const entered = deferred(), release = deferred();
    const paused = gatedDatabase(db, async (sql, operation) => {
      const point = operation === 'run' && pauseAt === 'run'
        || operation === 'first' && sql.includes('WHERE id = ? LIMIT 1') && ++finds === 2 && pauseAt === 'readback';
      if (point) { entered.resolve(); await release.promise; }
    });
    const responsePending = send(api, paused, body); await entered.promise;
    if (pauseAt === 'readback') assert.equal(db.rows().length, 1, 'INSERT already committed before receipt read');
    visible = false; release.resolve();
    const response = await responsePending; const text = await response.text(); assert.equal(response.status, 503); assert.equal(JSON.parse(text).error, 'submission_result_unknown');
    assert.ok(!text.includes(body.body)); assert.ok(!text.includes(body.submissionId)); assert.equal(db.rows().length, 1, 'hiding cannot cancel SQL already given to DB or delete the committed row');
    assert.equal((await get(api, db, '/api/workshop/receipt/' + body.submissionId)).status, 503);
    visible = true;
    const receipt = await get(api, db, '/api/workshop/receipt/' + body.submissionId); assert.equal(receipt.status, 200); assert.equal((await receipt.json()).post.body, body.body);
    const retry = await send(api, db, body); assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true); assert.equal(db.rows().length, 1);
  }
});

test('DB failures do not leak details, and a post-commit error is resolved only by row readback', async () => {
  const body = await input(); const unavailable = { prepare() { throw new Error('SECRET SQL /private/path user@example.invalid'); } };
  for (const response of [await send(enabled(), unavailable, body), await get(enabled(), unavailable, '/api/workshop/posts')]) {
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SECRET|SQL|private|example/);
  }
  const db = database(); const adapter = { prepare(sql) { const statement = db.prepare(sql); return { bind(...values) { const bound = statement.bind(...values); return { ...bound, async run() { await bound.run(); throw new Error('network timeout after commit'); } }; } }; } };
  const committed = await send(enabled(), adapter, body); assert.equal(committed.status, 200); assert.equal((await committed.json()).status, 'confirmed'); assert.equal(db.rows().length, 1);
  const missing = { prepare(sql) { const statement = db.prepare(sql); return { bind(...values) { const bound = statement.bind(...values); return { ...bound, async run() { throw new Error('unknown write result'); } }; } }; } };
  const unknown = await send(enabled(), missing, await input({ body: '未知寫入結果' })); assert.equal(unknown.status, 503); assert.equal((await unknown.json()).error, 'submission_result_unknown');
});

test('a write still unknown at readback may commit later; receipt and same-id retry converge without duplicates', async () => {
  const db = database(); let finishWrite;
  const delayedCommit = { prepare(sql) { const statement = db.prepare(sql); return { bind(...values) { const bound = statement.bind(...values); return { ...bound, async run() { finishWrite = () => bound.run(); throw new Error('timeout while server may continue'); } }; } }; } };
  const api = enabled(), body = await input({ body: '合成延後提交的結果未知' });
  const initial = await send(api, delayedCommit, body); assert.equal(initial.status, 503); assert.equal((await initial.json()).error, 'submission_result_unknown');
  assert.equal(db.rows().length, 0); assert.equal((await get(api, db, '/api/workshop/receipt/' + body.submissionId)).status, 404);
  await finishWrite();
  const receipt = await get(api, db, '/api/workshop/receipt/' + body.submissionId); assert.equal(receipt.status, 200); assert.equal((await receipt.json()).status, 'confirmed');
  const retry = await send(api, db, body); assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true); assert.equal(db.rows().length, 1);
});

test('corrupted rows fail closed; unsafe server limits cannot be expanded by clients or config', async () => {
  const db = database(), api = enabled(); const body = await input(); await send(api, db, body);
  db.sqlite.prepare('UPDATE workshop_posts SET body = ? WHERE id = ?').run('已被外部破壞', body.submissionId);
  assert.equal((await get(api, db, '/api/workshop/posts')).status, 503);
  assert.equal((await get(api, db, '/api/workshop/receipt/' + body.submissionId)).status, 503);
  assert.throws(() => enabled({ limits: { totalPosts: DEFAULT_LIMITS.totalPosts + 1 } }), /lower/);
  assert.throws(() => enabled({ allowedOrigin: '*' }), /origin/);
  assert.throws(() => enabled({ enabled: 'true' }), /configuration/);
});
