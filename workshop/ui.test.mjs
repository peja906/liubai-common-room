/** F-01 regression: synthetic minimal DOM and mocked fetch only, no HTTP or browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initWorkshopUI } from './ui.mjs';

const WORKSHOP_KEY = 'liubai.workshop.draft.v1';

test('503 feed removes the selected public excerpt while preserving draft, reply hash and unknown receipt without auto POST/private reads', async () => {
  const names = ['document', 'window', 'localStorage', 'fetch'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const elements = new Map();
  class Element {
    constructor(id = '') {
      this.children = new Map(); this.events = new Map(); this._id = id;
      this.innerHTML = ''; this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
      if (id) elements.set('#' + id, this);
    }
    set id(value) { this._id = value; elements.set('#' + value, this); }
    get id() { return this._id; }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
    addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(callback); }
    async dispatch(name, event = {}) { for (const callback of this.events.get(name) || []) await callback(event); }
    click() { return this.dispatch('click'); }
    setAttribute() {} removeAttribute() {} insertBefore() {} append() {} before() {} insertAdjacentHTML() {} focus() {} showModal() {} close() {}
  }
  for (const selector of ['.view-tabs', 'main.main', '#open-data-info', '.clear-scope', '#clear-data-dialog .dialog-actions', '#confirm-clear-data', '#close-notebook', '#chat-view', '#wiki-view', '#tab-chat', '#tab-wiki', '#notebook-wiki']) elements.set(selector, new Element());
  const privateCanary = 'SYNTHETIC_PRIVATE_CHAT_AND_WIKI_DO_NOT_PUBLISH';
  const removedBody = 'SYNTHETIC_PUBLIC_CONTENT_TO_HIDE';
  const draft = { kind: 'discussion', nickname: '合成訪客', body: 'SYNTHETIC_UNSENT_WORKSHOP_DRAFT', replyTo: null };
  const unknownPayload = { kind: 'proposal', nickname: '合成訪客', body: 'SYNTHETIC_EARLIER_UNKNOWN_SUBMISSION', replyTo: null };
  const unknownId = createHash('sha256').update(JSON.stringify(unknownPayload)).digest('hex');
  const outbox = [{ submissionId: unknownId, payload: unknownPayload, status: 'unknown', createdAt: 1000, note: 'Synthetic lost acknowledgement' }];
  const store = new Map([
    ['lounge.prototype.v1', privateCanary],
    [WORKSHOP_KEY, JSON.stringify({ version: 1, draft, outbox })],
  ]);
  const storageReads = [], storageWrites = [], requests = [];
  const publicPayload = { kind: 'discussion', nickname: '合成名稱', body: removedBody, replyTo: null };
  const id = createHash('sha256').update(JSON.stringify(publicPayload)).digest('hex');
  const publicPost = { ...publicPayload, id, seq: 1, createdAt: 1000, identity: 'unverified-visitor', verification: 'unverified', publication: 'public-proposal' };
  let hidden = false;
  try {
    globalThis.document = { querySelector: (selector) => elements.get(selector) ?? null, createElement: () => new Element(), body: new Element() };
    globalThis.window = new Element();
    globalThis.localStorage = {
      getItem(key) { storageReads.push(key); return store.get(key) ?? null; },
      setItem(key, value) { storageWrites.push(key); store.set(key, value); },
      removeItem(key) { store.delete(key); },
    };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/workshop/posts');
      requests.push({ url, method: options.method ?? 'GET', body: options.body ?? null, credentials: options.credentials });
      const payload = hidden ? { error: 'workshop_unavailable' } : { schema: 'liubai-workshop', schemaVersion: 1, posts: [publicPost], nextCursor: null, writes: 'enabled' };
      return new Response(JSON.stringify(payload), { status: hidden ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
    };
    const ui = initWorkshopUI();
    assert.equal(requests.length, 0, 'initialization never submits or fetches private contents');
    assert.deepEqual(storageReads, [WORKSHOP_KEY]);
    assert.equal(ui.root.querySelector('#workshop-body').value, draft.body);
    assert.ok(ui.root.querySelector('#workshop-outbox').innerHTML.includes(unknownId));
    ui.open(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.ok(ui.root.querySelector('#workshop-posts').innerHTML.includes(removedBody));
    await ui.root.dispatch('click', { target: { closest: () => ({ dataset: { workshopAction: 'reply', id } }) } });
    assert.ok(ui.root.querySelector('#workshop-reply').innerHTML.includes(removedBody), 'counterexample starts with the selected public excerpt');
    const before503 = JSON.parse(store.get(WORKSHOP_KEY));
    assert.equal(before503.draft.replyTo, id);
    hidden = true; await ui.refresh();
    assert.equal(ui.root.querySelector('#workshop-posts').innerHTML.includes(removedBody), false);
    assert.equal(ui.root.querySelector('#workshop-reply').innerHTML.includes(removedBody), false, 'the selected source preview must also stop showing the old public body');
    assert.ok(ui.root.querySelector('#workshop-reply').innerHTML.includes(id.slice(0, 12)), 'the source remains identified by its public hash');
    assert.equal(ui.root.querySelector('#workshop-body').value, draft.body);
    assert.deepEqual(JSON.parse(store.get(WORKSHOP_KEY)), before503, 'refresh must not rewrite or delete local draft/outbox');
    assert.equal(before503.outbox[0].submissionId, unknownId); assert.equal(before503.outbox[0].status, 'unknown');
    assert.ok(ui.root.querySelector('#workshop-outbox').innerHTML.includes(unknownId));
    assert.equal(ui.root.querySelector('#workshop-send').disabled, true);
    assert.equal(requests.length, 2); assert.ok(requests.every((request) => request.method === 'GET' && request.body === null && request.credentials === 'omit'));
    assert.deepEqual(storageReads, [WORKSHOP_KEY], 'chat/Wiki storage is never read');
    assert.ok(storageWrites.every((key) => key === WORKSHOP_KEY));
    assert.equal(store.get('lounge.prototype.v1'), privateCanary);
    assert.equal(JSON.stringify(requests).includes(privateCanary), false);
  } finally {
    for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
