import { PUBLIC_ARTICLES, SOURCE_CATALOG } from '../wiki-core.mjs';

/** Same-Site read-only D1 foundation. No visitor data, identity, or public writes. */
const MAX_PAYLOAD_BYTES = 32 * 1024;
const SQL_SELECT = 'SELECT revision_id, article_id, payload_sha256, payload_json FROM public_knowledge_revisions WHERE revision_id = ? LIMIT 1';
const SQL_INSERT = 'INSERT OR IGNORE INTO public_knowledge_revisions (revision_id, article_id, payload_sha256, payload_json, created_at) VALUES (?, ?, ?, ?, ?)';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const encoder = new TextEncoder();
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const sourceContext = (source) => source?.contextId ?? source?.sceneId;
const publicSourceOK = (source) => source && typeof source.id === 'string' && typeof source.text === 'string'
  && typeof source.author === 'string' && source.verification === 'unverified'
  && typeof sourceContext(source) === 'string' && sourceContext(source).length > 0
  && ((source.scope === 'public-synthetic' && source.origin === 'script' && source.synthetic === true)
    || (source.scope === 'public-curated' && source.origin === 'curated' && source.synthetic === false
      && source.sourceKind === 'project-collaboration-summary'));
const publicArticleOK = (article) => article && typeof article.id === 'string' && typeof article.title === 'string'
  && typeof article.body === 'string' && article.verification === 'unverified'
  && Number.isInteger(article.version) && article.version >= 1 && article.publicationStatus === 'public-read-only'
  && ((article.scope === 'public-synthetic' && article.synthetic === true)
    || (article.scope === 'public-curated' && article.synthetic === false && article.contextId === article.id
      && typeof article.footer === 'string'));

function response(body, status = 200, contentType = 'application/json; charset=utf-8', headers = {}) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, ...headers } });
}
const json = (value, status = 200, headers) => response(JSON.stringify(value), status, 'application/json; charset=utf-8', headers);

export function createReadOnlyWikiWorker({ articles = PUBLIC_ARTICLES, sources = SOURCE_CATALOG, assets = {}, clock = Date.now } = {}) {
  if (!Array.isArray(articles) || articles.length < 1 || articles.length > 8 || !Array.isArray(sources)) throw new Error('Invalid public catalogue');
  const publicSources = clone(sources);
  if (publicSources.some((source) => !publicSourceOK(source)) || new Set(publicSources.map((source) => source.id)).size !== publicSources.length) throw new Error('Only approved public source material may enter this foundation');
  const catalogue = new Map(publicSources.map((source) => [source.id, source]));
  if (new Set(articles.map((article) => article?.id)).size !== articles.length) throw new Error('Only distinct approved public articles may be persisted');
  const sealed = articles.map((article) => {
    if (!publicArticleOK(article) || !Array.isArray(article.sourceIds) || !Array.isArray(article.sources)
      || !Array.isArray(article.sections) || JSON.stringify(article.sourceIds) !== JSON.stringify(article.sources.map((source) => source?.id))) throw new Error('Only approved unverified public articles may be persisted');
    const context = article.contextId ?? sourceContext(article.sources[0]);
    const sourceIds = new Set(article.sourceIds);
    if (sourceIds.size !== article.sourceIds.length || !sourceIds.size
      || article.sources.some((source) => !publicSourceOK(source) || source.scope !== article.scope || sourceContext(source) !== context
        || JSON.stringify(source) !== JSON.stringify(catalogue.get(source.id)))
      || article.sections.some((section) => typeof section?.title !== 'string' || typeof section.text !== 'string'
        || !Array.isArray(section.sourceIds) || section.sourceIds.some((sourceId) => !sourceIds.has(sourceId)))) throw new Error('Only approved article sources from the same public context may be persisted');
    // Each sealed revision carries its own approved source context. Adding a new
    // public page must not silently change another article's historical hash.
    const contextSources = publicSources.filter((source) => source.scope === article.scope && sourceContext(source) === context);
    const payload = JSON.stringify({ article: clone(article), sources: contextSources });
    if (encoder.encode(payload).byteLength > MAX_PAYLOAD_BYTES) throw new Error('Public seed exceeds the fixed payload bound');
    return { articleId: article.id, version: article.version, payload };
  });
  const sealedPromise = Promise.all(sealed.map(async (entry) => ({ ...entry, hash: await digest(entry.payload) })));

  async function readCanonical(database) {
    const records = await sealedPromise;
    const stored = [];
    for (const record of records) {
      let row = await database.prepare(SQL_SELECT).bind(record.hash).first();
      if (!row) {
        // Only compiled approved constants are inserted. No request field reaches SQL.
        await database.prepare(SQL_INSERT).bind(record.hash, record.articleId, record.hash, record.payload, clock()).run();
        row = await database.prepare(SQL_SELECT).bind(record.hash).first();
      }
      if (!row || row.revision_id !== record.hash || row.article_id !== record.articleId || row.payload_sha256 !== record.hash || row.payload_json !== record.payload) throw new Error('Persisted public revision could not be verified');
      stored.push({ ...record, parsed: JSON.parse(row.payload_json) });
    }
    const sourceMap = new Map();
    for (const item of stored) for (const source of item.parsed.sources) sourceMap.set(source.id, source);
    const result = {
      schema: 'liubai-public-wiki', schemaVersion: 1, source: 'persistent-d1',
      articles: stored.map((item) => item.parsed.article), sources: publicSources.filter((source) => sourceMap.has(source.id)).map((source) => sourceMap.get(source.id)),
      revisions: stored.map((item) => ({ articleId: item.articleId, revisionId: item.hash, contentHash: item.hash, version: item.version })),
      writes: 'disabled',
    };
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_PAYLOAD_BYTES) throw new Error('Canonical response exceeds the fixed payload bound');
    return result;
  }

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (url.pathname.length > 200) return json({ error: 'path_too_long' }, 414);
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'read_only', writes: 'disabled' }, 405, { Allow: 'GET, HEAD' });
      if (url.pathname === '/api/wiki') {
        if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
        if (url.search) return json({ error: 'query_not_supported' }, 400);
        if (!env.DB || typeof env.DB.prepare !== 'function') return json({ error: 'shared_storage_unavailable', source: 'unavailable', writes: 'disabled' }, 503);
        try { return json(await readCanonical(env.DB)); }
        catch { return json({ error: 'shared_read_unavailable', source: 'unavailable', writes: 'disabled' }, 503); }
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : null;
      if (!asset) return response('Not found.\n', 404, 'text/plain; charset=utf-8');
      return response(request.method === 'HEAD' ? null : asset.body, 200, asset.contentType);
    },
  };
}

export default createReadOnlyWikiWorker();
