/** Synthetic minimal DOM and mocked fetch only; no HTTP, browser or private profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { initWorkshopUI } from './ui.mjs';

const KEY = 'liubai.workshop.draft.v1', PRIVATE = 'SYNTHETIC_PRIVATE_CHAT_AND_WIKI_DO_NOT_PUBLISH';
const hash = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const draft = (body = '', replyTo = null) => ({ kind: 'discussion', nickname: '合成訪客', body, replyTo });
const post = (body, seq = 1, replyTo = null) => ({ ...draft(body, replyTo), id: hash(draft(body, replyTo)), seq, createdAt: 1000, identity: 'unverified-visitor', verification: 'unverified', publication: 'public-proposal', reviewState: 'accepted', reviewVersion: 2, replyAvailability: replyTo ? 'accepted' : 'unavailable' });
const feed = (posts = [], visibleIds = posts.map((item) => item.id), nextCursor = null) => ({ schema: 'liubai-workshop', schemaVersion: 2, posts, visibleIds, nextCursor, writes: 'enabled' });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const local = (body = '', outbox = []) => ({ version: 1, draft: draft(body), outbox });
const unknown = (body) => { const payload = draft(body); return { submissionId: hash(payload), payload, status: 'unknown', createdAt: 1000 }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(record, handler, run, { failWrites = false } = {}) {
  const names = ['document', 'window', 'localStorage', 'fetch', 'crypto'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const elements = new Map();
  class Element {
    constructor(id = '') { this.children = new Map(); this.events = new Map(); this._id = id; this.innerHTML = ''; this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.open = false; if (id) elements.set('#' + id, this); }
    set id(value) { this._id = value; elements.set('#' + value, this); } get id() { return this._id; }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
    addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(callback); }
    async dispatch(name, event = {}) { for (const callback of this.events.get(name) || []) await callback(event); }
    click() { return this.dispatch('click'); } showModal() { this.open = true; } close() { this.open = false; }
    setAttribute() {} removeAttribute() {} insertBefore() {} append() {} before() {} insertAdjacentHTML() {} focus() {}
  }
  for (const selector of ['.view-tabs', 'main.main', '#open-data-info', '.clear-scope', '#clear-data-dialog .dialog-actions', '#confirm-clear-data', '#close-notebook', '#chat-view', '#wiki-view', '#tab-chat', '#tab-wiki', '#notebook-wiki']) elements.set(selector, new Element());
  const store = new Map([['lounge.prototype.v1', PRIVATE], [KEY, typeof record === 'string' ? record : JSON.stringify(record)]]);
  const reads = [], writes = [], requests = [];
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    globalThis.document = { querySelector: (selector) => elements.get(selector) ?? null, createElement: () => new Element(), body: new Element() };
    globalThis.window = new Element();
    globalThis.localStorage = { getItem(key) { reads.push(key); return store.get(key) ?? null; }, setItem(key, value) { writes.push(key); if (failWrites) throw new Error('Synthetic quota failure'); store.set(key, value); }, removeItem(key) { store.delete(key); } };
    globalThis.fetch = async (url, options) => { const request = { url, method: options.method ?? 'GET', body: options.body ?? null, credentials: options.credentials, redirect: options.redirect, referrerPolicy: options.referrerPolicy }; requests.push(request); return handler(request); };
    const ui = initWorkshopUI(), $ = (selector) => ui.root.querySelector(selector), report = (selector) => elements.get('#workshop-report-dialog').querySelector(selector);
    const action = (workshopAction, id) => ui.root.dispatch('click', { target: { closest: () => ({ dataset: { workshopAction, id } }) } });
    const edit = async (body) => { $('#workshop-body').value = body; await ui.root.dispatch('input', { target: { id: 'workshop-body' } }); };
    const submit = async () => { $('#workshop-consent').checked = true; await $('#workshop-form').dispatch('submit', { preventDefault() {} }); await tick(); };
    const submitReport = async () => { await report('#workshop-report-form').dispatch('submit', { preventDefault() {} }); await tick(); };
    await run({ ui, $, report, elements, action, edit, submit, submitReport, store, reads, writes, requests, state: () => JSON.parse(store.get(KEY)) });
    assert.deepEqual(reads, [KEY], 'chat/Wiki storage is never read');
    assert.ok(writes.every((key) => key === KEY)); assert.equal(store.get('lounge.prototype.v1'), PRIVATE);
    assert.equal(JSON.stringify(requests).includes(PRIVATE), false);
    assert.ok(requests.every((item) => item.credentials === 'omit' && item.redirect === 'error' && item.referrerPolicy === 'no-referrer'));
  } finally { for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } }
}

test('F-01: 503 removes feed and selected excerpt without changing draft, reply hash or unknown receipt', async () => {
  const source = post('SYNTHETIC_PUBLIC_CONTENT_TO_HIDE'), pending = unknown('SYNTHETIC_EARLIER_UNKNOWN_SUBMISSION'); let hidden = false;
  await fixture(local('SYNTHETIC_UNSENT_WORKSHOP_DRAFT', [pending]), () => hidden ? response({ error: 'workshop_unavailable' }, 503) : response(feed([source])), async ({ ui, $, action, state, requests }) => {
    assert.equal(requests.length, 0); ui.open(); await tick();
    assert.ok($('#workshop-posts').innerHTML.includes(source.body)); await action('reply', source.id);
    assert.ok($('#workshop-reply').innerHTML.includes(source.body)); const before = state(); hidden = true; await ui.refresh();
    assert.equal($('#workshop-posts').innerHTML.includes(source.body), false); assert.equal($('#workshop-reply').innerHTML.includes(source.body), false);
    assert.ok($('#workshop-reply').innerHTML.includes(source.id.slice(0, 12))); assert.deepEqual(state(), before);
    assert.equal($('#workshop-body').value, before.draft.body); assert.ok($('#workshop-outbox').innerHTML.includes(pending.submissionId));
    assert.equal($('#workshop-send').disabled, true); assert.equal(requests.length, 2); assert.ok(requests.every((item) => item.method === 'GET' && item.body === null));
  });
});

test('older response prunes hidden cached sources and retains only reply ID when the parent is unavailable', async () => {
  const parent = post('SYNTHETIC_PARENT_BODY_REMOVE', 2), child = post('SYNTHETIC_CHILD_BODY_KEEP', 1, parent.id); let reads = 0;
  await fixture(local('SYNTHETIC_OWN_DRAFT', [unknown('SYNTHETIC_UNKNOWN')]), () => response(++reads === 1 ? feed([parent], [parent.id, child.id], 2) : feed([{ ...child, replyAvailability: 'unavailable' }], [child.id])), async ({ ui, $, action, state }) => {
    await ui.refresh(); await action('reply', parent.id); const before = state(); await $('#workshop-older').dispatch('click'); await tick();
    assert.equal($('#workshop-posts').innerHTML.includes(parent.body), false); assert.ok($('#workshop-posts').innerHTML.includes(child.body));
    assert.ok($('#workshop-posts').innerHTML.includes('來源目前不可見')); assert.equal($('#workshop-reply').innerHTML.includes(parent.body), false); assert.deepEqual(state(), before);
  });
});

test('body-free pending metadata confirms receipt, preserves a newer local draft and does not imply publication', async () => {
  let resolvePost, submitted;
  await fixture(local('SYNTHETIC_SENT_TO_REVIEW'), (request) => request.method === 'GET' ? response(feed()) : new Promise((resolve) => { submitted = JSON.parse(request.body); resolvePost = resolve; }), async ({ ui, $, edit, submit, state, requests }) => {
    await ui.refresh(); const sending = submit(); while (!resolvePost) await tick();
    assert.equal(state().outbox[0].status, 'unknown', 'envelope is saved before POST'); await edit('SYNTHETIC_NEW_LOCAL_DRAFT');
    resolvePost(response({ status: 'received', submissionId: submitted.submissionId, reviewState: 'pending', reviewVersion: 1, duplicate: false }, 201)); await sending;
    assert.equal(state().outbox[0].status, 'received'); assert.equal(state().outbox[0].reviewState, 'pending'); assert.equal(state().draft.body, 'SYNTHETIC_NEW_LOCAL_DRAFT');
    assert.ok($('#workshop-outbox').innerHTML.includes('待審，尚未公開')); assert.ok($('#workshop-submit-status').textContent.includes('收件不等於公開'));
    assert.equal($('#workshop-posts').innerHTML.includes(submitted.body), false); assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
    assert.equal(hash({ kind: submitted.kind, nickname: submitted.nickname, body: submitted.body, replyTo: submitted.replyTo }), submitted.submissionId);
  });
});

test('older cache recalculates reply availability in both directions after parent hide then restore', async () => {
  const parent = post('SYNTHETIC_RESTORED_PARENT', 2), child = post('SYNTHETIC_CACHED_CHILD', 1, parent.id); let phase = 0;
  await fixture(local('SYNTHETIC_INDEPENDENT_DRAFT', [unknown('SYNTHETIC_UNKNOWN_TO_KEEP')]), () => response(phase === 0 ? feed([parent, child], [parent.id, child.id], 2) : phase === 1 ? feed([], [child.id], 1) : feed([], [parent.id, child.id], null)), async ({ ui, $, state, requests }) => {
    await ui.refresh(); const before = state(); assert.ok($('#workshop-posts').innerHTML.includes('來源允許展示'));
    phase = 1; await $('#workshop-older').dispatch('click'); await tick(); assert.ok($('#workshop-posts').innerHTML.includes('來源目前不可見'));
    phase = 2; await $('#workshop-older').dispatch('click'); await tick();
    assert.ok($('#workshop-posts').innerHTML.includes(child.body)); assert.equal($('#workshop-posts').innerHTML.includes('來源目前不可見'), false); assert.ok($('#workshop-posts').innerHTML.includes('來源允許展示'));
    assert.equal($('#workshop-posts').innerHTML.includes(parent.body), false, 'ID visibility does not resurrect an unrequested body'); assert.deepEqual(state(), before);
    assert.equal(requests.length, 3); assert.ok(requests.every((item) => item.method === 'GET'));
  });
});

test('echoed body or mismatching post receipt ID stays unknown without clearing the draft', async () => {
  for (const echo of [true, false]) {
    const item = unknown('SYNTHETIC_UNKNOWN_WITH_BODY');
    await fixture(local(item.payload.body, [item]), (request) => request.url === '/api/workshop/posts' ? response(feed()) : response({ status: 'received', submissionId: echo ? item.submissionId : 'f'.repeat(64), reviewState: 'pending', reviewVersion: 1, ...(echo ? { body: item.payload.body } : {}) }), async ({ ui, $, action, state, requests }) => {
      await ui.refresh(); await action('check', item.submissionId); assert.equal(state().outbox[0].status, 'unknown'); assert.equal(state().draft.body, item.payload.body);
      assert.ok($('#workshop-outbox').innerHTML.includes('結果未知')); assert.ok(requests.every((request) => request.method === 'GET'));
    });
  }
});

test('independent report sends only ID/reason/hash; unknown query/retry is manual and receipt means only received', async () => {
  const target = post('SYNTHETIC_TARGET_BODY_NEVER_SNAPSHOT'); let reports = 0, receipts = 0, envelope;
  await fixture(local('SYNTHETIC_PRIVATE_POST_DRAFT'), (request) => {
    if (request.url === '/api/workshop/posts') return response(feed([target]));
    if (request.url.startsWith('/api/workshop/report-receipt/')) { receipts += 1; return response({ status: 'not_found' }, 404); }
    assert.equal(request.url, '/api/workshop/reports'); reports += 1;
    if (reports === 1) { envelope = JSON.parse(request.body); throw new Error('Synthetic lost acknowledgement'); }
    assert.deepEqual(JSON.parse(request.body), envelope); return response({ status: 'received', reportId: envelope.reportId });
  }, async ({ ui, $, report, elements, action, submitReport, state, requests }) => {
    await ui.refresh(); await action('report', target.id);
    assert.equal(elements.get('#workshop-report-dialog').open, true); assert.equal(report('#workshop-report-target').textContent, target.id); assert.equal(report('#workshop-report-reason').value, '');
    assert.equal(elements.get('#workshop-report-dialog').innerHTML.includes(target.body), false); assert.equal(requests.length, 1);
    report('#workshop-report-reason').value = 'a'.repeat(301); await submitReport(); assert.equal(reports, 0);
    report('#workshop-report-reason').value = '  <script>synthetic()</script>  '; await submitReport();
    assert.deepEqual(Object.keys(envelope), ['postId', 'reason', 'reportId']); assert.equal(envelope.reportId, hash({ postId: target.id, reason: '<script>synthetic()</script>' }));
    assert.equal(state().reports[0].status, 'unknown'); assert.equal(state().draft.body, 'SYNTHETIC_PRIVATE_POST_DRAFT'); assert.equal($('#workshop-report-outbox').innerHTML.includes('<script>'), false);
    const before = requests.length; await tick(); assert.equal(requests.length, before, 'no automatic receipt or resend');
    await action('report-check', envelope.reportId); assert.equal(state().reports[0].status, 'unknown'); assert.equal(reports, 1); assert.equal(receipts, 1);
    await action('report-resend', envelope.reportId); assert.equal(reports, 2); assert.equal(state().reports[0].status, 'received');
    assert.ok($('#workshop-report-status').textContent.includes('不代表已處理')); assert.equal(state().draft.body, 'SYNTHETIC_PRIVATE_POST_DRAFT');
    assert.ok(requests.filter((item) => item.method === 'POST').every((item) => !item.body.includes(target.body) && !item.body.includes('SYNTHETIC_PRIVATE_POST_DRAFT')));
    await action('report', target.id); assert.equal(report('#workshop-report-reason').value, '');
  });
});

test('legacy v1 records stay intact; malformed optional reports cannot be silently overwritten', async () => {
  const legacy = { ...unknown('SYNTHETIC_LEGACY_CONFIRMED'), status: 'confirmed', note: 'Synthetic old acknowledgement' };
  await fixture(local('SYNTHETIC_LEGACY_DRAFT', [legacy]), () => response(feed()), async ({ ui, $, state, writes }) => {
    assert.deepEqual(state().outbox, [legacy]); assert.equal(writes.length, 0); assert.ok($('#workshop-outbox').innerHTML.includes('舊版本收件確認'));
    await ui.refresh(); assert.deepEqual(state().outbox, [legacy]); assert.equal(state().reports, undefined); assert.equal(writes.length, 0);
  });
  const malformed = JSON.stringify({ ...local('SYNTHETIC_MALFORMED_SOURCE', [legacy]), reports: [{ unexpected: 'SYNTHETIC_KEEP_CORRUPTED_RECORD' }] });
  await fixture(malformed, () => response(feed()), async ({ ui, $, edit, store, writes }) => {
    await ui.refresh(); await edit('SYNTHETIC_UNSAVED_EDIT'); assert.equal(store.get(KEY), malformed); assert.equal(writes.length, 0); assert.equal($('#workshop-send').disabled, true); assert.equal($('#workshop-storage-error').hidden, false);
  });
});

test('a reloaded unknown report never auto-checks or resends; only matching body-free receipt confirms it', async () => {
  const payload = { postId: post('SYNTHETIC_ACCEPTED_TARGET').id, reason: 'Synthetic persisted reason' }, reportId = hash(payload);
  const record = { ...local('SYNTHETIC_INDEPENDENT_DRAFT'), reports: [{ reportId, payload, status: 'unknown', createdAt: 1000 }] };
  let receiptCalls = 0;
  await fixture(record, (request) => request.url === '/api/workshop/posts' ? response(feed()) : response({ status: 'received', reportId, ...(++receiptCalls === 1 ? { reason: payload.reason } : {}) }), async ({ ui, $, action, state, requests, writes }) => {
    assert.equal(requests.length, 0); assert.equal(writes.length, 0); assert.ok($('#workshop-report-outbox').innerHTML.includes(reportId));
    await ui.refresh(); assert.equal(requests.length, 1); assert.equal(state().reports[0].status, 'unknown');
    await action('report-check', reportId); assert.equal(state().reports[0].status, 'unknown', 'echoed reasons are not the receipt schema');
    await action('report-check', reportId); assert.equal(state().reports[0].status, 'received'); assert.equal(state().draft.body, record.draft.body);
    assert.equal(requests.filter((request) => request.method === 'POST').length, 0); assert.ok($('#workshop-report-status').textContent.includes('不代表已處理'));
  });
});

test('report persistence failure prevents POST and labels not-sent without replacing the stored record', async () => {
  const target = post('SYNTHETIC_REPORT_TARGET'), initial = local('SYNTHETIC_ORIGINAL_DRAFT');
  await fixture(initial, () => response(feed([target])), async ({ ui, $, report, action, submitReport, store, requests }) => {
    await ui.refresh(); await action('report', target.id); report('#workshop-report-reason').value = 'Synthetic reason'; await submitReport();
    assert.equal(requests.filter((request) => request.method === 'POST').length, 0); assert.equal(store.get(KEY), JSON.stringify(initial));
    assert.ok($('#workshop-report-outbox').innerHTML.includes('未發出回報請求')); assert.ok($('#workshop-report-status').textContent.includes('未發出網路請求'));
  }, { failWrites: true });
});
