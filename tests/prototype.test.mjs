import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, setDraft, beginSend, resolveReceipt, loadState, saveState,
  startDemoRound, nextDemoMessage, setPaused, DEMO_LIMIT, STORAGE_KEY,
} from '../core.mjs';
import {
  PUBLIC_ARTICLES, SOURCE_CATALOG, ensureWiki, retainExcerpt, createProposal,
  setProposalDraft, saveRevision, addDissent, compareRevisions, searchWiki,
  exportProposal,
} from '../wiki-core.mjs';
import { createReadOnlyWikiWorker } from '../shared-foundation/worker.mjs';
import { createHash } from 'node:crypto';

const request = (path = '/api/wiki', method = 'GET', extra = {}) =>
  new Request(`https://example.invalid${path}`, { method, ...extra });
const clone = (value) => JSON.parse(JSON.stringify(value));
const sourceContext = (source) => source.contextId ?? source.sceneId;

test('the public catalogue separates ten synthetic sources from three collaboration summaries', () => {
  assert.equal(PUBLIC_ARTICLES.length, 2);
  assert.equal(SOURCE_CATALOG.length, 13);
  assert.equal(new Set(SOURCE_CATALOG.map((source) => source.id)).size, 13);
  const synthetic = SOURCE_CATALOG.filter((source) => source.scope === 'public-synthetic');
  const curated = SOURCE_CATALOG.filter((source) => source.scope === 'public-curated');
  assert.equal(synthetic.length, 10);
  assert.equal(curated.length, 3);
  assert.ok(synthetic.every((source) => source.synthetic && source.origin === 'script' && sourceContext(source) === 'old-park-photo'));
  assert.ok(curated.every((source) => !source.synthetic && source.origin === 'curated' && sourceContext(source) === 'base-how-we-gather'));
  const article = PUBLIC_ARTICLES.find((item) => item.id === 'base-how-we-gather');
  assert.equal(article.title, '進來坐坐：基地怎麼相處');
  assert.equal(article.synthetic, false);
  assert.deepEqual(article.sourceIds, curated.map((source) => source.id));
  assert.deepEqual(article.sections.map((section) => section.title), ['一起相處', '哲學討論・開放問題']);
  assert.match(article.body, /不是模型具有主觀感受的證明/);
  assert.match(article.footer, /模型尚未自動連接/);
});

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem(key) { assert.equal(key, STORAGE_KEY); return value; },
    setItem(key, next) { assert.equal(key, STORAGE_KEY); value = next; },
    value: () => value,
  };
}

// An in-memory API double, not SQLite or a live Cloudflare D1 database.
function mockDatabase() {
  const rows = new Map();
  const inserts = [];
  return {
    rows, inserts,
    prepare(sql) {
      assert.match(sql, /^(SELECT|INSERT OR IGNORE INTO) /);
      return { bind(...args) {
        return {
          async first() { assert.match(sql, /^SELECT /); return rows.get(args[0]) ?? null; },
          async run() {
            assert.match(sql, /^INSERT OR IGNORE INTO /);
            inserts.push(args);
            const [revision_id, article_id, payload_sha256, payload_json, created_at] = args;
            if (!rows.has(revision_id)) rows.set(revision_id, { revision_id, article_id, payload_sha256, payload_json, created_at });
          },
        };
      } };
    },
  };
}

test('local receipt resolution does not send or duplicate a message', () => {
  const state = createState();
  const text = '<script>not executable data</script>';
  setDraft(state, text, state.messages[0].id);
  const message = beginSend(state, { simulateDisconnect: true });
  assert.equal(message.status, 'unknown');
  assert.equal(message.text, text);
  assert.equal(state.draft.text, '');
  const count = state.messages.length;
  assert.equal(resolveReceipt(state, message.id).found, true);
  assert.equal(message.status, 'confirmed');
  assert.equal(state.messages.length, count);
  assert.equal(beginSend(state, { text: '  ' }), null);
});

test('storage reload makes pending receipts unknown and preserves an unreadable record', () => {
  const state = createState();
  const pending = beginSend(state, { text: 'local example' });
  const storage = memoryStorage();
  assert.equal(saveState(storage, state).ok, true);
  const loaded = loadState(storage);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.messages.find((item) => item.id === pending.id).status, 'unknown');
  const broken = memoryStorage('{broken');
  const recovered = loadState(broken);
  assert.equal(recovered.ok, false);
  assert.equal(saveState(broken, recovered.state).ok, false);
  assert.equal(broken.value(), '{broken');
});

test('the synthetic demo is bounded and pausing stops it', () => {
  const state = createState();
  assert.equal(startDemoRound(state), true);
  const produced = Array.from({ length: DEMO_LIMIT }, () => nextDemoMessage(state));
  assert.ok(produced.every((item) => item.origin === 'script'));
  assert.match(produced[0].sceneBreak, /虛構/);
  assert.equal(nextDemoMessage(state), null);
  assert.equal(state.demo.running, false);
  assert.equal(startDemoRound(state), true);
  setPaused(state, true);
  assert.equal(nextDemoMessage(state), null);
  assert.equal(startDemoRound(state), false);
});

