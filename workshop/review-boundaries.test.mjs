/** Review-2 regression: adapted unchanged assertions from the independent reviewer boundary suite. Only imports/schema path are relative to this candidate. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createWorkshopAPI, computeSubmissionId, normalizeSubmission } from './api.mjs';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const origin = 'https://workshop.example.invalid';
const headers = { origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json' };
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON'); sqlite.exec(schema);
  let operations = 0;
  return { sqlite, get operations() { return operations; }, prepare(sql) { operations++; return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
}
async function input(body, nickname = '合成') {
  const payload = { kind: 'discussion', nickname, body, replyTo: null };
  return { ...payload, submissionId: await computeSubmissionId(payload) };
}
const send = (api, db, raw, extra = {}, url = origin) => api.fetch(new Request(url + '/api/workshop/posts', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(raw) }), { DB: db });

test('forwarding and Host headers cannot substitute for the fixed origin or target origin', async () => {
  const db = database(), api = createWorkshopAPI({ enabled: true, allowedOrigin: origin }), body = await input('origin probe');
  const tries = [
    { origin: 'https://evil.example.invalid', host: 'workshop.example.invalid', 'x-forwarded-host': 'workshop.example.invalid' },
    { origin: origin + ':443', 'x-forwarded-proto': 'https' },
    { origin: origin + '/', 'x-forwarded-origin': origin },
    { origin: origin + ', ' + origin },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-mode': 'no-cors' },
    { 'sec-fetch-dest': '' },
  ];
  for (const h of tries) assert.equal((await send(api, db, body, h)).status, 403);
  assert.equal((await send(api, db, body, {}, 'https://evil.example.invalid')).status, 403);
  assert.equal(db.operations, 0);
  assert.equal((await send(api, db, body, { origin, host: 'wrong.invalid' })).status, 201);
  // The final synthetic request documents that Host is not an identity signal;
  // the URL + fixed Origin are authoritative, and a raw bot can forge metadata.
  db.sqlite.close();
});

test('default total payload quota uses UTF8 canonical JSON and blocks before 200 large posts', async () => {
  let now = 1700000000000;
  const db = database(), api = createWorkshopAPI({ enabled: true, allowedOrigin: origin, clock: () => now });
  let accepted = 0, canonicalBytes = 0;
  for (let n = 0; n < 200; n++) {
    const prefix = String(n).padStart(3, '0');
    const raw = await input(prefix + '😀'.repeat(1497), '名'.repeat(24));
    const requestBytes = Buffer.byteLength(JSON.stringify(raw));
    assert.ok(requestBytes <= 8192);
    const bytes = Buffer.byteLength(JSON.stringify(normalizeSubmission(raw)));
    const response = await send(api, db, raw);
    if (canonicalBytes + bytes > 1048576) { assert.equal(response.status, 507); break; }
    assert.equal(response.status, 201); accepted++; canonicalBytes += bytes; now += 86400000;
  }
  assert.ok(accepted > 0 && accepted < 200);
  const stats = db.sqlite.prepare('SELECT COUNT(*) AS count, SUM(payload_bytes) AS bytes FROM workshop_posts').get();
  assert.equal(stats.count, accepted); assert.equal(stats.bytes, canonicalBytes);
  console.log(JSON.stringify({ case: 'default bytes', accepted, canonicalBytes, cap: 1048576 }));
  db.sqlite.close();
});

test('200 default totalPosts stays a hard cap after rolling quotas expire', async () => {
  let now = 1700000000000;
  const db = database(), api = createWorkshopAPI({ enabled: true, allowedOrigin: origin, clock: () => now });
  for (let n = 0; n < 200; n++) { assert.equal((await send(api, db, await input('small-' + n))).status, 201); now += 86400000; }
  assert.equal((await send(api, db, await input('small-201'))).status, 507);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM workshop_posts').get().count, 200);
  db.sqlite.close();
});

test('the API deadline covers a continuing trickle instead of resetting for each chunk', async () => {
  const db = database(), api = createWorkshopAPI({ enabled: true, allowedOrigin: origin, bodyReadTimeoutMs: 40 });
  let stopped = false, timer;
  const stream = new ReadableStream({ start(controller) {
    timer = setInterval(() => { if (!stopped) controller.enqueue(new Uint8Array([32])); }, 8);
  }, cancel() { stopped = true; clearInterval(timer); } });
  try {
    const response = await api.fetch(new Request(origin + '/api/workshop/posts', { method: 'POST', headers, body: stream, duplex: 'half' }), { DB: db });
    assert.equal(response.status, 408); assert.equal(db.operations, 0); assert.equal(stopped, true);
  } finally { stopped = true; clearInterval(timer); db.sqlite.close(); }
});
