/**
 * LOCAL-ONLY operator CLI for synthetic workshop databases.
 * No HTTP listener, credentials, account lookup, schema migration, edit/delete,
 * or automatic creation of a missing database. Every output is bounded JSON.
 */
import { DatabaseSync } from 'node:sqlite';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const SCHEMA = 'liubai-workshop-local-admin';
const HEX = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(['accept', 'reject', 'hide', 'restore']);
const STATES = new Set(['pending', 'accepted', 'rejected', 'hidden', 'all']);
const SAFE_ERRORS = new Set([
  'invalid_arguments', 'unsafe_local_database', 'database_not_found',
  'unsupported_workshop_schema', 'stale_review_version',
  'post_not_found', 'invalid_review_transition', 'invalid_post_id',
  'invalid_limit', 'invalid_review_state', 'invalid_review_action',
  'invalid_moderation_note', 'invalid_expected_version', 'invalid_moderation_clock',
  'moderation_transaction_active', 'invalid_persisted_review_state',
  'review_version_exhausted', 'moderation_read_failed', 'moderation_transaction_failed',
]);

function fail(code) { const error = new Error(code); error.code = code; throw error; }

function parseArguments(args) {
  const options = new Map(); const words = [];
  const allowed = new Set(['--db', '--state', '--id', '--note', '--limit', '--expected-version']);
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word.startsWith('--')) {
      if (!allowed.has(word) || options.has(word) || args[index + 1] === undefined || args[index + 1].startsWith('--')) fail('invalid_arguments');
      options.set(word, args[++index]);
    } else words.push(word);
  }
  const command = words[0];
  const isReports = command === 'reports' && (words.length === 1 || (words.length === 2 && words[1] === 'list'));
  if (!isReports && (words.length !== 1 || !['list', 'audit', ...ACTIONS].includes(command))) fail('invalid_arguments');
  if (!options.has('--db')) fail('invalid_arguments');
  const forCommand = command === 'list' ? ['--db', '--state', '--limit']
    : command === 'reports' ? ['--db', '--limit']
      : command === 'audit' ? ['--db', '--id', '--limit']
        : ['--db', '--id', '--note', '--expected-version'];
  if ([...options.keys()].some((option) => !forCommand.includes(option))) fail('invalid_arguments');
  const state = options.get('--state') ?? 'pending';
  if (!STATES.has(state)) fail('invalid_arguments');
  const limitText = options.get('--limit') ?? (command === 'audit' ? '100' : '20');
  const maximumLimit = command === 'reports' ? 200 : 100;
  if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > maximumLimit) fail('invalid_arguments');
  const id = options.get('--id');
  if ((ACTIONS.has(command) || command === 'audit') && !HEX.test(id ?? '')) fail('invalid_arguments');
  const note = options.get('--note') ?? '';
  if ([...note].length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)) fail('invalid_arguments');
  const expectedText = options.get('--expected-version');
  if (expectedText !== undefined && (!/^[1-9]\d{0,14}$/.test(expectedText) || !Number.isSafeInteger(Number(expectedText)))) fail('invalid_arguments');
  return { command, databasePath: resolve(options.get('--db')), state, limit: Number(limitText), id, note, ...(expectedText === undefined ? {} : { expectedVersion: Number(expectedText) }) };
}

async function requireExistingQaDatabase(filename) {
  if (!/^liubai-workshop-[A-Za-z0-9._-]+\.sqlite$/.test(basename(filename))) fail('unsafe_local_database');
  let existing;
  try { existing = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') fail('database_not_found'); throw error; }
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) fail('unsafe_local_database');
  if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) fail('unsafe_local_database');
  const parent = await realpath(dirname(filename));
  const temporaryRoots = await Promise.all(['/tmp', tmpdir()].map((path) => realpath(path)));
  if (!temporaryRoots.some((path) => parent === path || parent.startsWith(path + sep))) fail('unsafe_local_database');
  return existing;
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  const firstStat = await requireExistingQaDatabase(config.databasePath);
  const { assertWorkshopSchema, listPosts, listReports, listAudit, transitionPost } = await import('./moderation.mjs');
  // Validate an existing DB through a read-only connection before any action
  // can open it writable. Old schemas are left byte-for-byte untouched.
  const inspection = new DatabaseSync(config.databasePath, { readOnly: true });
  let output;
  try {
    assertWorkshopSchema(inspection);
    if (config.command === 'list') output = { state: config.state, limit: config.limit, posts: listPosts(inspection, { state: config.state, limit: config.limit }) };
    else if (config.command === 'reports') output = { limit: config.limit, reports: listReports(inspection, { limit: config.limit }) };
    else if (config.command === 'audit') output = { id: config.id, limit: config.limit, events: listAudit(inspection, { id: config.id, limit: config.limit }) };
  } finally { inspection.close(); }
  if (ACTIONS.has(config.command)) {
    const currentStat = await requireExistingQaDatabase(config.databasePath);
    if (firstStat.dev !== currentStat.dev || firstStat.ino !== currentStat.ino) fail('unsafe_local_database');
    // New SQLite journals inherit owner-only permissions. No chmod or schema
    // modification is made to this already-existing, explicitly chosen file.
    process.umask(0o077);
    const database = new DatabaseSync(config.databasePath);
    try {
      assertWorkshopSchema(database);
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('PRAGMA busy_timeout = 1000');
      output = { result: transitionPost(database, { id: config.id, action: config.command, note: config.note, ...(config.expectedVersion === undefined ? {} : { expectedVersion: config.expectedVersion }) }) };
    } finally { database.close(); }
  }
  process.stdout.write(JSON.stringify({ schema: SCHEMA, schemaVersion: 1, command: config.command, ...output }) + '\n');
}

main().catch((error) => {
  const code = SAFE_ERRORS.has(error.code) ? error.code : 'operation_failed';
  // Never echo SQL, stack traces, database paths, submitted content or notes.
  process.stderr.write(JSON.stringify({ error: code }) + '\n');
  process.exitCode = 1;
});