test('retained quotes and revisions keep their original snapshots', () => {
  const state = createState();
  const message = state.messages[0];
  const originalText = message.text;
  const clip = retainExcerpt(state, message);
  assert.equal(retainExcerpt(state, message), clip);
  const proposal = createProposal(state, { clipId: clip.id });
  message.text = 'later local edit';
  assert.equal(clip.source.text, originalText);
  assert.equal(proposal.originalSources[0].text, originalText);
  setProposalDraft(state, proposal.id, { title: 'local title', body: 'revision needle' });
  const revision = saveRevision(state, proposal.id, { note: 'second snapshot' });
  setProposalDraft(state, proposal.id, { body: 'current draft' });
  assert.equal(revision.body, 'revision needle');
  assert.equal(proposal.revisions[0].body, originalText);
  assert.ok(Object.isFrozen(revision));
  const comparison = compareRevisions(state, proposal.id, 1, 2);
  assert.ok(comparison.lines.some((line) => line.type === 'added' && line.text === 'revision needle'));
});

test('search distinguishes dissent and saved history; export stays local and independent', () => {
  const state = createState();
  const proposal = createProposal(state, { publicArticleId: PUBLIC_ARTICLES[0].id });
  setProposalDraft(state, proposal.id, { body: 'historical unique needle' });
  const revision = saveRevision(state, proposal.id);
  setProposalDraft(state, proposal.id, { body: 'current draft only' });
  const dissent = addDissent(state, proposal.id, 'dissent unique marker', { revisionId: revision.id, sourceIds: ['seed-2'] });
  assert.deepEqual(searchWiki(state, 'dissent unique marker').map((hit) => hit.type), ['dissent']);
  assert.deepEqual(searchWiki(state, 'historical unique needle').map((hit) => hit.type), ['revision']);
  const exported = exportProposal(state, proposal.id);
  assert.equal(exported.scope, 'local-private');
  assert.equal(exported.publicationStatus, 'not-published');
  assert.equal(exported.proposal.dissent[0].id, dissent.id);
  assert.equal(exported.proposal.revisions.length, 2);
  exported.proposal.draft.body = 'changed export';
  assert.equal(proposal.draft.body, 'current draft only');
  assert.equal(PUBLIC_ARTICLES[0].version, 1);
});

test('corrupt Wiki data is retained and disabled rather than overwritten', () => {
  const state = createState();
  state.wiki = { version: 'unreadable', privateExample: 'keep this' };
  const existing = state.wiki;
  assert.equal(ensureWiki(state), null);
  assert.equal(createProposal(state), null);
  assert.equal(state.wiki, existing);
  assert.equal(state.wiki.privateExample, 'keep this');
});

test('a collaboration-page proposal preserves curated attribution through versions, dissent, export and reload', () => {
  const state = createState();
  const article = PUBLIC_ARTICLES.find((item) => item.id === 'base-how-we-gather');
  const originalArticle = JSON.stringify(article);
  const proposal = createProposal(state, { publicArticleId: article.id });
  assert.equal(proposal.publicationStatus, 'not-published');
  assert.deepEqual(proposal.originalSources, article.sources);
  setProposalDraft(state, proposal.id, { body: `${article.body}\n\nlocal proposed wording` });
  const revision = saveRevision(state, proposal.id, { note: 'local example revision' });
  const dissent = addDissent(state, proposal.id, 'local alternative remains open', { revisionId: revision.id, sourceIds: [article.sourceIds[1]] });
  assert.equal(dissent.sources[0].author, 'Gemini');
  assert.equal(dissent.sources[0].origin, 'curated');
  const storage = memoryStorage();
  assert.equal(saveState(storage, state).ok, true);
  const reloaded = loadState(storage);
  assert.equal(reloaded.ok, true);
  assert.ok(ensureWiki(reloaded.state));
  const restored = reloaded.state.wiki.proposals.find((item) => item.id === proposal.id);
  assert.equal(restored.revisions.length, 2);
  assert.equal(restored.revisions[0].body, article.body);
  assert.equal(restored.revisions[1].body, `${article.body}\n\nlocal proposed wording`);
  assert.ok(Object.isFrozen(restored.revisions[1]));
  assert.deepEqual(restored.dissent[0], dissent);
  assert.deepEqual(searchWiki(reloaded.state, 'local alternative remains open').map((hit) => hit.type), ['dissent']);
  const exported = exportProposal(reloaded.state, proposal.id);
  assert.equal(exported.scope, 'local-private');
  assert.equal(exported.publicationStatus, 'not-published');
  assert.deepEqual(exported.basedOnPublicArticle, article);
  assert.deepEqual(exported.proposal.originalSources, article.sources);
  assert.equal(exported.proposal.dissent.length, 1);
  assert.equal(JSON.stringify(article), originalArticle);
});

