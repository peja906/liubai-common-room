import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicAssets = [
  'index.html', 'styles.css', 'app.mjs', 'core.mjs', 'favicon.svg',
  'wiki-core.mjs', 'wiki-ui.mjs', 'wiki.css', 'relay.html', 'relay.css',
];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'liubai-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inputs = [...publicAssets, 'build-site.mjs', 'prepare-static.cjs',
    '.openai/hosting.example.json', 'shared-foundation/worker.mjs',
    'shared-foundation/drizzle/0000_public_knowledge_revisions.sql',
    'shared-foundation/drizzle/meta/_journal.json'];
  for (const path of inputs) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(root, path), join(dir, path));
  }
  // Synthetic stale output must never survive either public build.
  mkdirSync(join(dir, 'dist/workshop'), { recursive: true });
  writeFileSync(join(dir, 'dist/workshop/index.html'), 'STALE_PRIVATE_FIXTURE');
  writeFileSync(join(dir, 'dist/unapproved.txt'), 'STALE_PRIVATE_FIXTURE');
  // The default build must choose the portable example, not a local binding.
  writeFileSync(join(dir, '.openai/hosting.json'), '{"project_id":"IGNORED_LOCAL_FIXTURE"}');
  return dir;
}

test('static build clears stale output and publishes exactly ten approved source assets', (t) => {
  const dir = fixture(t);
  execFileSync(process.execPath, ['prepare-static.cjs'], { cwd: dir });
  assert.deepEqual(readdirSync(join(dir, 'dist')).sort(), [...publicAssets].sort());
  for (const path of publicAssets) {
    assert.deepEqual(readFileSync(join(dir, 'dist', path)), readFileSync(join(root, path)));
  }
});

test('portable Worker build serves the relay unchanged and keeps visitor writes disabled', async (t) => {
  const dir = fixture(t);
  const summary = JSON.parse(execFileSync(process.execPath, ['build-site.mjs'], { cwd: dir, encoding: 'utf8' }));
  assert.equal(summary.publicAssetCount, 10);
  assert.deepEqual(readdirSync(join(dir, 'dist')).sort(), ['.openai', 'server']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'dist/.openai/hosting.json'), 'utf8')),
    JSON.parse(readFileSync(join(root, '.openai/hosting.example.json'), 'utf8')));
  const output = readFileSync(join(dir, 'dist/server/index.js'), 'utf8');
  assert.ok(!output.includes('STALE_PRIVATE_FIXTURE'));
  assert.ok(!output.includes('IGNORED_LOCAL_FIXTURE'));
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)).default;
  const request = (path, method = 'GET') => new Request(`https://example.invalid${path}`, { method });
  for (const path of publicAssets) {
    const response = await worker.fetch(request(`/${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), readFileSync(join(root, path), 'utf8'), path);
    assert.equal(await (await worker.fetch(request(`/${path}`, 'HEAD'))).text(), '');
  }
  assert.match((await worker.fetch(request('/relay.html'))).headers.get('content-type'), /^text\/html/);
  assert.match((await worker.fetch(request('/relay.css'))).headers.get('content-type'), /^text\/css/);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await worker.fetch(request('/relay.html', method))).status, 405);
    assert.equal((await worker.fetch(request('/api/wiki', method))).status, 405);
  }
  assert.equal((await worker.fetch(request('/workshop/index.html'))).status, 404);
  assert.equal((await worker.fetch(request('/api/workshop'))).status, 404);
  assert.equal((await worker.fetch(request('/unapproved.txt'))).status, 404);
  assert.equal((await worker.fetch(request('/api/wiki'))).status, 503);
});
