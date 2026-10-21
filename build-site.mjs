/** Dependency-free same-Site Worker build. Only approved public assets enter output. */
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ARTICLES, SOURCE_CATALOG } from './wiki-core.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const destination = join(root, 'dist');
const files = {
  'index.html': 'text/html; charset=utf-8', 'styles.css': 'text/css; charset=utf-8',
  'app.mjs': 'text/javascript; charset=utf-8', 'core.mjs': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml', 'wiki-core.mjs': 'text/javascript; charset=utf-8',
  'wiki-ui.mjs': 'text/javascript; charset=utf-8', 'wiki.css': 'text/css; charset=utf-8',
};
const assets = {};
for (const [file, contentType] of Object.entries(files)) assets[`/${file}`] = { body: await readFile(join(root, file), 'utf8'), contentType };
// The public example builds locally without binding this repository to a live Site.
// A deployer can pass their own ignored manifest path as the first argument.
const manifest = JSON.parse(await readFile(join(root, process.argv[2] ?? '.openai/hosting.example.json'), 'utf8'));
if (manifest.static || manifest.d1 !== 'DB') throw new Error('Expected same-Site D1 Worker manifest');
const input = await readFile(join(root, 'shared-foundation/worker.mjs'), 'utf8');
const runtime = input.replace(/^import .*from '\.\.\/wiki-core\.mjs';\n/, '').replace('export default createReadOnlyWikiWorker();', 'export default createReadOnlyWikiWorker({ assets: EMBEDDED_ASSETS });');
const output = `// Generated from the exact approved source. Do not edit.\nconst PUBLIC_ARTICLES=${JSON.stringify(PUBLIC_ARTICLES)};\nconst SOURCE_CATALOG=${JSON.stringify(SOURCE_CATALOG)};\nconst EMBEDDED_ASSETS=${JSON.stringify(assets)};\n${runtime}`;
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'server'), { recursive: true });
await mkdir(join(destination, '.openai'), { recursive: true });
await writeFile(join(destination, '.openai/hosting.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(destination, 'server/index.js'), output);
await cp(join(root, 'shared-foundation/drizzle'), join(destination, '.openai/drizzle'), { recursive: true });
const worker = (await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)).default;
const response = await worker.fetch(new Request('https://example.invalid/'), {});
if (response.status !== 200 || !(await response.text()).includes('留白')) throw new Error('Worker build missing app entry');
console.log(JSON.stringify({ binding: manifest.d1, publicAssetCount: Object.keys(assets).length, entrypoint: 'dist/server/index.js' }));