test('Worker serves known assets, rejects writes and queries, and reports missing DB', async () => {
  const worker = createReadOnlyWikiWorker({ assets: { '/index.html': { body: '<p>example</p>', contentType: 'text/html' } } });
  const home = await worker.fetch(request('/'));
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(await home.text(), '<p>example</p>');
  assert.equal(await (await worker.fetch(request('/', 'HEAD'))).text(), '');
  assert.equal((await worker.fetch(request('/missing'))).status, 404);
  assert.equal((await worker.fetch(request('/api/wiki', 'POST', { body: 'private example' }))).status, 405);
  assert.equal((await worker.fetch(request('/api/wiki', 'DELETE'))).status, 405);
  assert.equal((await worker.fetch(request('/api/wiki?private=example'))).status, 400);
  assert.equal((await worker.fetch(request())).status, 503);
});

test('mock DB receives exactly the two compiled public seeds and reads reuse both revisions', async () => {
  const DB = mockDatabase();
  const worker = createReadOnlyWikiWorker({ clock: () => 1234 });
  const headers = { Cookie: 'private-example=do-not-persist', 'X-Local-Draft': 'do-not-persist' };
  const response = await worker.fetch(request('/api/wiki', 'GET', { headers }), { DB });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.articles, PUBLIC_ARTICLES);
  assert.deepEqual(body.sources, SOURCE_CATALOG);
  assert.equal(body.writes, 'disabled');
  assert.equal(DB.inserts.length, 2);
  for (const [index, [hash, articleId, payloadHash, payload, createdAt]] of DB.inserts.entries()) {
    const article = PUBLIC_ARTICLES[index];
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash, payloadHash);
    assert.equal(articleId, article.id);
    const context = article.contextId ?? sourceContext(article.sources[0]);
    const sources = SOURCE_CATALOG.filter((source) => source.scope === article.scope && sourceContext(source) === context);
    assert.deepEqual(JSON.parse(payload), { article, sources });
    assert.equal(createdAt, 1234);
  }
  assert.ok(!JSON.stringify(DB.inserts).includes('do-not-persist'));
  assert.equal((await worker.fetch(request(), { DB })).status, 200);
  assert.equal(DB.inserts.length, 2);
});

test('adding the collaboration page preserves the original synthetic revision hash', async () => {
  const originalArticle = PUBLIC_ARTICLES.find((article) => article.id === 'old-banyan-and-tofu');
  const originalSources = SOURCE_CATALOG.filter((source) => source.scope === 'public-synthetic');
  const expectedHash = createHash('sha256').update(JSON.stringify({ article: originalArticle, sources: originalSources })).digest('hex');
  const originalDB = mockDatabase();
  const originalWorker = createReadOnlyWikiWorker({ articles: [originalArticle], sources: originalSources });
  const originalResponse = await originalWorker.fetch(request(), { DB: originalDB });
  assert.equal(originalResponse.status, 200);
  const originalRevision = (await originalResponse.json()).revisions[0];
  const expandedDB = mockDatabase();
  const expandedResponse = await createReadOnlyWikiWorker().fetch(request(), { DB: expandedDB });
  assert.equal(expandedResponse.status, 200);
  const expandedRevision = (await expandedResponse.json()).revisions.find((revision) => revision.articleId === originalArticle.id);
  assert.equal(originalRevision.revisionId, expectedHash);
  assert.equal(expandedRevision.revisionId, expectedHash);
  assert.equal(originalDB.inserts[0][3], expandedDB.inserts.find((insert) => insert[1] === originalArticle.id)[3]);
});

test('write attempts never seed or alter even the mock public DB', async () => {
  const DB = mockDatabase();
  const worker = createReadOnlyWikiWorker();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await worker.fetch(request('/api/wiki', method, { body: 'local private example' }), { DB });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).writes, 'disabled');
  }
  assert.equal(DB.inserts.length, 0);
  assert.equal(DB.rows.size, 0);
});

test('mock DB integrity mismatch fails closed', async () => {
  const DB = mockDatabase();
  const worker = createReadOnlyWikiWorker();
  assert.equal((await worker.fetch(request(), { DB })).status, 200);
  DB.rows.values().next().value.payload_json = '{"tampered":true}';
  const response = await worker.fetch(request(), { DB });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'shared_read_unavailable');
});

test('Worker rejects private sources and inconsistent synthetic metadata before persistence', () => {
  const sources = clone(SOURCE_CATALOG);
  sources[0].scope = 'local-private';
  assert.throws(() => createReadOnlyWikiWorker({ sources }), /public source material/);
  const articles = clone(PUBLIC_ARTICLES);
  articles[0].synthetic = false;
  assert.throws(() => createReadOnlyWikiWorker({ articles }), /public articles/);
});

test('Worker rejects cross-context curated sources even when their catalogue entry matches', () => {
  const sources = clone(SOURCE_CATALOG);
  const articles = clone(PUBLIC_ARTICLES);
  const curated = sources.find((source) => source.origin === 'curated');
  curated.contextId = 'another-public-context';
  const article = articles.find((item) => item.id === 'base-how-we-gather');
  article.sources[0] = clone(curated);
  assert.throws(() => createReadOnlyWikiWorker({ articles, sources }), /same public context/);
});
