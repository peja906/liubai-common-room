/**
 * LOCAL-ONLY workshop overlay. Production build and hosting remain untouched.
 * Reuses the current lounge assets and read-only Wiki Worker; adds a loopback
 * workshop API backed by Node's built-in SQLite through a D1-shaped adapter.
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath, lstat, open } from 'node:fs/promises';
import { dirname, resolve, join, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createReadOnlyWikiWorker } from '../shared-foundation/worker.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, '..');
const MAX_TRANSPORT_BYTES = 8 * 1024;
// Starts only after Node has delivered the complete request headers. This is
// an application deadline for the whole body, not an idle/slow-header timer.
const BODY_DEADLINE_MS = 5000;
const MIME_JSON = 'application/json; charset=utf-8';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const files = {
  'index.html': 'text/html; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'app.mjs': 'text/javascript; charset=utf-8',
  'core.mjs': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
  'wiki-core.mjs': 'text/javascript; charset=utf-8',
  'wiki-ui.mjs': 'text/javascript; charset=utf-8',
  'wiki.css': 'text/css; charset=utf-8',
};

function argumentsForPreview(args) {
  const config = { port: 4176, databasePath: `/tmp/liubai-workshop-preview-${process.pid}.sqlite`, enabled: false, visible: true };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--enable-public-submissions') config.enabled = true;
    else if (argument === '--hide-public-board') config.visible = false;
    else if (argument === '--port' || argument === '--db') {
      const value = args[++index];
      if (value === undefined) throw new Error('invalid_preview_arguments');
      if (argument === '--port') {
        if (!/^\d{1,5}$/.test(value)) throw new Error('invalid_preview_port');
        config.port = Number(value);
        if (config.port < 0 || config.port > 65535) throw new Error('invalid_preview_port');
      } else config.databasePath = resolve(value);
    } else throw new Error('unknown_preview_argument');
  }
  return config;
}

async function requireLocalQaDatabase(filename) {
  // Never open another project's or a browser profile's database. Explicit QA
  // paths must have this prototype's prefix and an existing temporary parent.
  if (!/^liubai-workshop-[A-Za-z0-9._-]+\.sqlite$/.test(basename(filename))) throw new Error('qa_database_name_required');
  const parent = await realpath(dirname(filename));
  const temporaryRoots = await Promise.all(['/tmp', tmpdir()].map((path) => realpath(path)));
  if (!temporaryRoots.some((path) => parent === path || parent.startsWith(path + sep))) throw new Error('temporary_database_required');
  const existing = await lstat(filename).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
    || (typeof process.getuid === 'function' && existing.uid !== process.getuid()))) throw new Error('qa_database_must_be_regular_file');
  return existing;
}

function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const methods = (parameters) => ({
        async first(column) {
          const row = statement.get(...parameters) ?? null;
          return row && column !== undefined ? row[column] ?? null : row;
        },
        async all() { return { success: true, results: statement.all(...parameters), meta: {} }; },
        async run() {
          const result = statement.run(...parameters);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      });
      return { ...methods([]), bind(...parameters) { return methods(parameters); } };
    },
  };
}

function localError(outgoing, status, error, head = false, close = false) {
  if (outgoing.headersSent || outgoing.destroyed) return;
  const body = JSON.stringify({ error });
  outgoing.writeHead(status, {
    'Content-Type': MIME_JSON, 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    ...(close ? { Connection: 'close' } : {}),
  });
  outgoing.end(head ? undefined : body);
}

function stopBodyAndClose(incoming, outgoing, status, error) {
  // Do not await iterator cancellation, peer completion, or a graceful close.
  // Pause input immediately, try to flush the small error, then force closure
  // within a bounded grace period even if the peer keeps transmitting.
  incoming.pause();
  const ignoreStoppedInputError = () => {};
  incoming.on('error', ignoreStoppedInputError);
  incoming.once('close', () => incoming.off('error', ignoreStoppedInputError));
  const socket = incoming.socket;
  if (socket.destroyed) return;
  const forceClose = setTimeout(() => socket.destroy(), 200);
  forceClose.unref();
  const clearForceClose = () => clearTimeout(forceClose);
  socket.once('close', clearForceClose);
  outgoing.once('finish', () => { if (!socket.destroyed) socket.end(); });
  localError(outgoing, status, error, false, true);
}

function boundedBody(incoming, outgoing) {
  return new Promise((resolve) => {
    const chunks = []; let length = 0; let settled = false; let deadline;
    const cleanup = () => {
      clearTimeout(deadline);
      incoming.off('data', onData);
      incoming.off('end', onEnd);
      incoming.off('error', onError);
      incoming.off('aborted', onAborted);
    };
    const rejectBody = (status, error) => {
      if (settled) return;
      settled = true; cleanup();
      stopBodyAndClose(incoming, outgoing, status, error);
      resolve(null);
    };
    const onData = (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_TRANSPORT_BYTES) { rejectBody(413, 'request_too_large'); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true; cleanup(); resolve(Buffer.concat(chunks, length));
    };
    const onError = () => rejectBody(400, 'invalid_request_body');
    const onAborted = () => rejectBody(400, 'invalid_request_body');
    const declared = incoming.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_TRANSPORT_BYTES)) {
      rejectBody(413, 'request_too_large'); return;
    }
    deadline = setTimeout(() => rejectBody(408, 'request_read_timeout'), BODY_DEADLINE_MS);
    incoming.on('data', onData);
    incoming.once('end', onEnd);
    incoming.once('error', onError);
    incoming.once('aborted', onAborted);
  });
}

async function main() {
  const config = argumentsForPreview(process.argv.slice(2));
  const existingDatabase = await requireLocalQaDatabase(config.databasePath);
  // Dynamic import permits a short, non-sensitive startup error while the local
  // API/UI files are still being authored. It is never a production import.
  const { createWorkshopAPI } = await import('./api.mjs');
  const { assertWorkshopSchema } = await import('./moderation.mjs');
  // Old local databases are inspected without a writable connection. Reject
  // incompatible schemas before any CREATE or connection PRAGMA can run.
  if (existingDatabase) {
    const inspection = new DatabaseSync(config.databasePath, { readOnly: true });
    try { assertWorkshopSchema(inspection); }
    finally { inspection.close(); }
  }
  const assets = {};
  for (const [file, contentType] of Object.entries(files)) assets[`/${file}`] = { body: await readFile(join(root, file), 'utf8'), contentType };
  assets['/index.html'].body = assets['/index.html'].body
    .replace(/<title>.*?<\/title>/s, '<title>留白交誼廳 · 共同工坊本機安全測試</title>')
    .replace('</head>', '<meta name="liubai-local-workshop" content="local-only"><link rel="stylesheet" href="/workshop-ui.css"></head>')
    .replace('</body>', '<script type="module" src="/workshop-entry.mjs"></script></body>');
  assets['/workshop-ui.mjs'] = { body: await readFile(join(folder, 'ui.mjs'), 'utf8'), contentType: 'text/javascript; charset=utf-8' };
  assets['/workshop-ui.css'] = { body: await readFile(join(folder, 'ui.css'), 'utf8'), contentType: 'text/css; charset=utf-8' };
  assets['/workshop-entry.mjs'] = { body: "import '/app.mjs';\nimport { initWorkshopUI } from '/workshop-ui.mjs';\ninitWorkshopUI();\n", contentType: 'text/javascript; charset=utf-8' };
  const readOnlyWiki = createReadOnlyWikiWorker({ assets });
  let schema;
  let wikiSchema;
  if (!existingDatabase) {
    [schema, wikiSchema] = await Promise.all([
      readFile(join(folder, 'schema.sql'), 'utf8'),
      readFile(join(root, 'shared-foundation/drizzle/0000_public_knowledge_revisions.sql'), 'utf8'),
    ]);
    // Applies only to this process and newly created SQLite files/journals.
    // Exclusive creation avoids silently opening a file that appeared meanwhile.
    process.umask(0o077);
    const newFile = await open(config.databasePath, 'wx', 0o600);
    await newFile.close();
  } else {
    const current = await requireLocalQaDatabase(config.databasePath);
    if (!current || current.dev !== existingDatabase.dev || current.ino !== existingDatabase.ino) throw new Error('qa_database_changed');
    process.umask(0o077);
  }
  const sqlite = new DatabaseSync(config.databasePath);
  try {
    if (!existingDatabase) { sqlite.exec(wikiSchema); sqlite.exec(schema); }
    assertWorkshopSchema(sqlite);
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec('PRAGMA busy_timeout = 1000');
  } catch (error) { sqlite.close(); throw error; }
  const DB = sqliteD1(sqlite);
  let workshop;
  let origin;
  const server = createServer({ maxHeaderSize: 8192 }, async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? 'GET';
      const actualPort = server.address().port;
      if (incoming.headers.host !== `127.0.0.1:${actualPort}`) {
        localError(outgoing, 403, 'loopback_host_required', method === 'HEAD', true); incoming.resume(); return;
      }
      const url = new URL(incoming.url, origin);
      if (url.origin !== origin || url.username || url.password) {
        localError(outgoing, 403, 'invalid_target', method === 'HEAD', true); incoming.resume(); return;
      }
      let body;
      if (!['GET', 'HEAD'].includes(method)) {
        body = await boundedBody(incoming, outgoing);
        if (body === null) return;
      }
      const request = new Request(url, { method, headers: incoming.headers, ...(body === undefined ? {} : { body }) });
      const response = url.pathname.startsWith('/api/workshop')
        ? await workshop.fetch(request, { DB })
        : await readOnlyWiki.fetch(request, { DB }, {});
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
      incoming.resume();
    } catch {
      localError(outgoing, 500, 'local_preview_failed', incoming.method === 'HEAD', true);
      incoming.resume();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  let stopping = false;
  function stop() {
    if (stopping) return; stopping = true;
    server.close(() => { sqlite.close(); });
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 1500); timer.unref();
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.once('error', (error) => {
    console.error(`Local workshop unavailable: ${['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'startup_failed'}`);
    sqlite.close(); process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    workshop = createWorkshopAPI({ enabled: config.enabled, visible: config.visible, allowedOrigin: origin });
    console.log(`LOCAL workshop security test: ${origin}`);
    console.log(`Synthetic-only SQLite: ${config.databasePath}`);
    console.log(`Public submissions: ${config.enabled && config.visible ? 'enabled for this local test' : 'OFF'}; board: ${config.visible ? 'visible' : 'hidden'}`);
    console.log('Loopback only. No production change, remote D1, account, credentials or model connection. Ctrl+C stops this owned preview.');
  });
}

main().catch((error) => {
  console.error(error.code === 'unsupported_workshop_schema'
    ? 'Local workshop unavailable: unsupported_workshop_schema; existing database left unchanged.'
    : 'Local workshop unavailable: invalid arguments, temporary QA database, or local files not ready.');
  process.exitCode = 1;
});
